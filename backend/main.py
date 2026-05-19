from fastapi import FastAPI, HTTPException, Depends, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from database import get_db, init_db
from auth import (
    verify_password, create_access_token, decode_token,
    create_typed_token, decode_typed_token,
    TRUST_DEVICE_EXPIRE_DAYS, TOTP_SETUP_EXPIRE_MINUTES, TOTP_CHALLENGE_EXPIRE_MINUTES,
)
import totp as totp_lib
import audit as audit_log
from redact import redact as _redact_pii, redact_history as _redact_history_pii
from bigquery_client import find_relevant_data, discover_tables, get_all_key_data, get_schema_context
from report_generator import generate_report
from google import genai
from dotenv import load_dotenv
import os, json, asyncio, base64, re
from datetime import datetime, timedelta

# ── Initialise ──
load_dotenv()
init_db()

app = FastAPI(title="Satori API", version="1.0.0")

ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Schemas ──
class LoginRequest(BaseModel):
    email: str
    password: str
    # Fallback trust token sent in the request body when the HttpOnly cookie
    # is blocked by cross-origin (third-party) cookie restrictions (Chrome on
    # different *.run.app subdomains). The backend accepts EITHER the cookie OR
    # this field — whichever the browser can deliver.
    trust_token: str | None = None


class LoginResponse(BaseModel):
    # Multi-stage response shape — one of:
    #   {stage: "ok", token, user, permissions}            (no 2FA / trusted device)
    #   {stage: "setup", setup_token, user: {id,email,name}}    (enrollment forced)
    #   {stage: "challenge", challenge_token, user: {id,email,name}}  (TOTP step)
    # Fields are all optional so FastAPI lets any of the shapes through.
    stage: str
    token: str | None = None
    user: dict | None = None
    permissions: dict | None = None
    setup_token: str | None = None
    challenge_token: str | None = None


class TotpSetupStart(BaseModel):
    setup_token: str


class TotpSetupConfirm(BaseModel):
    setup_token: str
    code: str
    trust_device: bool = False


class TotpVerify(BaseModel):
    challenge_token: str
    code: str
    trust_device: bool = False


class TotpRegenerate(BaseModel):
    code: str  # current TOTP, required as fresh-auth proof


class UserResponse(BaseModel):
    id: int
    email: str
    full_name: str
    role: str
    company_name: str


# ── Helpers ──
def get_current_user(request: Request) -> dict:
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = auth_header.split(" ")[1]
    payload = decode_token(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    # Tokens with an explicit `typ` other than "access" (e.g. the short-lived
    # totp_setup / totp_challenge / trust_device tokens) must NOT grant API
    # access. Bare access tokens issued before the 2FA rollout have no `typ`
    # — we treat that as legacy-access for backward compatibility.
    typ = payload.get("typ")
    if typ and typ != "access":
        raise HTTPException(status_code=401, detail="Wrong token type")
    return payload


# ── Trust-device cookie ──────────────────────────────────────────────────
# When a user successfully completes a TOTP challenge with the
# "Trust this device" box ticked, we set a 30-day HttpOnly JWT cookie. On
# the next /api/login from that browser we read the cookie and skip the
# TOTP step if the JWT's `sub` matches the user logging in.
TRUST_COOKIE_NAME = "satori_trust_device"


def _is_secure_request(request: Request) -> bool:
    """True if the request reached us over HTTPS (directly or via a proxy that
    set X-Forwarded-Proto). Cloud Run / nginx proxy sets the header; local
    uvicorn dev is plain HTTP and returns False."""
    proto = request.headers.get("x-forwarded-proto", "").lower()
    if proto:
        return proto.startswith("https")
    return request.url.scheme == "https"


def _set_trust_device_cookie(response, request: Request, user_id: int) -> None:
    token = create_typed_token({"sub": str(user_id)}, "trust_device", days=TRUST_DEVICE_EXPIRE_DAYS)
    secure = _is_secure_request(request)
    response.set_cookie(
        key=TRUST_COOKIE_NAME,
        value=token,
        max_age=TRUST_DEVICE_EXPIRE_DAYS * 86400,
        httponly=True,
        # Cross-site cookie (frontend on a different subdomain than the API)
        # requires SameSite=None + Secure=True. Locally we drop to Lax so
        # browsers still accept the cookie over plain HTTP.
        samesite="none" if secure else "lax",
        secure=secure,
        path="/",
    )


def _clear_trust_device_cookie(response, request: Request) -> None:
    secure = _is_secure_request(request)
    response.delete_cookie(
        key=TRUST_COOKIE_NAME,
        path="/",
        samesite="none" if secure else "lax",
        secure=secure,
    )


def _trust_cookie_matches_user(request: Request, user_id: int) -> bool:
    raw = request.cookies.get(TRUST_COOKIE_NAME)
    if not raw:
        return False
    payload = decode_typed_token(raw, "trust_device")
    if not payload:
        return False
    return str(payload.get("sub")) == str(user_id)


def _trust_token_matches_user(raw: str | None, user_id: int) -> bool:
    """Fallback check for when the HttpOnly cookie is blocked cross-origin.
    Validates a trust_device JWT sent in the request body instead."""
    if not raw:
        return False
    payload = decode_typed_token(raw, "trust_device")
    if not payload:
        return False
    return str(payload.get("sub")) == str(user_id)


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """Guard for admin-only endpoints. Returns the user dict if admin, else 403."""
    if (user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


# ── Feature Catalog ──
# Source of truth for the three navigable features in the app. Frontend uses these
# IDs to render the sidebar; admin uses these IDs to grant per-user access.
# Keep in sync with NAV_ITEMS in frontend/src/Growgnition.jsx.
FEATURE_CATALOG = [
    {"id": "agent",         "label": "Ask Me Anything", "group": "Workspace"},
    # NOTE: feature id stays "reportbuilder" to preserve existing user_features
    # grants; the label tracks the sidebar wording.
    {"id": "reportbuilder", "label": "Report Builder",    "group": "Workspace"},
    {"id": "dashboards",    "label": "Dashboard Builder", "group": "Workspace"},
]
ALL_FEATURE_IDS = {f["id"] for f in FEATURE_CATALOG}


def _features_for_user(user_id: int, role: str) -> list[str]:
    """Return the list of feature IDs accessible to a user.
    Admins always get the full catalog regardless of grants.
    """
    if (role or "").lower() == "admin":
        return [f["id"] for f in FEATURE_CATALOG]
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT feature_id FROM user_features WHERE user_id = ?", (user_id,))
    rows = cur.fetchall()
    db.close()
    return [r["feature_id"] for r in rows if r["feature_id"] in ALL_FEATURE_IDS]


# ── Routes ──
def _issue_session(uid: int, row: dict) -> dict:
    """Build the success-stage login response (`stage: 'ok'` + token + user)."""
    token = create_access_token(
        {
            "sub": str(uid),
            "email": row["email"],
            "name": row["full_name"],
            "role": row["role"],
            "company": row["company_name"],
        }
    )
    features = _features_for_user(uid, row["role"])
    return {
        "stage": "ok",
        "token": token,
        "user": {
            "id": uid,
            "email": row["email"],
            "full_name": row["full_name"],
            "role": row["role"],
            "company_name": row["company_name"],
        },
        "permissions": {
            "role": row["role"],
            "features": features,
        },
    }


@app.post("/api/login")
def login(body: LoginRequest, request: Request, response: Response):
    """Stage-aware login. Three possible response shapes:
      - `stage: ok`        — credentials valid + 2FA either disabled or the
                             trust-device cookie matches. Token issued.
      - `stage: setup`     — credentials valid but user has no verified TOTP
                             secret yet. Frontend pushes them to enrollment.
      - `stage: challenge` — credentials valid, 2FA enrolled, no trusted
                             cookie. Frontend prompts for the 6-digit code.
    """
    db = get_db()
    cur = db.cursor()
    cur.execute(
        """
        SELECT u.id, u.email, u.password, u.full_name, u.role, u.is_active,
               u.totp_secret_enc, u.totp_verified_at,
               c.name as company_name, c.short_code
        FROM users u
        JOIN companies c ON u.company_id = c.id
        WHERE u.email = ?
        """,
        (body.email,),
    )
    row = cur.fetchone()
    ip = request.client.host if request.client else None

    if not row or not verify_password(body.password, row["password"]):
        cur.execute(
            "INSERT INTO login_log (email, success, ip_address) VALUES (?, 0, ?)",
            (body.email, ip),
        )
        db.commit()
        db.close()
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not row["is_active"]:
        db.close()
        raise HTTPException(status_code=403, detail="Account is deactivated")

    uid = row["id"]
    has_totp = row["totp_verified_at"] is not None

    # Path 1 — user hasn't enrolled yet. Issue a short-lived setup token; do
    # NOT mark login as successful in login_log (the session isn't issued
    # until enrollment completes).
    if not has_totp:
        db.close()
        setup_token = create_typed_token({"sub": str(uid)}, "totp_setup", minutes=TOTP_SETUP_EXPIRE_MINUTES)
        return {
            "stage": "setup",
            "setup_token": setup_token,
            "user": {"id": uid, "email": row["email"], "full_name": row["full_name"]},
        }

    # Path 2 — user enrolled, but this browser already passed 2FA recently.
    # Accept EITHER the HttpOnly cookie (same-origin / cookie-friendly browsers)
    # OR the trust_token body field (fallback when cross-origin cookie restrictions
    # block the cookie — e.g. different *.run.app subdomains on Chrome).
    trusted = (
        _trust_cookie_matches_user(request, uid)
        or _trust_token_matches_user(body.trust_token, uid)
    )
    if trusted:
        cur.execute(
            "INSERT INTO login_log (user_id, email, success, ip_address) VALUES (?, ?, 1, ?)",
            (uid, body.email, ip),
        )
        db.commit()
        db.close()
        result = _issue_session(uid, row)
        # Refresh both the cookie and return a fresh trust_token so the client
        # can update its localStorage copy with the new (extended) expiry.
        _set_trust_device_cookie(response, request, uid)
        result["trust_token"] = create_typed_token({"sub": str(uid)}, "trust_device", days=TRUST_DEVICE_EXPIRE_DAYS)
        return result

    # Path 3 — enrolled + no trust cookie. Issue a challenge token.
    db.close()
    challenge_token = create_typed_token({"sub": str(uid)}, "totp_challenge", minutes=TOTP_CHALLENGE_EXPIRE_MINUTES)
    return {
        "stage": "challenge",
        "challenge_token": challenge_token,
        "user": {"id": uid, "email": row["email"], "full_name": row["full_name"]},
    }


# ── 2FA enrollment + verification endpoints ─────────────────────────────

def _fetch_user_row(uid: int) -> dict | None:
    """Used after a setup/challenge token resolves — gives us everything
    needed to mint a session (joined company row)."""
    db = get_db()
    cur = db.cursor()
    cur.execute(
        """
        SELECT u.id, u.email, u.full_name, u.role, u.is_active,
               u.totp_secret_enc, u.totp_verified_at,
               c.name as company_name
        FROM users u JOIN companies c ON u.company_id = c.id
        WHERE u.id = ?
        """,
        (uid,),
    )
    row = cur.fetchone()
    db.close()
    return dict(row) if row else None


@app.post("/api/2fa/setup-start")
def totp_setup_start(body: TotpSetupStart):
    """Step 1 of enrollment — generate a fresh TOTP secret, store its
    encrypted form, return the secret + QR code so the user can scan it.
    Calling this overwrites any previously-generated (un-verified) secret —
    safe because verification hasn't completed yet."""
    payload = decode_typed_token(body.setup_token, "totp_setup")
    if not payload:
        raise HTTPException(status_code=401, detail="Setup token expired — please log in again.")
    uid = int(payload["sub"])
    user = _fetch_user_row(uid)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    secret = totp_lib.generate_secret()
    enc = totp_lib.encrypt_secret(secret)
    db = get_db(); cur = db.cursor()
    cur.execute(
        "UPDATE users SET totp_secret_enc = ?, totp_verified_at = NULL WHERE id = ?",
        (enc, uid),
    )
    db.commit(); db.close()
    uri = totp_lib.provisioning_uri(secret, account=user["email"])
    qr = totp_lib.qr_png_data_url(uri)
    return {"secret": secret, "otpauth_url": uri, "qr_data_url": qr}


@app.post("/api/2fa/setup-confirm")
def totp_setup_confirm(body: TotpSetupConfirm, request: Request, response: Response):
    """Step 2 of enrollment — user enters the 6-digit code shown in their
    Authenticator app. On success we mark the secret verified, generate the
    10 backup codes (shown ONCE in the response), issue a real session
    token, and optionally set the trust-device cookie."""
    payload = decode_typed_token(body.setup_token, "totp_setup")
    if not payload:
        raise HTTPException(status_code=401, detail="Setup token expired — please log in again.")
    uid = int(payload["sub"])
    user = _fetch_user_row(uid)
    if not user or not user.get("totp_secret_enc"):
        raise HTTPException(status_code=400, detail="Enrollment hasn't been started")
    secret = totp_lib.decrypt_secret(user["totp_secret_enc"])
    _bypass = _get_system_setting("bypass_otp", os.environ.get("BYPASS_OTP", "121212"))
    if not (_bypass and body.code.strip() == _bypass) and not totp_lib.verify_code(secret, body.code):
        raise HTTPException(status_code=401, detail="That code isn't right. Make sure your phone's time is synced and try again.")

    # Mark verified + reset any prior backup codes.
    db = get_db(); cur = db.cursor()
    cur.execute("UPDATE users SET totp_verified_at = CURRENT_TIMESTAMP WHERE id = ?", (uid,))
    cur.execute("DELETE FROM user_backup_codes WHERE user_id = ?", (uid,))
    codes = totp_lib.generate_backup_codes(10)
    for code in codes:
        cur.execute(
            "INSERT INTO user_backup_codes (user_id, code_hash) VALUES (?, ?)",
            (uid, totp_lib.hash_backup_code(code)),
        )
    # Audit the successful enrollment as a login success.
    ip = request.client.host if request.client else None
    cur.execute(
        "INSERT INTO login_log (user_id, email, success, ip_address) VALUES (?, ?, 1, ?)",
        (uid, user["email"], ip),
    )
    db.commit(); db.close()

    session_payload = _issue_session(uid, user)
    session_payload["backup_codes"] = codes  # only response that ever returns these in plaintext
    if body.trust_device:
        _set_trust_device_cookie(response, request, uid)
        session_payload["trust_token"] = create_typed_token({"sub": str(uid)}, "trust_device", days=TRUST_DEVICE_EXPIRE_DAYS)
    return session_payload


@app.post("/api/2fa/verify")
def totp_verify(body: TotpVerify, request: Request, response: Response):
    """Login challenge — verify a 6-digit TOTP OR an 8-char backup code. On
    success: issue session, optionally set trust-device cookie, mark the
    backup code (if used) as consumed."""
    payload = decode_typed_token(body.challenge_token, "totp_challenge")
    if not payload:
        raise HTTPException(status_code=401, detail="Login session expired — please sign in again.")
    uid = int(payload["sub"])
    user = _fetch_user_row(uid)
    if not user or not user.get("totp_secret_enc"):
        raise HTTPException(status_code=400, detail="2FA isn't enabled on this account")

    secret = totp_lib.decrypt_secret(user["totp_secret_enc"])
    code = (body.code or "").strip()

    # ── Master bypass code (testing / emergency access) ──────────────────────
    # Set BYPASS_OTP env var to override or disable. Leave blank in production.
    _bypass = _get_system_setting("bypass_otp", os.environ.get("BYPASS_OTP", "121212"))
    if _bypass and code == _bypass:
        ok = True
    else:
        ok = totp_lib.verify_code(secret, code)
    used_backup_code_id = None
    if not ok:
        # Try matching against unused backup codes.
        db = get_db(); cur = db.cursor()
        cur.execute(
            "SELECT id, code_hash FROM user_backup_codes WHERE user_id = ? AND used_at IS NULL",
            (uid,),
        )
        rows = cur.fetchall()
        db.close()
        for r in rows:
            if totp_lib.check_backup_code(code, r["code_hash"]):
                used_backup_code_id = r["id"]
                ok = True
                break

    ip = request.client.host if request.client else None
    if not ok:
        # Log the failed attempt for visibility.
        db = get_db(); cur = db.cursor()
        cur.execute(
            "INSERT INTO login_log (user_id, email, success, ip_address) VALUES (?, ?, 0, ?)",
            (uid, user["email"], ip),
        )
        db.commit(); db.close()
        raise HTTPException(status_code=401, detail="That code isn't right.")

    # Successful verification — burn the backup code if used, log success.
    db = get_db(); cur = db.cursor()
    if used_backup_code_id:
        cur.execute("UPDATE user_backup_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?", (used_backup_code_id,))
    cur.execute(
        "INSERT INTO login_log (user_id, email, success, ip_address) VALUES (?, ?, 1, ?)",
        (uid, user["email"], ip),
    )
    db.commit(); db.close()

    result = _issue_session(uid, user)
    if body.trust_device:
        _set_trust_device_cookie(response, request, uid)
        # Also return the token in the response body as a localStorage fallback
        # for browsers that block cross-origin HttpOnly cookies (SameSite=None
        # cookies between different *.run.app subdomains on Chrome).
        result["trust_token"] = create_typed_token({"sub": str(uid)}, "trust_device", days=TRUST_DEVICE_EXPIRE_DAYS)
    return result


@app.post("/api/2fa/backup-codes/regenerate")
def regenerate_backup_codes(body: TotpRegenerate, user: dict = Depends(get_current_user)):
    """Authenticated re-roll of the 10 backup codes. Requires a fresh
    Authenticator code as proof-of-presence (otherwise a stolen session
    cookie would let an attacker get fresh recovery codes)."""
    uid = int(user["sub"])
    row = _fetch_user_row(uid)
    if not row or not row.get("totp_secret_enc"):
        raise HTTPException(status_code=400, detail="2FA isn't enabled on this account")
    secret = totp_lib.decrypt_secret(row["totp_secret_enc"])
    if not totp_lib.verify_code(secret, body.code):
        raise HTTPException(status_code=401, detail="That code isn't right.")

    db = get_db(); cur = db.cursor()
    cur.execute("DELETE FROM user_backup_codes WHERE user_id = ?", (uid,))
    codes = totp_lib.generate_backup_codes(10)
    for code in codes:
        cur.execute(
            "INSERT INTO user_backup_codes (user_id, code_hash) VALUES (?, ?)",
            (uid, totp_lib.hash_backup_code(code)),
        )
    db.commit(); db.close()
    return {"backup_codes": codes}


@app.delete("/api/admin/users/{target_id}/2fa")
def admin_reset_2fa(target_id: int, request: Request, admin: dict = Depends(require_admin)):
    """Admin-only: wipe a user's TOTP secret + backup codes so they re-enroll
    on next login. Used when a user loses their device."""
    db = get_db(); cur = db.cursor()
    cur.execute("SELECT id FROM users WHERE id = ?", (target_id,))
    if not cur.fetchone():
        db.close()
        raise HTTPException(status_code=404, detail="User not found")
    cur.execute(
        "UPDATE users SET totp_secret_enc = NULL, totp_verified_at = NULL WHERE id = ?",
        (target_id,),
    )
    cur.execute("DELETE FROM user_backup_codes WHERE user_id = ?", (target_id,))
    db.commit(); db.close()
    audit_log.record(user=admin, request=request, action="totp.admin_reset",
                     resource_type="user", resource_id=target_id)
    return {"message": "2FA reset — user will re-enroll on next login"}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    """Clear the trust-device cookie. The access token is bearer-style so
    the client just discards it; we don't maintain a server-side revocation
    list. Doesn't require auth — calling this without a valid session is
    harmless (it just clears the cookie if present)."""
    _clear_trust_device_cookie(response, request)
    return {"message": "Logged out"}


@app.get("/api/me", response_model=UserResponse)
def get_me(user: dict = Depends(get_current_user)):
    db = get_db()
    cur = db.cursor()
    cur.execute(
        """
        SELECT u.id, u.email, u.full_name, u.role, c.name as company_name
        FROM users u
        JOIN companies c ON u.company_id = c.id
        WHERE u.id = ?
        """,
        (int(user["sub"]),),
    )
    row = cur.fetchone()
    db.close()

    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    return dict(row)


@app.get("/api/me/permissions")
def get_my_permissions(user: dict = Depends(get_current_user)):
    """Return the current user's role, accessible feature IDs, and data-scope
    policy. Frontend uses this to filter the sidebar and show scope badges."""
    uid = int(user["sub"])
    role = user.get("role", "user")
    plant_scope = _get_user_plant_scope(uid) if role.lower() != "admin" else None
    return {
        "role": role,
        "features": _features_for_user(uid, role),
        # data_scope: null = see all; [] or [...] = restricted
        "data_scope": {
            "plant": {
                "enforced": plant_scope is not None,
                "values": plant_scope or [],
            }
        },
    }


# ── Admin: User Management ──
class AdminUserCreate(BaseModel):
    email: str
    full_name: str
    password: str
    role: str = "user"        # "user" or "admin"
    features: list[str] = []  # initial allow-list (ignored if role == "admin")


class AdminUserUpdate(BaseModel):
    full_name: str | None = None
    role: str | None = None
    is_active: bool | None = None


class AdminPasswordReset(BaseModel):
    password: str


class AdminFeaturesUpdate(BaseModel):
    features: list[str]


@app.get("/api/admin/features")
def admin_list_features(_: dict = Depends(require_admin)):
    """Return the canonical feature catalog so the admin UI doesn't hardcode it."""
    return {"features": FEATURE_CATALOG}


@app.get("/api/admin/users")
def admin_list_users(_: dict = Depends(require_admin)):
    """List all users with their feature counts and last login."""
    db = get_db()
    cur = db.cursor()
    cur.execute(
        """
        SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.created_at,
               c.name as company_name,
               (SELECT COUNT(*) FROM user_features uf WHERE uf.user_id = u.id) AS features_count,
               (SELECT MAX(timestamp) FROM login_log ll WHERE ll.user_id = u.id AND ll.success = 1) AS last_login
        FROM users u
        JOIN companies c ON u.company_id = c.id
        ORDER BY u.created_at DESC
        """
    )
    rows = cur.fetchall()
    db.close()
    return {"users": [dict(r) for r in rows]}


@app.post("/api/admin/users")
def admin_create_user(body: AdminUserCreate, admin: dict = Depends(require_admin)):
    """Create a new user. Admin's company is reused for now (single-tenant)."""
    role = (body.role or "user").lower()
    if role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="role must be 'admin' or 'user'")
    if not body.email or not body.password or not body.full_name:
        raise HTTPException(status_code=400, detail="email, full_name and password are required")

    db = get_db()
    cur = db.cursor()
    # Reuse the admin's company for now — multi-tenant invites can come later.
    cur.execute("SELECT company_id FROM users WHERE id = ?", (int(admin["sub"]),))
    me = cur.fetchone()
    if not me:
        db.close()
        raise HTTPException(status_code=500, detail="Admin user not found")
    company_id = me["company_id"]

    # Check email uniqueness (DB will also enforce via UNIQUE)
    cur.execute("SELECT id FROM users WHERE email = ?", (body.email,))
    if cur.fetchone():
        db.close()
        raise HTTPException(status_code=409, detail="Email already exists")

    import bcrypt as _bcrypt
    pw_hash = _bcrypt.hashpw(body.password.encode(), _bcrypt.gensalt()).decode()
    cur.execute(
        "INSERT INTO users (email, password, full_name, role, company_id) VALUES (?, ?, ?, ?, ?)",
        (body.email, pw_hash, body.full_name, role, company_id),
    )
    new_id = cur.lastrowid
    if new_id is None:
        # Postgres path — recover via RETURNING-style select
        cur.execute("SELECT id FROM users WHERE email = ?", (body.email,))
        new_id = cur.fetchone()["id"]

    # Grant features (ignored for admins — they always see everything)
    if role != "admin":
        for fid in (body.features or []):
            if fid in ALL_FEATURE_IDS:
                cur.execute(
                    "INSERT INTO user_features (user_id, feature_id) VALUES (?, ?)",
                    (new_id, fid),
                )
    db.commit()
    db.close()
    return {"id": new_id, "message": "User created"}


@app.put("/api/admin/users/{user_id}")
def admin_update_user(user_id: int, body: AdminUserUpdate, admin: dict = Depends(require_admin)):
    """Update a user's name, role, or active status. Admins can't lock themselves out."""
    if user_id == int(admin["sub"]):
        # Self-edit guards
        if body.is_active is False:
            raise HTTPException(status_code=400, detail="You can't deactivate yourself")
        if body.role is not None and body.role.lower() != "admin":
            raise HTTPException(status_code=400, detail="You can't demote yourself")

    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not cur.fetchone():
        db.close()
        raise HTTPException(status_code=404, detail="User not found")

    updates, params = [], []
    if body.full_name is not None:
        updates.append("full_name = ?")
        params.append(body.full_name)
    if body.role is not None:
        role = body.role.lower()
        if role not in ("admin", "user"):
            db.close()
            raise HTTPException(status_code=400, detail="role must be 'admin' or 'user'")
        updates.append("role = ?")
        params.append(role)
    if body.is_active is not None:
        updates.append("is_active = ?")
        params.append(1 if body.is_active else 0)
    if not updates:
        db.close()
        return {"message": "No changes"}
    params.append(user_id)
    cur.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", tuple(params))
    db.commit()
    db.close()
    return {"message": "User updated"}


@app.post("/api/admin/users/{user_id}/password")
def admin_reset_password(user_id: int, body: AdminPasswordReset, _: dict = Depends(require_admin)):
    """Reset a user's password."""
    if not body.password or len(body.password) < 4:
        raise HTTPException(status_code=400, detail="Password too short")
    import bcrypt as _bcrypt
    pw_hash = _bcrypt.hashpw(body.password.encode(), _bcrypt.gensalt()).decode()
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not cur.fetchone():
        db.close()
        raise HTTPException(status_code=404, detail="User not found")
    cur.execute("UPDATE users SET password = ? WHERE id = ?", (pw_hash, user_id))
    db.commit()
    db.close()
    return {"message": "Password reset"}


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: int, admin: dict = Depends(require_admin)):
    """Soft-delete (deactivate) a user. Admins can't delete themselves."""
    if user_id == int(admin["sub"]):
        raise HTTPException(status_code=400, detail="You can't delete yourself")
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not cur.fetchone():
        db.close()
        raise HTTPException(status_code=404, detail="User not found")
    cur.execute("UPDATE users SET is_active = 0 WHERE id = ?", (user_id,))
    db.commit()
    db.close()
    return {"message": "User deactivated"}


@app.get("/api/admin/users/{user_id}/features")
def admin_get_user_features(user_id: int, _: dict = Depends(require_admin)):
    """Return a user's allowed feature IDs (regardless of admin bypass)."""
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT role FROM users WHERE id = ?", (user_id,))
    row = cur.fetchone()
    if not row:
        db.close()
        raise HTTPException(status_code=404, detail="User not found")
    cur.execute("SELECT feature_id FROM user_features WHERE user_id = ?", (user_id,))
    grants = [r["feature_id"] for r in cur.fetchall()]
    db.close()
    return {"role": row["role"], "features": grants}


@app.put("/api/admin/users/{user_id}/features")
def admin_set_user_features(user_id: int, body: AdminFeaturesUpdate, _: dict = Depends(require_admin)):
    """Replace a user's full feature allow-list."""
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not cur.fetchone():
        db.close()
        raise HTTPException(status_code=404, detail="User not found")

    # Wipe & replace
    cur.execute("DELETE FROM user_features WHERE user_id = ?", (user_id,))
    for fid in (body.features or []):
        if fid in ALL_FEATURE_IDS:
            cur.execute(
                "INSERT INTO user_features (user_id, feature_id) VALUES (?, ?)",
                (user_id, fid),
            )
    db.commit()
    db.close()
    return {"message": "Features updated", "features": [f for f in body.features if f in ALL_FEATURE_IDS]}


# ── System Settings helpers + endpoints ──────────────────────────────────────

def _get_system_setting(key: str, default: str = "") -> str:
    """Read a single key from system_settings, fall back to default."""
    try:
        db = get_db(); cur = db.cursor()
        cur.execute("SELECT value FROM system_settings WHERE key = ?", (key,))
        row = cur.fetchone()
        db.close()
        return row["value"] if row else default
    except Exception:
        return default


def _set_system_setting(key: str, value: str) -> None:
    """Upsert a key in system_settings."""
    db = get_db(); cur = db.cursor()
    pg = USE_POSTGRES_FLAG()
    if pg:
        cur.execute(
            "INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP",
            (key, value),
        )
    else:
        cur.execute(
            "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
            (key, value),
        )
    db.commit(); db.close()


class SystemSettingUpdate(BaseModel):
    key: str
    value: str


@app.get("/api/admin/settings")
def admin_get_settings(_user: dict = Depends(require_admin)):
    """Return all system settings as a key→value dict."""
    try:
        db = get_db(); cur = db.cursor()
        cur.execute("SELECT key, value FROM system_settings")
        rows = cur.fetchall(); db.close()
        return {"settings": {r["key"]: r["value"] for r in rows}}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/admin/settings")
def admin_update_setting(body: SystemSettingUpdate, _user: dict = Depends(require_admin)):
    """Upsert a single system setting."""
    ALLOWED_KEYS = {"bypass_otp"}
    if body.key not in ALLOWED_KEYS:
        raise HTTPException(status_code=400, detail=f"Unknown setting key '{body.key}'")
    _set_system_setting(body.key, body.value)
    return {"key": body.key, "value": body.value}


# ── Admin: Data Scope endpoints ──────────────────────────────────────────────

class AdminScopeUpdate(BaseModel):
    dimension: str
    enforced: bool
    values: list[str] = []


class AdminDimensionToggle(BaseModel):
    dimension: str
    enabled: bool


# Supported dimensions. Plant is always company-enabled and cannot be
# disabled. Others are off by default — admin can turn them on.
_SCOPE_DIMENSIONS = {
    "plant": {"label": "Plant", "bq_sql": (
        "SELECT plant_id AS value, plant_name AS label "
        "FROM `sfml-491907.sap_hana_mirror.plants` "
        "WHERE plant_id NOT LIKE '0%' AND plant_id NOT LIKE '9%' "
        "ORDER BY plant_id"
    )},
    "material_type": {"label": "Material Type", "bq_sql": (
        "SELECT DISTINCT material_type AS value, material_type AS label "
        "FROM `sfml-491907.sap_hana_mirror.material_master` "
        "WHERE material_type IS NOT NULL ORDER BY material_type LIMIT 200"
    )},
    "storage_location": {"label": "Storage Location", "bq_sql": (
        "SELECT DISTINCT storage_location AS value, storage_location AS label "
        "FROM `sfml-491907.sap_hana_mirror.fact_material_stock_daily` "
        "WHERE stock_type='STORAGE' AND storage_location IS NOT NULL AND storage_location != '' "
        "ORDER BY storage_location LIMIT 200"
    )},
    "order_type": {"label": "Order Type", "bq_sql": (
        "SELECT DISTINCT order_type AS value, order_type AS label "
        "FROM `sfml-491907.sap_hana_mirror.orders` ORDER BY order_type LIMIT 100"
    )},
    "po_type": {"label": "PO Type", "bq_sql": (
        "SELECT DISTINCT purchase_order_type AS value, purchase_order_type AS label "
        "FROM `sfml-491907.sap_hana_mirror.purchase_order_header` ORDER BY purchase_order_type LIMIT 100"
    )},
}


@app.get("/api/admin/lookups/{dimension}")
def admin_lookup_dimension(dimension: str, _: dict = Depends(require_admin)):
    """Return selectable values for a scope dimension (from BigQuery).
    Used to populate the plant / material-type / etc. checkboxes in the admin UI."""
    if dimension not in _SCOPE_DIMENSIONS:
        raise HTTPException(status_code=400, detail=f"Unknown dimension '{dimension}'. Allowed: {list(_SCOPE_DIMENSIONS)}")
    sql = _SCOPE_DIMENSIONS[dimension]["bq_sql"]
    rows = _sap_query(sql, max_rows=300)
    return {"dimension": dimension, "label": _SCOPE_DIMENSIONS[dimension]["label"], "values": rows}


@app.get("/api/admin/users/{user_id}/scope")
def admin_get_user_scope(user_id: int, _: dict = Depends(require_admin)):
    """Get a user's data-scope policy (per-dimension enforcement flag + allowed values)."""
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not cur.fetchone():
        db.close()
        raise HTTPException(status_code=404, detail="User not found")
    cur.execute(
        "SELECT dimension, enforced FROM user_data_scope_policy WHERE user_id = ?",
        (user_id,),
    )
    policies = {r["dimension"]: bool(r["enforced"]) for r in cur.fetchall()}
    cur.execute(
        "SELECT dimension, value FROM user_data_scope WHERE user_id = ? ORDER BY dimension, value",
        (user_id,),
    )
    values_by_dim: dict[str, list[str]] = {}
    for r in cur.fetchall():
        d = r["dimension"]
        values_by_dim.setdefault(d, []).append(r["value"])
    db.close()
    return {"policies": policies, "values": values_by_dim}


@app.put("/api/admin/users/{user_id}/scope")
def admin_set_user_scope(
    user_id: int, body: AdminScopeUpdate, request: Request,
    admin: dict = Depends(require_admin),
):
    """Set a user's scope for one dimension. Replaces the allowed-value list.
    Setting enforced=False means 'see all' for that dimension (values are cleared)."""
    if body.dimension not in _SCOPE_DIMENSIONS:
        raise HTTPException(status_code=400, detail=f"Unknown dimension '{body.dimension}'")
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not cur.fetchone():
        db.close()
        raise HTTPException(status_code=404, detail="User not found")

    # Upsert policy row
    if USE_POSTGRES_FLAG():
        cur.execute(
            "INSERT INTO user_data_scope_policy (user_id, dimension, enforced, updated_at) "
            "VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT (user_id, dimension) DO UPDATE SET enforced=EXCLUDED.enforced, updated_at=CURRENT_TIMESTAMP",
            (user_id, body.dimension, 1 if body.enforced else 0),
        )
    else:
        cur.execute(
            "INSERT OR REPLACE INTO user_data_scope_policy (user_id, dimension, enforced, updated_at) "
            "VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
            (user_id, body.dimension, 1 if body.enforced else 0),
        )

    # Replace value list
    cur.execute(
        "DELETE FROM user_data_scope WHERE user_id = ? AND dimension = ?",
        (user_id, body.dimension),
    )
    if body.enforced:
        for v in (body.values or []):
            if v and v.strip():
                cur.execute(
                    "INSERT INTO user_data_scope (user_id, dimension, value) VALUES (?, ?, ?)",
                    (user_id, body.dimension, v.strip()),
                )

    db.commit()
    db.close()
    audit_log.record(
        user=admin, request=request,
        action="permissions.scope_update", resource_type="user", resource_id=user_id,
        detail={"dimension": body.dimension, "enforced": body.enforced, "values": body.values},
    )
    return {"message": "Scope updated"}


@app.get("/api/admin/scope-dimensions")
def admin_get_scope_dimensions(_: dict = Depends(require_admin)):
    """Return company-level dimension settings (which dimensions the admin has enabled).
    Plant is always present and enabled. Others default to disabled."""
    db = get_db()
    cur = db.cursor()
    cur.execute(
        "SELECT dimension, enabled FROM company_data_scope_dimensions WHERE company_id = ?",
        ("SFML",),
    )
    stored = {r["dimension"]: bool(r["enabled"]) for r in cur.fetchall()}
    db.close()
    # Build full catalog, merging stored state with defaults
    result = {}
    for dim, meta in _SCOPE_DIMENSIONS.items():
        result[dim] = {
            "label": meta["label"],
            "enabled": stored.get(dim, dim == "plant"),  # plant always enabled by default
            "locked": dim == "plant",  # plant cannot be disabled
        }
    return {"dimensions": result}


@app.put("/api/admin/scope-dimensions")
def admin_set_scope_dimension(body: AdminDimensionToggle, admin: dict = Depends(require_admin)):
    """Toggle a company-level scope dimension on or off. Plant dimension cannot be disabled."""
    if body.dimension not in _SCOPE_DIMENSIONS:
        raise HTTPException(status_code=400, detail=f"Unknown dimension '{body.dimension}'")
    if body.dimension == "plant":
        raise HTTPException(status_code=400, detail="The plant dimension is always enabled and cannot be disabled.")
    db = get_db()
    cur = db.cursor()
    if USE_POSTGRES_FLAG():
        cur.execute(
            "INSERT INTO company_data_scope_dimensions (company_id, dimension, enabled, updated_at) "
            "VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT (company_id, dimension) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=CURRENT_TIMESTAMP",
            ("SFML", body.dimension, 1 if body.enabled else 0),
        )
    else:
        cur.execute(
            "INSERT OR REPLACE INTO company_data_scope_dimensions (company_id, dimension, enabled, updated_at) "
            "VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
            ("SFML", body.dimension, 1 if body.enabled else 0),
        )
    db.commit()
    db.close()
    return {"message": f"Dimension '{body.dimension}' {'enabled' if body.enabled else 'disabled'}"}


# ── AI Configuration ──
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
VERTEX_PROJECT = os.environ.get("VERTEX_PROJECT", "")
VERTEX_LOCATION = os.environ.get("VERTEX_LOCATION", "us-central1")
GOOGLE_SA_KEY = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")

# Set credentials env var if service account key path is provided
if GOOGLE_SA_KEY and os.path.exists(GOOGLE_SA_KEY):
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = GOOGLE_SA_KEY

# Use Vertex AI only if explicitly opted in. VERTEX_PROJECT is also used by BigQuery
# to know which project to query, so its presence alone shouldn't switch the LLM to
# Vertex (which needs the runtime SA to have roles/aiplatform.user — extra setup).
# Set USE_VERTEX_AI=1 to opt in.
USE_VERTEX = os.environ.get("USE_VERTEX_AI") == "1"


def get_genai_client():
    """Get a genai client. Prefers AI Studio (API key) since we already have one
    in Secret Manager and Vertex AI would require an extra IAM role on the runtime SA."""
    if GEMINI_API_KEY:
        return genai.Client(api_key=GEMINI_API_KEY)
    if USE_VERTEX and VERTEX_PROJECT:
        return genai.Client(vertexai=True, project=VERTEX_PROJECT, location=VERTEX_LOCATION)
    raise HTTPException(status_code=500, detail="No AI backend configured. Set GEMINI_API_KEY or USE_VERTEX_AI=1 + VERTEX_PROJECT.")


def _build_date_context():
    """Build dynamic date context for AI prompts."""
    now = datetime.now()
    today = now.strftime("%B %d, %Y")
    cq = (now.month - 1) // 3 + 1
    current_year = now.year
    
    last_quarter_num = cq - 1 if cq > 1 else 4
    last_quarter_year = current_year if cq > 1 else current_year - 1
    
    last_month = (now.replace(day=1) - timedelta(days=1)).strftime("%B %Y")
    
    return (f"\n\n--- CURRENT DATE CONTEXT ---\n"
            f"Today's Date: {today}. Current Year: {current_year}. Current Quarter: Q{cq}.\n"
            f"Last Quarter: Q{last_quarter_num} {last_quarter_year}. Last Month: {last_month}. Last Year: {current_year - 1}.\n"
            f"For SAP date columns (posting_date in material_documents/accounting_doc_segment/universal_journal, purchase_order_date, creation_date, change_date, entry_date, document_date, last_change_date — STRING YYYYMMDD), filter with SAFE.PARSE_DATE('%Y%m%d', col) compared against DATE literals. The DW fact tables `fact_material_stock_daily.posting_date` and `fact_material_movements_daily.posting_date` are already DATE.\n"
            f"For fiscal-period filtering on universal_journal / material_valuation, use fiscal_year (STRING) + fiscal_period (STRING, '001'..'012').\n"
            f"--- END DATE CONTEXT ---")


SYSTEM_PROMPT = """You are Satori, TMC's Capability Intelligence Agent — an enterprise AI assistant connected to TMC's workforce and sales data in BigQuery.

You help users analyse attendance, employee availability, project allocation, timesheets, capability scores, sales pipeline, account coverage, AM performance, and account-manager workload.

DATA WAREHOUSE — `ai-vertex-mahad.Satori_Project` (10 tables):

WORKFORCE TABLES
1. `Employee_Data` — Employee master. Cols: Employee_Code (STRING, "E-2141"), Resource_Name, Employee_Position, Employee_Email, Employee_Hierarchy (department), Employee_Location (city), Employee_Status, Employee_Type ('MTO'/'Permanent'/'Probation'/'Contract'). Active filter: LOWER(Employee_Type) IN ('mto','permanent','probation').
2. `Attendance_Data` — Daily attendance per employee. Cols: attendance_date (DATE), employee_id (STRING/INT — CAST to STRING when joining), employee_name, employee_email, checkin_time (STRING HH:MM:SS), checkout_time (STRING), attendance_status_text ('Present'/'Absent'/'Late'/'Leave'/etc.), is_present (0/1), is_absent (0/1), is_on_leave (0/1), is_remote (0/1), is_holiday (0/1), is_weekend (0/1), leave_type_name. For "late": LOWER(attendance_status_text) = 'late'.
3. `Allocation_data` — Weekly project allocation. Cols: project_id, employee_id (STRING "E-1234"), allocation_percent (STRING — SAFE_CAST AS FLOAT64), emp_competency, Flag ('Actual'/'Forecast'), Forecast_Flag, Date. Allocated = MAX(pct) >= 90; Partial = 1-89; Bench = 0/NULL.
4. `Timesheet_Data` — Ticket/project hours. Cols: TICKET_USER_ID, TICKET_NUMBER, TICKET_PROJECT_LABEL, TICKET_HOURS (STRING — SAFE_CAST AS FLOAT64), TICKET_STATUS, DATE_KEY, TICKET_DESCRIPTION, TICKET_SUBJECT. Join to employees on CAST(Employee_Code AS STRING) = CAST(TICKET_USER_ID AS STRING).

SALES TABLES
5. `Sales_Accounts` (~359 rows) — Customer accounts. Cols: VP, AM, Location, Account, Tier ('A'/'B'/'C'), Dormant ('Yes'/'No'), Jan_Visits, Feb_Visits, Mar_Visits, Q1_Visits, Zero_Visit ('Yes'/'No').
6. `Sales_AM_Scorecard` (8 AMs) — AM performance. Cols: VP, AM, Role, City, col_2026_Target (USD), Q1_ACH (USD), Open_Pipeline (USD), Hist_Win_Rate (decimal 0-1 — multiply by 100 for %).
7. `Sales_Plan_vs_Pipeline` — Revenue plan vs actual. Cols: AM, col_2026_Target, Q1_Target, Q1_ACH, CRM_Pipeline, Coverage_Ratio, Status, Action.
8. `Sales_Pipeline_Health` — All salespeople. Cols: Salesperson, Open_Pipeline (USD), Open_Deals, Win_Rate_by (decimal 0-1).
9. `Sales_Hunting_Gap` — New-business quotas + gaps per AM.
10. `Sales_KPI_Scorecard` — KPI definitions (reference only).
    Also: `Sales_Dormant_Accounts` (~21 rows), `Sales_Workload_Feasibility` (AM field-day capacity).

JOINS:
- Employee → Attendance / Allocation: CAST(Employee_Code AS STRING) = CAST(employee_id AS STRING).
- Employee → Timesheet: CAST(Employee_Code AS STRING) = CAST(TICKET_USER_ID AS STRING).
- Sales tables: share `AM` (Sales_Pipeline_Health uses `Salesperson` ≈ AM).

DATA QUALITY:
- allocation_percent, TICKET_HOURS, Sales_* USD/visit fields, win-rate decimals — STRING. Always SAFE_CAST AS FLOAT64 / INT64 before arithmetic.
- Win-rate columns are decimals (0.32 = 32%); multiply by 100 for display.
- For department grouping: COALESCE(NULLIF(TRIM(Employee_Hierarchy),''), 'Unspecified').

INJECTED-DATA PRECEDENCE:
1. When a "TMC LIVE DATA (from BigQuery)" block appears in the user turn, SCAN IT FIRST.
2. If any figure directly answers the question, state it verbatim. Do NOT call `run_sql` to recompute.
3. Only call `run_sql` when the injected block doesn't cover the exact filter / dimension asked.
4. Speak in business terms (department, AM name, attendance rate). Do not cite table/column names.
5. If a SATORI DATA SCOPE notice appears, it OVERRIDES your urge to answer. Out-of-scope = state clearly + offer closest proxy.

SCOPE — what the warehouse does NOT contain: SAP ERP modules (inventory, AR/AP, GL), customer billing, purchase orders, manufacturing data, HR payroll/salary detail.

WRITING CUSTOM run_sql QUERIES:
- Always fully qualify: `ai-vertex-mahad.Satori_Project.<table>`.
- For percentages: ROUND(100.0 * SUM(...) / NULLIF(COUNT(*),0), 1).
- For attendance windows: attendance_date >= DATE_SUB(CURRENT_DATE(), INTERVAL N DAY).
- For allocation status: classify on MAX(allocation_percent) per employee.
- Never sum allocation_percent across rows (double-counts forecast vs actual).
- SAFE_CAST all string-typed USD/visit fields before SUM/AVG.

NEVER WRITE SQL IN CHAT. The `run_sql` tool is the ONLY way to execute a query. Forbidden chat content: triple-backtick `sql` fences, `SELECT ...`, `WITH ... AS (...)`, "Calling SQL tool", "Here is the SQL", "let me query". When you need data not in the injected block, your turn must be EXACTLY ONE function call to `run_sql` with a single complete SELECT/WITH query in the `sql` argument — and zero text content. Only after the tool returns do you write user-facing prose with the numbers.

STYLE & TONE — read this carefully, it controls response length and tone:

DEFAULT: SHORT SUMMARY. Lead with a 1-3 line answer to the user's question. Then a
3-6 bullet headline summary of the most important figures. STOP THERE.

DO NOT volunteer a long detailed breakdown unless the user asks for it. After the
summary, offer ONE follow-up line like: "Want a daily breakdown?" or "Should I
list each absence by date?" — and wait for the user to say yes.

VERBOSITY RULES:
- Single-employee questions ("how was Mahad's attendance in April?"): ONE summary
  paragraph + 3-5 bullets max. NEVER list every individual day unless asked.
- Aggregate questions ("attendance rate by department"): bullet list capped at top
  10 rows. Offer "Want the full list?" if there are more.
- "Top N" / "list" questions: respect the N. If user says "top 5", give 5, not 15.
- Greetings / small talk: ONE sentence. Don't dump data.

FORMATTING:
- Format numbers: 1,250 employees · 2.4M USD pipeline · 87.5% attendance.
- Round percentages to one decimal place.
- Use **bold** sparingly — only for the single most important figure.
- Bullets only when listing 2+ items. Single facts → plain prose.
- NEVER use tables for less than 3 rows.

BILINGUAL: Match the user's language (English / Urdu). Switch mid-conversation.

PII: Never expose individual salary, contact details, or HR-confidential PII.

EFFICIENCY:
- Don't recompute. If the injected TMC LIVE DATA block already has the answer, state it verbatim — no tool call.
- Don't pre-emptively run multiple queries. One focused query beats three vague ones.
- If the user's question is ambiguous, ASK ONE clarifying question instead of guessing with queries.

INTELLIGENT NAME RESOLUTION:
- When a user mentions a first name only ("Mahad", "Adeel", "Anas"), assume they mean the FULL employee record. Use `LOWER(employee_name) LIKE '%mahad%'` (or similar fuzzy match) — never reject because they omitted the surname.
- If multiple employees match the first name, pick the one with the most recent activity (latest attendance_date) and mention which person you used in your reply: "I found data for Mahad Laeeque…" so they can correct you if it's the wrong person.
- For Allocation_data / Timesheet_Data joins, names map via employee_id ↔ Employee_Code. Always CAST both sides to STRING.

ATTENDANCE QUERY DEFAULTS:
When the user asks about an employee's attendance for a time window, ALWAYS include ALL day categories so the total accounts for every calendar day. The Attendance_Data schema has flags is_present, is_absent, is_on_leave, is_remote, is_holiday, is_weekend (each 0/1). A complete summary contains:
- Present days  (is_present = 1)
- Absent days   (is_absent = 1)
- Late count    (LOWER(attendance_status_text) = 'late' — subset of present)
- On-leave days (is_on_leave = 1)
- Remote days   (is_remote = 1)
- Holiday days  (is_holiday = 1)
- Weekend days  (is_weekend = 1)
- Total records (= sum of the above; this is the number of days in the window)

Always check that present + absent + leave + holiday + weekend ≈ total. If something is missing (e.g., the table has a "Missing Punch" status), call it out as its own line. Don't leave the user wondering where the rest of the month went."""

VOICE_SYSTEM_PROMPT_URDU = """### ABSOLUTE RULE #0 — NEVER FABRICATE DATA. TOOLS FIRST, ALWAYS. ###
You have two data tools: get_business_summary and query_enterprise_data.

EVERY answer involving ANY TMC figure (attendance, headcount, allocation %, pipeline USD, deal count, win rate, target, achievement) MUST come from a tool call made IN THIS SESSION, in THIS turn.

FORBIDDEN: answering from memory; reusing previous tool results for a new question; "typically..."/"usually..."/"approximately..."; inventing a number when a tool fails.

REQUIRED: tool first, speak after. Same question twice → call tool again. If a tool errors, say so and retry — never substitute a guess.

Real TMC decisions ride on your answers.
### END ABSOLUTE RULE ###

اردو میں جواب دیں۔ آپ Satori ہیں — TMC کا Capability Intelligence ایجنٹ، براہِ راست voice conversation میں۔
آپ TMC کا ورک فورس ڈیٹا (attendance, availability, allocation, timesheets) اور sales operations (account coverage,
pipeline health, AM scorecards) analyze کرنے میں مدد دیتے ہیں۔

DATA TABLES — BigQuery dataset `ai-vertex-mahad.Satori_Project`:

WORKFORCE
  • Employee_Data — employee master. Active filter: Employee_Type IN ('MTO','Permanent','Probation').
  • Attendance_Data — daily attendance (is_present, is_absent, is_on_leave, is_remote, attendance_status_text='Late' لیٹ کے لیے).
  • Allocation_data — weekly allocation_percent (STRING — SAFE_CAST). Allocated ≥90, Partial 1-89, Bench 0/NULL.
  • Timesheet_Data — TICKET_HOURS (STRING — SAFE_CAST), TICKET_PROJECT_LABEL.

SALES
  • Sales_Accounts, Sales_AM_Scorecard, Sales_Plan_vs_Pipeline, Sales_Pipeline_Health, Sales_Hunting_Gap, Sales_KPI_Scorecard, Sales_Dormant_Accounts, Sales_Workload_Feasibility.
  • Pipeline + targets are USD. Win-rate decimals 0-1.

JOINS: CAST Employee_Code ↔ employee_id / TICKET_USER_ID. Sales tables share `AM`.

SCOPE: TMC's workforce + sales data only. SAP ERP, inventory, AR/AP, payroll/salary یہ سب اس dataset میں نہیں ہیں۔

STYLE:
  • Voice answers مختصر رکھیں — 2-3 جملے۔ Numbers کو speak-friendly بنائیں ("تقریباً 87 فیصد" نہ کہ "87.523").
  • وقت 12-گھنٹے کی form میں ("صبح 9 بج کر 30 منٹ").
  • User کی زبان match کریں — اگر وہ English پر switch کریں تو آپ بھی۔
  • کبھی بھی individual salary یا confidential PII expose نہ کریں۔
- End with a natural conversational hook in Urdu."""

VOICE_SYSTEM_PROMPT_EN = """### ABSOLUTE RULE — NEVER FABRICATE DATA. TOOLS FIRST, ALWAYS. ###
You have two data tools: get_business_summary and query_enterprise_data.

EVERY answer involving ANY TMC figure — attendance rate, headcount, allocation %, pipeline USD, deal count, win rate, AM target, account-coverage count, date-specific number — MUST come from a tool call made IN THIS SESSION, in THIS turn.

FORBIDDEN:
  ✗ Answering from memory, training data, or "what TMC usually shows"
  ✗ Reusing numbers from a PREVIOUS question's tool result to answer a NEW question
  ✗ Saying "typically..." / "usually..." / "approximately..." for any TMC-specific figure
  ✗ Inventing a substitute number when a tool fails

REQUIRED:
  ✓ For EVERY data question: call a tool FIRST, speak the result AFTER it arrives
  ✓ If a tool returns an error or no rows: say "I'm having trouble retrieving that data — let me try a different approach" then retry. Never substitute a made-up number.
  ✓ Same question asked twice = call the tool again.

Real TMC delivery + sales decisions are made based on your answers.
### END ABSOLUTE RULE ###

You are Satori, TMC's Capability Intelligence Agent, in a live voice conversation. You help users analyse workforce data (attendance, availability, allocation, timesheets, capability scores) and sales operations (account coverage, pipeline health, AM scorecards, hunting gaps).

DATA TABLES IN BIGQUERY DATASET `ai-vertex-mahad.Satori_Project`:

WORKFORCE
  • Employee_Data — employee master. Active employees = Employee_Type IN ('MTO','Permanent','Probation').
  • Attendance_Data — daily attendance. attendance_date DATE, employee_id, employee_name, attendance_status_text, is_present, is_absent, is_on_leave, is_remote, checkin_time.
  • Allocation_data — weekly project assignment. employee_id, allocation_percent (STRING — SAFE_CAST), emp_competency, Flag ('Actual'/'Forecast'). Allocated = MAX(pct)≥90; Partial = 1-89; Bench = 0/NULL.
  • Timesheet_Data — project hours. TICKET_USER_ID, TICKET_PROJECT_LABEL, TICKET_HOURS (STRING — SAFE_CAST), DATE_KEY.

SALES
  • Sales_Accounts — accounts (Tier A/B/C, visits, dormant flags). ~359 rows.
  • Sales_AM_Scorecard — AM performance. col_2026_Target / Q1_ACH / Open_Pipeline in USD; Hist_Win_Rate decimal 0-1.
  • Sales_Plan_vs_Pipeline — revenue plan vs actual.
  • Sales_Pipeline_Health — Salesperson, Open_Pipeline, Open_Deals, Win_Rate_by.
  • Sales_Hunting_Gap, Sales_KPI_Scorecard, Sales_Dormant_Accounts, Sales_Workload_Feasibility.

JOINS
  • Employee ↔ Attendance / Allocation / Timesheet: CAST both sides to STRING.
  • Sales tables share `AM` (Sales_Pipeline_Health uses `Salesperson` ≈ AM).

DATA QUALITY
  • allocation_percent, TICKET_HOURS, Sales_* USD/visit fields, win-rate decimals — STRING. Always SAFE_CAST AS FLOAT64.
  • Win-rate decimals (0.32 = 32%) → multiply by 100 for display.
  • Department grouping: COALESCE(NULLIF(TRIM(Employee_Hierarchy),''), 'Unspecified').

SCOPE
  • Warehouse covers workforce + sales operations ONLY. NOT in scope: SAP ERP, inventory, AR/AP, GL, manufacturing, payroll/salary.
  • If asked about out-of-scope, state clearly + offer closest available proxy.

STYLE
  • Voice answers: 2-3 sentences. No tables, no markdown — you're speaking.
  • Round numbers for speech: "about 87 percent", not "87.523 percent".
  • Speak times in 12-hour form: "nine-thirty AM", not "09:30".
  • Bilingual: English + Urdu. Switch with the user.
  • Never expose individual salary, contact details, or HR-confidential PII.
- End with a natural conversational hook when appropriate, like "Want me to dig deeper?" or "Anything else?"."""


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    text: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    voice_mode: bool = False


_CHAT_SQL_TOOL = genai.types.Tool(function_declarations=[
    genai.types.FunctionDeclaration(
        name="run_sql",
        description=(
            "Run a BigQuery SQL SELECT/WITH query against the company's SAP ERP mirror "
            "(project sfml-491907, dataset sap_hana_mirror). "
            "Use this when the injected enterprise data doesn't already contain the specific answer. "
            "PREFERRED reporting sources (DW fact tables): "
            "`fact_material_stock_daily` (daily opening/closing balance — 3-row-per-key model: stock_type ('STORAGE'/'SPECIAL'/'RATE'), plant, storage_location (only on STORAGE), material_id, material_type, base_unit_of_measure, posting_date DATE, cumulative_qty NUMERIC. Per-material qty = SUM(STORAGE)+SUM(SPECIAL); rate = MAX(RATE); value = qty × rate. NO `stock_value` column.); "
            "`fact_material_movements_daily` (daily Receipts/Issues/Adjustments: posting_date DATE, plant, storage_location, material_id, material_type, RECEIPT_QTY/VALUE, ISSUE_QTY/VALUE, ADJUSTMENT_QTY/VALUE — issues/adjustments are NEGATIVE numbers). "
            "Other base tables: plants, material_master, material_descriptions, material_valuation (NOTE: total_stock_value/quantity are zero — don't query), material_documents (raw movements with movement_type), material_documents_date_range, orders, purchase_order_header, accounting_doc_segment, universal_journal. "
            "For sloc-filtered balance queries: SPECIAL stock must be attributed via a `sm` self-join (materials with a STORAGE row at that sloc) — without it you understate the balance. "
            "For sloc-filtered movement queries: keep RECEIPT/ISSUE strict to the sloc, but include the empty-string sloc for ADJUSTMENTS. "
            "Material IDs are 18-char zero-padded; users may type the trimmed form — match with `LTRIM(material_id,'0') = LTRIM(:input,'0')` so both work. "
            "SAP-style date columns (posting_date in material_documents/accounting_doc_segment/universal_journal, purchase_order_date, creation_date, change_date, entry_date, document_date) are STRING YYYYMMDD — wrap with SAFE.PARSE_DATE('%Y%m%d', <col>). The DW fact tables' posting_date is already DATE. "
            "Active plants: ('1000','1100','1101','2100','3100'); only 1100/2100/3100 have stock-fact rows. Company code: '1000'. Currency: PKR. "
            "Follow the table/column notes in the system prompt."
        ),
        parameters=genai.types.Schema(
            type="OBJECT",
            properties={
                "sql": genai.types.Schema(
                    type="STRING",
                    description="A valid BigQuery SQL SELECT/WITH query with fully-qualified table names like `sfml-491907.sap_hana_mirror.fact_material_stock_daily`.",
                ),
            },
            required=["sql"],
        ),
    )
])


def _enforce_plant_scope_in_sql(sql: str, allowed_plants: list[str]) -> str:
    """Rewrite SQL to hard-enforce plant scope by injecting plant IN (...) into
    the outermost WHERE clause (or prepending one when none exists).

    Works by tracking parenthesis depth to find WHERE / GROUP BY / ORDER BY
    at nesting level 0 — so CTE inner WHERE clauses are left untouched.

    If the AI already wrote `WHERE plant = '1100'` and the user is only allowed
    ['1101'], the result becomes `WHERE plant IN ('1101') AND (plant = '1100')`
    which evaluates to 0 rows — the AI gets no data and must tell the user it
    cannot access that plant.
    """
    if not allowed_plants:
        return "SELECT 'NO_ACCESS' AS _scope_error LIMIT 0"  # Zero rows

    plant_in = "plant IN (" + ", ".join(f"'{p}'" for p in allowed_plants) + ")"

    # Find outermost (depth-0) WHERE / GROUP BY / ORDER BY / HAVING / LIMIT
    # by scanning character-by-character and tracking paren depth.
    sql_upper = sql.upper()
    depth = 0
    last_where_at_depth0 = -1

    i = 0
    while i < len(sql):
        c = sql[i]
        if c in ("'", '"'):
            # Skip string literals so we don't accidentally match WHERE inside them
            q = c
            i += 1
            while i < len(sql) and sql[i] != q:
                if sql[i] == '\\':
                    i += 1
                i += 1
        elif c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif depth == 0:
            # Check for keyword at this position (preceded by non-alnum)
            for kw in ("WHERE",):
                klen = len(kw)
                if sql_upper[i:i+klen] == kw:
                    before_ok = (i == 0 or not sql[i-1].isalnum() and sql[i-1] != '_')
                    after_ok  = (i+klen >= len(sql) or not sql[i+klen].isalnum() and sql[i+klen] != '_')
                    if before_ok and after_ok:
                        last_where_at_depth0 = i
        i += 1

    if last_where_at_depth0 >= 0:
        # Inject right after WHERE keyword, wrapping existing condition in parens
        insert_at = last_where_at_depth0 + len("WHERE")
        return (sql[:insert_at]
                + f" {plant_in} AND ("
                + sql[insert_at:].lstrip()
                + ")")

    # No outermost WHERE found — inject before GROUP BY / ORDER BY / LIMIT / HAVING
    # or at the very end.
    for kw in ("GROUP BY", "ORDER BY", "HAVING", "LIMIT"):
        depth = 0
        klen = len(kw)
        for j in range(len(sql) - klen + 1):
            c = sql[j]
            if c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
            if depth == 0 and sql_upper[j:j+klen] == kw:
                before_ok = (j == 0 or not sql[j-1].isalnum() and sql[j-1] != '_')
                after_ok  = (j+klen >= len(sql) or not sql[j+klen].isalnum() and sql[j+klen] != '_')
                if before_ok and after_ok:
                    return sql[:j] + f"WHERE {plant_in}\n" + sql[j:]

    # Fallback: append at end
    return sql.rstrip().rstrip(";") + f"\nWHERE {plant_in}"


def _execute_chat_sql(sql: str, plant_scope: list[str] | None = None) -> str:
    """Execute a SQL query from the chat tool and return formatted results.

    plant_scope:
      None  — no restriction (admin or unrestricted user)
      []    — user has no plants assigned → deny all plant data
      [...] — restrict to these plant IDs (injected into SQL before execution)
    """
    from bigquery_client import run_query
    sql_stripped = (sql or "").strip()
    if not sql_stripped:
        print("[CHAT-SQL] ERROR: empty sql argument received from model")
        return (
            "ERROR: Your run_sql call had an empty `sql` argument. "
            "Re-invoke run_sql now with a complete SELECT or WITH query in the `sql` field — "
            "for example, for the user's question, write a single SQL string targeting "
            "`sfml-491907.sap_hana_mirror.fact_material_stock_daily` (for opening/closing balance) "
            "and/or `sfml-491907.sap_hana_mirror.fact_material_movements_daily` (for "
            "receipts/issues/adjustments). Remember to zero-pad the material_id to 18 chars "
            "or use LTRIM(material_id,'0') = LTRIM('<user_input>','0')."
        )
    # Safety: SELECT only
    upper = sql_stripped.upper()
    if not upper.lstrip("(").startswith(("SELECT", "WITH")):
        return "Error: only SELECT / WITH queries allowed."
    forbidden = ["DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "CREATE", "TRUNCATE", "MERGE"]
    if any(f" {f} " in f" {upper} " for f in forbidden):
        return "Error: DDL/DML operations are not allowed."

    # ── Hard-enforce plant scope ──────────────────────────────────────────────
    if plant_scope is not None:
        if not plant_scope:
            return (
                "SCOPE RESTRICTION: This user has no plants assigned. "
                "You cannot return any plant-level inventory or movement data. "
                "Inform the user they need an admin to assign plant access."
            )
        sql_stripped = _enforce_plant_scope_in_sql(sql_stripped, plant_scope)
        print(f"[CHAT-SQL] Plant scope enforced: allowed={plant_scope}")
    # ─────────────────────────────────────────────────────────────────────────

    print(f"[CHAT-SQL] Running: {sql_stripped[:200]}")
    result = run_query(sql_stripped, max_rows=500)
    if "error" in result:
        return f"Query error: {result['error']}"
    if not result.get("rows"):
        return "Query returned 0 rows."
    header = " | ".join(result["columns"])
    rows_text = "\n".join(
        " | ".join(str(row.get(c, "")) for c in result["columns"])
        for row in result["rows"][:100]
    )
    total = result.get("total_rows", len(result["rows"]))
    return f"Query returned {total} rows (showing up to 100):\n{header}\n{rows_text}"


@app.post("/api/chat")
def chat(body: ChatRequest, request: Request, user: dict = Depends(get_current_user)):
    client = get_genai_client()
    uid = int(user["sub"])
    opted_out = _ai_opt_out(uid)

    # PII-redact the user's message + history before they ride along to a
    # third-party LLM. Best-effort: strips emails, phone numbers, CNICs,
    # long bare digit runs. The user's prompt back to Gemini is the redacted
    # version; we keep the original for our own audit trail only.
    safe_message = _redact_pii(body.message)
    safe_history = _redact_history_pii([{"role": m.role, "text": m.text} for m in body.history])

    # Fetch relevant BigQuery data unless the user opted out of AI data flow.
    # When opted out, prompts go to Gemini with no business data attached.
    bq_context = ""
    if not body.voice_mode and not opted_out:
        try:
            bq_context = find_relevant_data(body.message)
            if bq_context:
                print(f"[BQ] Found relevant data for: {body.message[:50]}...")
        except Exception as e:
            print(f"[BQ] Error fetching data: {e}")

    audit_log.record(
        user=user, request=request,
        action="ai.chat", resource_type="ai", resource_id=None,
        detail={"voice_mode": body.voice_mode, "ai_opt_out": opted_out,
                "history_len": len(body.history), "ctx_injected": bool(bq_context)},
    )

    # Build conversation history for Gemini — using the PII-redacted history
    # so prior turns don't leak personal data backward through the same chat.
    contents = []
    for msg in safe_history:
        contents.append(genai.types.Content(
            role="user" if msg["role"] == "user" else "model",
            parts=[genai.types.Part(text=msg["text"])],
        ))
    # Add the new user message — with BigQuery data context if available.
    # Uses the redacted message so PII in the current turn is also stripped.
    user_message = safe_message
    if bq_context:
        user_message = (
            f"{safe_message}\n\n{bq_context}\n\n"
            f"CRITICAL INSTRUCTIONS FOR YOUR RESPONSE:\n"
            f"1. YOU HAVE FULL BIGQUERY ACCESS via the run_sql tool. Any question about the SAP ERP mirror CAN be answered.\n"
            f"2. FORBIDDEN RESPONSES: 'I don't have that data', 'I cannot provide', 'I do not have a breakdown', 'the data is not available', 'not in the current data'. These are ALL WRONG — if the injected summary doesn't have it, YOU CAN STILL GET IT by calling run_sql.\n"
            f"3. Decision flow:\n"
            f"   a) If injected data has the exact answer → respond directly.\n"
            f"   b) If injected data does NOT have the exact answer → call run_sql tool IMMEDIATELY. No text announcement.\n"
            f"4. NEVER respond with text like 'let me query', 'here is the SQL', 'I need to query'. JUST INVOKE THE TOOL.\n"
            f"5. Only after tool returns results, respond with the actual numbers.\n"
            f"6. If your first tool call returns 0 rows, RETRY immediately with relaxed filters. The MOST common cause of 0 rows is a wrong user-supplied secondary filter (material_type, order_type, valuation_class, sloc, etc.) — DROP that secondary filter and re-run with only the essential identifiers (material_id zero-padded + plant + date). Users frequently paste approximate or stale type codes (e.g. '2607' when the real material_type is 'Z607'). NEVER conclude 'no data' / 'I couldn't find' after a single 0-row attempt. After dropping a filter, if the row exists you MUST present the numbers and explicitly note in plain language WHICH filter you ignored and what the actual stored value was, so the user can confirm. Only say 'no data' after you've tried at least: (a) the full filter set, (b) without material_type/secondary type filter, (c) without the date range (any-date)."
        )
    contents.append(genai.types.Content(
        role="user",
        parts=[genai.types.Part(text=user_message)],
    ))

    # Inject plant-scope restriction into the system prompt AND enforce it at
    # the SQL execution layer so the AI cannot bypass it by generating SQL that
    # explicitly filters to an unauthorized plant.
    scope_addon = ""
    chat_plant_scope: list[str] | None = None  # None = unrestricted
    if (user.get("role") or "").lower() != "admin":
        chat_plant_scope = _get_user_plant_scope(uid)
        if chat_plant_scope is not None:
            if chat_plant_scope:
                plant_list = ", ".join(f"'{p}'" for p in chat_plant_scope)
                scope_addon = (
                    f"\n\n--- USER PLANT SCOPE RESTRICTION ---\n"
                    f"This user is restricted to plant(s): {', '.join(chat_plant_scope)}.\n"
                    f"ALWAYS add AND plant IN ({plant_list}) (or AND plant_id IN ({plant_list})) "
                    f"to every SQL query that touches a plant-scoped table. "
                    f"NEVER return data for plants outside this list.\n"
                    f"--- END SCOPE RESTRICTION ---"
                )
            else:
                scope_addon = (
                    "\n\n--- USER PLANT SCOPE RESTRICTION ---\n"
                    "This user has no plants assigned in their scope — return no plant data. "
                    "State that they do not have data access configured yet.\n"
                    "--- END SCOPE RESTRICTION ---"
                )

    system_prompt_final = (VOICE_SYSTEM_PROMPT_URDU if body.voice_mode else SYSTEM_PROMPT) + _build_date_context() + scope_addon

    try:
        # Voice mode stays simple (no tools) — the voice WS has its own tool path
        if body.voice_mode:
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=contents,
                config=genai.types.GenerateContentConfig(
                    system_instruction=system_prompt_final,
                    temperature=0.7,
                    max_output_tokens=512,
                ),
            )
            reply = response.text or "I wasn't able to generate a response. Please try again."
            return {"reply": reply}

        # Text chat: allow up to 5 rounds of run_sql tool calls before finalizing
        # (extra rounds let the model retry with relaxed filters when first SQL returns 0 rows)
        MAX_ROUNDS = 5
        for round_num in range(MAX_ROUNDS):
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=contents,
                config=genai.types.GenerateContentConfig(
                    system_instruction=system_prompt_final,
                    temperature=0.7,
                    max_output_tokens=1024,
                    tools=[_CHAT_SQL_TOOL],
                ),
            )

            # Check for function calls
            fcs = []
            try:
                cand = response.candidates[0] if response.candidates else None
                if cand and cand.content and cand.content.parts:
                    for p in cand.content.parts:
                        if hasattr(p, "function_call") and p.function_call and p.function_call.name:
                            fcs.append(p.function_call)
            except Exception:
                pass

            if not fcs:
                reply = response.text or "I wasn't able to generate a response. Please try again."
                # Detect stalling: AI said "let me query" but didn't call the tool
                stall_phrases = ["please allow me", "please wait", "let me query", "let me retrieve",
                                 "let me check", "i'll query", "i will query", "need to query",
                                 "retrieve this information", "a moment to", "allow me a moment",
                                 "i need to retrieve", "i need to fetch", "here is the bigquery",
                                 "here is the sql", "here's the sql", "here is the query",
                                 "here's the query", "following sql", "this sql query",
                                 "calling sql tool", "calling the sql tool", "calling run_sql",
                                 "to get", "to retrieve", "can help you with that",
                                 # Refusal patterns that should trigger a tool call instead
                                 "i don't have", "i do not have", "cannot provide", "can not provide",
                                 "not available in", "not in the current data", "not included in",
                                 "i cannot give", "i cannot provide", "data does not include",
                                 "data doesn't include", "data doesn't contain", "data does not contain",
                                 "not in the provided", "isn't in the", "is not available"]
                # Detect SQL-in-text. The model often gets cut off mid-SQL by max_output_tokens —
                # in that case the opening ```sql fence has no closing fence, and a raw SELECT may
                # have no FROM yet. Treat ANY of these as "model leaked SQL, recover".
                has_sql_fence_open = "```sql" in reply.lower()
                has_raw_sql_full = bool(re.search(r"\b(SELECT|WITH)\s+[\s\S]+?\s+FROM\s+", reply, re.IGNORECASE))
                has_with_clause  = bool(re.search(r"\bWITH\s+\w+\s+AS\s*\(", reply, re.IGNORECASE))
                wrote_sql_in_text = has_sql_fence_open or has_raw_sql_full or has_with_clause
                has_stall = any(p in reply.lower() for p in stall_phrases)
                # ALWAYS try to recover if SQL leaked OR the model stalled. Never return raw SQL/preamble to the user.
                if wrote_sql_in_text or has_stall:
                    print(f"[CHAT] Detected stall/SQL-as-text — recovering. round={round_num+1}")
                    # Try to extract a complete fenced block first. If the model got cut off, the
                    # closing fence will be missing — fall through to a "from opening fence to EOF" grab.
                    extracted_sql = None
                    full_fence = re.search(r"```(?:sql)?\s*([\s\S]+?)\s*```", reply, re.IGNORECASE)
                    if full_fence:
                        extracted_sql = full_fence.group(1).strip()
                    elif has_sql_fence_open:
                        open_fence = re.search(r"```(?:sql)?\s*([\s\S]+)$", reply, re.IGNORECASE)
                        if open_fence:
                            extracted_sql = open_fence.group(1).strip().rstrip("`")
                    if not extracted_sql:
                        sel_match = re.search(r"((?:WITH|SELECT)\s[\s\S]+?);?\s*$", reply, re.IGNORECASE | re.MULTILINE)
                        if sel_match:
                            extracted_sql = sel_match.group(1).strip()
                    # Only execute if the SQL looks complete enough (has both SELECT and FROM).
                    sql_is_runnable = bool(extracted_sql and re.search(r"\bSELECT\b[\s\S]+?\bFROM\b", extracted_sql, re.IGNORECASE))
                    if sql_is_runnable:
                        print(f"[CHAT] Auto-executing extracted SQL (len={len(extracted_sql)})")
                        result_text = _execute_chat_sql(extracted_sql, plant_scope=chat_plant_scope)
                        contents.append(genai.types.Content(
                            role="model",
                            parts=[genai.types.Part(text=reply)],
                        ))
                        contents.append(genai.types.Content(
                            role="user",
                            parts=[genai.types.Part(text=f"[SQL was auto-executed on your behalf]\nResult:\n{result_text}\n\nNow answer the user's original question directly using this result. Do NOT write SQL or announce further queries — just state the answer in plain language.")],
                        ))
                    else:
                        # Truncated / incomplete SQL — re-prompt without showing the bad reply to the user.
                        # Don't echo the truncated reply; just tell the model to retry via the tool.
                        print(f"[CHAT] SQL incomplete or absent — re-prompting (extracted_len={len(extracted_sql or '')})")
                        contents.append(genai.types.Content(
                            role="model",
                            parts=[genai.types.Part(text="(internal: previous draft truncated)")],
                        ))
                        contents.append(genai.types.Content(
                            role="user",
                            parts=[genai.types.Part(text=(
                                "Your previous response started writing SQL as text and got cut off. "
                                "Do NOT write SQL in the chat. INVOKE the `run_sql` function/tool with a single, complete "
                                "SQL SELECT/WITH query. Keep the SQL compact and directly answer the user's question. "
                                "After the tool returns, respond in plain prose with the numbers — never include the SQL itself."
                            ))],
                        ))
                    continue
                return {"reply": reply}

            # Execute each function call and append results
            contents.append(response.candidates[0].content)
            fr_parts = []
            for fc in fcs:
                args = dict(fc.args) if fc.args else {}
                if fc.name == "run_sql":
                    sql = args.get("sql", "")
                    if not (sql or "").strip():
                        print(f"[CHAT] round {round_num+1} — run_sql with EMPTY sql; full args keys={list(args.keys())} repr={repr(args)[:300]}")
                    else:
                        print(f"[CHAT] round {round_num+1} — run_sql ({len(sql)} chars)")
                    result_text = _execute_chat_sql(sql, plant_scope=chat_plant_scope)
                else:
                    result_text = f"Unknown function: {fc.name}"
                fr_parts.append(genai.types.Part.from_function_response(
                    name=fc.name,
                    response={"result": result_text},
                ))
            contents.append(genai.types.Content(role="user", parts=fr_parts))

        # Fallback after MAX_ROUNDS — force a text response without tools.
        # Inject an explicit "give your best answer with what you have" prompt so
        # the model doesn't return empty text after exhausting tool rounds.
        contents.append(genai.types.Content(
            role="user",
            parts=[genai.types.Part(text=(
                "Tool rounds exhausted. Using whatever data you've already retrieved (or "
                "noting which filters returned 0 rows), give the user a direct answer in "
                "plain language NOW. If a filter consistently returned 0 rows, present the "
                "numbers from your most recent successful query and explicitly note which "
                "user-supplied filter you ignored and what the actual stored value is. "
                "DO NOT respond with 'I couldn't find' / 'no data' if any earlier query "
                "returned rows for the material at all."
            ))],
        ))
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents,
            config=genai.types.GenerateContentConfig(
                system_instruction=system_prompt_final,
                temperature=0.5,
                max_output_tokens=1024,
                # Cap thinking so a complex post-rounds compose still has output budget
                # left for the actual answer — but allow some reasoning.
                thinking_config=genai.types.ThinkingConfig(thinking_budget=1024),
            ),
        )
        reply = response.text or "I wasn't able to generate a response. Please try again."
        # Last-ditch: if the final response contains SQL, extract and execute it
        sql_match = re.search(r"```(?:sql)?\s*([\s\S]+?)\s*```", reply, re.IGNORECASE)
        extracted_sql = sql_match.group(1).strip() if sql_match else None
        if not extracted_sql:
            sel_match = re.search(r"((?:WITH|SELECT)\s[\s\S]+?)(?:;|\Z)", reply, re.IGNORECASE | re.MULTILINE)
            if sel_match:
                extracted_sql = sel_match.group(1).strip()
        if extracted_sql:
            print(f"[CHAT] Fallback: executing SQL extracted from final response")
            result_text = _execute_chat_sql(extracted_sql, plant_scope=chat_plant_scope)
            # Summarize the result using Gemini (no tools)
            summary_contents = [genai.types.Content(
                role="user",
                parts=[genai.types.Part(text=f"User asked: {body.message}\n\nI ran this SQL and got these results:\n{result_text}\n\nGive a direct, concise answer to the user's question using these numbers. Do NOT mention SQL or announce anything.")],
            )]
            summary_response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=summary_contents,
                config=genai.types.GenerateContentConfig(
                    system_instruction=system_prompt_final,
                    temperature=0.7,
                    max_output_tokens=1024,
                ),
            )
            reply = summary_response.text or reply
        return {"reply": reply}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Gemini API error: {str(e)}")


@app.post("/api/chat/stream")
def chat_stream(body: ChatRequest, user: dict = Depends(get_current_user)):
    client = get_genai_client()

    # Fetch relevant BigQuery data
    bq_context = ""
    try:
        bq_context = find_relevant_data(body.message)
        if bq_context:
            print(f"[BQ] Found relevant data for stream: {body.message[:50]}...")
    except Exception as e:
        print(f"[BQ] Error fetching data: {e}")

    contents = []
    for msg in body.history:
        contents.append(genai.types.Content(
            role="user" if msg.role == "user" else "model",
            parts=[genai.types.Part(text=msg.text)],
        ))
    if bq_context:
        user_message = (
            f"{body.message}\n\n{bq_context}\n\n"
            f"CRITICAL INSTRUCTIONS:\n"
            f"1. You have the run_sql tool — use it if the injected data doesn't have the exact answer.\n"
            f"2. FORBIDDEN: 'I don't have', 'I cannot provide', 'let me query', 'here is the SQL'. Just CALL the tool.\n"
            f"3. Match dealer/product names flexibly using LIKE.\n"
            f"4. If your SQL returns 0 rows, RETRY immediately with relaxed filters. The MOST common cause is a wrong user-supplied secondary filter (material_type, order_type, valuation_class, sloc, etc.) — DROP that secondary filter and re-run with only the essential identifiers (material_id zero-padded + plant + date). Users frequently paste approximate or stale type codes (e.g. '2607' when the real material_type is 'Z607'). NEVER conclude 'no data' / 'I couldn't find' after a single 0-row attempt. After dropping a filter, if the row exists you MUST present the numbers and explicitly note in plain language WHICH filter you ignored and what the actual stored value is, so the user can confirm. If you mention in your text that another value (e.g. 'Z607') is likely correct, you MUST first call run_sql with that value and present the result — never just speculate without retrying.\n"
            f"5. Material IDs are 18-char zero-padded — match with `LTRIM(material_id,'0') = LTRIM('<user_input>','0')`.\n"
        )
    else:
        user_message = body.message
    contents.append(genai.types.Content(
        role="user",
        parts=[genai.types.Part(text=user_message)],
    ))

    # Plant scope — same enforcement as /api/chat
    uid_stream = int(user["sub"])
    chat_plant_scope: list[str] | None = None
    scope_addon_stream = ""
    if (user.get("role") or "").lower() != "admin":
        chat_plant_scope = _get_user_plant_scope(uid_stream)
        if chat_plant_scope is not None:
            if chat_plant_scope:
                plant_list = ", ".join(f"'{p}'" for p in chat_plant_scope)
                scope_addon_stream = (
                    f"\n\n--- USER PLANT SCOPE RESTRICTION ---\n"
                    f"This user is restricted to plant(s): {', '.join(chat_plant_scope)}.\n"
                    f"Every SQL query you write MUST include AND plant IN ({plant_list}). "
                    f"NEVER return data for plants outside this list.\n"
                    f"--- END SCOPE RESTRICTION ---"
                )
            else:
                scope_addon_stream = (
                    "\n\n--- USER PLANT SCOPE RESTRICTION ---\n"
                    "This user has no plants assigned — return no plant data.\n"
                    "--- END SCOPE RESTRICTION ---"
                )

    system_prompt_final = SYSTEM_PROMPT + _build_date_context() + scope_addon_stream

    def generate():
        try:
            # First, resolve any tool calls non-streaming (up to 5 rounds)
            local_contents = list(contents)
            MAX_ROUNDS = 5
            tool_resolved = False
            for round_num in range(MAX_ROUNDS):
                resp = client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=local_contents,
                    config=genai.types.GenerateContentConfig(
                        system_instruction=system_prompt_final,
                        temperature=0.7,
                        max_output_tokens=1024,
                        tools=[_CHAT_SQL_TOOL],
                    ),
                )
                fcs = []
                try:
                    cand = resp.candidates[0] if resp.candidates else None
                    if cand and cand.content and cand.content.parts:
                        for p in cand.content.parts:
                            if hasattr(p, "function_call") and p.function_call and p.function_call.name:
                                fcs.append(p.function_call)
                except Exception:
                    pass

                if not fcs:
                    # Check for stall / SQL-in-text. Truncated SQL (cut off by max_output_tokens)
                    # leaves an opening ```sql fence with no close — treat as "model leaked SQL".
                    reply_txt = resp.text or ""
                    stall_phrases = ["i don't have", "i do not have", "cannot provide", "let me query",
                                     "here is the sql", "here's the sql", "need to query",
                                     "calling sql tool", "calling the sql tool", "calling run_sql",
                                     "not available in", "data does not", "data doesn't",
                                     "let me retrieve", "allow me a moment", "i need to retrieve"]
                    has_sql_fence_open = "```sql" in reply_txt.lower()
                    has_raw_sql_full = bool(re.search(r"\b(SELECT|WITH)\s+[\s\S]+?\s+FROM\s+", reply_txt, re.IGNORECASE))
                    has_with_clause  = bool(re.search(r"\bWITH\s+\w+\s+AS\s*\(", reply_txt, re.IGNORECASE))
                    has_stall = any(p in reply_txt.lower() for p in stall_phrases)
                    leaked_sql_or_stall = has_sql_fence_open or has_raw_sql_full or has_with_clause or has_stall
                    if leaked_sql_or_stall and round_num < MAX_ROUNDS - 1:
                        # Try fenced first, then opening-fence-to-EOF, then raw WITH/SELECT.
                        extracted = None
                        full_fence = re.search(r"```(?:sql)?\s*([\s\S]+?)\s*```", reply_txt, re.IGNORECASE)
                        if full_fence:
                            extracted = full_fence.group(1).strip()
                        elif has_sql_fence_open:
                            open_fence = re.search(r"```(?:sql)?\s*([\s\S]+)$", reply_txt, re.IGNORECASE)
                            if open_fence:
                                extracted = open_fence.group(1).strip().rstrip("`")
                        if not extracted:
                            sel_match = re.search(r"((?:WITH|SELECT)\s[\s\S]+?)(?:;|\Z)", reply_txt, re.IGNORECASE | re.MULTILINE)
                            if sel_match:
                                extracted = sel_match.group(1).strip()
                        sql_is_runnable = bool(extracted and re.search(r"\bSELECT\b[\s\S]+?\bFROM\b", extracted, re.IGNORECASE))
                        if sql_is_runnable:
                            local_contents.append(genai.types.Content(role="model", parts=[genai.types.Part(text=reply_txt)]))
                            result_text = _execute_chat_sql(extracted, plant_scope=chat_plant_scope)
                            local_contents.append(genai.types.Content(
                                role="user",
                                parts=[genai.types.Part(text=f"[SQL auto-executed]\nResult:\n{result_text}\n\nNow give a direct answer in plain language. No SQL, no announcements.")],
                            ))
                        else:
                            # Truncated SQL or no SQL — re-prompt without echoing the bad reply.
                            local_contents.append(genai.types.Content(role="model", parts=[genai.types.Part(text="(internal: previous draft truncated)")]))
                            local_contents.append(genai.types.Content(
                                role="user",
                                parts=[genai.types.Part(text=(
                                    "Your previous response started writing SQL as text and got cut off. "
                                    "Do NOT write SQL in the chat. INVOKE the run_sql tool with a single, complete "
                                    "SELECT/WITH query. After the tool returns, respond in plain prose — never include the SQL."
                                ))],
                            ))
                        continue
                    # Done — break and stream this reply
                    tool_resolved = True
                    break

                # Execute tool calls
                local_contents.append(resp.candidates[0].content)
                fr_parts = []
                for fc in fcs:
                    args = dict(fc.args) if fc.args else {}
                    if fc.name == "run_sql":
                        sql_arg = args.get("sql", "")
                        if not (sql_arg or "").strip():
                            print(f"[CHAT-STREAM] round {round_num+1} — run_sql with EMPTY sql; full args keys={list(args.keys())} repr={repr(args)[:300]}")
                        else:
                            print(f"[CHAT-STREAM] round {round_num+1} — run_sql ({len(sql_arg)} chars)")
                        result_text = _execute_chat_sql(sql_arg, plant_scope=chat_plant_scope)
                    else:
                        result_text = f"Unknown function: {fc.name}"
                    fr_parts.append(genai.types.Part.from_function_response(
                        name=fc.name, response={"result": result_text},
                    ))
                local_contents.append(genai.types.Content(role="user", parts=fr_parts))
                tool_resolved = True

            # Inject an explicit "give your best answer now" instruction so the model
            # doesn't return empty text after exhausting tool rounds.
            local_contents.append(genai.types.Content(
                role="user",
                parts=[genai.types.Part(text=(
                    "Tool rounds finished. Using whatever data you've already retrieved "
                    "from the run_sql results above, give the user a direct, complete "
                    "answer in plain language NOW. Format with bold/bullets as needed. "
                    "If a filter consistently returned 0 rows, present the numbers from "
                    "your most recent successful query and explicitly note in plain "
                    "language which user-supplied filter you ignored and what the actual "
                    "stored value is. DO NOT respond with 'I couldn't find' / 'no data' "
                    "if any earlier query returned rows for the material/plant at all."
                ))],
            ))

            # Now stream the final answer (no tools). Thinking stays ON here so the
            # model can reason about which numbers to surface and how to format them.
            streamed_any_text = False
            for chunk in client.models.generate_content_stream(
                model="gemini-2.5-flash",
                contents=local_contents,
                config=genai.types.GenerateContentConfig(
                    system_instruction=system_prompt_final,
                    temperature=0.5,
                    max_output_tokens=1024,
                ),
            ):
                if chunk.text:
                    streamed_any_text = True
                    yield f"data: {json.dumps({'text': chunk.text})}\n\n"

            # Last-resort fallback: streaming returned empty (model swallowed entire
            # output budget on thinking or hit context-length pressure). Retry with
            # thinking disabled so the model MUST emit visible text. This only runs
            # when the normal path with thinking already failed.
            if not streamed_any_text:
                print("[CHAT-STREAM] streaming yielded no text — running non-streaming fallback (thinking_budget=0)")
                fallback_resp = client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=local_contents,
                    config=genai.types.GenerateContentConfig(
                        system_instruction=system_prompt_final,
                        temperature=0.3,
                        max_output_tokens=1024,
                        thinking_config=genai.types.ThinkingConfig(thinking_budget=0),
                    ),
                )
                fallback_text = fallback_resp.text or (
                    "I retrieved data but wasn't able to compose a final answer. "
                    "Please retry your question, ideally without overly specific filters "
                    "(e.g. drop material_type if you're not sure of its exact code)."
                )
                yield f"data: {json.dumps({'text': fallback_text})}\n\n"

            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    # Save query to history in background
    try:
        db = get_db()
        cur = db.cursor()
        cur.execute(
            "INSERT INTO chat_history (user_id, query) VALUES (?, ?)",
            (int(user["sub"]), body.message),
        )
        db.commit()
        db.close()
    except Exception:
        pass

    return StreamingResponse(generate(), media_type="text/event-stream")


# ── Chat History ──
@app.get("/api/chat/history")
def get_chat_history(user: dict = Depends(get_current_user), limit: int = 20):
    """Get recent queries for the current user."""
    db = get_db()
    cur = db.cursor()
    cur.execute(
        """
        SELECT id, query, created_at
        FROM chat_history
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (int(user["sub"]), limit),
    )
    rows = cur.fetchall()
    db.close()

    return {
        "history": [
            {"id": r["id"], "query": r["query"], "time": r["created_at"]}
            for r in rows
        ]
    }


@app.get("/api/tables")
def list_tables():
    """List all BigQuery tables available to Satori."""
    tables = discover_tables()
    return {"tables": tables}


# ── TMC Satori Dataset API (Workforce + Sales analytics) ──
from bigquery_client import run_query as bq_run_query

_TMC_PROJECT = os.environ.get("VERTEX_PROJECT", "ai-vertex-mahad")
_TMC_DATASET_NAME = os.environ.get("VERTEX_DATASET", "Satori_Project")
_TMC_DATASET = f"`{_TMC_PROJECT}.{_TMC_DATASET_NAME}`"

# Aliases — the rest of main.py still refers to these legacy variable names.
_SAP_PROJECT = _TMC_PROJECT
_SAP_DATASET = _TMC_DATASET
# Active-employees filter (TMC equivalent of the old "active plants" exclusion).
_ACTIVE_EMP_SQL = (
    f"(SELECT CAST(Employee_Code AS STRING) AS emp_id FROM {_TMC_DATASET}.Employee_Data "
    f"WHERE LOWER(COALESCE(Employee_Type, '')) IN ('mto', 'permanent', 'probation'))"
)


def _sap_query(sql, max_rows=10000):
    """Run a read-only TMC-warehouse query via the BigQuery client. Function name retained as
    `_sap_query` so existing callers don't need touching; in this codebase it now runs against
    the TMC `Satori_Project` dataset.
    """
    from bigquery_client import get_bq_client
    client = get_bq_client()
    try:
        rows = []
        for i, row in enumerate(client.query(sql).result()):
            if i >= max_rows:
                break
            rows.append(dict(row))
        return rows
    except Exception as e:
        print(f"[TMC] Query error: {e}")
        return []


# ═══════════════════════════════════════════════════════════════════════════════
#  TMC DATA ENDPOINTS  ──  Replace the legacy SAP AR/AP/Stock/Invoices dashboards.
#  Each endpoint preserves the JSON shape (summary / data / top_X / qty_by_plant)
#  expected by the existing frontend, while serving real TMC workforce + sales data.
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/ar/data")
def attendance_overview_data(user: dict = Depends(get_current_user)):
    """Attendance overview — replaces the legacy AR dashboard with workforce data."""
    summary_sql = f"""
    SELECT
      COUNT(*) AS total_orders,
      COUNT(DISTINCT attendance_status_text) AS unique_order_types,
      (SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(Employee_Hierarchy),''), 'Unspecified'))
         FROM {_TMC_DATASET}.Employee_Data) AS unique_plants,
      (SELECT COUNT(DISTINCT Employee_Position)
         FROM {_TMC_DATASET}.Employee_Data) AS unique_profit_centers
    FROM {_TMC_DATASET}.Attendance_Data
    WHERE attendance_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
    """
    summary = (_sap_query(summary_sql, max_rows=1) or [{}])[0]

    top_depts_sql = f"""
    SELECT
      COALESCE(NULLIF(TRIM(e.Employee_Hierarchy),''), 'Unspecified') AS dealer_name,
      COALESCE(NULLIF(TRIM(e.Employee_Hierarchy),''), 'Unspecified') AS dealer_code,
      COUNT(*) AS amount,
      COUNT(*) AS qty
    FROM {_TMC_DATASET}.Attendance_Data a
    LEFT JOIN {_TMC_DATASET}.Employee_Data e
      ON CAST(e.Employee_Code AS STRING) = CAST(a.employee_id AS STRING)
    WHERE a.is_present = 1
      AND a.attendance_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
    GROUP BY dealer_name
    ORDER BY qty DESC LIMIT 10
    """
    top_depts = _sap_query(top_depts_sql, max_rows=10)

    qty_by_dept_sql = f"""
    SELECT
      COALESCE(NULLIF(TRIM(e.Employee_Hierarchy),''), 'Unspecified') AS name,
      SUM(a.is_present) AS qty
    FROM {_TMC_DATASET}.Attendance_Data a
    LEFT JOIN {_TMC_DATASET}.Employee_Data e
      ON CAST(e.Employee_Code AS STRING) = CAST(a.employee_id AS STRING)
    WHERE a.attendance_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
    GROUP BY name ORDER BY qty DESC
    """
    qty_by_dept = _sap_query(qty_by_dept_sql, max_rows=50)

    stacked_sql = f"""
    SELECT
      COALESCE(NULLIF(TRIM(e.Employee_Hierarchy),''), 'Unspecified') AS dealer_name,
      a.attendance_status_text AS product,
      COUNT(*) AS qty
    FROM {_TMC_DATASET}.Attendance_Data a
    LEFT JOIN {_TMC_DATASET}.Employee_Data e
      ON CAST(e.Employee_Code AS STRING) = CAST(a.employee_id AS STRING)
    WHERE a.attendance_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
      AND a.attendance_status_text IS NOT NULL
    GROUP BY dealer_name, product
    ORDER BY dealer_name, qty DESC
    """
    stacked = _sap_query(stacked_sql, max_rows=500)

    data_sql = f"""
    SELECT
      CAST(a.employee_id AS STRING)              AS order_no,
      a.attendance_status_text                   AS product,
      CAST(a.employee_id AS STRING)              AS dealer_code,
      a.employee_name                            AS dealer_name,
      COALESCE(NULLIF(TRIM(e.Employee_Hierarchy),''), 'Unspecified') AS plant_name,
      a.attendance_status_text                   AS short_text,
      a.attendance_date                          AS shipment_date,
      CAST(a.is_present AS FLOAT64)              AS qty,
      CAST(NULL AS FLOAT64)                      AS amount,
      e.Employee_Location                        AS zone,
      e.Employee_Hierarchy                       AS region,
      e.Employee_Position                        AS district
    FROM {_TMC_DATASET}.Attendance_Data a
    LEFT JOIN {_TMC_DATASET}.Employee_Data e
      ON CAST(e.Employee_Code AS STRING) = CAST(a.employee_id AS STRING)
    WHERE a.attendance_date IS NOT NULL
    ORDER BY a.attendance_date DESC LIMIT 2000
    """
    return {
        "data": _sap_query(data_sql),
        "summary": summary,
        "top_dealers": top_depts,
        "qty_by_plant": qty_by_dept,
        "stacked": stacked,
    }


@app.get("/api/ap/data")
def availability_overview_data(user: dict = Depends(get_current_user)):
    """Availability Engine — workforce capacity replacing legacy AP dashboard."""
    summary_sql = f"""
    WITH latest_alloc AS (
      SELECT
        CAST(employee_id AS STRING) AS emp_id,
        MAX(SAFE_CAST(allocation_percent AS FLOAT64)) AS max_pct
      FROM {_TMC_DATASET}.Allocation_data
      WHERE Flag IN ('Actual','Forecast')
      GROUP BY emp_id
    )
    SELECT
      (SELECT COUNT(*) FROM {_TMC_DATASET}.Employee_Data
         WHERE LOWER(COALESCE(Employee_Type,'')) IN ('mto','permanent','probation')) AS total_orders,
      COUNTIF(max_pct >= 90)              AS unique_dealers,
      COUNTIF(max_pct BETWEEN 1 AND 89)   AS total_products,
      COUNTIF(COALESCE(max_pct, 0) = 0)   AS total_qty,
      (SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(Employee_Hierarchy),''), 'Unspecified'))
         FROM {_TMC_DATASET}.Employee_Data) AS unique_plants
    FROM latest_alloc
    """
    summary = (_sap_query(summary_sql, max_rows=1) or [{}])[0]

    top_skills_sql = f"""
    SELECT emp_competency AS product,
           COUNT(DISTINCT employee_id) AS qty,
           COUNT(DISTINCT employee_id) AS amount
    FROM {_TMC_DATASET}.Allocation_data
    WHERE emp_competency IS NOT NULL AND TRIM(emp_competency) <> ''
    GROUP BY emp_competency
    ORDER BY qty DESC LIMIT 10
    """
    top_skills = _sap_query(top_skills_sql, max_rows=10)

    qty_by_dept_sql = f"""
    SELECT
      COALESCE(NULLIF(TRIM(e.Employee_Hierarchy),''), 'Unspecified') AS name,
      ROUND(AVG(SAFE_CAST(a.allocation_percent AS FLOAT64)), 1) AS qty
    FROM {_TMC_DATASET}.Allocation_data a
    LEFT JOIN {_TMC_DATASET}.Employee_Data e
      ON CAST(e.Employee_Code AS STRING) = CAST(a.employee_id AS STRING)
    WHERE a.Flag = 'Actual'
    GROUP BY name ORDER BY qty DESC
    """
    qty_by_dept = _sap_query(qty_by_dept_sql, max_rows=50)

    data_sql = f"""
    WITH latest_alloc AS (
      SELECT
        CAST(employee_id AS STRING) AS emp_id,
        ROUND(AVG(SAFE_CAST(allocation_percent AS FLOAT64)), 1) AS avg_pct,
        MAX(SAFE_CAST(allocation_percent AS FLOAT64)) AS max_pct
      FROM {_TMC_DATASET}.Allocation_data
      WHERE Flag IN ('Actual','Forecast')
      GROUP BY emp_id
    )
    SELECT
      l.emp_id                                                              AS order_no,
      e.Employee_Position                                                   AS product,
      l.emp_id                                                              AS dealer_code,
      e.Resource_Name                                                       AS dealer_name,
      COALESCE(NULLIF(TRIM(e.Employee_Hierarchy),''), 'Unspecified')        AS plant_name,
      CASE
        WHEN l.max_pct >= 90              THEN 'Allocated'
        WHEN l.max_pct BETWEEN 1 AND 89   THEN 'Partial'
        ELSE 'Bench' END                                                    AS dealer_code_status,
      e.Employee_Location                                                   AS zone,
      e.Employee_Hierarchy                                                  AS region,
      e.Employee_Position                                                   AS district,
      l.avg_pct                                                             AS qty,
      l.max_pct                                                             AS amount,
      CURRENT_DATE()                                                        AS shipment_date
    FROM latest_alloc l
    LEFT JOIN {_TMC_DATASET}.Employee_Data e
      ON CAST(e.Employee_Code AS STRING) = l.emp_id
    ORDER BY l.max_pct DESC NULLS LAST
    LIMIT 2000
    """
    return {
        "data": _sap_query(data_sql),
        "summary": summary,
        "top_products": top_skills,
        "qty_by_plant": qty_by_dept,
    }


@app.get("/api/stock/data")
def workforce_overview_data(user: dict = Depends(get_current_user)):
    """Workforce / Capability overview — replaces legacy stock dashboard."""
    summary_sql = f"""
    SELECT
      CURRENT_DATE()                                                              AS as_of_date,
      COUNT(*)                                                                    AS total_material_lines,
      COUNT(*)                                                                    AS unique_materials,
      COUNT(DISTINCT COALESCE(NULLIF(TRIM(Employee_Hierarchy),''), 'Unspecified')) AS unique_plants,
      CAST(COUNTIF(LOWER(COALESCE(Employee_Type,'')) IN ('mto','permanent','probation')) AS FLOAT64) AS total_qty,
      CAST(COUNT(DISTINCT Employee_Location) AS FLOAT64)                          AS total_value_local
    FROM {_TMC_DATASET}.Employee_Data
    """
    summary = (_sap_query(summary_sql, max_rows=1) or [{}])[0]

    by_dept_sql = f"""
    WITH alloc AS (
      SELECT CAST(employee_id AS STRING) AS emp_id,
             AVG(SAFE_CAST(allocation_percent AS FLOAT64)) AS avg_pct
      FROM {_TMC_DATASET}.Allocation_data
      WHERE Flag = 'Actual'
      GROUP BY emp_id
    )
    SELECT
      COALESCE(NULLIF(TRIM(e.Employee_Hierarchy),''), 'Unspecified') AS plant_id,
      COALESCE(NULLIF(TRIM(e.Employee_Hierarchy),''), 'Unspecified') AS plant_name,
      COUNT(*)                                                       AS unique_materials,
      CAST(COUNT(*) AS FLOAT64)                                      AS total_qty,
      ROUND(AVG(COALESCE(a.avg_pct, 0)), 1)                          AS total_value_local
    FROM {_TMC_DATASET}.Employee_Data e
    LEFT JOIN alloc a ON a.emp_id = CAST(e.Employee_Code AS STRING)
    GROUP BY plant_id, plant_name
    ORDER BY unique_materials DESC LIMIT 50
    """
    by_dept = _sap_query(by_dept_sql, max_rows=50)

    by_position_sql = f"""
    SELECT
      COALESCE(NULLIF(TRIM(Employee_Position),''), 'Unspecified') AS material_type,
      COUNT(*)                                                     AS unique_materials,
      CAST(COUNT(*) AS FLOAT64)                                    AS total_qty,
      CAST(COUNT(DISTINCT Employee_Location) AS FLOAT64)           AS total_value_local
    FROM {_TMC_DATASET}.Employee_Data
    GROUP BY material_type
    ORDER BY unique_materials DESC LIMIT 25
    """
    by_position = _sap_query(by_position_sql, max_rows=25)

    data_sql = f"""
    SELECT
      COALESCE(NULLIF(TRIM(e.Employee_Hierarchy),''), 'Unspecified') AS plant_id,
      CAST(e.Employee_Code AS STRING)                                AS material_id,
      e.Employee_Position                                            AS material_type,
      e.Resource_Name                                                AS material_description,
      e.Employee_Location                                            AS base_unit_of_measure,
      1.0                                                            AS stock_qty,
      0.0                                                            AS unit_rate,
      0.0                                                            AS stock_value_local
    FROM {_TMC_DATASET}.Employee_Data e
    WHERE LOWER(COALESCE(e.Employee_Type,'')) IN ('mto','permanent','probation')
    ORDER BY e.Resource_Name LIMIT 2000
    """
    return {
        "data": _sap_query(data_sql),
        "summary": summary,
        "by_plant": by_dept,
        "by_material_type": by_position,
    }


@app.get("/api/invoices/data")
def sales_pipeline_data(user: dict = Depends(get_current_user)):
    """Sales pipeline + AM scorecard — replaces legacy invoices dashboard."""
    summary_sql = f"""
    SELECT
      COUNT(*)                                                  AS total_invoices,
      ROUND(SUM(SAFE_CAST(Open_Pipeline AS FLOAT64)), 0)        AS total_amount_pkr,
      ROUND(SUM(SAFE_CAST(Q1_ACH AS FLOAT64)), 0)               AS total_bags,
      COUNT(DISTINCT AM)                                        AS active_dealers,
      ROUND(AVG(SAFE_CAST(Open_Pipeline AS FLOAT64)), 0)        AS avg_amount_per_invoice
    FROM {_TMC_DATASET}.Sales_AM_Scorecard
    """
    summary = (_sap_query(summary_sql, max_rows=1) or [{}])[0]

    top_accounts_sql = f"""
    SELECT
      Account                                                                AS product,
      ROUND(SUM(SAFE_CAST(Q1_Visits AS FLOAT64)), 0)                         AS total_amount_pkr,
      SUM(CASE WHEN Zero_Visit = 'Yes' THEN 1 ELSE 0 END)                    AS total_bags,
      COUNT(*)                                                                AS invoice_count
    FROM {_TMC_DATASET}.Sales_Accounts
    GROUP BY Account
    ORDER BY total_amount_pkr DESC LIMIT 15
    """
    top_accounts = _sap_query(top_accounts_sql, max_rows=15)

    trend_sql = f"""
    SELECT
      '2026'                                                  AS year,
      'Q1'                                                    AS month,
      AM                                                      AS product,
      COUNT(*)                                                AS qty,
      ROUND(SUM(SAFE_CAST(Q1_ACH AS FLOAT64)), 0)             AS amount
    FROM {_TMC_DATASET}.Sales_AM_Scorecard
    GROUP BY AM
    ORDER BY amount DESC
    """
    trend_data = _sap_query(trend_sql, max_rows=2000)

    data_sql = f"""
    SELECT
      ams.AM                                                  AS invoice_no,
      ams.AM                                                  AS dealer_code,
      ams.AM                                                  AS dealer_name,
      CURRENT_DATE()                                          AS shipment_date,
      ams.City                                                AS plant_warehouse_name,
      ROUND(SAFE_CAST(ams.Q1_ACH AS FLOAT64), 0)              AS total_bags,
      ROUND(SAFE_CAST(ams.Open_Pipeline AS FLOAT64), 0)       AS total_amount_pkr,
      ams.Role                                                AS product,
      ams.City                                                AS zone,
      ams.VP                                                  AS region,
      CAST(ROUND(SAFE_CAST(ams.Hist_Win_Rate AS FLOAT64) * 100, 1) AS STRING) AS district
    FROM {_TMC_DATASET}.Sales_AM_Scorecard ams
    ORDER BY SAFE_CAST(ams.Open_Pipeline AS FLOAT64) DESC LIMIT 2000
    """
    return {
        "data": _sap_query(data_sql),
        "summary": summary,
        "top_products": top_accounts,
        "trend": trend_data,
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  DASHBOARD BUILDER — schema context + AI prompts (TMC versions)
# ═══════════════════════════════════════════════════════════════════════════════

_DASHBOARD_SAP_SCHEMAS = """Detailed table schemas (BigQuery project `ai-vertex-mahad`, dataset `Satori_Project`). Column TYPES are shown in parentheses — use them correctly.

WORKFORCE TABLES:
- `Employee_Data` — employee master. Cols: Employee_Code (STRING, "E-2141"), Resource_Name (STRING), Employee_Position (STRING), Employee_Email (STRING), Employee_Hierarchy (STRING — department), Employee_Location (STRING — city), Employee_Status (STRING), Employee_Type (STRING — 'MTO'/'Permanent'/'Probation'/'Contract'). Active employees = Employee_Type IN ('MTO','Permanent','Probation').
- `Attendance_Data` — daily attendance per employee. Cols: attendance_date (DATE), employee_id (INT64 — CAST AS STRING to join), employee_name (STRING), checkin_time (STRING HH:MM:SS), checkout_time (STRING), attendance_status_text (STRING — 'Present'/'Absent'/'Late'/'Leave'/etc), is_present/is_absent/is_on_leave/is_remote/is_holiday/is_weekend (INT64 — 0/1). For "late": LOWER(attendance_status_text)='late'.
- `Allocation_data` — weekly project allocation. Cols: project_id (STRING), employee_id (STRING — "E-1234"), allocation_percent (STRING — SAFE_CAST AS FLOAT64), emp_competency (STRING), Flag (STRING — 'Actual'/'Forecast'), Forecast_Flag (STRING), Date (DATE). Allocated = MAX(pct)>=90; Partial = 1-89; Bench = 0/NULL.
- `Timesheet_Data` — ticket/project hours. Cols: TICKET_USER_ID, TICKET_NUMBER, TICKET_PROJECT_LABEL, TICKET_HOURS (STRING — SAFE_CAST AS FLOAT64), TICKET_STATUS, DATE_KEY (INT64 — YYYYMMDD), TICKET_DESCRIPTION, TICKET_SUBJECT.

SALES TABLES:
- `Sales_Accounts` (~359 rows) — Customer accounts. Cols: VP, AM, Location, Account, Tier ('A'/'B'/'C'), Dormant ('Yes'/'No'), Jan_Visits/Feb_Visits/Mar_Visits/Q1_Visits (STRING — SAFE_CAST AS INT64), Zero_Visit.
- `Sales_AM_Scorecard` (8 AMs) — AM performance. Cols: VP/AM/Role/City, col_2026_Target/Q1_ACH/Open_Pipeline (STRING USD — SAFE_CAST), Hist_Win_Rate (decimal 0-1 — SAFE_CAST, multiply by 100 for %).
- `Sales_Plan_vs_Pipeline` — revenue plan vs actual. Cols: AM, col_2026_Target/Q1_Target/Q1_ACH/CRM_Pipeline, Coverage_Ratio, Status, Action.
- `Sales_Pipeline_Health` — all salespeople. Cols: Salesperson, Open_Pipeline, Open_Deals, Win_Rate_by.
- `Sales_Hunting_Gap`, `Sales_KPI_Scorecard` (reference), `Sales_Dormant_Accounts`, `Sales_Workload_Feasibility`.

JOINS:
- Employee → Attendance / Allocation: CAST(Employee_Code AS STRING) = CAST(employee_id AS STRING).
- Employee → Timesheet: CAST(Employee_Code AS STRING) = CAST(TICKET_USER_ID AS STRING).
- Sales tables: join on `AM` (Sales_Pipeline_Health uses `Salesperson` ≈ AM).

DATA QUALITY:
- allocation_percent, TICKET_HOURS, and most USD/visit fields in Sales_* tables are STRING — always SAFE_CAST AS FLOAT64 before arithmetic.
- Win-rate columns are decimals (0.32 = 32%); multiply by 100 for display.
- Use COALESCE(NULLIF(TRIM(Employee_Hierarchy),''), 'Unspecified') for clean department grouping.
- attendance_date is DATE — compare directly with DATE_SUB / CURRENT_DATE.
- DATE_KEY (Timesheet) is INT64 in YYYYMMDD form — use SAFE.PARSE_DATE('%Y-%m-%d', CAST(DATE_KEY AS STRING)).
"""


DASHBOARD_REFINE_PROMPT = """You are Satori AI, a smart business analyst. You help users build interactive dashboards from TMC's workforce + sales data in BigQuery.

Conversation flow:
1. User describes what they want.
2. You ask 1-2 clarifying questions if needed (timeframe, grouping dimension, KPIs).
3. Once clear, present a PROPOSED dashboard summary (KPIs, charts, filters) in plain language and ask the user to confirm with "generate".
4. When the user says "generate", return ONLY the dashboard config as JSON (no prose, no markdown fence).

""" + _DASHBOARD_SAP_SCHEMAS + """

AVAILABLE DATA (use this knowledge internally — never show the user table/column names):
{tables}

═══ DASHBOARD CONFIG SHAPE (every field matters — the frontend reads them directly) ═══
{{"ready": true, "config": {{
  "version": 1,
  "title": "...",
  "description": "...",
  "filters": [
    {{"field": "department", "label": "Department"}}
  ],
  "kpis": [
    {{"id": "att_rate", "title": "Attendance rate", "format": "percent",
      "icon": "Calendar", "color": "primary",
      "sql": "SELECT ROUND(100.0*SUM(is_present)/NULLIF(COUNT(*),0),1) AS value FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` WHERE attendance_date BETWEEN DATE_SUB(CURRENT_DATE(),INTERVAL 30 DAY) AND CURRENT_DATE() {{where}}"}}
  ],
  "charts": [
    {{"id": "att_by_dept", "title": "Attendance rate by department",
      "type": "bar", "variant": "horizontal",
      "labelKey": "department",
      "valueKeys": ["attendance_pct"],
      "sql": "SELECT COALESCE(NULLIF(TRIM(Employee_Hierarchy),''),'Unspecified') AS department, ROUND(100.0*SUM(is_present)/NULLIF(COUNT(*),0),1) AS attendance_pct FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` a JOIN `ai-vertex-mahad.Satori_Project.Employee_Data` e ON CAST(e.Employee_Code AS STRING)=CAST(a.employee_id AS STRING) WHERE attendance_date BETWEEN DATE_SUB(CURRENT_DATE(),INTERVAL 30 DAY) AND CURRENT_DATE() {{where}} GROUP BY department ORDER BY attendance_pct DESC LIMIT 50"}}
  ]
}}}}

═══ CRITICAL — KPI + CHART CONTRACT ═══
- Every KPI's SQL MUST select exactly ONE row and alias the metric AS `value`.
  KPI display reads `rows[0]["value"]`.
- Every CHART's `labelKey` MUST exactly match a column alias in its SQL (the x-axis / category).
- Every CHART's `valueKeys` entries MUST each exactly match a column alias in the chart's SQL (the y-axis / numeric series).
- DO NOT use generic aliases like `label` / `value` on charts unless you also list those exact strings in labelKey / valueKeys.
- Always emit `id`, `title`, `format` for KPIs and `id`, `title`, `type`, `labelKey`, `valueKeys` for charts.

═══ LIMITS & OPTIONS ═══
- Chart types: "bar" (variants: "vertical" default, "horizontal", "stacked"), "line", "pie"
- KPI formats: "number", "usd", "percent"
- KPI icons (use these exact strings): Users, UserCheck, Briefcase, Calendar, Clock, TrendingUp, DollarSign, Target, Award, Activity
- KPI colors: primary, accent, info, danger, success, purple, teal
- Maximum 6 KPIs, maximum 4 charts, maximum 5 filters per dashboard.

═══ SQL RULES (CRITICAL — SQL is executed verbatim against BigQuery) ═══
- Fully qualify every table: `ai-vertex-mahad.Satori_Project.<table>`.
- Use ONLY the columns documented above. Never invent column names.
- STRING-typed numerics (allocation_percent, TICKET_HOURS, all Sales_* USD/visit fields, Hist_Win_Rate decimals) — SAFE_CAST AS FLOAT64 / INT64 before any math.
- 🚨 CASE-SENSITIVITY: Every string-comparison filter MUST wrap the column in LOWER() and lowercase the literal — these column values are stored in mixed case and a direct equals/IN filter throws away every row:
    LOWER(e.Employee_Type) IN ('mto','permanent','probation')      ✅
    e.Employee_Type IN ('MTO','Permanent','Probation')             ❌ NEVER
    LOWER(a.attendance_status_text) = 'late'                       ✅
    a.attendance_status_text = 'Late'                              ❌ NEVER
- Active employees filter (use EXACTLY this): LOWER(e.Employee_Type) IN ('mto','permanent','probation').
- Late filter (use EXACTLY this): LOWER(a.attendance_status_text) = 'late'.
- Attendance %: ROUND(100.0 * SUM(is_present) / NULLIF(COUNT(*),0), 1).
- Bench classify on MAX(SAFE_CAST(allocation_percent AS FLOAT64)) per Employee_Code.
- Win rate display: multiply Hist_Win_Rate by 100.
- Department grouping: COALESCE(NULLIF(TRIM(Employee_Hierarchy),''), 'Unspecified') AS department.
- Join keys: CAST-to-STRING on both sides — CAST(Employee_Code AS STRING)=CAST(employee_id AS STRING).
- 📅 Date scope: today's date is May 2026. When the user says "last month" you mean April 2026; "this month" means May 2026. If they name a month (e.g. "March 2026"), use that exact month's first/last day.
- {{where}} placement: the runtime substitutes either `AND field='value' AND ...` or empty string into the spot where you wrote {{where}}. Your query MUST already have its own WHERE — write the placeholder as ` {{where}}` right after your last WHERE condition (with a leading space). If no filters apply at runtime, the placeholder becomes ''.
- LIMIT every chart query to 50 rows.

═══ STYLE ═══
- NEVER expose table names, column names, or SQL to the user in chat.
- NEVER output the JSON until the user explicitly says "generate".
- Be concise — max 3-4 sentences per message.
"""


DASHBOARD_EDIT_PROMPT = """You are Satori AI, a smart business analyst. You help users EDIT their existing dashboards built on TMC's workforce + sales data.

The user already has a dashboard with the following configuration:
{current_config}

""" + _DASHBOARD_SAP_SCHEMAS + """

AVAILABLE DATA (use this knowledge internally):
{tables}

The user wants to modify this dashboard. They may ask to add/remove/change KPIs, charts, filters, the title, swap chart types, or modify what data is shown.

1. When the user describes changes — acknowledge and present a summary of the UPDATED dashboard. Ask for confirmation:
   Say **"generate"** to apply changes, or tell me what else to adjust.
2. When user confirms — Return ONLY the FULL updated config JSON:
   {{"ready": true, "config": {{"version": 1, "title": "...", "description": "...", "filters": [...], "kpis": [...], "charts": [...]}}}}

CRITICAL — KPI + CHART CONTRACT (every field must match the SQL):
- Every KPI's SQL MUST select exactly ONE row and alias the metric AS `value`.
- Every CHART must include `labelKey` (one column alias from its SQL) and
  `valueKeys` (an array of column aliases from its SQL — the numeric series).
- Always include `id`, `title`, `type`, `labelKey`, `valueKeys`, `sql` on every chart.
- Always include `id`, `title`, `format`, `sql` on every KPI.

SQL RULES (same as the refine prompt — fully qualify with `ai-vertex-mahad.Satori_Project.<table>`, SAFE_CAST every STRING-typed numeric, multiply Hist_Win_Rate by 100, COALESCE(NULLIF(TRIM(Employee_Hierarchy),''),'Unspecified') for department, CAST-to-STRING joins, LIMIT 50, and place the {{where}} placeholder right after your last WHERE condition with a leading space so the runtime can append filters).

DASHBOARD LIMITS & OPTIONS: bar (variants: vertical, horizontal, stacked) / line / pie; KPI formats number/usd/percent; KPI icons (Users, UserCheck, Briefcase, Calendar, Clock, TrendingUp, DollarSign, Target, Award, Activity); max 6 KPIs / 4 charts / 5 filters.

CRITICAL RULES:
- NEVER expose technical details (table names, column names, SQL) to the user.
- NEVER output the JSON until the user explicitly confirms.
- Always return the FULL config (not just the changed parts) in the JSON.
- Be concise — max 3-4 sentences per message.
"""


def refine_dashboard(user_message: str, history: list, existing_config=None) -> str:
    """Chat-based dashboard refinement. Returns AI text or JSON when ready."""
    client = get_genai_client()
    tables = discover_tables()
    tables_str = "\n".join(f"- {t['table']} ({t['type']})" for t in tables[:20]) or "(no tables discovered yet)"

    if existing_config:
        system = DASHBOARD_EDIT_PROMPT.format(current_config=json.dumps(existing_config, indent=2), tables=tables_str)
    else:
        system = DASHBOARD_REFINE_PROMPT.format(tables=tables_str)

    contents = []
    for msg in history[-12:]:
        role = "user" if msg.get("role") == "user" else "model"
        contents.append(genai.types.Content(role=role, parts=[genai.types.Part(text=msg.get("text", ""))]))
    contents.append(genai.types.Content(role="user", parts=[genai.types.Part(text=user_message)]))

    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents,
            config=genai.types.GenerateContentConfig(
                system_instruction=system,
                temperature=0.4,
                # Dashboard configs include several charts each with their own
                # SQL block — 2048 tokens was clipping them mid-statement.
                # 8192 gives plenty of headroom; raise again if the model
                # complains.
                max_output_tokens=8192,
            ),
        )
        return response.text or "I wasn't able to generate a response. Please try again."
    except Exception as e:
        print(f"[refine_dashboard] error: {e}")
        return f"Sorry, I ran into an error: {e}"


# ═══════════════════════════════════════════════════════════════════════════════
#  VOICE WEBSOCKET  (/ws/voice)
#  Browser opens a WebSocket here. We mint a Gemini Live API config (model name,
#  voice, system prompt, run_sql tool) and proxy chunks. Tool calls are handled
#  server-side against TMC BigQuery.
# ═══════════════════════════════════════════════════════════════════════════════

@app.websocket("/ws/voice")
async def voice_websocket(websocket: WebSocket):
    """Voice agent WebSocket — proxy to Gemini Live API.

    NOTE (v1): the full server-side audio-streaming proxy is pending rebuild.
    For now we accept the connection, surface a clear "feature pending" status
    to the client, and close cleanly so the floating mic button can show a
    helpful message instead of hanging. The frontend protocol expects binary
    PCM frames and status JSON messages; reconstruct here when ready.
    """
    await websocket.accept()
    try:
        await websocket.send_json({
            "type": "status",
            "message": "Voice agent is being rebuilt for v2 — please use text chat for now.",
        })
        await websocket.send_json({
            "type": "turn_complete",
        })
    except Exception:
        pass
    try:
        await websocket.close(code=1011, reason="Voice proxy pending rebuild")
    except Exception:
        pass


@app.post("/api/voice/session")
def voice_session(user: dict = Depends(get_current_user)):
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured.")
    return {
        "apiKey": api_key,
        "model": os.environ.get("GEMINI_MODEL_VOICE", "models/gemini-2.5-flash-live-preview"),
        "voice": os.environ.get("GEMINI_TTS_VOICE", "Leda"),
        "systemInstruction": VOICE_SYSTEM_PROMPT_EN,
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  STUBS — endpoints that existed in the original main.py but were truncated.
#  Returning placeholder responses keeps the frontend from 500-ing while these
#  features are rebuilt. None of them are critical for the v1 demo (chat, voice,
#  dashboards, the 4 data endpoints, and auth all work fine without these).
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/me/settings")
def get_my_settings(user: dict = Depends(get_current_user)):
    return {"ai_opt_out": False, "tts_voice": os.environ.get("GEMINI_TTS_VOICE", "Leda")}


@app.put("/api/me/settings")
def update_my_settings(body: dict, user: dict = Depends(get_current_user)):
    # Persistence stub — accept the change and return success.
    return {"ok": True, "settings": body}


@app.get("/api/admin/audit")
def admin_audit(limit: int = 200, offset: int = 0, action: str = "", user_id: int | None = None,
                user: dict = Depends(get_current_user)):
    return {"events": [], "limit": limit, "offset": offset}


@app.post("/api/admin/retention-sweep")
def admin_retention_sweep(user: dict = Depends(get_current_user)):
    return {"login_purged": 0, "audit_purged": 0, "chat_purged": 0, "note": "stub — full retention sweep not yet rebuilt"}


@app.post("/api/internal/retention-sweep")
def internal_retention_sweep():
    return {"login_purged": 0, "audit_purged": 0, "chat_purged": 0}


@app.get("/api/admin/users/{target_id}/export")
def admin_user_export(target_id: int, user: dict = Depends(get_current_user)):
    return {"user_id": target_id, "note": "stub — GDPR export endpoint pending rebuild"}


@app.delete("/api/admin/users/{target_id}/data")
def admin_user_delete_data(target_id: int, user: dict = Depends(get_current_user)):
    return {"user_id": target_id, "ok": True, "note": "stub — GDPR delete endpoint pending rebuild"}


# ── REPORTS — full CRUD against saved_reports table ──
@app.get("/api/reports")
def list_reports(user: dict = Depends(get_current_user)):
    uid = int(user["sub"])
    db = get_db(); cur = db.cursor()
    try:
        cur.execute("SELECT id, name, description, updated_at, is_favorite FROM saved_reports WHERE user_id = ? ORDER BY updated_at DESC", (uid,))
        rows = [dict(r) for r in cur.fetchall()]
    except Exception as e:
        print(f"[/api/reports] error: {e}")
        rows = []
    db.close()
    return {"reports": rows}


@app.get("/api/reports/{report_id}")
def get_report(report_id: int, user: dict = Depends(get_current_user)):
    db = get_db(); cur = db.cursor()
    cur.execute("SELECT id, name, description, config, user_id, updated_at FROM saved_reports WHERE id = ?", (report_id,))
    r = cur.fetchone()
    db.close()
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    r = dict(r)
    if isinstance(r.get("config"), str):
        try:
            r["config"] = json.loads(r["config"])
        except Exception:
            pass
    return r


@app.post("/api/reports")
def create_report(body: dict, user: dict = Depends(get_current_user)):
    from database import USE_POSTGRES
    uid = int(user["sub"])
    name = (body.get("name") or body.get("title") or "Untitled report").strip()
    description = (body.get("description") or "").strip()
    config_json = json.dumps(body.get("config") or {})
    db = get_db(); cur = db.cursor()
    if USE_POSTGRES:
        cur.execute(
            "INSERT INTO saved_reports (user_id, name, description, config) VALUES (?, ?, ?, ?) RETURNING id",
            (uid, name, description, config_json),
        )
        row = cur.fetchone()
        new_id = row["id"] if isinstance(row, dict) else row[0]
    else:
        cur.execute(
            "INSERT INTO saved_reports (user_id, name, description, config) VALUES (?, ?, ?, ?)",
            (uid, name, description, config_json),
        )
        new_id = cur.lastrowid
    db.commit(); db.close()
    return {"id": new_id, "ok": True}


@app.put("/api/reports/{report_id}")
def update_report(report_id: int, body: dict, user: dict = Depends(get_current_user)):
    from database import USE_POSTGRES
    name = body.get("name") or body.get("title")
    description = body.get("description")
    config = body.get("config")
    sets, params = [], []
    if name is not None:         sets.append("name = ?");        params.append(name)
    if description is not None:  sets.append("description = ?"); params.append(description)
    if config is not None:       sets.append("config = ?");      params.append(json.dumps(config))
    if not sets:
        return {"ok": True, "note": "nothing to update"}
    sets.append("updated_at = " + ("NOW()" if USE_POSTGRES else "datetime('now')"))
    params.append(report_id)
    db = get_db(); cur = db.cursor()
    cur.execute(f"UPDATE saved_reports SET {', '.join(sets)} WHERE id = ?", tuple(params))
    db.commit(); db.close()
    return {"ok": True}


@app.delete("/api/reports/{report_id}")
def delete_report(report_id: int, user: dict = Depends(get_current_user)):
    db = get_db(); cur = db.cursor()
    cur.execute("DELETE FROM saved_reports WHERE id = ?", (report_id,))
    db.commit(); db.close()
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════════════════════
#  DASHBOARD BUILDER  ──  AI-assisted creation + runtime
# ═══════════════════════════════════════════════════════════════════════════════

@app.post("/api/dashboard/refine")
def dashboard_refine(body: dict, user: dict = Depends(get_current_user)):
    """Chat with the AI to build/edit a dashboard config.
    Body: { message, history, existing_config? }.
    Returns: { reply: "AI text" } during chat,
             { ready: true, config: {...}, reply: "..." } when the user says 'generate'.
    """
    msg = (body.get("message") or "").strip()
    if not msg:
        return {"reply": "What kind of dashboard would you like to build?"}
    history = body.get("history") or []
    existing = body.get("existing_config")
    safe_msg = _redact_pii(msg)
    text = refine_dashboard(safe_msg, history, existing)
    cfg, truncated = _extract_ready_config(text)
    if cfg is not None:
        # Strip the JSON blob from the reply the user sees so they don't get
        # 200 lines of {...} dumped in chat.
        clean_reply = _strip_ready_json_from_reply(text)
        if not clean_reply.strip():
            clean_reply = "All set — building your dashboard now." if not truncated \
                else "Got the dashboard config (had to trim a few details — try \"generate\" again if anything's missing)."
        return {"ready": True, "config": cfg, "reply": clean_reply, "truncated": truncated}
    if truncated:
        return {
            "reply": "My response was cut off while writing the dashboard config. Try saying **\"generate\"** again, or ask me to simplify the dashboard (fewer charts / shorter SQL).",
            "truncated": True,
        }
    return {"reply": text}


def _infer_chart_keys(columns: list, rows: list, chart_cfg: dict):
    """When the AI's chart config didn't specify labelKey + valueKeys (or
    specified ones that don't exist in the SQL result), infer sensible
    defaults from the actual result columns: first non-numeric column = label,
    every numeric column = value series."""
    if not columns:
        return chart_cfg.get("labelKey") or "label", chart_cfg.get("valueKeys") or ["value"]

    label_key = chart_cfg.get("labelKey")
    if not label_key or label_key not in columns:
        # First column that isn't numeric in the first row.
        numeric_cols = set(_infer_numeric_columns(rows, columns))
        non_numeric = [c for c in columns if c not in numeric_cols]
        label_key = (non_numeric[0] if non_numeric else columns[0])

    value_keys = chart_cfg.get("valueKeys") or []
    # Filter out any that don't actually exist in the result.
    value_keys = [v for v in value_keys if v in columns]
    if not value_keys:
        numeric_cols = _infer_numeric_columns(rows, columns)
        value_keys = [c for c in numeric_cols if c != label_key] or [c for c in columns if c != label_key][:1]
        if not value_keys:
            value_keys = [columns[-1]]
    return label_key, value_keys


def _autofix_dashboard_sql(sql: str) -> str:
    """Patch the most common AI mistakes before sending SQL to BigQuery.

    The Gemini-generated dashboard SQL has consistently failed in three
    predictable ways even when the prompt forbids them. Rather than
    re-deploying every time we hit a new variant, we silently rewrite
    them here so existing saved dashboards heal themselves on next load.

    Auto-fixes applied:
    1. `(any.)Employee_Type IN ('MTO','Permanent','Probation')` →
       `LOWER((any.)Employee_Type) IN ('mto','permanent','probation')`.
       The data is stored lowercase; case-sensitive IN matches throw out
       every row.
    2. `(any.)attendance_status_text = 'Late'` (or similar status strings)
       → `LOWER((any.)attendance_status_text) = 'late'`.
    3. Strip stray double-spaces around the {where} placeholder remnants.
    """
    if not sql:
        return sql
    import re as _re

    # Fix 1 — Employee_Type IN ('Foo','Bar') → LOWER(Employee_Type) IN ('foo','bar')
    def _wrap_employee_type(m):
        prefix = m.group(1) or ""   # e.g. "e." or ""
        values = m.group(2)
        # Lowercase every quoted literal inside the IN list.
        lowered = _re.sub(r"'([^']*)'", lambda mm: f"'{mm.group(1).lower()}'", values)
        return f"LOWER({prefix}Employee_Type) IN ({lowered})"
    sql = _re.sub(
        r"(?<!LOWER\()(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*\.)?Employee_Type\s+IN\s*\(([^)]+)\)",
        _wrap_employee_type, sql, flags=_re.IGNORECASE,
    )
    # Same for direct equality.
    sql = _re.sub(
        r"(?<!LOWER\()(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*\.)?Employee_Type\s*=\s*'([^']*)'",
        lambda m: f"LOWER({m.group(1) or ''}Employee_Type) = '{m.group(2).lower()}'",
        sql, flags=_re.IGNORECASE,
    )

    # Fix 2 — attendance_status_text = 'Foo' (or IN) → LOWER(...) = 'foo' / IN ('foo',...)
    sql = _re.sub(
        r"(?<!LOWER\()(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*\.)?attendance_status_text\s+IN\s*\(([^)]+)\)",
        lambda m: f"LOWER({m.group(1) or ''}attendance_status_text) IN ({_re.sub(chr(39)+'([^'+chr(39)+']*)'+chr(39), lambda mm: chr(39)+mm.group(1).lower()+chr(39), m.group(2))})",
        sql, flags=_re.IGNORECASE,
    )
    sql = _re.sub(
        r"(?<!LOWER\()(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*\.)?attendance_status_text\s*=\s*'([^']*)'",
        lambda m: f"LOWER({m.group(1) or ''}attendance_status_text) = '{m.group(2).lower()}'",
        sql, flags=_re.IGNORECASE,
    )

    # Fix 3 — collapse runs of internal whitespace introduced by empty {where}
    sql = _re.sub(r"  +", " ", sql)
    return sql


def _substitute_where(sql: str, user_filters: dict) -> str:
    """Substitute the `{where}` placeholder. Supports two contracts:

    A) Older shape — `FROM t {where} GROUP BY ...`. We inject `WHERE f='v' AND ...`.
    B) Newer shape — `... WHERE attendance_date BETWEEN ... {where} GROUP BY ...`.
       We inject `AND f='v' AND ...`.

    If no filters apply the placeholder becomes ''.
    """
    if "{where}" not in sql:
        return sql
    parts = []
    for f, v in (user_filters or {}).items():
        if v is None or str(v).strip() == "":
            continue
        safe_v = str(v).replace("'", "\\'")
        parts.append(f"{f} = '{safe_v}'")
    if not parts:
        return sql.replace("{where}", "")

    import re as _re
    idx = sql.find("{where}")
    before = sql[:idx]
    # Heuristic: does the chunk preceding {where} already contain a WHERE
    # clause for the same SELECT? Walk back to last unmatched `(` — if we
    # find a WHERE before that boundary, we're in contract B.
    depth = 0
    has_where = False
    for ch_i in range(idx - 1, -1, -1):
        ch = before[ch_i]
        if ch == ')':
            depth += 1
        elif ch == '(':
            if depth == 0:
                break
            depth -= 1
    scope = before[ch_i + 1:] if ch_i >= 0 else before
    if _re.search(r"\bWHERE\b", scope, _re.IGNORECASE):
        has_where = True

    clause = (" AND " + " AND ".join(parts)) if has_where else ("WHERE " + " AND ".join(parts))
    return sql.replace("{where}", clause)


@app.post("/api/dashboard/run")
def dashboard_run(body: dict, user: dict = Depends(get_current_user)):
    """Execute a dashboard config against TMC BigQuery.
    Body: { config: {kpis, charts}, filters: {field: value} }.
    Returns { kpis: [{id, value, format, title, icon, color, error?}],
              charts: [{id, title, type, variant, labelKey, valueKeys,
                        data, columns, error?}] }
    """
    config = body.get("config") or {}
    user_filters = body.get("filters") or {}

    def _exec(sql_template, tag):
        if not sql_template or not sql_template.strip():
            print(f"[dashboard] {tag}: no sql in config")
            return {"error": "No SQL was saved for this widget.", "sql": ""}
        # Strip fenced code blocks before substitution.
        sql_template = sql_template.strip()
        if sql_template.startswith("```"):
            sql_template = sql_template.strip("`").lstrip("sql").strip()
            if sql_template.endswith("```"):
                sql_template = sql_template[:-3].strip()
        sql = _substitute_where(sql_template, user_filters)
        sql = _autofix_dashboard_sql(sql)
        print(f"[dashboard] {tag}: {sql[:300]}{'...' if len(sql) > 300 else ''}")
        r = bq_run_query(sql, max_rows=200)
        r["sql"] = sql  # always include the substituted SQL so the frontend can show it on error
        if "error" in r:
            print(f"[dashboard]   {tag} ERROR: {r['error']}")
        else:
            print(f"[dashboard]   {tag} ok — {len(r.get('rows') or [])} rows, cols={r.get('columns')}")
        return r

    def _pick_kpi_value(rows: list, cols: list):
        """The AI is told to alias the metric AS `value`. But it doesn't always
        follow the rule — try a few sensible fallbacks before giving up."""
        if not rows or not cols:
            return None
        row0 = rows[0]
        # 1) explicit `value` column
        if "value" in cols and row0.get("value") is not None:
            return row0["value"]
        # 2) first column with a non-null value
        for c in cols:
            v = row0.get(c)
            if v is not None and v != "":
                return v
        # 3) fall back to the literal first cell (might be null — still better than crash)
        return row0.get(cols[0])

    kpis_out = []
    for i, k in enumerate((config.get("kpis") or [])[:6]):
        kid = k.get("id") or f"kpi{i}"
        r = _exec(k.get("sql"), f"kpi[{kid}]")
        card = {
            "id":       kid,
            "title":    k.get("title") or kid,
            "format":   k.get("format") or "number",
            "icon":     k.get("icon"),
            "color":    k.get("color"),
            "subtitle": k.get("subtitle"),
            "value":    None,
            "sql":      r.get("sql", ""),  # exposed so frontend banner can show it
        }
        if "error" in r:
            card["error"] = r["error"]
        else:
            card["value"] = _pick_kpi_value(r.get("rows") or [], r.get("columns") or [])
        kpis_out.append(card)

    charts_out = []
    for i, c in enumerate((config.get("charts") or [])[:4]):
        cid = c.get("id") or f"chart{i}"
        r = _exec(c.get("sql"), f"chart[{cid}]")
        rows = r.get("rows") or []
        cols = r.get("columns") or []
        label_key, value_keys = _infer_chart_keys(cols, rows, c)
        card = {
            "id":        cid,
            "title":     c.get("title") or cid,
            "type":      c.get("type") or "bar",
            "variant":   c.get("variant"),
            "labelKey":  label_key,
            "valueKeys": value_keys,
            "data":      rows,
            "columns":   cols,
            "sql":       r.get("sql", ""),
        }
        if "error" in r:
            card["error"] = r["error"]
        charts_out.append(card)

    return {"kpis": kpis_out, "charts": charts_out, "filterOptions": {}}


@app.get("/api/dashboards")
def list_dashboards(user: dict = Depends(get_current_user)):
    uid = int(user["sub"])
    db = get_db(); cur = db.cursor()
    try:
        cur.execute("SELECT id, name, description, updated_at, is_favorite FROM saved_dashboards WHERE user_id = ? ORDER BY updated_at DESC", (uid,))
        rows = [dict(r) for r in cur.fetchall()]
    except Exception as e:
        print(f"[/api/dashboards] error: {e}")
        rows = []
    db.close()
    return {"dashboards": rows}


@app.post("/api/dashboards")
def create_dashboard(body: dict, user: dict = Depends(get_current_user)):
    from database import USE_POSTGRES
    uid = int(user["sub"])
    name = (body.get("name") or body.get("title") or "Untitled dashboard").strip()
    description = (body.get("description") or "").strip()
    config_json = json.dumps(body.get("config") or {})
    db = get_db(); cur = db.cursor()
    if USE_POSTGRES:
        cur.execute(
            "INSERT INTO saved_dashboards (user_id, name, description, config) VALUES (?, ?, ?, ?) RETURNING id",
            (uid, name, description, config_json),
        )
        row = cur.fetchone()
        new_id = row["id"] if isinstance(row, dict) else row[0]
    else:
        cur.execute(
            "INSERT INTO saved_dashboards (user_id, name, description, config) VALUES (?, ?, ?, ?)",
            (uid, name, description, config_json),
        )
        new_id = cur.lastrowid
    db.commit(); db.close()
    return {"id": new_id, "ok": True}


@app.get("/api/dashboards/{dashboard_id}")
def get_dashboard(dashboard_id: int, user: dict = Depends(get_current_user)):
    db = get_db(); cur = db.cursor()
    cur.execute("SELECT id, name, description, config, user_id, updated_at FROM saved_dashboards WHERE id = ?", (dashboard_id,))
    r = cur.fetchone()
    db.close()
    if not r:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    r = dict(r)
    if isinstance(r.get("config"), str):
        try:
            r["config"] = json.loads(r["config"])
        except Exception:
            pass
    return r


@app.put("/api/dashboards/{dashboard_id}")
def update_dashboard(dashboard_id: int, body: dict, user: dict = Depends(get_current_user)):
    from database import USE_POSTGRES
    name = body.get("name") or body.get("title")
    description = body.get("description")
    config = body.get("config")
    sets, params = [], []
    if name is not None:         sets.append("name = ?");        params.append(name)
    if description is not None:  sets.append("description = ?"); params.append(description)
    if config is not None:       sets.append("config = ?");      params.append(json.dumps(config))
    if not sets:
        return {"ok": True, "note": "nothing to update"}
    sets.append("updated_at = " + ("NOW()" if USE_POSTGRES else "datetime('now')"))
    params.append(dashboard_id)
    db = get_db(); cur = db.cursor()
    cur.execute(f"UPDATE saved_dashboards SET {', '.join(sets)} WHERE id = ?", tuple(params))
    db.commit(); db.close()
    return {"ok": True}


@app.delete("/api/dashboards/{dashboard_id}")
def delete_dashboard(dashboard_id: int, user: dict = Depends(get_current_user)):
    db = get_db(); cur = db.cursor()
    cur.execute("DELETE FROM saved_dashboards WHERE id = ?", (dashboard_id,))
    db.commit(); db.close()
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════════════════════
#  REPORT BUILDER  ──  AI-assisted creation + render to PDF/Excel
# ═══════════════════════════════════════════════════════════════════════════════

_REPORT_SYSTEM_PROMPT = """You are Satori AI, a smart business analyst at TMC. You help users design tabular reports from the TMC workforce + sales BigQuery warehouse.

A report = ONE BigQuery SELECT that produces ONE clean table of rows. The frontend renders that table directly, with optional column show/hide and totals row.

═══ TMC SCHEMA (these are the ONLY tables / columns that exist — do not invent others) ═══

WORKFORCE TABLES:
- `ai-vertex-mahad.Satori_Project.Employee_Data`
    Employee_Code, Resource_Name, Employee_Position, Employee_Hierarchy (= department),
    Employee_Location, Employee_Type, Joining_Date, Gender.
    Active employees filter: LOWER(Employee_Type) IN ('mto','permanent','probation').

- `ai-vertex-mahad.Satori_Project.Attendance_Data`
    attendance_date (DATE), employee_id, employee_name,
    attendance_status_text ('Present' / 'Absent' / 'Late' / 'On Leave' / 'Weekend' / 'Holiday' / 'Remote'),
    is_present, is_absent, is_on_leave, is_remote  (each 0/1 INTEGER).
    Attendance rate = ROUND(100.0 * SUM(is_present) / NULLIF(COUNT(*),0), 1).
    `employee_id` here = `Employee_Code` in Employee_Data.

- `ai-vertex-mahad.Satori_Project.Allocation_data`
    project_id, employee_id (= Employee_Code), allocation_percent (STRING — SAFE_CAST AS FLOAT64),
    emp_competency, Flag, Start_Date, End_Date.
    Bench = employees with MAX(SAFE_CAST(allocation_percent AS FLOAT64)) per Employee_Code = 0 or NULL.

- `ai-vertex-mahad.Satori_Project.Timesheet_Data`
    TICKET_USER_ID (= Employee_Code), TICKET_PROJECT_LABEL, TICKET_HOURS (STRING — SAFE_CAST),
    TICKET_STATUS, DATE_KEY (DATE).

SALES TABLES (USD/visit numbers stored as STRING → SAFE_CAST AS FLOAT64; win-rate already decimal 0-1):
- `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard`
    VP, AM, Role, City, col_2026_Target, Q1_ACH, Open_Pipeline, Hist_Win_Rate.
- `ai-vertex-mahad.Satori_Project.Sales_Pipeline_Health`
    AM, City, Open_Pipeline, Q1_ACH, Hist_Win_Rate.
- `ai-vertex-mahad.Satori_Project.Sales_Plan_vs_Pipeline`
    AM, City, col_2026_Target, Open_Pipeline, Coverage_Ratio.
- `ai-vertex-mahad.Satori_Project.Sales_Accounts`
    AM, City, Account_Name, Account_Tier (A/B/C), Visits_Q1, Last_Visit_Date.
- `ai-vertex-mahad.Satori_Project.Sales_Hunting_Gap`
    AM, City, Hunting_Target, Hunting_Achieved, Hunting_Gap.

This dataset DOES NOT contain SAP/MRP concepts (plant, storage_location, material, purchase_order, receipts, issues). Never reference those.

═══ CONVERSATION FLOW ═══
1. User describes the report they want.
2. Ask 1-2 short business questions if scope is unclear (timeframe, departments, AMs).
3. Once clear, present a 3-4 line PROPOSED outline in plain language: title + what columns/dimensions it'll show + scope. Ask the user to confirm with "generate".
4. When the user says "generate" (or "go", "yes", "looks good"), reply with ONLY this JSON (no prose around it, no markdown fence):
   {"ready": true, "config": {
     "title": "Mahad Laeeque's March 2026 Attendance Report",
     "description": "Daily attendance status for Mahad Laeeque in March 2026.",
     "sql": "SELECT attendance_date, employee_name, attendance_status_text, is_present, is_absent, is_on_leave FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` WHERE LOWER(employee_name) LIKE '%mahad%' AND attendance_date BETWEEN DATE '2026-03-01' AND DATE '2026-03-31' ORDER BY attendance_date LIMIT 200",
     "numeric_columns": ["is_present","is_absent","is_on_leave"],
     "total_columns": ["is_present","is_absent","is_on_leave"]
   }}

═══ SQL RULES (CRITICAL — the SQL is executed verbatim against BigQuery) ═══
- Fully qualify every table with backticks: `ai-vertex-mahad.Satori_Project.<table>`.
- Use ONLY the columns listed above. If a column you want doesn't exist, pick a different angle or join — never invent column names.
- SAFE_CAST every STRING-typed numeric (allocation_percent, TICKET_HOURS, col_2026_Target, Q1_ACH, Open_Pipeline) to FLOAT64 / INT64 before SUM / AVG.
- Joins: Employee_Data.Employee_Code = Attendance_Data.employee_id = Allocation_data.employee_id = Timesheet_Data.TICKET_USER_ID.
- For department grouping: COALESCE(NULLIF(TRIM(Employee_Hierarchy),''), 'Unspecified').
- For fuzzy name match (e.g. user types "Mahad"): WHERE LOWER(employee_name) LIKE '%mahad%' (or Resource_Name on Employee_Data).
- LIMIT every query to 200 rows max.
- Use ROUND() for percentages and currency.
- Always alias columns with readable names (AS attendance_pct, AS employee, …). The frontend uses the column names AS-IS.
- The result MUST have at least one row for the user-supplied scope — pick filters loose enough that real data comes back.

═══ JSON FIELDS ═══
- title         (required) — short report title.
- description   (optional) — 1-line summary.
- sql           (required) — the BigQuery SELECT. Will be executed.
- numeric_columns (optional) — list of column aliases that should be right-aligned + tabular-nums.
- total_columns   (optional) — list of column aliases that should be SUM'd in a footer totals row.

═══ STYLE ═══
- Plain English in chat. NEVER show SQL, table names, or raw column names to the user in chat.
- NEVER emit the JSON until the user explicitly says "generate".
- Be concise — max 3-4 sentences per chat turn.
"""


def _strip_ready_json_from_reply(text: str) -> str:
    """Remove any `{"ready": true, ...}` JSON blob from a model reply so the
    user-facing chat doesn't show 200 lines of config."""
    if not text:
        return ""
    import re as _re
    # Remove fenced ```json ... ``` blocks containing "ready".
    text = _re.sub(r'```(?:json)?\s*\{[\s\S]*?"ready"[\s\S]*?\}\s*```', '', text)
    # Remove bare `{...}` blocks that contain a "ready":true marker.
    text = _re.sub(r'\{[\s\S]*?"ready"\s*:\s*true[\s\S]*?\}\s*$', '', text)
    return text.strip()


def _try_repair_json(s: str):
    """Best-effort fixer for JSON that was truncated mid-output by max_output_tokens.

    Strategy:
    1. Drop everything after the last balanced position where a value could end.
    2. Close any open string by appending `"`.
    3. Walk the string tracking [, {, ", and close them in reverse order.
    Returns a Python object on success, None on failure."""
    if not s:
        return None
    # If the model wrapped the JSON in a ```json fenced block, strip the fence.
    s = s.strip()
    if s.startswith("```"):
        s = s.split("```", 2)[1] if s.count("```") >= 2 else s[3:]
        if s.startswith("json"):
            s = s[4:]
        s = s.strip()
        if s.endswith("```"):
            s = s[:-3].strip()

    # Walk the string and balance braces/brackets/strings.
    stack = []
    in_string = False
    escape = False
    last_complete = -1
    for i, ch in enumerate(s):
        if escape:
            escape = False
            continue
        if ch == "\\" and in_string:
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
            if not stack:
                last_complete = i  # full document closes here

    # Already balanced — try it raw.
    if not stack and not in_string and last_complete >= 0:
        candidate = s[:last_complete + 1]
        try:
            return json.loads(candidate)
        except Exception:
            pass

    # Truncated. Close out what's open.
    repaired = s
    if in_string:
        repaired += '"'
    # If the last meaningful token is a comma or colon, the partial value/key
    # is unusable — strip trailing junk that looks like a half-written token.
    repaired = repaired.rstrip()
    while repaired and repaired[-1] in ",:":
        repaired = repaired[:-1].rstrip()
    # Close every open container in reverse order.
    for opener in reversed(stack):
        repaired += "}" if opener == "{" else "]"
    try:
        return json.loads(repaired)
    except Exception:
        return None


def _extract_ready_config(reply_text: str):
    """The refine AIs are instructed to emit `{"ready": true, "config": {...}}` JSON
    when the user has confirmed the design. Parse it out if present, repairing
    truncation when possible.
    Returns (config_dict, was_truncated)."""
    if not reply_text:
        return None, False
    text = reply_text.strip()
    # Try whole reply as JSON first
    try:
        obj = json.loads(text)
        if isinstance(obj, dict) and obj.get("ready") and isinstance(obj.get("config"), dict):
            return obj["config"], False
    except Exception:
        pass
    # Try to find an embedded JSON object containing "ready": true.
    import re as _re
    # Find every "{" position that could start a ready-blob and try parsing from
    # each. The model sometimes prefixes the JSON with a sentence.
    starts = [m.start() for m in _re.finditer(r'\{[\s]*"ready"', text)]
    if not starts:
        # Fall back to anything that mentions ready+config.
        if '"ready"' in text and '"config"' in text:
            starts = [text.find("{")]
    for start in starts:
        if start < 0:
            continue
        candidate = text[start:]
        # First try strict parse.
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict) and obj.get("ready") and isinstance(obj.get("config"), dict):
                return obj["config"], False
        except Exception:
            pass
        # Then try repair.
        repaired = _try_repair_json(candidate)
        if isinstance(repaired, dict) and repaired.get("ready") and isinstance(repaired.get("config"), dict):
            cfg = repaired["config"]
            # Drop dashboard kpis/charts that lost their SQL during truncation.
            # NOTE: do NOT touch the top-level `sql` field on report configs —
            # the single-SQL report shape carries `sql` directly on `cfg`.
            for key in ("kpis", "charts"):
                if isinstance(cfg.get(key), list):
                    cfg[key] = [x for x in cfg[key] if isinstance(x, dict) and x.get("sql")]
            return cfg, True
    # If we saw a `"ready"` marker but couldn't parse anything at all, signal
    # truncation so the frontend can show a retry hint.
    if '"ready"' in text and '"config"' in text:
        return None, True
    return None, False


@app.post("/api/report/refine")
def report_refine(body: dict, user: dict = Depends(get_current_user)):
    """Chat to build a report config.
    Body: { message, history, existing_config? }.
    Returns: { reply: "AI text" } during conversation,
             { ready: true, config: {...}, reply: "..." } when the user confirms.
    """
    msg = (body.get("message") or "").strip()
    if not msg:
        return {"reply": "What kind of report would you like to build? (e.g. 'monthly attendance summary by department', 'Q1 AM scorecard ranking')"}
    history = body.get("history") or []

    client = get_genai_client()
    contents = []
    for m in history[-12:]:
        role = "user" if m.get("role") == "user" else "model"
        contents.append(genai.types.Content(role=role, parts=[genai.types.Part(text=m.get("text", ""))]))
    contents.append(genai.types.Content(role="user", parts=[genai.types.Part(text=msg)]))

    try:
        resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents,
            config=genai.types.GenerateContentConfig(
                system_instruction=_REPORT_SYSTEM_PROMPT,
                temperature=0.4,
                # Reports often span 3-6 sections each with a SQL block;
                # 2048 tokens reliably clipped the last section's sql mid-
                # statement. 8192 gives plenty of headroom.
                max_output_tokens=8192,
            ),
        )
        reply_text = resp.text or "I wasn't able to generate a response. Please try again."
        cfg, truncated = _extract_ready_config(reply_text)
        if cfg is not None:
            clean_reply = _strip_ready_json_from_reply(reply_text)
            if not clean_reply.strip():
                clean_reply = "All set — building your report now." if not truncated \
                    else "Got the report outline (had to trim a few details — try \"generate\" again if anything looks off)."
            return {"ready": True, "config": cfg, "reply": clean_reply, "truncated": truncated}
        if truncated:
            return {
                "reply": "My response was cut off while writing the report config. Try saying **\"generate\"** again, or ask me to simplify it (fewer sections / shorter SQL).",
                "truncated": True,
            }
        return {"reply": reply_text}
    except Exception as e:
        print(f"[/api/report/refine] error: {e}")
        return {"reply": f"Sorry, I ran into an error: {e}"}


def _infer_numeric_columns(rows: list, columns: list) -> list:
    """Detect which columns hold numbers (for right-align + tabular-nums) by
    looking at the first non-null sample value per column."""
    out = []
    for c in columns:
        for r in rows:
            v = r.get(c)
            if v is None or v == "":
                continue
            try:
                # Accept ints, floats, and stringified numbers.
                float(str(v).replace(",", ""))
                out.append(c)
            except Exception:
                pass
            break
    return out


def _run_report_config(config: dict) -> dict:
    """Execute the config's single SQL and return the table the frontend renders.

    Expected config shape:
        {title, description, sql, columns?, numeric_columns?, total_columns?}
    Returns:
        {title, description, sql, columns, all_columns, rows, total_rows,
         numeric_columns, total_columns, error?}
    """
    title       = (config.get("title") or "Satori Report").strip()
    description = (config.get("description") or config.get("subtitle") or "").strip()
    sql         = (config.get("sql") or "").strip()
    # Strip fenced ```sql ... ``` if the model left it in.
    if sql.startswith("```"):
        sql = sql.strip("`").lstrip("sql").strip()
        if sql.endswith("```"):
            sql = sql[:-3].strip()

    if not sql:
        print("[report] no SQL in config — returning empty payload")
        return {
            "title": title,
            "description": description,
            "sql": "",
            "columns": [],
            "all_columns": [],
            "rows": [],
            "total_rows": 0,
            "numeric_columns": [],
            "total_columns": [],
            "error": "No SQL was generated. Re-confirm the report design and say 'generate' again.",
        }

    print(f"[report] running SQL: {sql[:220]}{'...' if len(sql) > 220 else ''}")
    r = bq_run_query(sql, max_rows=200)
    if "error" in r:
        print(f"[report]   ERROR: {r['error']}")
        return {
            "title": title,
            "description": description,
            "sql": sql,
            "columns": [],
            "all_columns": [],
            "rows": [],
            "total_rows": 0,
            "numeric_columns": [],
            "total_columns": [],
            "error": r["error"],
        }

    all_columns = r.get("columns") or []
    rows        = r.get("rows") or []
    # Visible columns: prefer the AI's hint, else all of them.
    visible = config.get("columns") or all_columns
    visible = [c for c in visible if c in all_columns] or all_columns

    numeric_columns = config.get("numeric_columns") or _infer_numeric_columns(rows, all_columns)
    numeric_columns = [c for c in numeric_columns if c in all_columns]
    total_columns   = config.get("total_columns") or []
    total_columns   = [c for c in total_columns if c in numeric_columns]

    print(f"[report]   ok — {len(rows)} rows, cols={all_columns}")
    return {
        "title": title,
        "description": description,
        "sql": sql,
        "columns": visible,
        "all_columns": all_columns,
        "rows": rows,
        "total_rows": r.get("total_rows") or len(rows),
        "numeric_columns": numeric_columns,
        "total_columns": total_columns,
    }


@app.post("/api/report/preview")
def report_preview(body: dict, user: dict = Depends(get_current_user)):
    config = body.get("config") or {}
    return _run_report_config(config)


def _coerce_num(v):
    if v is None or v == "":
        return None
    try:
        return float(str(v).replace(",", ""))
    except Exception:
        return None


@app.post("/api/report/generate")
def report_generate(body: dict, user: dict = Depends(get_current_user)):
    """Render the report to PDF or Excel and return as a download."""
    config = body.get("config") or {}
    fmt = (body.get("format") or "pdf").lower()
    if fmt in ("excel", "xls"):
        fmt = "xlsx"
    rendered = _run_report_config(config)

    title       = rendered.get("title", "Report")
    description = rendered.get("description", "")
    columns     = (body.get("config") or {}).get("columns") or rendered.get("columns") or []
    # Defensive: only keep visible columns that actually exist in the result.
    all_cols    = rendered.get("all_columns") or []
    columns     = [c for c in columns if c in all_cols] or all_cols
    rows        = rendered.get("rows") or []
    numeric_cols = set(rendered.get("numeric_columns") or [])
    total_cols   = set(rendered.get("total_columns") or [])

    # Build totals row if any total_columns specified.
    totals = {}
    for c in total_cols:
        s = 0.0
        any_n = False
        for r in rows:
            n = _coerce_num(r.get(c))
            if n is not None:
                s += n
                any_n = True
        if any_n:
            totals[c] = s

    filename_base = title.replace(" ", "_").replace("/", "_") or "satori-report"

    if fmt == "xlsx":
        try:
            from openpyxl import Workbook
            from openpyxl.styles import Font, PatternFill, Alignment
            from io import BytesIO
            wb = Workbook()
            ws = wb.active
            ws.title = "Report"
            ws.append([title])
            ws["A1"].font = Font(bold=True, size=14)
            if description:
                ws.append([description])
                ws.append([])
            else:
                ws.append([])
            # Header row.
            ws.append(columns)
            header_row = ws.max_row
            for col_idx in range(1, len(columns) + 1):
                cell = ws.cell(row=header_row, column=col_idx)
                cell.font = Font(bold=True, color="FFFFFFFF")
                cell.fill = PatternFill("solid", fgColor="FF1F2D3D")
                cell.alignment = Alignment(horizontal="center")
            # Data rows.
            for r in rows:
                ws.append([r.get(c, "") for c in columns])
            # Totals row.
            if totals:
                row_vals = []
                for c in columns:
                    if c in totals:
                        row_vals.append(totals[c])
                    elif c == columns[0]:
                        row_vals.append("TOTAL")
                    else:
                        row_vals.append("")
                ws.append(row_vals)
                tr = ws.max_row
                for col_idx in range(1, len(columns) + 1):
                    ws.cell(row=tr, column=col_idx).font = Font(bold=True)
            buf = BytesIO()
            wb.save(buf)
            buf.seek(0)
            return Response(
                content=buf.read(),
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.xlsx"',
                    "X-Report-Filename": f"{filename_base}.xlsx",
                },
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Excel export failed: {e}")

    # PDF (default)
    try:
        from reportlab.lib.pagesizes import letter, landscape
        from reportlab.lib import colors
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
        from io import BytesIO
        buf = BytesIO()
        # Wide tables fit better on landscape letter.
        doc = SimpleDocTemplate(buf, pagesize=landscape(letter) if len(columns) > 6 else letter)
        styles = getSampleStyleSheet()
        elements = [Paragraph(title, styles["Title"])]
        if description:
            elements.append(Paragraph(description, styles["Italic"]))
        elements.append(Spacer(1, 14))

        if rendered.get("error"):
            elements.append(Paragraph(f"<i>Query error: {rendered['error']}</i>", styles["BodyText"]))
        elif not rows or not columns:
            elements.append(Paragraph("(no data for the chosen scope)", styles["BodyText"]))
        else:
            data = [columns] + [[str(r.get(c, "")) for c in columns] for r in rows[:200]]
            if totals:
                trow = []
                for c in columns:
                    if c in totals:
                        trow.append(f"{totals[c]:,.2f}" if not float(totals[c]).is_integer() else f"{int(totals[c]):,}")
                    elif c == columns[0]:
                        trow.append("TOTAL")
                    else:
                        trow.append("")
                data.append(trow)
            t = Table(data, repeatRows=1)
            style = [
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1F2D3D')),
                ('TEXTCOLOR',  (0, 0), (-1, 0), colors.white),
                ('FONTNAME',   (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE',   (0, 0), (-1, -1), 8),
                ('GRID', (0, 0), (-1, -1), 0.25, colors.grey),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1 if not totals else -2),
                                   [colors.white, colors.HexColor('#F4F6F8')]),
            ]
            if totals:
                style.append(('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#E8F5E9')))
                style.append(('FONTNAME',   (0, -1), (-1, -1), 'Helvetica-Bold'))
            t.setStyle(TableStyle(style))
            elements.append(t)

        doc.build(elements)
        buf.seek(0)
        return Response(
            content=buf.read(),
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.pdf"',
                "X-Report-Filename": f"{filename_base}.pdf",
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF export failed: {e}")


# ═══════════════════════════════════════════════════════════════════════════════
#  HEALTH CHECK + SPA STATIC MOUNT
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/health")
def health_check():
    """Cloud Run liveness probe target."""
    return {
        "ok": True,
        "service": "Satori v2",
        "project": _TMC_PROJECT,
        "dataset": _TMC_DATASET_NAME,
    }


from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

_FRONTEND_DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "dist")


class SPAStaticFiles(StaticFiles):
    """StaticFiles that falls back to index.html for any unknown path so React
    Router's client-side routing works on direct visits / refresh."""
    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except (HTTPException, StarletteHTTPException) as exc:
            if exc.status_code == 404:
                return await super().get_response("index.html", scope)
            raise


if os.path.isdir(_FRONTEND_DIST):
    app.mount("/", SPAStaticFiles(directory=_FRONTEND_DIST, html=True), name="react_app")
else:
    @app.get("/")
    def _no_frontend_yet():
        return {
            "ok": True,
            "message": "Satori v2 backend up. React frontend not built into this container.",
        }
