from fastapi import FastAPI, HTTPException, Depends, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional
from database import get_db, init_db, USE_POSTGRES
from auth import (
    verify_password, create_access_token, decode_token,
    create_typed_token, decode_typed_token,
    TRUST_DEVICE_EXPIRE_DAYS, TOTP_SETUP_EXPIRE_MINUTES, TOTP_CHALLENGE_EXPIRE_MINUTES,
)
import totp as totp_lib
import audit as audit_log
from redact import redact as _redact_pii, redact_history as _redact_history_pii
from bigquery_client import find_relevant_data, discover_tables, get_all_key_data, get_schema_context
import live_schema
from report_generator import generate_report
from google import genai
from dotenv import load_dotenv
import os, json, asyncio, base64, re
from datetime import datetime, timedelta

# ─── BigQuery target (project + dataset) ──────────────────────────────────────
# Single source of truth for which warehouse we're querying. Defaults preserve
# the original TMC dataset so the existing deploy keeps working; overriding
# either env var lets us point the same code at the migrated capability-agent-
# prod project without touching prompts or autofix patterns.
BQ_PROJECT  = os.environ.get("VERTEX_PROJECT",  "ai-vertex-mahad")
BQ_DATASET  = os.environ.get("VERTEX_DATASET",  "Satori_Project")
BQ_FULL     = f"{BQ_PROJECT}.{BQ_DATASET}"          # 'ai-vertex-mahad.Satori_Project'
BQ_BACKTICK = f"`{BQ_FULL}`"                         # for SQL embedding


def normalize_bq_project(sql: str) -> str:
    """Rewrite legacy project names in user-supplied SQL so saved configs
    keep working after a project migration. Maps the original TMC project
    'ai-vertex-mahad' to whatever BQ_PROJECT is set to. Idempotent — no-op
    when BQ_PROJECT is still the legacy default."""
    if not sql:
        return sql
    if BQ_PROJECT != "ai-vertex-mahad":
        sql = sql.replace("ai-vertex-mahad.Satori_Project",
                          f"{BQ_PROJECT}.{BQ_DATASET}")
        sql = sql.replace("`ai-vertex-mahad`.`Satori_Project`",
                          f"`{BQ_PROJECT}`.`{BQ_DATASET}`")
    return sql


def sql_table(table_name: str) -> str:
    """Return the fully-qualified backtick-wrapped table reference for SQL
    embedding, using the configured BQ_PROJECT/BQ_DATASET. Use whenever code
    builds a SQL string at runtime so the migration to capability-agent-prod
    is a single env-var flip."""
    return f"`{BQ_FULL}.{table_name}`"

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


# Email that identifies the company-wide superadmin. Used to gate the System
# Settings page and data-scope configuration endpoints. These affect how
# every user (including other admins) sees data, so we lock them to the
# single bootstrap account rather than the entire admin role.
SUPERADMIN_EMAIL = (os.environ.get("SUPERADMIN_EMAIL") or "superadmin@tmc.com").strip().lower()
# Accept every email shape the superadmin has ever had, so an env-var that
# still pins the old address or an in-flight migration that hasn't run yet
# can't lock the superadmin out of System Settings.
_SUPERADMIN_EMAILS = {
    SUPERADMIN_EMAIL,
    "superadmin@tmc.com",
    "superadmin@tmcltd.com",
    "superadmin@sfml.com",
}


def _user_is_superadmin(user: dict) -> bool:
    """True if the JWT-resolved user is the configured superadmin account."""
    if (user.get("role") or "").lower() != "admin":
        return False
    return (user.get("email") or "").strip().lower() in _SUPERADMIN_EMAILS


def require_superadmin(user: dict = Depends(get_current_user)) -> dict:
    """Guard for company-wide configuration endpoints (System Settings,
    data scope dimensions, per-user scope assignments). Only the bootstrap
    superadmin account passes - other admins get 403."""
    if not _user_is_superadmin(user):
        raise HTTPException(status_code=403, detail="Superadmin access required")
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
    {"id": "availability",  "label": "Availability Engine", "group": "Intelligence"},
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
    """Return the current user's role, accessible feature IDs, data-scope
    policy, and the is_superadmin flag the frontend uses to gate the
    System Settings page."""
    uid = int(user["sub"])
    role = user.get("role", "user")
    is_admin = role.lower() == "admin"
    dept_scope = _get_user_dept_scope(uid) if not is_admin else None
    practice_scope = _get_user_scope_values(uid, "practice_node") if not is_admin else None
    return {
        "role": role,
        "is_superadmin": _user_is_superadmin(user),
        "features": _features_for_user(uid, role),
        # data_scope: null = see all; [] or [...] = restricted
        "data_scope": {
            "department": {
                "enforced": dept_scope is not None,
                "values": dept_scope or [],
            },
            "practice_node": {
                "enforced": practice_scope is not None,
                "values": practice_scope or [],
            },
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


# ── Practice Heads bulk import ──────────────────────────────────────────────
# Reads `Practice_Heads_List` from BigQuery and creates Satori user accounts
# in one shot. Each head gets:
#   - role: user (not admin)
#   - features: the full FEATURE_CATALOG
#   - department scope: their EmployeeHierarchyNode (so they only see their
#     own practice's data once row-level scoping is active)
# Preview vs import is a two-step flow so the admin can untick rows in the UI.

def _read_practice_heads_from_bq() -> tuple[list[dict], str | None]:
    """Pull every row of Practice_Heads_List as a list of plain dicts.
    Columns: employee_code, resource_name, EmployeePosition, EmployeeEmail,
    EmployeeHierarchyNode, EmployeeLocation, employee_status, employee_type,
    Department. Returns (rows, error_msg) — error_msg is None on success,
    otherwise a specific human-readable explanation (table not found,
    permission denied, etc.) so the import UI can show what actually failed."""
    sql = f"""
        SELECT
          employee_code,
          resource_name,
          EmployeePosition,
          EmployeeEmail,
          EmployeeHierarchyNode,
          EmployeeLocation,
          employee_status,
          employee_type,
          Department
        FROM {_bq_avail('Practice_Heads_List')}
        WHERE EmployeeEmail IS NOT NULL AND TRIM(EmployeeEmail) != ''
        ORDER BY resource_name
    """
    sql = normalize_bq_project(sql)
    r = bq_run_query(sql, max_rows=500)
    if "error" in r:
        err = str(r["error"])
        print(f"[practice-heads] BQ read error against {BQ_FULL}.Practice_Heads_List: {err}")
        # Classify the most common failure modes so the UI message is useful.
        low = err.lower()
        if "not found" in low or "does not exist" in low or "404" in low:
            msg = (f"Practice_Heads_List doesn't exist in {BQ_FULL}. "
                   f"Either upload it to that dataset, or check that Cloud Run's "
                   f"VERTEX_PROJECT env var points to the project where the table lives.")
        elif "permission" in low or "denied" in low or "403" in low:
            msg = (f"Permission denied reading {BQ_FULL}.Practice_Heads_List. "
                   f"The Satori runtime service account needs roles/bigquery.dataViewer "
                   f"+ roles/bigquery.jobUser on this project.")
        else:
            msg = f"BigQuery error reading {BQ_FULL}.Practice_Heads_List: {err}"
        return [], msg
    rows_out = [
        {
            "employee_code":        (row.get("employee_code") or "").strip(),
            "resource_name":        (row.get("resource_name") or "").strip(),
            "position":             (row.get("EmployeePosition") or "").strip(),
            "email":                (row.get("EmployeeEmail") or "").strip().lower(),
            "hierarchy_node":       (row.get("EmployeeHierarchyNode") or "").strip(),
            "location":             (row.get("EmployeeLocation") or "").strip(),
            "employee_status":      (row.get("employee_status") or "").strip(),
            "employee_type":        (row.get("employee_type") or "").strip(),
            "department":           (row.get("Department") or "").strip(),
        }
        for row in (r.get("rows") or [])
    ]
    return rows_out, None


def _random_temp_password(n: int = 12) -> str:
    """A friendly random temp password — alnum, no ambiguous chars (0/O/1/l)."""
    import secrets, string
    alphabet = "".join(c for c in (string.ascii_letters + string.digits)
                       if c not in "0Ol1I")
    return "".join(secrets.choice(alphabet) for _ in range(n))


@app.get("/api/admin/users/practice-heads-preview")
def admin_practice_heads_preview(_: dict = Depends(require_admin)):
    """Return the Practice_Heads_List rows annotated with which would be
    created vs already exist (matched by lowercased email). The frontend
    renders this as a confirm-table before the actual import."""
    rows, err = _read_practice_heads_from_bq()
    if err:
        return {"rows": [], "warning": err, "bq_project": BQ_PROJECT, "bq_dataset": BQ_DATASET}
    if not rows:
        return {"rows": [], "warning": (
            f"Practice_Heads_List exists in {BQ_FULL} but no rows came back. "
            f"Likely cause: every row has an empty EmployeeEmail. "
            f"Check the table contents in BigQuery."
        )}
    db = get_db(); cur = db.cursor()
    cur.execute("SELECT LOWER(email) AS email FROM users")
    existing = {r["email"] for r in cur.fetchall()}
    db.close()
    out = []
    for r in rows:
        already = r["email"] in existing
        out.append({
            **r,
            "would_create": not already,
            "status": "already_exists" if already else "ready",
        })
    return {
        "rows": out,
        "summary": {
            "total":      len(out),
            "to_create":  sum(1 for r in out if r["would_create"]),
            "skipped":    sum(1 for r in out if not r["would_create"]),
        },
    }


@app.post("/api/admin/users/practice-heads-import")
def admin_practice_heads_import(body: dict, admin: dict = Depends(require_admin)):
    """Create users for the selected Practice_Heads_List rows.

    Body: { emails: ["a@b.com", ...] }     # the lowercased emails to import.
                                            # If omitted, every "ready" row is imported.

    Each created user gets: role=user, full FEATURE_CATALOG granted, and a
    `department` data-scope entry with their EmployeeHierarchyNode. Returns
    per-row status + a temporary password so the admin can pass it on."""
    import bcrypt as _bcrypt
    from database import USE_POSTGRES

    selected_emails = {(e or "").strip().lower() for e in (body.get("emails") or [])}

    rows, err = _read_practice_heads_from_bq()
    if err:
        raise HTTPException(status_code=502, detail=err)
    if not rows:
        raise HTTPException(status_code=502, detail=f"Practice_Heads_List in {BQ_FULL} returned no rows with non-empty EmployeeEmail.")

    db = get_db(); cur = db.cursor()
    # Admin's company is reused — matches admin_create_user above.
    cur.execute("SELECT company_id FROM users WHERE id = ?", (int(admin["sub"]),))
    me = cur.fetchone()
    if not me:
        db.close()
        raise HTTPException(status_code=500, detail="Admin user not found")
    company_id = me["company_id"]

    cur.execute("SELECT LOWER(email) AS email FROM users")
    existing = {r["email"] for r in cur.fetchall()}

    results = []
    created_count = 0
    skipped_count = 0
    errored_count = 0

    feature_ids = [f["id"] for f in FEATURE_CATALOG]

    for r in rows:
        email = r["email"]
        name = r["resource_name"] or email.split("@")[0]
        practice = r["hierarchy_node"] or r["department"]

        # Honour the selection if the caller sent one; otherwise default to
        # every row that's not already in the system.
        if selected_emails and email not in selected_emails:
            continue

        if not email or "@" not in email:
            results.append({"email": email, "name": name, "status": "error",
                             "message": "missing or invalid email"})
            errored_count += 1
            continue

        if email in existing:
            results.append({"email": email, "name": name, "status": "skipped",
                             "message": "user with this email already exists"})
            skipped_count += 1
            continue

        try:
            temp_password = _random_temp_password(12)
            pw_hash = _bcrypt.hashpw(temp_password.encode(), _bcrypt.gensalt()).decode()
            if USE_POSTGRES:
                cur.execute(
                    "INSERT INTO users (email, password, full_name, role, company_id) "
                    "VALUES (?, ?, ?, ?, ?) RETURNING id",
                    (email, pw_hash, name, "user", company_id),
                )
                row = cur.fetchone()
                new_id = row["id"] if isinstance(row, dict) else row[0]
            else:
                cur.execute(
                    "INSERT INTO users (email, password, full_name, role, company_id) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (email, pw_hash, name, "user", company_id),
                )
                new_id = cur.lastrowid

            # Grant every feature in the catalog (per user's choice: full features).
            for fid in feature_ids:
                if USE_POSTGRES:
                    cur.execute(
                        "INSERT INTO user_features (user_id, feature_id) VALUES (?, ?) "
                        "ON CONFLICT DO NOTHING",
                        (new_id, fid),
                    )
                else:
                    cur.execute(
                        "INSERT OR IGNORE INTO user_features (user_id, feature_id) VALUES (?, ?)",
                        (new_id, fid),
                    )

            # Seed department scope so they only see their own practice once
            # the row-level scope wiring lands. Stores both the scope value
            # and a "scope is enforced" policy row.
            if practice:
                if USE_POSTGRES:
                    cur.execute(
                        "INSERT INTO user_data_scope_policy (user_id, dimension, enforced) "
                        "VALUES (?, ?, ?) ON CONFLICT (user_id, dimension) DO UPDATE "
                        "SET enforced = EXCLUDED.enforced",
                        (new_id, "department", 1),
                    )
                    cur.execute(
                        "INSERT INTO user_data_scope (user_id, dimension, value) "
                        "VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                        (new_id, "department", practice),
                    )
                else:
                    cur.execute(
                        "INSERT OR REPLACE INTO user_data_scope_policy (user_id, dimension, enforced) "
                        "VALUES (?, ?, ?)",
                        (new_id, "department", 1),
                    )
                    cur.execute(
                        "INSERT OR IGNORE INTO user_data_scope (user_id, dimension, value) "
                        "VALUES (?, ?, ?)",
                        (new_id, "department", practice),
                    )

            db.commit()  # commit per-row so a single bad row doesn't roll back the whole batch
            existing.add(email)
            results.append({
                "email":         email,
                "name":          name,
                "practice":      practice,
                "status":        "created",
                "user_id":       new_id,
                "temp_password": temp_password,
            })
            created_count += 1
        except Exception as e:
            db.rollback() if hasattr(db, "rollback") else None
            print(f"[practice-heads] error creating {email}: {e}")
            results.append({"email": email, "name": name, "status": "error",
                             "message": str(e)})
            errored_count += 1

    db.close()

    # Audit a single batch entry rather than per-user — keeps the log clean.
    try:
        audit_log.record(
            user=admin,
            action="user.bulk_import",
            resource_type="practice_heads",
            resource_id="batch",
            detail={"created": created_count, "skipped": skipped_count, "errored": errored_count},
        )
    except Exception:
        pass

    return {
        "results": results,
        "summary": {
            "created":  created_count,
            "skipped":  skipped_count,
            "errored":  errored_count,
        },
    }


@app.post("/api/admin/users/resync-practice-head-scopes")
def admin_resync_practice_head_scopes(admin: dict = Depends(require_admin)):
    """One-shot fixer for already-imported practice heads whose
    user_data_scope rows were stored with the WRONG value -- e.g. the
    parent label 'Capability (Functional)' instead of the comma-split leaf
    list ('SAP Finance', 'SAP Controlling'). Re-reads Practice_Heads_List
    from BigQuery, matches each row to an existing user by email, replaces
    that user's department scope rows in place. Idempotent."""
    rows, err = _read_practice_heads_from_bq()
    if err:
        raise HTTPException(status_code=502, detail=err)
    db = get_db()
    cur = db.cursor()
    updated, missing, skipped_empty = 0, 0, 0
    per_user = []  # detailed per-row outcome so the admin can verify all heads
    for r in rows:
        email = (r.get("email") or "").strip().lower()
        name  = (r.get("resource_name") or "").strip()
        if not email:
            per_user.append({"email": "", "name": name, "status": "skipped", "reason": "no email"})
            continue
        cur.execute("SELECT id FROM users WHERE email = ?", (email,))
        row = cur.fetchone()
        if not row:
            missing += 1
            per_user.append({"email": email, "name": name, "status": "no_user",
                             "reason": "no matching user account for this email"})
            continue
        uid = row["id"] if isinstance(row, dict) else row[0]
        dept_raw = r.get("department") or r.get("hierarchy_node") or ""
        leaves = [s.strip() for s in dept_raw.split(",") if s.strip()]
        if not leaves:
            skipped_empty += 1
            per_user.append({"email": email, "name": name, "status": "skipped",
                             "reason": "empty Department and hierarchy_node in Practice_Heads_List"})
            continue
        cur.execute(
            "DELETE FROM user_data_scope WHERE user_id = ? AND dimension = ?",
            (uid, "department"),
        )
        if USE_POSTGRES:
            cur.execute(
                "INSERT INTO user_data_scope_policy (user_id, dimension, enforced) "
                "VALUES (?, ?, ?) ON CONFLICT (user_id, dimension) DO UPDATE "
                "SET enforced = EXCLUDED.enforced",
                (uid, "department", 1),
            )
            for leaf in leaves:
                cur.execute(
                    "INSERT INTO user_data_scope (user_id, dimension, value) "
                    "VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                    (uid, "department", leaf),
                )
        else:
            cur.execute(
                "INSERT OR REPLACE INTO user_data_scope_policy (user_id, dimension, enforced) "
                "VALUES (?, ?, ?)",
                (uid, "department", 1),
            )
            for leaf in leaves:
                cur.execute(
                    "INSERT OR IGNORE INTO user_data_scope (user_id, dimension, value) "
                    "VALUES (?, ?, ?)",
                    (uid, "department", leaf),
                )
        updated += 1
        per_user.append({"email": email, "name": name, "status": "updated",
                         "leaves": leaves, "leaf_count": len(leaves)})
        # Bust the in-process scope-policy cache so the next chat
        # request recomputes the policy with the fresh scope rows.
        try:
            _scope_policy_cache.pop(int(uid), None)
        except Exception:
            pass
    db.commit()
    db.close()
    return {
        "summary": {
            "updated":       updated,
            "no_user":       missing,
            "skipped_empty": skipped_empty,
            "total_rows":    len(rows),
        },
        "per_user": per_user,
    }


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
    pg = USE_POSTGRES
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
# Workforce-scoping dimensions. Both pull distinct values from Employee_Data
# in the active BigQuery project (capability-agent-prod.Satori_Project on prod).
# Department maps to EmployeeHierarchyNode (top-level practice grouping).
# Practice Node maps to EmployeeHierarchyNode (the same column the Practice
# Heads import seeds against the user_data_scope table).
_SCOPE_DIMENSIONS = {
    "department": {"label": "Department", "bq_sql": (
        "SELECT DISTINCT TRIM(EmployeeHierarchyNode) AS value, TRIM(EmployeeHierarchyNode) AS label "
        "FROM `__BQ_FULL__`.Employee_Data "
        "WHERE EmployeeHierarchyNode IS NOT NULL AND TRIM(EmployeeHierarchyNode) != '' "
        "ORDER BY value LIMIT 200"
    )},
    "practice_node": {"label": "Practice Node", "bq_sql": (
        "SELECT DISTINCT TRIM(EmployeeHierarchyNode) AS value, TRIM(EmployeeHierarchyNode) AS label "
        "FROM `__BQ_FULL__`.Employee_Data "
        "WHERE EmployeeHierarchyNode IS NOT NULL AND TRIM(EmployeeHierarchyNode) != '' "
        "ORDER BY value LIMIT 500"
    )},
}


@app.get("/api/admin/lookups/{dimension}")
def admin_lookup_dimension(dimension: str, _: dict = Depends(require_superadmin)):
    """Return selectable values for a scope dimension (from BigQuery).
    Used to populate the department / practice-node checkboxes in the
    System Settings page."""
    if dimension not in _SCOPE_DIMENSIONS:
        raise HTTPException(status_code=400, detail=f"Unknown dimension '{dimension}'. Allowed: {list(_SCOPE_DIMENSIONS)}")
    # __BQ_FULL__ placeholder lets the dimension config stay project-agnostic;
    # swap it for the live BQ_FULL value at lookup time so the same dict works
    # across migrations between projects.
    sql = _SCOPE_DIMENSIONS[dimension]["bq_sql"].replace("__BQ_FULL__", BQ_FULL)
    r = bq_run_query(normalize_bq_project(sql), max_rows=500)
    if "error" in r:
        print(f"[/api/admin/lookups/{dimension}] BQ error: {r['error']}")
        raise HTTPException(status_code=500, detail=r["error"])
    rows = r.get("rows") or []
    return {"dimension": dimension, "label": _SCOPE_DIMENSIONS[dimension]["label"], "values": rows}


@app.get("/api/admin/users/{user_id}/scope")
def admin_get_user_scope(user_id: int, _: dict = Depends(require_superadmin)):
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
    admin: dict = Depends(require_superadmin),
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
    if USE_POSTGRES:
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
def admin_get_scope_dimensions(_: dict = Depends(require_superadmin)):
    """Return company-level dimension settings (which dimensions the admin has enabled).
    Plant is always present and enabled. Others default to disabled."""
    db = get_db()
    cur = db.cursor()
    cur.execute(
        "SELECT dimension, enabled FROM company_data_scope_dimensions WHERE company_id = ?",
        ("TMC",),
    )
    stored = {r["dimension"]: bool(r["enabled"]) for r in cur.fetchall()}
    db.close()
    # Build full catalog, merging stored state with defaults
    result = {}
    for dim, meta in _SCOPE_DIMENSIONS.items():
        # Default-on for both workforce dimensions. Neither is locked - the
        # superadmin can turn either off if the company decides scoping by
        # one of them is too restrictive.
        result[dim] = {
            "label": meta["label"],
            "enabled": stored.get(dim, True),
            "locked": False,
        }
    return {"dimensions": result}


@app.put("/api/admin/scope-dimensions")
def admin_set_scope_dimension(body: AdminDimensionToggle, admin: dict = Depends(require_superadmin)):
    """Toggle a company-level scope dimension on or off. Plant dimension cannot be disabled."""
    if body.dimension not in _SCOPE_DIMENSIONS:
        raise HTTPException(status_code=400, detail=f"Unknown dimension '{body.dimension}'")
    db = get_db()
    cur = db.cursor()
    if USE_POSTGRES:
        cur.execute(
            "INSERT INTO company_data_scope_dimensions (company_id, dimension, enabled, updated_at) "
            "VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT (company_id, dimension) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=CURRENT_TIMESTAMP",
            ("TMC", body.dimension, 1 if body.enabled else 0),
        )
    else:
        cur.execute(
            "INSERT OR REPLACE INTO company_data_scope_dimensions (company_id, dimension, enabled, updated_at) "
            "VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
            ("TMC", body.dimension, 1 if body.enabled else 0),
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


def _ai_opt_out(user_id: int) -> bool:
    """Whether a user has opted out of sending business data to the LLM.
    Reads user_settings if present; defaults to False (opt-in) otherwise."""
    try:
        db = get_db(); cur = db.cursor()
        cur.execute("SELECT ai_opt_out FROM user_settings WHERE user_id = ?", (user_id,))
        row = cur.fetchone()
        db.close()
        if not row:
            return False
        val = row["ai_opt_out"] if isinstance(row, dict) else row[0]
        return bool(val)
    except Exception:
        return False


def _get_user_plant_scope(user_id: int):
    """Returns the list of plant codes the user is restricted to, or None
    when unrestricted. With plant-scope governance not yet wired for TMC v2
    (workforce data isn't plant-partitioned the way SAP data was), this
    always returns None so admin SQL is unrestricted."""
    try:
        db = get_db(); cur = db.cursor()
        cur.execute(
            "SELECT value FROM user_data_scope WHERE user_id = ? AND dimension = 'plant'",
            (user_id,),
        )
        rows = cur.fetchall()
        db.close()
        if not rows:
            return None
        return [r["value"] if isinstance(r, dict) else r[0] for r in rows]
    except Exception:
        return None


def _get_user_scope_values(user_id: int, dimension: str) -> "list[str] | None":
    """Return the allowed values for any scope dimension on this user.
    None = unrestricted (no enforcement policy). [] = explicitly empty.
    Mirrors _get_user_dept_scope but parameterised on the dimension name."""
    try:
        db = get_db(); cur = db.cursor()
        cur.execute(
            "SELECT enforced FROM user_data_scope_policy "
            "WHERE user_id = ? AND dimension = ?",
            (user_id, dimension),
        )
        pol = cur.fetchone()
        if not pol:
            db.close(); return None
        enforced = pol["enforced"] if isinstance(pol, dict) else pol[0]
        if not bool(enforced):
            db.close(); return None
        cur.execute(
            "SELECT value FROM user_data_scope "
            "WHERE user_id = ? AND dimension = ? ORDER BY value",
            (user_id, dimension),
        )
        rows = cur.fetchall()
        db.close()
        return [(r["value"] if isinstance(r, dict) else r[0]) for r in rows]
    except Exception as e:
        print(f"[_get_user_scope_values] error for dimension={dimension}: {e}")
        return None


def _get_user_dept_scope(user_id: int):
    """Returns the list of department/practice values the user is restricted
    to (matches `Employee_Data.EmployeeHierarchyNode`), or None when unrestricted.

    Practice Heads imported via /api/admin/users/practice-heads-import get one
    scope entry each (their own practice). The chat / dashboard / report /
    Availability Engine handlers honour this by appending a "WHERE
    EmployeeHierarchyNode IN (...)" filter, both as a prompt addon for the AI
    AND as a server-side post-filter safety net.
    """
    try:
        db = get_db(); cur = db.cursor()
        # Honour the per-user enforcement policy: scope is only applied when
        # the policy row exists with enforced=1. This lets admins import a
        # user with scope values but temporarily disable enforcement during
        # transitions without losing the values.
        cur.execute(
            "SELECT enforced FROM user_data_scope_policy "
            "WHERE user_id = ? AND dimension = 'department'",
            (user_id,),
        )
        policy = cur.fetchone()
        if policy is not None:
            enforced = policy["enforced"] if isinstance(policy, dict) else policy[0]
            if not enforced:
                db.close()
                return None
        cur.execute(
            "SELECT value FROM user_data_scope WHERE user_id = ? AND dimension = 'department'",
            (user_id,),
        )
        rows = cur.fetchall()
        db.close()
        if not rows:
            return None
        return [r["value"] if isinstance(r, dict) else r[0] for r in rows]
    except Exception:
        return None


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


SYSTEM_PROMPT = """You are Satori, TMC's Capability Intelligence Agent. You help managers, HR teams, and sales leadership understand employee attendance patterns, timesheets, resource allocation, and sales account coverage.

### ABSOLUTE RULE #0 - NEVER FABRICATE DATA ###
Every numeric figure (counts, dates, percentages, hours, names of employees, departments, accounts, AMs) in your reply MUST come from a run_sql tool result that the user can see in this turn or a previous turn of THIS conversation. If run_sql returns 0 rows for an employee, department, or period, say "no records found" - do NOT invent days, hours, or status. If you don't know, ask the user to clarify. NEVER guess. NEVER round. NEVER paraphrase a real result with synthesized-looking numbers (e.g. "about 20 present days" when the SQL didn't return that). Especially for single-employee lookups: if run_sql returns 0 rows for that employee, say "I couldn't find attendance records for <name>" - do not assemble a plausible-looking attendance block.
### END RULE #0 ###


PERSONALITY:
- Friendly, professional, and concise.
- Use specific numbers, names, and dates in answers.
- Format times in 12-hour format (e.g., 9:37 AM).
- Format dollar amounts with $ and commas (e.g., $5,000,000).
- Round percentages to 1 decimal place.
- Never mention SQL, queries, tables, or columns to the user — translate everything into business language.
- If data seems unusual, flag it as a potential data quality issue.
- If no records found, suggest the user rephrase their question.
- Handle general conversation gracefully; use context for follow-up questions.
- You have access to: attendance records, timesheet data, resource allocation data, and sales account coverage (accounts, AM scorecards, pipeline, revenue targets, KPIs, hunting gaps, workload feasibility).

OUTPUT FORMATTING (CRITICAL):
Return PLAIN TEXT with light markdown. Use **bold** for emphasis (not <strong>),
lines starting with `- ` for bullet lists (not <ul>/<li>), blank lines to
separate paragraphs (not <p>). NEVER emit raw HTML tags — the UI does not
render them and the user will see literal angle brackets.

You help users analyse attendance, employee availability, project allocation, timesheets, capability scores, sales pipeline, account coverage, AM performance, and account-manager workload.

DATA WAREHOUSE — `ai-vertex-mahad.Satori_Project` (10 tables):

WORKFORCE TABLES
1. `Employee_Data` — Employee master. Cols: Employee_Code (STRING, "E-2141"), Resource_Name, EmployeePosition, EmployeeEmail, EmployeeHierarchyNode (department), EmployeeLocation (city), Employee_Status, Employee_Type ('MTO'/'Permanent'/'Probation'/'Contract'). Active filter: LOWER(Employee_Type) IN ('mto','permanent','probation').
2. `Attendance_Data` — Daily attendance per employee. Cols: attendance_date (DATE), personal_no (STRING, 'E-902' format — JOIN to Employee_Data on this), employee_id (INT64 sequence, NOT a JOIN key), employee_name, employee_email, checkin_time (STRING HH:MM:SS), checkout_time (STRING), attendance_status_text ('Present'/'Absent'/'Late'/'Leave'/etc.), is_present (0/1), is_absent (0/1), is_on_leave (0/1), is_remote (0/1), is_holiday (0/1), is_weekend (0/1), leave_type_name. For "late": LOWER(attendance_status_text) = 'late'.
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

JOINS — CRITICAL JOIN-KEY NORMALIZATION:
- Employee_Code is stored like "E-2141"; employee_id / TICKET_USER_ID are stored as bare numbers ("2141") or zero-padded. A direct CAST-to-STRING comparison returns ZERO matches and the join silently drops every row.
- ALWAYS normalize both sides: strip non-digits and leading zeros before comparing. Use this exact pattern:
    LTRIM(REGEXP_REPLACE(CAST(<col> AS STRING), r'[^0-9]', ''), '0')
- Employee_Data → Attendance_Data: JOIN on a.personal_no (Attendance_Data's STRING employee-code column like 'E-902', NOT the INT64 employee_id which is an unrelated sequence number)
    LEFT JOIN Attendance_Data a
      ON LTRIM(REGEXP_REPLACE(CAST(e.Employee_Code AS STRING), r'[^0-9]', ''), '0')
       = LTRIM(REGEXP_REPLACE(CAST(a.personal_no   AS STRING), r'[^0-9]', ''), '0')
- Employee_Data → Allocation_data: JOIN on a.employee_id (Allocation_data's employee_id IS the 'E-2141' code).
- Employee_Data → Timesheet_Data: same pattern, on t.TICKET_USER_ID.
- Always use LEFT JOIN (not INNER) so attendance rows aren't dropped when the lookup table doesn't have a matching row.
- EmployeeHierarchyNode is the DEPARTMENT field. Group by COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''), 'Unspecified') AS department.
- Sales tables: share `AM` (Sales_Pipeline_Health uses `Salesperson` ≈ AM).

DATA QUALITY:
- allocation_percent, TICKET_HOURS, Sales_* USD/visit fields, win-rate decimals — STRING. Always SAFE_CAST AS FLOAT64 / INT64 before arithmetic.
- Win-rate columns are decimals (0.32 = 32%); multiply by 100 for display.
- For department grouping: COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''), 'Unspecified').

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


ATTENDANCE_BEHAVIOR_ADDON = """
--- ATTENDANCE QUESTION DEFAULTS ---

NO FABRICATION: every figure below MUST come from a run_sql result you actually executed in this turn. If your SQL returns 0 rows for the user's scope + period, the answer is "no attendance records found for <departments> in <period>" - DO NOT invent present_days, absent_days, missing-punch counts, or working-day math when there are no underlying rows. If a single employee has 0 rows in the period, say "no attendance records for <name> in <period>" - do not synthesize a 21-day plausible-looking block.

When the user asks about attendance for a period (a month, a week, a date range):

1. PER-EMPLOYEE BREAKDOWN BY DEFAULT. Issue ONE run_sql call that returns
   one row per active employee in scope: employee_name, employee_email,
   total_rows, present_days, late_days, absent_days, leave_days,
   remote_days, missing_punch_days. Order by absent_days DESC (worst
   attendance first). DO NOT cap inside SQL -- return every employee.
   Use COUNTIF(...) over Attendance_Data filtered to the period, joined to
   Employee_Data via the standard digits-only employee-id rule + the
   EmployeeHierarchyNode IN (...) scope filter from the USER CONTEXT block.

2. CALENDAR vs WORKING DAYS. For a named month (e.g. "March 2026"):
     calendar_days = DATE_DIFF(LAST_DAY, FIRST_DAY, DAY) + 1.
     weekend_days  = COUNTIF of dates where is_weekend = 1.
     holiday_days  = COUNTIF of dates where is_holiday = 1 (de-duped).
     working_days  = calendar_days - weekend_days - holiday_days.
   Compute attendance rate against working_days, NOT calendar_days.

3. RESPONSE LAYOUT -- PAGINATED.
   Open with a 1-2 line summary stating: department(s), period,
   calendar days, weekend days, holiday days, working days, total
   employees found (N), average attendance rate.
   Then bullet ONLY THE FIRST 20-25 employees from the SQL result
   (already sorted worst-first). Format each as:
     **<name>** - present X / W (Y%), absent Z, leave L, remote R, missing M
   where W = working_days.
   If N > 25, end the message with EXACTLY this line so the user knows
   how to drill in:
     "Showing 25 of N. Reply 'show next 25' or 'show all' for the rest."
   If N <= 25, show all and skip the prompt.

4. FOLLOW-UP HANDLING -- ZERO NEW QUERIES.
   The full SQL result from step 1 is already in your conversation history
   as a function_response (tool result block). For these follow-ups,
   re-read THAT existing result -- do NOT call run_sql again:
     "who missed the most days"   -> show top N by absent_days from prev
     "who was here every day"     -> filter prev rows present_days = working_days
     "show next 25"               -> next 25 bullets from prev rows
     "show all"                   -> every employee from prev rows
     "show me [name]"             -> just that one row from prev rows
   Re-running run_sql for a follow-up risks getting a different result
   (different snapshot, schema drift) and burns tokens. Only call run_sql
   again if the user changes the PERIOD or the DEPARTMENT FILTER.

5. NEVER report calendar_days as the denominator for attendance rate.
   Always call out weekends + holidays separately.

6. INJECTED-DATA EXCEPTION. If the user's turn already includes a TMC LIVE
   DATA block with per-employee figures, format them per the rules above
   instead of re-querying.
--- END ATTENDANCE QUESTION DEFAULTS ---
"""

VOICE_SYSTEM_PROMPT_URDU = """### ABSOLUTE RULE #0 — NEVER FABRICATE DATA. TOOLS FIRST, ALWAYS. ###
You have two tools: `run_sql(sql)` for BigQuery queries (use for every TMC figure) and `end_call(reason)` to hang up when the user says goodbye.

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

VOICE_SYSTEM_PROMPT_EN = """You are Satori, TMC's Capability Intelligence voice agent. You answer ANY question about TMC's workforce + sales data by calling the run_sql tool. You speak the answer in plain conversational English (or Urdu if the user spoke Urdu).

═══ TOOLS YOU HAVE ═══

1. run_sql(sql) — runs a BigQuery SELECT against `ai-vertex-mahad.Satori_Project`.
   CALL THIS for every TMC data question. No exceptions.
2. end_call(reason) — hangs up the call. Call ONLY when the user says goodbye.

═══ DATA QUESTION FLOW (do exactly this) ═══

When the user asks ANY question about TMC data:
  STEP 1: Call run_sql with a BigQuery SELECT that answers their question.
  STEP 2: After the tool returns numbers, speak the answer in 1-2 sentences.

DO NOT say "I don't have access" — you DO have access via run_sql. CALL THE TOOL.
DO NOT say "let me check" without calling the tool — actually call run_sql.
DO NOT answer from memory.

═══ run_sql EXAMPLES (mimic these patterns — these cover most question types) ═══

[A] OVERALL ATTENDANCE RATE TODAY
User: "What's today's attendance rate?"
  → run_sql: SELECT ROUND(100.0*SUM(is_present)/NULLIF(COUNT(*),0),1) AS rate FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` WHERE attendance_date = CURRENT_DATE()
  → Speak: "Today's attendance rate is about 87 percent."

[B] SINGLE EMPLOYEE — FULL MONTHLY BREAKDOWN
User: "Tell me about Mahad's attendance for March."
  → run_sql: SELECT SUM(is_present) AS present, SUM(is_absent) AS absent, SUM(is_on_leave) AS on_leave, SUM(is_remote) AS remote, COUNTIF(LOWER(attendance_status_text)='missing punch') AS missing_punch, COUNT(*) AS total_days FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` WHERE LOWER(employee_name) LIKE '%mahad%' AND attendance_date BETWEEN DATE '2026-03-01' AND DATE '2026-03-31'
  → Speak: "In March, Mahad was present 19 days, on leave 1 day, with 4 weekends and 7 other non-working days. No absences."

[C] SINGLE EMPLOYEE — SPECIFIC DAY'S CHECKIN/CHECKOUT
User: "What time did Mahad check in on Monday?"
  → run_sql: SELECT attendance_date, checkin_time, checkout_time, attendance_status_text FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` WHERE LOWER(employee_name) LIKE '%mahad%' AND attendance_date = DATE '2026-03-17' LIMIT 1
  → Speak: "On Monday March 17th, Mahad checked in at 9:32 AM and checked out at 6:15 PM."

[D] SINGLE EMPLOYEE — AVERAGE CHECKIN OVER A PERIOD
User: "What's Mahad's average checkin time this month?"
  → run_sql: SELECT FORMAT_TIME('%I:%M %p', TIME(TIMESTAMP_SECONDS(CAST(AVG(UNIX_SECONDS(TIMESTAMP(CONCAT('2000-01-01 ', checkin_time)))) AS INT64)))) AS avg_in FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` WHERE LOWER(employee_name) LIKE '%mahad%' AND attendance_date BETWEEN DATE_TRUNC(CURRENT_DATE(),MONTH) AND CURRENT_DATE() AND is_present=1 AND checkin_time IS NOT NULL
  → Speak: "Mahad's average checkin this month is about 9:18 AM."

[D2] SIMPLER FALLBACK — list per-day checkin/checkout for the period
  → run_sql: SELECT attendance_date, checkin_time, checkout_time FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` WHERE LOWER(employee_name) LIKE '%mahad%' AND attendance_date BETWEEN DATE '2026-03-01' AND DATE '2026-03-31' AND is_present=1 ORDER BY attendance_date

[E] TOP ABSENTEES
User: "Who are the top absentees this month?"
  → run_sql: SELECT employee_name, SUM(is_absent) AS absent_days FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` WHERE attendance_date BETWEEN DATE_TRUNC(CURRENT_DATE(),MONTH) AND CURRENT_DATE() GROUP BY employee_name HAVING absent_days > 0 ORDER BY absent_days DESC LIMIT 5
  → Speak: "Top absentees this month: Ali Khan with 4 days, Sara Ahmed with 3 days, Hassan Malik with 3 days, Fatima Sheikh with 2 days, Bilal Iqbal with 2 days."

[F] DEPARTMENT-LEVEL ATTENDANCE
User: "Attendance rate by department for March?"
  → run_sql: SELECT COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''),'Unspecified') AS dept, ROUND(100.0*SUM(a.is_present)/NULLIF(COUNT(*),0),1) AS rate FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` a LEFT JOIN `{BQ_FULL}.Employee_Data` e ON UPPER(TRIM(e.Resource_Name))=UPPER(TRIM(a.employee_name)) WHERE a.attendance_date BETWEEN DATE '2026-03-01' AND DATE '2026-03-31' GROUP BY dept ORDER BY rate DESC LIMIT 10
  → Speak: "SAP Finance leads March at 94 percent, SAP Supply Chain at 91, Professional Services at 89, KPO at 85, and Emerging Tech at 82."

[G] BENCH SIZE
User: "How many people are on the bench?"
  → run_sql: WITH a AS (SELECT emp_name, MAX(SAFE_CAST(allocation_percent AS FLOAT64)) AS mp FROM `ai-vertex-mahad.Satori_Project.Allocation_data` GROUP BY emp_name) SELECT COUNT(*) AS n FROM a WHERE COALESCE(mp,0) = 0
  → Speak: "About 142 people are currently on the bench."

[H] LIST OF BENCHED EMPLOYEES
User: "Who's on the bench right now?"
  → run_sql: WITH a AS (SELECT emp_name, MAX(SAFE_CAST(allocation_percent AS FLOAT64)) AS mp, ANY_VALUE(emp_competency) AS comp FROM `ai-vertex-mahad.Satori_Project.Allocation_data` GROUP BY emp_name) SELECT emp_name, comp FROM a WHERE COALESCE(mp,0) = 0 ORDER BY emp_name LIMIT 20
  → Speak: "On the bench right now: Ahmed Khan with SAP Finance skills, Sara Ali with ABAP, Hassan Malik with Emerging Tech, and 12 others."

[I] TOP AM
User: "Who's leading Q1 sales?"
  → run_sql: SELECT AM, SAFE_CAST(Q1_ACH AS FLOAT64) AS ach FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` ORDER BY ach DESC NULLS LAST LIMIT 3
  → Speak: "Sehrish leads Q1 at about 2.4 million USD, followed by Zain Haider at 1.9 million and Atif Ahmed at 1.6 million."

[J] ACCOUNT COVERAGE FOR AN AM
User: "How many accounts does Sehrish cover?"
  → run_sql: SELECT Tier, COUNT(*) AS n FROM `ai-vertex-mahad.Satori_Project.Sales_Accounts` WHERE LOWER(AM) LIKE '%sehrish%' GROUP BY Tier
  → Speak: "Sehrish covers 12 tier-A accounts, 28 tier-B, and 9 tier-C — 49 accounts total."

[K] TIMESHEET HOURS
User: "How many hours did the team log on Project Alpha last week?"
  → run_sql: SELECT SUM(SAFE_CAST(TICKET_HOURS AS FLOAT64)) AS total_hrs FROM `ai-vertex-mahad.Satori_Project.Timesheet_Data` WHERE LOWER(TICKET_PROJECT_LABEL) LIKE '%alpha%' AND SAFE.PARSE_DATE('%Y%m%d', CAST(DATE_KEY AS STRING)) BETWEEN DATE_SUB(CURRENT_DATE(),INTERVAL 7 DAY) AND CURRENT_DATE()
  → Speak: "The team logged about 312 hours on Project Alpha last week."

CRITICAL: If you are not sure which exact column to use, STILL CALL run_sql with your best-guess SELECT. The system will return the actual columns and rows, and you can read them aloud. NEVER say "I don't have access" — that is a lie, you have access via run_sql.

═══ KEY TABLES (ai-vertex-mahad.Satori_Project) ═══

WORKFORCE
  • Employee_Data — Employee_Code, Resource_Name, EmployeePosition, EmployeeHierarchyNode (department), EmployeeLocation, Employee_Type, Joining_Date, Gender. Active filter: LOWER(Employee_Type) IN ('mto','permanent','probation','contractual fixed term').
  • Attendance_Data — attendance_date (DATE), personal_no (STRING 'E-902' — JOIN to Employee_Data on this), employee_id (INT64 sequence, not a JOIN key), employee_name, employee_email, checkin_time (STRING HH:MM:SS — for the moment they checked in), checkout_time (STRING HH:MM:SS — for the moment they checked out), attendance_status_text ('Present'/'Absent'/'Weekend'/'Holiday'/'On Leave'/'Missing Punch'/'Remote Work'), is_present, is_absent, is_on_leave, is_remote, is_holiday, is_weekend (all 0/1). NO 'Late' status — closest concept is 'Missing Punch'.
  • Allocation_data — project_id, employee_id, emp_name, allocation_percent (STRING — SAFE_CAST AS FLOAT64), emp_competency, Flag ('Allocated'/'Bench'), Date, Week, Year, Month.
  • Timesheet_Data — TICKET_USER_ID, TICKET_NUMBER, TICKET_PROJECT_LABEL, TICKET_HOURS (STRING — SAFE_CAST AS FLOAT64), TICKET_STATUS, DATE_KEY (INT YYYYMMDD — use SAFE.PARSE_DATE('%Y%m%d', CAST(DATE_KEY AS STRING)) for date filters).

SALES
  • Sales_AM_Scorecard — VP, AM, Role, City, col_2026_Target, Q1_ACH, Open_Pipeline (all STRING USD — SAFE_CAST AS FLOAT64), Hist_Win_Rate (decimal 0-1, multiply by 100 for %).
  • Sales_Accounts — VP, AM, Location, Account, Tier (A/B/C), Dormant ('Yes'/'No'), Jan_Visits, Feb_Visits, Mar_Visits, Q1_Visits (STRING — SAFE_CAST).
  • Sales_Pipeline_Health — Salesperson, Open_Pipeline (USD STRING), Open_Deals, Win_Rate_by.
  • Sales_Plan_vs_Pipeline — AM, col_2026_Target, Q1_ACH, CRM_Pipeline, Coverage_Ratio, Status.
  • Sales_Hunting_Gap — AM, City, Hunting_Target, Hunting_Achieved, Hunting_Gap.

DEPARTMENTS (real EmployeeHierarchyNode values): SAP Supply Chain, SAP Finance, SAP ABAP & Fiori, SAP HCM & SLCM, Professional Services, Emerging Tech, KPO, SAP SF & Workday, SAP EAM, SAP Basis, LMS & UniTime, SAP Controlling, PMO Islamabad, Qlik, SAP Analytics, Cloud, Account Management, Finance, BOD, Marketing, HR Ops, IT, Admin, Textile.

JOIN RULE (the only working one): Employee_Data ↔ Attendance/Allocation on names:
  ON UPPER(TRIM(e.Resource_Name)) = UPPER(TRIM(a.employee_name))
NOT on Employee_Code = employee_id — those are different ID systems and don't overlap.

═══ STYLE ═══
  • Voice answers: 1-2 sentences. No tables, no lists — you're speaking.
  • Round numbers for speech: "about 87 percent", not "87.523 percent". "$2.4 million", not "2,402,938 dollars".
  • Match the user's language exactly: English in → English out. Urdu in → Urdu out (Roman Urdu pronunciation is fine, e.g. "Mahad ka attendance is mahine 87 percent raha"). Never mix languages in one reply.
  • Never expose individual salary or HR-confidential PII.

═══ OPENING GREETING ═══
When the system sends "Greet the user now with your opening line", reply with EXACTLY:
  English: "Hi, I'm Satori. How can I help you today?"
  Urdu:    "Assalamu alaikum. Mera naam Satori hai. Main aap ki kaise madad kar sakti hoon?"
Pick English by default. No other text.

═══ ENDING THE CALL ═══
When the user says goodbye (bye / goodbye / see you / take care / that's all / we're done / Allah hafiz / Khuda hafiz / alvida / bas / chalo phir):
  STEP 1: Speak a short warm farewell in their language ("Take care, goodbye!" or "Allah hafiz, khayal rakhiye ga.").
  STEP 2: Call the end_call tool with reason='farewell'.
DO NOT call end_call on casual "thanks" or other mid-conversation acknowledgements.

═══ OUT-OF-SCOPE ═══
If the user asks about something outside TMC workforce + sales data (general knowledge, weather, jokes, sports, coding, recipes, etc.), respond ONCE with: "I'm Satori — I only answer questions about TMC's workforce and sales data. Ask me about attendance, allocation, pipeline, or AM performance." Then wait. NOT a reason to call end_call.
"""


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    text: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    voice_mode: bool = False
    # Use Optional[...] not int | None — broadest Pydantic v1/v2 compat.
    conversation_id: Optional[int] = None


_CHAT_SQL_TOOL = genai.types.Tool(function_declarations=[
    genai.types.FunctionDeclaration(
        name="run_sql",
        description=(
            "Run a BigQuery SQL SELECT/WITH query against the company's SAP ERP mirror "
            "(project capability-agent-prod, dataset sap_hana_mirror). "
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
                    description="A valid BigQuery SQL SELECT/WITH query with fully-qualified table names like `capability-agent-prod.Satori_Project.fact_material_stock_daily`.",
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


def _dept_scope_addon_str(dept_scope: "list[str] | None") -> str:
    """Build the system-prompt fragment that tells Gemini the user is scoped
    to one or more departments / practices. Returns empty string when the
    user has no scope (admin or unrestricted). The addon names the exact
    BigQuery column (EmployeeHierarchyNode) so the model knows where to filter."""
    if dept_scope is None:
        return ""
    if not dept_scope:  # empty list = no access
        return (
            "\n\n--- USER DEPARTMENT SCOPE RESTRICTION ---\n"
            "This user has no departments assigned in their scope - return no "
            "workforce data. State that they do not have data access configured "
            "yet and that an admin needs to assign departments via System Settings.\n"
            "--- END SCOPE RESTRICTION ---"
        )
    quoted = ", ".join(f"'{d}'" for d in dept_scope)
    return (
        "\n\n--- USER DEPARTMENT SCOPE RESTRICTION ---\n"
        f"This user is restricted to department(s) / practice node(s): "
        f"{', '.join(dept_scope)}.\n"
        f"Every SQL query you write against workforce tables (Employee_Data, "
        f"Allocation_data, Timesheet_Data, Attendance_Data, Practice_Heads_List) "
        f"MUST include an AND clause that filters by EmployeeHierarchyNode. "
        f"Use: AND EmployeeHierarchyNode IN ({quoted}) on Employee_Data, and join "
        f"to Employee_Data via the employee id (REGEXP_EXTRACT digits, LTRIM "
        f"leading zeros) for tables that don't carry EmployeeHierarchyNode directly. "
        f"NEVER return employee, attendance, allocation, timesheet, or practice "
        f"data for departments outside this list. Sales tables (Sales_*) are NOT "
        f"department-scoped - those remain visible to scoped users.\n"
        "--- END SCOPE RESTRICTION ---"
    )


def _enforce_dept_scope_on_sql(sql: str, dept_scope: "list[str] | None") -> str:
    """Server-side safety net: rewrite SQL to inject the EmployeeHierarchyNode
    filter when the user has a dept scope AND the SQL references a workforce
    table. Best-effort - if the SQL doesn't contain a recognisable workforce
    table reference, it's returned untouched.

    For an empty scope ([]) returns a zero-row sentinel so the AI gets
    nothing back and can't fall through to non-scoped data.
    """
    if dept_scope is None:
        return sql
    if not dept_scope:
        return "SELECT 'NO_ACCESS' AS _scope_error LIMIT 0"

    sql_upper = sql.upper()
    workforce_tables = ("EMPLOYEE_DATA", "ALLOCATION_DATA", "TIMESHEET_DATA",
                         "ATTENDANCE_DATA", "PRACTICE_HEADS_LIST")
    if not any(t in sql_upper for t in workforce_tables):
        return sql

    # Only safe to inject EmployeeHierarchyNode when Employee_Data is in the SQL
    # (directly queried or LEFT-JOINed). If the SQL touches workforce data
    # but doesn't join to Employee_Data, we CANNOT enforce the dept scope -
    # silently passing the query through would leak cross-department rows
    # to a scoped user. Instead return a refusal sentinel that Gemini sees
    # as the tool result and retries with the required join.
    if "EMPLOYEE_DATA" not in sql_upper:
        return ("SELECT 'SCOPE_REFUSED' AS _error, "
                "'Re-run this query with a LEFT JOIN to Employee_Data via "
                "the digits-only employee id - the dept-scope filter on "
                "EmployeeHierarchyNode can only be applied through that join.' "
                "AS _message LIMIT 0")

    quoted = ", ".join("'" + str(v).replace("'", "''") + "'" for v in dept_scope)
    scope_clause = (
        f"COALESCE(NULLIF(TRIM(EmployeeHierarchyNode), ''), 'Unspecified') IN ({quoted})"
    )

    # Find the outermost (depth-0) WHERE keyword, same scanning approach as
    # _enforce_plant_scope_in_sql, then inject `scope_clause AND (` after it.
    depth = 0
    last_where_at_depth0 = -1
    i = 0
    while i < len(sql):
        c = sql[i]
        if c in ("'", '"'):
            q = c; i += 1
            while i < len(sql) and sql[i] != q:
                if sql[i] == '\\': i += 1
                i += 1
        elif c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif depth == 0 and sql_upper[i:i+5] == "WHERE":
            before_ok = (i == 0 or (not sql[i-1].isalnum() and sql[i-1] != '_'))
            after_ok  = (i+5 >= len(sql) or (not sql[i+5].isalnum() and sql[i+5] != '_'))
            if before_ok and after_ok:
                last_where_at_depth0 = i
        i += 1

    if last_where_at_depth0 >= 0:
        insert_at = last_where_at_depth0 + len("WHERE")
        return (sql[:insert_at] + f" {scope_clause} AND (" + sql[insert_at:].lstrip() + ")")

    # No outermost WHERE - inject before GROUP BY / ORDER BY / LIMIT / HAVING
    for kw in ("GROUP BY", "ORDER BY", "HAVING", "LIMIT"):
        depth = 0
        klen = len(kw)
        for j in range(len(sql) - klen + 1):
            c = sql[j]
            if c == '(': depth += 1
            elif c == ')': depth -= 1
            if depth == 0 and sql_upper[j:j+klen] == kw:
                before_ok = (j == 0 or (not sql[j-1].isalnum() and sql[j-1] != '_'))
                after_ok  = (j+klen >= len(sql) or (not sql[j+klen].isalnum() and sql[j+klen] != '_'))
                if before_ok and after_ok:
                    return sql[:j] + f"WHERE {scope_clause}\n" + sql[j:]

    return sql.rstrip().rstrip(";") + f"\nWHERE {scope_clause}"


# ============================================================================
# Gatekeeper scope agent (new design)
# ----------------------------------------------------------------------------
# When a user opens chat / voice for the first time in this process, we
# call Gemini with their name + department + role and ask it to write a
# scope policy in natural language. The policy is cached per user_id for
# the process lifetime so subsequent requests don't pay the LLM latency.
# The policy is then prepended to every system prompt - chat, voice,
# dashboard refine, report refine - so the main agent treats it as a
# hard rule. Out-of-scope questions get a fixed refusal phrase.
# ============================================================================

_scope_policy_cache: "dict[int, str]" = {}

_SCOPE_AGENT_PROMPT = """You are the Satori Data-Access Policy Agent at TallyMarks Consulting (TMC).

A user is signing in to Satori. Based on their role and the department they head, decide what workforce data they should be allowed to query through the main Satori agent, and write that policy as direct instructions to the main agent.

USER:
- Name: {name}
- Department they head (or work in): {department}
- Role: {role}

WAREHOUSE CONTEXT:
- Workforce data tables in `capability-agent-prod.Satori_Project`:
  * Employee_Data (EmployeeHierarchyNode column = department)
  * Attendance_Data (JOIN on personal_no, NOT employee_id)
  * Allocation_data (joined via employee_id)
  * Timesheet_Data (joined via TICKET_USER_ID)
  * Practice_Heads_List
- Sales data tables in the same project (Sales_Accounts, Sales_AM_Scorecard, Sales_Pipeline_Health, Sales_Plan_vs_Pipeline, Sales_Hunting_Gap, Sales_KPI_Scorecard, Sales_Dormant_Accounts, Sales_Workload_Feasibility, Account_Coverage_Plan__*, Project_Master) are shared - everyone sees them.

OUTPUT (return ONLY the addon text, no preamble, no markdown headers):

USER CONTEXT - {name} (departments: {department_list_quoted})

DATA ACCESS POLICY (treat as a HARD rule for every query you write):
- Workforce queries (Employee_Data, Attendance_Data, Allocation_data, Timesheet_Data, Practice_Heads_List): restrict to employees whose EmployeeHierarchyNode is in this exact list: {department_list_quoted}. {name} heads {departments_count} department(s) and ONLY those. NEVER return employee, attendance, allocation, timesheet, or practice data for any other department - not even by fuzzy / partial / similar-name match. "Cloud Engineering" is NOT "Cloud", "SAP Finance team" is NOT "Finance", etc. If the user names a dept not exactly in the list above, treat it as out of scope.
- Sales queries (Sales_*, Account_Coverage_Plan__*, Project_Master): full visibility, no restriction.
- Admin-only data (other users' login history, audit logs, system settings): NO access.

REQUIRED SQL JOIN PATTERN (copy this verbatim - do not invent variants, the IN clause is REQUIRED even for a single dept):

  -- Attendance scoped to {name}'s departments:
  SELECT a.*, e.Resource_Name, e.EmployeeHierarchyNode
  FROM `capability-agent-prod.Satori_Project.Attendance_Data` a
  INNER JOIN `capability-agent-prod.Satori_Project.Employee_Data` e
    ON LTRIM(REGEXP_REPLACE(CAST(a.personal_no AS STRING), r'[^0-9]', ''), '0')
     = LTRIM(REGEXP_REPLACE(CAST(e.Employee_Code AS STRING), r'[^0-9]', ''), '0')
  WHERE e.EmployeeHierarchyNode IN ({department_list_quoted})
    AND LOWER(COALESCE(e.Employee_Type, '')) IN ('mto','permanent','probation')

  -- For Allocation_data, use a.employee_id (it's the 'E-2141' code) NOT personal_no.
  -- For Timesheet_Data, use a.TICKET_USER_ID (bare digits like '1643').

Use INNER JOIN (not LEFT) when scoped, so employees outside the dept can't sneak in via NULL-matches. The IN clause is REQUIRED even when {departments_count} = 1.

OUT-OF-SCOPE BEHAVIOUR: if {name} asks about employees / attendance / allocation / timesheets / practice heads in ANY department whose name is not EXACTLY one of {department_list_quoted}, reply with EXACTLY:
  "I don't have that data available for your role - it's outside your department's scope ({department_list_human})."
Do NOT fuzzy-match. Do NOT suggest a related-sounding dept. Do NOT show employee names or counts from any other dept. Just the refusal phrase.

ADDRESSING: Greet and address {name} by their first name (first word of their name) whenever it sounds natural. Sign off with their first name when appropriate.
"""


def _admin_unrestricted_addon(user: dict) -> str:
    """Admins (including superadmin) get unrestricted access. We still
    prepend the user-context block so the main agent addresses them by
    name and knows their role."""
    name = (user.get("name") or user.get("full_name") or "Admin").strip()
    first = name.split()[0] if name else "Admin"
    return (
        f"\n\nUSER CONTEXT - {name} (role: admin)\n"
        f"DATA ACCESS POLICY: unrestricted. {first} can query any table "
        f"in capability-agent-prod.Satori_Project including cross-"
        f"department workforce data and all sales data.\n"
        f"ADDRESSING: address {first} by their first name when natural.\n"
    )


def _compute_scope_policy(user: dict) -> str:
    """Call Gemini once (per user_id, per process) to compute the scope
    policy text. Cached forever (process restart re-computes). For admins
    we skip the LLM call and return a deterministic unrestricted policy.
    Returns the system-prompt-addon text the main agent will treat as
    a hard rule."""
    try:
        uid = int(user.get("sub") or user.get("id") or 0)
    except Exception:
        uid = 0
    if uid in _scope_policy_cache:
        return _scope_policy_cache[uid]

    role = (user.get("role") or "user").strip().lower()
    if role == "admin":
        addon = _admin_unrestricted_addon(user)
        _scope_policy_cache[uid] = addon
        return addon

    name = (user.get("name") or user.get("full_name") or "User").strip() or "User"
    first = name.split()[0] if name else "User"

    # Load EVERY dept scope row for this user (no LIMIT 1) so practice
    # heads who cover multiple leaves get all of them in the policy.
    dept_values: list[str] = []
    try:
        from database import get_db
        db = get_db(); cur = db.cursor()
        cur.execute(
            "SELECT value FROM user_data_scope WHERE user_id = ? "
            "AND dimension = 'department' ORDER BY value",
            (uid,),
        )
        rows = cur.fetchall() or []
        db.close()
        for r in rows:
            v = (r["value"] if isinstance(r, dict) else r[0])
            if v:
                dept_values.append(str(v).strip())
    except Exception as e:
        print(f"[scope-agent] could not load dept rows for user {uid}: {e}")

    # Empty -> unrestricted fallback so chat keeps working.
    if not dept_values:
        addon = (
            f"\n\nUSER CONTEXT - {name}\n"
            f"DATA ACCESS POLICY: unrestricted (no department assigned).\n"
            f"ADDRESSING: address {first} by their first name when natural.\n"
        )
        _scope_policy_cache[uid] = addon
        print(f"[scope-agent] uid={uid} has no dept scope rows -> unrestricted fallback")
        return addon

    # Build the formats the prompt template expects.
    department_list_quoted = ", ".join(f'"{d}"' for d in dept_values)  # for SQL IN clause
    department_list_human  = ", ".join(dept_values)                     # human-readable
    departments_count      = len(dept_values)

    try:
        client = get_genai_client()
        prompt = _SCOPE_AGENT_PROMPT.format(
            name=name,
            role=role,
            department=department_list_human,  # legacy single-dept placeholder, kept for any leftover refs
            department_list_quoted=department_list_quoted,
            department_list_human=department_list_human,
            departments_count=departments_count,
        )
        resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[genai.types.Content(
                role="user",
                parts=[genai.types.Part(text=prompt)],
            )],
            config=genai.types.GenerateContentConfig(
                temperature=0.2,
                max_output_tokens=800,
            ),
        )
        addon_text = (resp.text or "").strip()
        if not addon_text:
            raise RuntimeError("scope agent returned empty text")
        addon = "\n\n" + addon_text + "\n"
        _scope_policy_cache[uid] = addon
        print(f"[scope-agent] computed policy for uid={uid} depts={dept_values}")
        return addon
    except Exception as e:
        print(f"[scope-agent] FAILED for uid={uid} depts={dept_values}: {e}")
        # Static fallback so chat keeps working even if Gemini is down.
        addon = (
            f"\n\nUSER CONTEXT - {name} (departments: {department_list_human})\n"
            f"DATA ACCESS POLICY: Workforce queries are HARD-restricted to "
            f"EmployeeHierarchyNode IN ({department_list_quoted}). "
            f"NEVER return rows for any other department. The IN clause is "
            f"required on every workforce JOIN. Sales tables unrestricted.\n"
            f"OUT-OF-SCOPE REPLY: if asked about any other department, "
            f"reply EXACTLY: \"I don't have that data available for your "
            f"role - it's outside your department's scope "
            f"({department_list_human}).\" Do NOT fuzzy-match similar names.\n"
            f"ADDRESSING: call {first} by their first name when natural.\n"
        )
        _scope_policy_cache[uid] = addon
        return addon


def _user_context_addon(user: dict) -> str:
    """Thin wrapper: returns the cached / freshly-computed scope-policy
    addon for this user. Safe to call on every chat/voice/dashboard/
    report request - the underlying agent call only fires on the FIRST
    call per user_id per process."""
    if not user:
        return ""
    return _compute_scope_policy(user)


def _log_chat_error(user: dict, user_message: str, sql_attempted: str,
                    bq_error: str, source: str) -> None:
    """Persist a chat error to data_access_log so the superadmin can see
    what went wrong via /api/admin/chat-errors. Silent if the write
    fails (we don't want logging itself to break the chat reply)."""
    try:
        from database import get_db
        import json as _json
        db = get_db(); cur = db.cursor()
        detail = _json.dumps({
            "source":        source,
            "user_message":  (user_message or "")[:2000],
            "sql_attempted": (sql_attempted or "")[:4000],
            "bq_error":      (bq_error or "")[:2000],
        })
        cur.execute(
            "INSERT INTO data_access_log (user_id, user_email, action, "
            "resource_type, resource_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
            (
                int(user.get("sub") or 0) or None,
                (user.get("email") or "").strip().lower() or None,
                "chat.error",
                "chat",
                None,
                detail,
            ),
        )
        db.commit()
        db.close()
    except Exception as e:
        print(f"[chat.error] could not persist chat error (continuing): {e}")


@app.get("/api/admin/chat-errors")
def admin_chat_errors(limit: int = 100, admin: dict = Depends(require_superadmin)):
    """Superadmin-only: latest chat errors with the SQL Gemini ran and
    the BQ error message. End users never see this -- the chat UI shows
    them only Gemini's polite refusal, the actual error lives here."""
    db = get_db(); cur = db.cursor()
    cur.execute(
        "SELECT id, user_id, user_email, created_at, detail "
        "FROM data_access_log WHERE action = ? "
        "ORDER BY created_at DESC LIMIT ?",
        ("chat.error", int(max(1, min(int(limit or 100), 500)))),
    )
    rows = cur.fetchall() or []
    db.close()
    out = []
    import json as _json
    for r in rows:
        try:
            d = dict(r) if isinstance(r, dict) else {
                "id": r[0], "user_id": r[1], "user_email": r[2],
                "created_at": r[3], "detail": r[4],
            }
            try:
                d["detail"] = _json.loads(d["detail"]) if d.get("detail") else {}
            except Exception:
                d["detail"] = {"raw": d.get("detail")}
            # Stringify created_at for JSON safety
            ts = d.get("created_at")
            if ts and not isinstance(ts, str):
                d["created_at"] = str(ts)
            out.append(d)
        except Exception:
            pass
    return {"errors": out, "count": len(out)}



def _execute_chat_sql(sql: str, plant_scope: list[str] | None = None, dept_scope: list[str] | None = None) -> str:
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
            "`capability-agent-prod.Satori_Project.fact_material_stock_daily` (for opening/closing balance) "
            "and/or `capability-agent-prod.Satori_Project.fact_material_movements_daily` (for "
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

    # Dept-scope enforcement is now done in the system prompt via the
    # gatekeeper-agent context addon. _execute_chat_sql trusts the SQL
    # that Gemini produces; the scope is enforced upstream.
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

    # Rewrite legacy ai-vertex-mahad project refs to the live BQ_PROJECT.
    sql_stripped = normalize_bq_project(sql_stripped)
    print(f"[CHAT-SQL] Running: {sql_stripped[:300]}")
    result = run_query(sql_stripped, max_rows=500)
    if "error" in result:
        print(f"[CHAT-SQL] BQ ERROR: {result.get('error')}")
        # Also persist to data_access_log for /api/admin/chat-errors. We
        # have no `user` here -- _execute_chat_sql is called from the
        # chat loop which has user in scope. We re-fetch from a frame
        # local via the runtime stack; simpler: callers can also log,
        # but this catches every BQ error in one place.
        try:
            import inspect as _ins
            _fr = _ins.currentframe().f_back if _ins.currentframe() else None
            _user_local = _fr.f_locals.get("user") if _fr else None
            _body_local = _fr.f_locals.get("body") if _fr else None
            if _user_local and _body_local:
                _log_chat_error(
                    _user_local,
                    getattr(_body_local, "message", "") or "",
                    sql_stripped[:4000],
                    str(result.get("error"))[:2000],
                    "bq_error",
                )
        except Exception:
            pass
    else:
        print(f"[CHAT-SQL] BQ OK rows={len(result.get('rows') or [])} cols={result.get('columns')}")
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
    """Outer wrapper — any uncaught exception surfaces the real message + a
    short traceback to the user (and a full one to Cloud Run logs) instead of
    returning a generic 500 'Internal Server Error'."""
    try:
        return _chat_impl(body, request, user)
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[/api/chat] UNHANDLED EXCEPTION:\n{tb}")
        # Short, copy-pasteable detail for the user so we don't need server logs.
        first_line = tb.strip().split("\n")[-1][:300]
        return JSONResponse(
            status_code=502,
            content={"reply": f"Backend error: {first_line}", "error": str(e)},
        )


def _chat_impl(body: ChatRequest, request: Request, user: dict):
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

    # Build the system prompt defensively — if the schema-settings DB read or
    # the live-schema snapshot fails, we still want chat to work.
    try:
        _schema_notes = _load_schema_settings_block()
    except Exception as _e:
        print(f"[chat] schema-settings load failed (continuing): {_e}")
        _schema_notes = ""
    try:
        _live_snap = live_schema.render_context_block()
    except Exception as _e:
        print(f"[chat] live-schema render failed (continuing): {_e}")
        _live_snap = ""
    system_prompt_final = (
        ANALYST_COMMON_SENSE + "\n\n" +
        (VOICE_SYSTEM_PROMPT_URDU if body.voice_mode else SYSTEM_PROMPT) +
        _build_date_context() + scope_addon + "\n\n" + _schema_notes + "\n\n" + _live_snap +
        ATTENDANCE_BEHAVIOR_ADDON +
        _user_context_addon(user)
    )

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
            reply = response.text
            if not reply:
                # Empty response usually means MAX_TOKENS / safety / a model
                # glitch. Look at the last tool result we shoved into
                # `contents` and surface that to the user so they know what
                # actually happened instead of a generic apology.
                last_tool = ""
                try:
                    for _c in reversed(contents):
                        if getattr(_c, "role", "") != "user":
                            continue
                        for _p in getattr(_c, "parts", []) or []:
                            fr = getattr(_p, "function_response", None)
                            if fr and getattr(fr, "response", None):
                                resp_obj = fr.response
                                _last = resp_obj.get("result") if isinstance(resp_obj, dict) else None
                                if _last:
                                    last_tool = str(_last)[:1200]
                                    break
                        if last_tool:
                            break
                except Exception:
                    pass
                # Also scan for the SQL Gemini attempted to run, so the user can
                # see WHAT was tried even if no tool result came back cleanly.
                last_sql = ""
                try:
                    for _c in reversed(contents):
                        for _p in getattr(_c, "parts", []) or []:
                            fc = getattr(_p, "function_call", None)
                            if fc and getattr(fc, "args", None):
                                _args = fc.args
                                _sql = _args.get("sql") if isinstance(_args, dict) else None
                                if _sql:
                                    last_sql = str(_sql)[:600]
                                    break
                        if last_sql:
                            break
                except Exception:
                    pass

                if last_tool:
                    reply = ("I couldn't compose a final answer. Last tool "
                             f"result I saw:\n\n{last_tool}\n\n"
                             "Try rephrasing or ask me to retry with simpler "
                             "filters.")
                elif last_sql:
                    reply = ("I attempted a query but didn't receive results "
                             f"I could summarise. The SQL I tried was:\n\n```sql\n{last_sql}\n```\n\n"
                             "Try rephrasing the question.")
                else:
                    reply = "I wasn't able to generate a response. Please try again."
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
                    max_output_tokens=4096,
                    tools=[_CHAT_SQL_TOOL],
                    # Cap thinking budget so internal reasoning can't eat
                    # the whole output allocation. 4096 output is enough
                    # for a 25-employee paginated bullet list + summary.
                    thinking_config=genai.types.ThinkingConfig(thinking_budget=512),
                ),
            )

            # Check for function calls
            fcs = []
            finish_reason = None
            try:
                cand = response.candidates[0] if response.candidates else None
                if cand:
                    finish_reason = getattr(cand, "finish_reason", None)
                if cand and cand.content and cand.content.parts:
                    for p in cand.content.parts:
                        if hasattr(p, "function_call") and p.function_call and p.function_call.name:
                            fcs.append(p.function_call)
            except Exception as _fce:
                print(f"[CHAT] round {round_num+1} fcs-extract error: {_fce}")

            # Verbose diagnostics so the next time chat fails we can grep
            # Cloud Run logs and see exactly what Gemini sent back.
            _resp_text_preview = ""
            try:
                _rt = response.text
                _resp_text_preview = repr(_rt)[:160] if _rt else "EMPTY"
            except Exception:
                _resp_text_preview = "<no .text attr>"
            print(f"[CHAT] round {round_num+1} fcs={len(fcs)} "
                  f"finish_reason={finish_reason} "
                  f"text={_resp_text_preview}")

            if not fcs:
                reply = response.text

                # EMERGENCY FALLBACK: if response.text is empty AND no
                # function call was made, fire one more Gemini call without
                # tools and without the giant system prompt. Guarantees the
                # user gets SOMETHING for simple messages like 'hi buddy'.
                if not reply:
                    print(f"[CHAT] round {round_num+1} EMPTY text + no fcs -- "
                          f"firing emergency text-only fallback")
                    try:
                        _user_first = (user.get("name") or user.get("full_name") or "there").split()[0]
                        emergency_resp = client.models.generate_content(
                            model="gemini-2.5-flash",
                            contents=[genai.types.Content(
                                role="user",
                                parts=[genai.types.Part(text=(
                                    f"The user '{_user_first}' said: {body.message!r}\n\n"
                                    f"Respond in 1-3 friendly conversational sentences. "
                                    f"Address them by first name if natural. "
                                    f"Do not call any tools or write SQL. "
                                    f"Do not announce that you're going to query data. "
                                    f"If this looks like a greeting, just greet them back "
                                    f"and ask what they want to know."
                                ))],
                            )],
                            config=genai.types.GenerateContentConfig(
                                temperature=0.7,
                                max_output_tokens=300,
                            ),
                        )
                        _em_text = (emergency_resp.text or "").strip()
                        if _em_text:
                            print(f"[CHAT] emergency fallback succeeded "
                                  f"({len(_em_text)} chars)")
                            return {"reply": _em_text}
                        print("[CHAT] emergency fallback also returned empty text")
                    except Exception as _eme:
                        print(f"[CHAT] emergency fallback raised: {_eme}")

                if not reply:
                    # Empty response usually means MAX_TOKENS / safety / a model
                    # glitch. Look at the last tool result we shoved into
                    # `contents` and surface that to the user so they know what
                    # actually happened instead of a generic apology.
                    last_tool = ""
                    try:
                        for _c in reversed(contents):
                            if getattr(_c, "role", "") != "user":
                                continue
                            for _p in getattr(_c, "parts", []) or []:
                                fr = getattr(_p, "function_response", None)
                                if fr and getattr(fr, "response", None):
                                    resp_obj = fr.response
                                    _last = resp_obj.get("result") if isinstance(resp_obj, dict) else None
                                    if _last:
                                        last_tool = str(_last)[:400]
                                        break
                            if last_tool:
                                break
                    except Exception:
                        pass
                    if last_tool:
                        reply = ("I couldn't compose a final answer. Last data I "
                                 f"saw from the tool was:\n\n{last_tool}\n\n"
                                 "Try rephrasing the question or ask me to "
                                 "summarise the rows above.")
                    else:
                        reply = "I wasn't able to generate a response. Please try again."
                # Detect stalling: AI said "let me query" but didn't call the tool
                # Only match phrases that explicitly indicate the model is
                # ABOUT to write SQL as text or REFUSED to call the tool when
                # data is needed. Generic phrases like "to get", "to retrieve"
                # or "can help you with that" matched innocent greetings
                # ("Hi Sohaib! I can help you with that. What would you like
                # to know?") and incorrectly drove the chat into SQL-recovery,
                # which then failed and burned MAX_ROUNDS.
                stall_phrases = [
                    "let me query", "let me retrieve", "let me run",
                    "i'll query", "i will query", "need to query",
                    "i need to retrieve", "i need to fetch",
                    "here is the bigquery", "here is the sql",
                    "here's the sql", "here is the query",
                    "here's the query", "following sql", "this sql query",
                    "calling sql tool", "calling the sql tool",
                    "calling run_sql", "running the sql",
                ]
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

                # Refusal logger: when Gemini composes a polite refusal
                # ('persistent technical issue', etc.) we silently log the
                # actual BQ error to chat_error_log so the admin can see
                # what failed via /api/admin/chat-errors. The user-facing
                # reply stays clean -- they only see the polite message
                # Gemini wrote.
                _refusal_markers = [
                    "technical issue", "persistent issue", "persistent technical",
                    "i apologize", "i'm sorry", "i am sorry",
                    "encountering a", "encountering an", "encountered a",
                    "encountered an", "cannot retrieve", "could not retrieve",
                    "unable to retrieve", "unable to filter",
                    "data access problem", "data access issue",
                ]
                _has_refusal = any(m in reply.lower() for m in _refusal_markers)
                if _has_refusal:
                    _last_err = ""
                    _last_sql_attempted = ""
                    try:
                        for _c in reversed(contents):
                            if getattr(_c, "role", "") != "user":
                                continue
                            for _p in getattr(_c, "parts", []) or []:
                                fr = getattr(_p, "function_response", None)
                                if fr and getattr(fr, "response", None):
                                    resp_obj = fr.response
                                    _last = resp_obj.get("result") if isinstance(resp_obj, dict) else None
                                    if _last and ("Query error" in str(_last) or
                                                  "0 rows" in str(_last) or
                                                  "error" in str(_last).lower()[:30]):
                                        _last_err = str(_last)[:2000]
                                        break
                            if _last_err:
                                break
                        # Also walk contents for the most recent attempted SQL
                        for _c in reversed(contents):
                            for _p in getattr(_c, "parts", []) or []:
                                fc = getattr(_p, "function_call", None)
                                if fc and getattr(fc, "args", None):
                                    _args = fc.args
                                    _sql_attempted = _args.get("sql") if isinstance(_args, dict) else None
                                    if _sql_attempted:
                                        _last_sql_attempted = str(_sql_attempted)[:4000]
                                        break
                            if _last_sql_attempted:
                                break
                    except Exception:
                        pass
                    if _last_err or _last_sql_attempted:
                        _log_chat_error(user, body.message, _last_sql_attempted, _last_err, "refusal_unmask")

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
                max_output_tokens=2048,
                # Cap thinking so a complex post-rounds compose still has output budget
                # left for the actual answer — but allow some reasoning.
                thinking_config=genai.types.ThinkingConfig(thinking_budget=1024),
            ),
        )
        reply = response.text
        _post_text_preview = repr(reply)[:160] if reply else "EMPTY"
        print(f"[CHAT] post-MAX_ROUNDS final reply preview: {_post_text_preview}")
        if not reply:
            # Try the emergency text-only fallback FIRST: maybe the loop
            # exhausted not because we needed data but because Gemini kept
            # returning empty text under the huge system prompt. A short
            # no-tool call should still land a friendly reply.
            try:
                _user_first = (user.get("name") or user.get("full_name") or "there").split()[0]
                emergency_resp = client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=[genai.types.Content(
                        role="user",
                        parts=[genai.types.Part(text=(
                            f"The user '{_user_first}' said: {body.message!r}\n\n"
                            f"Respond in 1-3 friendly conversational sentences. "
                            f"Address them by first name if natural. "
                            f"Do not call any tools."
                        ))],
                    )],
                    config=genai.types.GenerateContentConfig(
                        temperature=0.7,
                        max_output_tokens=300,
                    ),
                )
                _em_text = (emergency_resp.text or "").strip()
                if _em_text:
                    print(f"[CHAT] post-MAX_ROUNDS emergency succeeded ({len(_em_text)} chars)")
                    return {"reply": _em_text}
            except Exception as _eme2:
                print(f"[CHAT] post-MAX_ROUNDS emergency raised: {_eme2}")
            # Post-MAX_ROUNDS empty - surface the last successful tool result
            # so the user at least sees the rows instead of a generic apology.
            last_tool = ""
            try:
                for _c in reversed(contents):
                    if getattr(_c, "role", "") != "user":
                        continue
                    for _p in getattr(_c, "parts", []) or []:
                        fr = getattr(_p, "function_response", None)
                        if fr and getattr(fr, "response", None):
                            resp_obj = fr.response
                            _last = resp_obj.get("result") if isinstance(resp_obj, dict) else None
                            if _last:
                                last_tool = str(_last)[:1200]
                                break
                    if last_tool:
                        break
            except Exception:
                pass
            # Also gather the last SQL attempt so the user sees what was tried.
            last_sql_pm = ""
            try:
                for _c in reversed(contents):
                    for _p in getattr(_c, "parts", []) or []:
                        fc = getattr(_p, "function_call", None)
                        if fc and getattr(fc, "args", None):
                            _args = fc.args
                            _sql = _args.get("sql") if isinstance(_args, dict) else None
                            if _sql:
                                last_sql_pm = str(_sql)[:600]
                                break
                    if last_sql_pm:
                        break
            except Exception:
                pass

            if last_tool:
                reply = ("I ran out of tool rounds without finishing a "
                         f"clean summary. Last tool result:\n\n{last_tool}\n\n"
                         "Ask me to re-summarise these in plain language.")
            elif last_sql_pm:
                reply = ("I tried multiple queries but none returned data I "
                         f"could summarise. Last SQL I attempted:\n\n```sql\n{last_sql_pm}\n```\n\n"
                         "Likely cause: column mismatch or dept-scope filter "
                         "interaction. Tell me to 'try without the dept "
                         "filter' or rephrase the question.")
            else:
                reply = ("I exhausted 5 tool rounds without a single "
                         "function_call being made. The model may have "
                         "rejected the request. Try rephrasing - e.g. "
                         "'attendance breakdown for my department in March 2026'.")
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
        # Persist this turn so the user can re-open the conversation later.
        # If the chat_conversations table is missing on the deployed DB the
        # save will throw — never let that bubble up and break the chat reply,
        # but log loudly so we can see why history isn't accumulating.
        try:
            new_conv_id = _save_chat_turn(uid, body.conversation_id, body.message, reply)
            print(f"[chat] saved turn — conv_id={new_conv_id} user={uid}")
        except Exception as _e:
            import traceback as _tb
            print(f"[chat] conversation save failed (continuing): {_e}\n{_tb.format_exc()}")
            new_conv_id = body.conversation_id
        return {"reply": reply, "conversation_id": new_conv_id}
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

    try:    _schema_notes_s = _load_schema_settings_block()
    except: _schema_notes_s = ""
    try:    _live_snap_s = live_schema.render_context_block()
    except: _live_snap_s = ""
    system_prompt_final = (
        ANALYST_COMMON_SENSE + "\n\n" +
        SYSTEM_PROMPT + _build_date_context() + scope_addon_stream + "\n\n" +
        _schema_notes_s + "\n\n" + _live_snap_s +
        ATTENDANCE_BEHAVIOR_ADDON +
        _user_context_addon(user)
    )

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
                    stall_phrases = [
                        "let me query", "let me retrieve", "let me run",
                        "need to query", "i need to retrieve", "i need to fetch",
                        "here is the sql", "here's the sql", "following sql",
                        "calling sql tool", "calling the sql tool", "calling run_sql",
                        "running the sql",
                    ]
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


# ── Chat conversations: list / load / delete saved chats ──
@app.get("/api/chat/conversations")
def list_chat_conversations(user: dict = Depends(get_current_user), limit: int = 50):
    """List the current user's conversations, newest first. If the underlying
    table is missing (startup migration silently failed) we run the migration
    on the fly and retry once before giving up — so a stale DB self-heals on
    first visit to the chat sidebar."""
    uid = int(user["sub"])

    def _query():
        db = get_db(); cur = db.cursor()
        try:
            cur.execute(
                """
                SELECT c.id, c.title, c.created_at, c.updated_at,
                       (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
                FROM chat_conversations c
                WHERE c.user_id = ?
                ORDER BY c.updated_at DESC
                LIMIT ?
                """,
                (uid, limit),
            )
            return [dict(r) for r in cur.fetchall()]
        finally:
            try: db.close()
            except Exception: pass

    try:
        rows = _query()
    except Exception as e:
        print(f"[/api/chat/conversations] first attempt failed, self-healing migration: {e}")
        try:
            _ensure_chat_tables_exist()
            rows = _query()
        except Exception as e2:
            print(f"[/api/chat/conversations] retry also failed: {e2}")
            rows = []
    return {"conversations": rows}


@app.get("/api/chat/conversations/{conv_id}")
def get_chat_conversation(conv_id: int, user: dict = Depends(get_current_user)):
    """Return all messages in a conversation in chronological order."""
    uid = int(user["sub"])
    db = get_db(); cur = db.cursor()
    cur.execute("SELECT id, title, created_at FROM chat_conversations WHERE id = ? AND user_id = ?", (conv_id, uid))
    conv = cur.fetchone()
    if not conv:
        db.close()
        raise HTTPException(status_code=404, detail="Conversation not found")
    cur.execute(
        "SELECT id, role, content, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC",
        (conv_id,),
    )
    msgs = [dict(r) for r in cur.fetchall()]
    db.close()
    return {"conversation": dict(conv), "messages": msgs}


@app.delete("/api/chat/conversations/{conv_id}")
def delete_chat_conversation(conv_id: int, user: dict = Depends(get_current_user)):
    """Delete a conversation and all its messages."""
    uid = int(user["sub"])
    db = get_db(); cur = db.cursor()
    cur.execute("DELETE FROM chat_messages WHERE conversation_id IN (SELECT id FROM chat_conversations WHERE id = ? AND user_id = ?)", (conv_id, uid))
    cur.execute("DELETE FROM chat_conversations WHERE id = ? AND user_id = ?", (conv_id, uid))
    db.commit(); db.close()
    return {"ok": True}


def _ensure_chat_tables_exist():
    """Self-heal in case the startup migration silently failed. Safe to call
    repeatedly — every statement is `CREATE TABLE IF NOT EXISTS`. Called from
    `_save_chat_turn` so a fresh DB still works without a service restart."""
    try:
        from database import USE_POSTGRES, _migrate_add_chat_tables
        _migrate_add_chat_tables()
    except Exception as e:
        print(f"[_ensure_chat_tables_exist] migration retry failed: {e}")


def _save_chat_turn(user_id: int, conv_id, user_message: str, ai_reply: str) -> int:
    """Persist a (user, assistant) turn to chat_conversations + chat_messages.
    If conv_id is None or 0, creates a fresh conversation. Returns the
    conv_id used (so the frontend can adopt it for subsequent turns)."""
    from database import USE_POSTGRES
    print(f"[_save_chat_turn] user={user_id} conv_id={conv_id} msg_len={len(user_message or '')} reply_len={len(ai_reply or '')}")
    try:
        db = get_db(); cur = db.cursor()
    except Exception as e:
        print(f"[_save_chat_turn] get_db FAILED: {e}")
        return conv_id
    try:
        if not conv_id:
            # Build a 60-char title from the first user message.
            title = (user_message or "New conversation").strip().split("\n")[0][:60]
            if USE_POSTGRES:
                cur.execute(
                    "INSERT INTO chat_conversations (user_id, title) VALUES (?, ?) RETURNING id",
                    (user_id, title),
                )
                row = cur.fetchone()
                if row is None:
                    print("[_save_chat_turn] RETURNING gave None — likely table missing")
                    raise RuntimeError("chat_conversations RETURNING returned None")
                conv_id = row["id"] if isinstance(row, dict) else row[0]
            else:
                cur.execute(
                    "INSERT INTO chat_conversations (user_id, title) VALUES (?, ?)",
                    (user_id, title),
                )
                conv_id = cur.lastrowid
            print(f"[_save_chat_turn] created new conv_id={conv_id}")
        else:
            # Touch updated_at so list ordering reflects most-recent activity.
            cur.execute(
                "UPDATE chat_conversations SET updated_at = " + ("NOW()" if USE_POSTGRES else "CURRENT_TIMESTAMP") + " WHERE id = ? AND user_id = ?",
                (conv_id, user_id),
            )
        cur.execute(
            "INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)",
            (conv_id, "user", user_message or ""),
        )
        cur.execute(
            "INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)",
            (conv_id, "assistant", ai_reply or ""),
        )
        db.commit()
        print(f"[_save_chat_turn] committed conv_id={conv_id}")
    except Exception as e:
        # If the tables don't exist (e.g. startup migration silently failed
        # against a Cloud SQL instance with a tighter schema), retry the
        # migration and the save once. This keeps chat working without
        # requiring a service redeploy.
        import traceback as _tb
        print(f"[_save_chat_turn] first attempt failed: {e}\n{_tb.format_exc()}")
        try: db.close()
        except Exception: pass
        _ensure_chat_tables_exist()
        try:
            db = get_db(); cur = db.cursor()
            if not conv_id:
                title = (user_message or "New conversation").strip().split("\n")[0][:60]
                if USE_POSTGRES:
                    cur.execute(
                        "INSERT INTO chat_conversations (user_id, title) VALUES (?, ?) RETURNING id",
                        (user_id, title),
                    )
                    row = cur.fetchone()
                    conv_id = row["id"] if isinstance(row, dict) else row[0]
                else:
                    cur.execute(
                        "INSERT INTO chat_conversations (user_id, title) VALUES (?, ?)",
                        (user_id, title),
                    )
                    conv_id = cur.lastrowid
            cur.execute(
                "INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)",
                (conv_id, "user", user_message or ""),
            )
            cur.execute(
                "INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)",
                (conv_id, "assistant", ai_reply or ""),
            )
            db.commit()
            print(f"[_save_chat_turn] recovered after migration retry, conv_id={conv_id}")
        except Exception as e2:
            print(f"[_save_chat_turn] retry also failed: {e2}")
    finally:
        try: db.close()
        except Exception: pass
    return conv_id


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
      (SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''), 'Unspecified'))
         FROM {_TMC_DATASET}.Employee_Data) AS unique_plants,
      (SELECT COUNT(DISTINCT EmployeePosition)
         FROM {_TMC_DATASET}.Employee_Data) AS unique_profit_centers
    FROM {_TMC_DATASET}.Attendance_Data
    WHERE attendance_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
    """
    summary = (_sap_query(summary_sql, max_rows=1) or [{}])[0]

    top_depts_sql = f"""
    SELECT
      COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''), 'Unspecified') AS dealer_name,
      COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''), 'Unspecified') AS dealer_code,
      COUNT(*) AS amount,
      COUNT(*) AS qty
    FROM {_TMC_DATASET}.Attendance_Data a
    LEFT JOIN {_TMC_DATASET}.Employee_Data e
      ON CAST(e.Employee_Code AS STRING) = CAST(a.personal_no AS STRING)
    WHERE a.is_present = 1
      AND a.attendance_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
    GROUP BY dealer_name
    ORDER BY qty DESC LIMIT 10
    """
    top_depts = _sap_query(top_depts_sql, max_rows=10)

    qty_by_dept_sql = f"""
    SELECT
      COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''), 'Unspecified') AS name,
      SUM(a.is_present) AS qty
    FROM {_TMC_DATASET}.Attendance_Data a
    LEFT JOIN {_TMC_DATASET}.Employee_Data e
      ON CAST(e.Employee_Code AS STRING) = CAST(a.personal_no AS STRING)
    WHERE a.attendance_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
    GROUP BY name ORDER BY qty DESC
    """
    qty_by_dept = _sap_query(qty_by_dept_sql, max_rows=50)

    stacked_sql = f"""
    SELECT
      COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''), 'Unspecified') AS dealer_name,
      a.attendance_status_text AS product,
      COUNT(*) AS qty
    FROM {_TMC_DATASET}.Attendance_Data a
    LEFT JOIN {_TMC_DATASET}.Employee_Data e
      ON CAST(e.Employee_Code AS STRING) = CAST(a.personal_no AS STRING)
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
      COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''), 'Unspecified') AS plant_name,
      a.attendance_status_text                   AS short_text,
      a.attendance_date                          AS shipment_date,
      CAST(a.is_present AS FLOAT64)              AS qty,
      CAST(NULL AS FLOAT64)                      AS amount,
      e.EmployeeLocation                        AS zone,
      e.EmployeeHierarchyNode                       AS region,
      e.EmployeePosition                        AS district
    FROM {_TMC_DATASET}.Attendance_Data a
    LEFT JOIN {_TMC_DATASET}.Employee_Data e
      ON CAST(e.Employee_Code AS STRING) = CAST(a.personal_no AS STRING)
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
      (SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''), 'Unspecified'))
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
      COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''), 'Unspecified') AS name,
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
      e.EmployeePosition                                                   AS product,
      l.emp_id                                                              AS dealer_code,
      e.Resource_Name                                                       AS dealer_name,
      COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''), 'Unspecified')        AS plant_name,
      CASE
        WHEN l.max_pct >= 90              THEN 'Allocated'
        WHEN l.max_pct BETWEEN 1 AND 89   THEN 'Partial'
        ELSE 'Bench' END                                                    AS dealer_code_status,
      e.EmployeeLocation                                                   AS zone,
      e.EmployeeHierarchyNode                                                  AS region,
      e.EmployeePosition                                                   AS district,
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
      COUNT(DISTINCT COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''), 'Unspecified')) AS unique_plants,
      CAST(COUNTIF(LOWER(COALESCE(Employee_Type,'')) IN ('mto','permanent','probation')) AS FLOAT64) AS total_qty,
      CAST(COUNT(DISTINCT EmployeeLocation) AS FLOAT64)                          AS total_value_local
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
      COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''), 'Unspecified') AS plant_id,
      COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''), 'Unspecified') AS plant_name,
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
      COALESCE(NULLIF(TRIM(EmployeePosition),''), 'Unspecified') AS material_type,
      COUNT(*)                                                     AS unique_materials,
      CAST(COUNT(*) AS FLOAT64)                                    AS total_qty,
      CAST(COUNT(DISTINCT EmployeeLocation) AS FLOAT64)           AS total_value_local
    FROM {_TMC_DATASET}.Employee_Data
    GROUP BY material_type
    ORDER BY unique_materials DESC LIMIT 25
    """
    by_position = _sap_query(by_position_sql, max_rows=25)

    data_sql = f"""
    SELECT
      COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''), 'Unspecified') AS plant_id,
      CAST(e.Employee_Code AS STRING)                                AS material_id,
      e.EmployeePosition                                            AS material_type,
      e.Resource_Name                                                AS material_description,
      e.EmployeeLocation                                            AS base_unit_of_measure,
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
- `Employee_Data` — employee master. Cols: Employee_Code (STRING, "E-2141"), Resource_Name (STRING), EmployeePosition (STRING), EmployeeEmail (STRING), EmployeeHierarchyNode (STRING — department), EmployeeLocation (STRING — city), Employee_Status (STRING), Employee_Type (STRING — 'MTO'/'Permanent'/'Probation'/'Contract'). Active employees = Employee_Type IN ('MTO','Permanent','Probation').
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

DATA QUALITY (READ TWICE — these are the column-type rules that break queries):
- 🔴 STRING-typed numerics (need SAFE_CAST AS FLOAT64 before math, never compare to '<number>' literals):
    Sales_AM_Scorecard: col_2026_Target, Q1_ACH, Open_Pipeline
    Sales_Plan_vs_Pipeline: col_2026_Target, Q1_Target, Q1_ACH, CRM_Pipeline
    Sales_Pipeline_Health.Open_Pipeline
    Sales_Accounts: Jan_Visits, Feb_Visits, Mar_Visits, Q1_Visits
    Sales_Hunting_Gap: Hunting_Target, Hunting_Achieved, Hunting_Gap
    Allocation_data.allocation_percent
    Timesheet_Data.TICKET_HOURS
- 🟢 ALREADY-NUMERIC columns (FLOAT64 or INT64 — NEVER wrap in REPLACE or SAFE_CAST AS STRING):
    Sales_Plan_vs_Pipeline.Coverage_Ratio (FLOAT64 — already a ratio, NEVER REPLACE)
    Sales_AM_Scorecard.Hist_Win_Rate (FLOAT64 decimal 0-1 — multiply by 100 for display)
    Sales_Pipeline_Health.Open_Deals (INT64), Sales_Pipeline_Health.Win_Rate_by (FLOAT64)
    Attendance_Data.is_present / is_absent / is_on_leave / is_remote / is_holiday / is_weekend (INT64 0/1)
    Attendance_Data.attendance_date (DATE)
    Attendance_Data.employee_id (INT64, sequence number) | personal_no (STRING 'E-902' - JOIN key to Employee_Data.employee_code)
- ❌ NEVER do: REPLACE(Coverage_Ratio, ',', ''), REPLACE(Hist_Win_Rate, '%', ''), SAFE_CAST(is_present AS STRING).
  These columns are ALREADY numeric. REPLACE only takes STRING args and BQ will throw "No matching signature for function REPLACE Argument types: FLOAT64, STRING, STRING".
- ✅ DO instead: ROUND(Coverage_Ratio * 100, 1), ROUND(Hist_Win_Rate * 100, 1), SUM(is_present).
- Win-rate columns are decimals (0.32 = 32%); multiply by 100 for display.
- For Headcount/Total Employees: ALWAYS use COUNT(DISTINCT employee_id) — never COUNT(*) on Attendance_Data (that counts attendance rows, ~30× too high).
- Use COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''), 'Unspecified') for clean department grouping.
- attendance_date is DATE — compare directly with DATE_SUB / CURRENT_DATE.
- DATE_KEY (Timesheet) is INT64 in YYYYMMDD form — use SAFE.PARSE_DATE('%Y-%m-%d', CAST(DATE_KEY AS STRING)).

CANONICAL ATTENDANCE PATTERNS (copy these — they are tested):
- Attendance rate (last 30 days, working days only):
    SELECT ROUND(100.0*SUM(is_present)/NULLIF(SUM(CASE WHEN is_weekend=0 AND is_holiday=0 THEN 1 ELSE 0 END),0),1) AS value
    FROM `ai-vertex-mahad.Satori_Project.Attendance_Data`
    WHERE attendance_date BETWEEN DATE_SUB(CURRENT_DATE(),INTERVAL 30 DAY) AND CURRENT_DATE() AND is_weekend=0 AND is_holiday=0
- Total employees:
    SELECT COUNT(DISTINCT Employee_Code) AS value
    FROM `ai-vertex-mahad.Satori_Project.Employee_Data`
    WHERE LOWER(Employee_Type) IN ('mto','permanent','probation')
- Pipeline coverage by AM (Coverage_Ratio is FLOAT64 — no REPLACE):
    SELECT AM, ROUND(Coverage_Ratio * 100, 1) AS coverage_pct
    FROM `ai-vertex-mahad.Satori_Project.Sales_Plan_vs_Pipeline`
    ORDER BY coverage_pct DESC LIMIT 50
"""


# ─── Cross-surface analyst common sense ──────────────────────────────────────
# Injected into EVERY AI surface that generates SQL or summarises TMC data:
# dashboard refine/edit, report builder, chat agent, voice agent. Goal: the AI
# behaves like a senior analyst who already knows the data — not a literal SQL
# translator. It silently applies defaults; asks only when the answer would
# materially change. This is plain text — NO curly braces — so it's safe to
# concatenate into prompts that go through .format().
ANALYST_COMMON_SENSE = """═══ ANALYST COMMON SENSE (apply silently to every answer, every dashboard, every report) ═══

You are a senior TMC analyst, not a translator. The user often won't spell out
the obvious — apply these defaults yourself unless they say otherwise. Confirm
out loud only when a default would materially change the answer.

DEFAULT FILTERS — apply automatically without asking:
1. Workforce queries → ACTIVE EMPLOYEES ONLY.
   LOWER(Employee_Type) IN ('mto','permanent','probation').
   Contract / Intern / Terminated are excluded unless the user asks for them.
2. Attendance metrics → WORKING DAYS ONLY (skip weekends + holidays).
   AND is_weekend = 0 AND is_holiday = 0.
   The denominator of an attendance rate must NEVER include weekends/holidays —
   that's what produces nonsense rates like 39.7%.
3. Headcount / "total employees" → COUNT(DISTINCT Employee_Code) on Employee_Data
   filtered to active employees. NEVER COUNT(*) on Attendance_Data — that counts
   ~30 attendance rows per employee per month, ~30× too high.
4. Date defaults — today is May 2026:
   - "this month" = May 2026; "last month" = April 2026; "Q1" = Jan–Mar 2026;
     "YTD" = Jan 1, 2026 to CURRENT_DATE(); "recent" / "lately" = last 30 days.
   - When the user names a month with no year, assume current year (2026).
5. Person searches — fuzzy match: WHERE LOWER(employee_name) LIKE '%mahad%'
   not WHERE employee_name = 'Mahad Laeeque'. People type partial names.
6. Department, location, position, AM, VP, city, tier — these are STRINGs.
   Always TRIM and COALESCE empties to 'Unspecified' when grouping.
7. Sales currency — USD values are STRING; SAFE_CAST AS FLOAT64 before sums.
   Coverage_Ratio is already a decimal — multiply by 100 only when DISPLAYING.

DASHBOARD-LEVEL COMMON SENSE:
- An "attendance dashboard" without further input should include: overall
  attendance rate (working days, active employees), active headcount, total
  absent days for the period, attendance by department, and daily trend.
- A "sales dashboard" without further input should include: total pipeline,
  coverage ratio, win rate %, top AMs by Q1 achievement, pipeline by city or
  tier — using AMs from Sales_AM_Scorecard.
- A "bench / utilization dashboard" should join Allocation_data → Employee_Data,
  classify by MAX(SAFE_CAST(allocation_percent AS FLOAT64)) per Employee_Code:
  Allocated >= 90, Partial 1-89, Bench 0/NULL.

WHEN TO ASK vs. WHEN TO ACT:
- ASK only when the answer materially depends on a choice you can't infer:
  "Did you mean Q1 (Jan-Mar) or this quarter?" / "By department or by location?"
- DON'T ask about active-only, working-days-only, fuzzy-name, or default-month —
  those are senior-analyst defaults. Just apply them and mention briefly in the
  description: "across active employees, working days only".

SANITY CHECK YOUR OWN NUMBERS BEFORE EMITTING SQL:
- TMC has roughly 1,190 active employees. A "Total Employees" KPI in the
  tens of thousands means you counted attendance rows, not people — fix the SQL.
- Attendance rates under 70% almost always mean weekends/holidays slipped into
  the denominator — fix the filter.
- Pipeline coverage of 0% or NULL across every AM means Coverage_Ratio got
  wrapped in REPLACE() — remove the wrapper.
"""


# Compact common-sense for voice (tight token budget). Keep under ~600 tokens.
ANALYST_COMMON_SENSE_COMPACT = """ANALYST COMMON SENSE (apply silently):
- Workforce queries → active employees only: LOWER(Employee_Type) IN ('mto','permanent','probation').
- Attendance metrics → working days only: AND is_weekend=0 AND is_holiday=0. Never count weekends/holidays as absent.
- Headcount → COUNT(DISTINCT Employee_Code) on Employee_Data (never COUNT(*) on Attendance_Data).
- Today is May 2026. "this month"=May 2026; "last month"=April 2026; "Q1"=Jan-Mar 2026.
- Name searches → fuzzy: LOWER(employee_name) LIKE '%mahad%'.
- STRING numerics (need SAFE_CAST): allocation_percent, TICKET_HOURS, Open_Pipeline, Q1_ACH, col_2026_Target, Q1_Visits.
- Already FLOAT64/INT64 (NEVER REPLACE): Coverage_Ratio, Hist_Win_Rate, Open_Deals, Win_Rate_by, is_*.
- Timesheet_Data.DATE_KEY: type varies — DATE on capability-agent-prod, INT64 YYYYMMDD elsewhere. ALWAYS filter with `COALESCE(SAFE_CAST(CAST(DATE_KEY AS STRING) AS DATE), SAFE.PARSE_DATE('%Y%m%d', CAST(DATE_KEY AS STRING))) >= <cutoff>`. Plain `PARSE_DATE('%Y%m%d', CAST(DATE_KEY AS STRING))` errors when DATE_KEY is DATE (CAST gives ISO "2025-07-01" which `%Y%m%d` rejects).
- Allocation_data.Date: type unreliable across environments — DON'T filter on it. Aggregate MAX(allocation_percent) per employee across all rows; the latest peak still wins for Bench / Partial / Allocated classification.
- "Utilization" / "hours worked" → Timesheet_Data, not Allocation_data. SUM(SAFE_CAST(TICKET_HOURS AS FLOAT64)) grouped by TICKET_USER_ID, joined to Employee_Data via CAST(Employee_Code AS STRING) = CAST(TICKET_USER_ID AS STRING). Optional 90-day window via the COALESCE pattern above.
- TMC has roughly 1,190 active employees. If your headcount is in the tens of thousands you counted attendance rows, not people.
- Apply defaults silently; only ask when the answer materially depends on a choice you can't infer."""


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
      "sql": "SELECT COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''),'Unspecified') AS department, ROUND(100.0*SUM(is_present)/NULLIF(COUNT(*),0),1) AS attendance_pct FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` a JOIN `ai-vertex-mahad.Satori_Project.Employee_Data` e ON CAST(e.Employee_Code AS STRING)=CAST(a.personal_no AS STRING) WHERE attendance_date BETWEEN DATE_SUB(CURRENT_DATE(),INTERVAL 30 DAY) AND CURRENT_DATE() {{where}} GROUP BY department ORDER BY attendance_pct DESC LIMIT 50"}}
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
- Department grouping: COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''), 'Unspecified') AS department.
- Join keys (CRITICAL): Different tables use different JOIN columns. Always normalize both sides with LTRIM(REGEXP_REPLACE(CAST(<col> AS STRING), r'[^0-9]', ''), '0') so 'E-902' and '902' both reduce to '902'.

    -- Attendance_Data: JOIN on personal_no (NOT employee_id - employee_id is an INT64 sequence like 3765, personal_no is the 'E-902' code).
    LEFT JOIN `<proj>.<ds>.Attendance_Data` a
      ON LTRIM(REGEXP_REPLACE(CAST(e.Employee_Code AS STRING), r'[^0-9]', ''), '0')
       = LTRIM(REGEXP_REPLACE(CAST(a.personal_no   AS STRING), r'[^0-9]', ''), '0')

    -- Allocation_data: JOIN on employee_id (here employee_id IS the 'E-2141' / 'I-2024' code).
    LEFT JOIN `<proj>.<ds>.Allocation_data` a
      ON LTRIM(REGEXP_REPLACE(CAST(e.Employee_Code AS STRING), r'[^0-9]', ''), '0')
       = LTRIM(REGEXP_REPLACE(CAST(a.employee_id   AS STRING), r'[^0-9]', ''), '0')

    -- Timesheet_Data: JOIN on TICKET_USER_ID (numeric like '1643').
    LEFT JOIN `<proj>.<ds>.Timesheet_Data` t
      ON LTRIM(REGEXP_REPLACE(CAST(e.Employee_Code AS STRING), r'[^0-9]', ''), '0')
       = LTRIM(REGEXP_REPLACE(CAST(t.TICKET_USER_ID AS STRING), r'[^0-9]', ''), '0')
  And ALWAYS use LEFT JOIN (not plain JOIN) so attendance rows survive even if Employee_Data has no matching row.
- EmployeeHierarchyNode is the DEPARTMENT — never call it anything else.
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

SQL RULES (same as the refine prompt — fully qualify with `ai-vertex-mahad.Satori_Project.<table>`, SAFE_CAST every STRING-typed numeric, multiply Hist_Win_Rate by 100, COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''),'Unspecified') for department, CAST-to-STRING joins, LIMIT 50, and place the {{where}} placeholder right after your last WHERE condition with a leading space so the runtime can append filters).

DASHBOARD LIMITS & OPTIONS: bar (variants: vertical, horizontal, stacked) / line / pie; KPI formats number/usd/percent; KPI icons (Users, UserCheck, Briefcase, Calendar, Clock, TrendingUp, DollarSign, Target, Award, Activity); max 6 KPIs / 4 charts / 5 filters.

CRITICAL RULES:
- NEVER expose technical details (table names, column names, SQL) to the user.
- NEVER output the JSON until the user explicitly confirms.
- Always return the FULL config (not just the changed parts) in the JSON.
- Be concise — max 3-4 sentences per message.
"""


def refine_dashboard(user_message: str, history: list, existing_config=None, scope_addon: str = '') -> str:
    """Chat-based dashboard refinement. Returns AI text or JSON when ready."""
    client = get_genai_client()
    tables = discover_tables()
    tables_str = "\n".join(f"- {t['table']} ({t['type']})" for t in tables[:20]) or "(no tables discovered yet)"

    if existing_config:
        system = DASHBOARD_EDIT_PROMPT.format(current_config=json.dumps(existing_config, indent=2), tables=tables_str)
    else:
        system = DASHBOARD_REFINE_PROMPT.format(tables=tables_str)
    # Inject analyst common-sense defaults + admin-curated schema notes + live
    # warehouse snapshot so the AI behaves like a senior analyst (active-only,
    # working days, distinct employees, sane numbers) by default.
    system = (
        ANALYST_COMMON_SENSE + "\n\n" +
        system + "\n\n" +
        _load_schema_settings_block() + "\n\n" +
        live_schema.render_context_block() +
        (scope_addon or "")
    )

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
    """Return everything the browser needs to open the Gemini Live WebSocket."""
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured.")
    # Tool the voice agent can call to run BigQuery SQL against TMC's warehouse.
    # The browser forwards toolCall events to /api/voice/query for execution.
    tools = [{
        "functionDeclarations": [
            {
                "name": "run_sql",
                "description": (
                    "Run a BigQuery SELECT against TMC's workforce + sales warehouse "
                    "(ai-vertex-mahad.Satori_Project). Use for any question that needs "
                    "live numbers — attendance, allocation, timesheets, pipeline, AM scorecards."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "sql": {
                            "type": "string",
                            "description": "A complete BigQuery SQL SELECT statement. Fully qualified table refs.",
                        }
                    },
                    "required": ["sql"],
                },
            },
            {
                "name": "end_call",
                "description": (
                    "Call this AFTER your spoken farewell when the user signals the "
                    "conversation has ended (allah hafiz, khuda hafiz, bye, goodbye, "
                    "take care, that's all, we're done, alvida, see you later). "
                    "Calling this triggers the client to hang up. Do NOT call it on "
                    "casual 'thanks' or other in-conversation acknowledgements."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reason": {
                            "type": "string",
                            "description": "Brief reason — usually 'farewell'.",
                        }
                    },
                },
            },
        ],
    }]
    # Voice prompt is already self-contained — DON'T inject the admin schema
    # notes + live snapshot like we do for chat. The voice session has tight
    # token budgets and a 7k-token system prompt was drowning out the tool
    # definitions so the model never called run_sql. The compact tables list
    # inside VOICE_SYSTEM_PROMPT_EN is enough for voice. We still inject the
    # compact common-sense block (active-only, working days, distinct
    # employees, etc.) — it's small enough to fit alongside the tool defs.
    system_instruction = (
        ANALYST_COMMON_SENSE_COMPACT + "\n\n" + VOICE_SYSTEM_PROMPT_EN +
        _user_context_addon(user)
    )
    # Pick a live model that exists for THIS API key. We probe the list and
    # fall back through a preferred order. Cached on the function for life of
    # the process.
    cache = getattr(voice_session, "_model_cache", {"model": None})
    model = os.environ.get("GEMINI_MODEL_VOICE", "").strip() or cache.get("model")
    if not model:
        preferred = [
            "models/gemini-2.0-flash-live-001",
            "models/gemini-2.5-flash-live-preview",
            "models/gemini-2.5-flash-preview-native-audio-dialog",
        ]
        try:
            import urllib.request
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                import json as _j
                data = _j.loads(resp.read())
                names = [m.get("name", "") for m in data.get("models", [])]
                # Only consider models that actually support BidiGenerateContent.
                supports_live = set()
                for m in data.get("models", []):
                    methods = m.get("supportedGenerationMethods", []) or []
                    if "bidiGenerateContent" in methods:
                        supports_live.add(m.get("name", ""))
                model = next((p for p in preferred if p in supports_live), None)
                if not model and supports_live:
                    model = sorted(supports_live)[0]
        except Exception as e:
            print(f"[voice/session] model probe failed: {e}")
        if not model:
            model = "models/gemini-2.0-flash-live-001"
        cache["model"] = model
        voice_session._model_cache = cache  # type: ignore[attr-defined]
        print(f"[voice/session] using model {model}")
    return {
        "apiKey": api_key,
        "model": model,
        "voice": os.environ.get("GEMINI_TTS_VOICE", "Leda"),
        "systemInstruction": system_instruction,
        "tools": tools,
    }


@app.post("/api/voice/query")
def voice_query(body: dict, user: dict = Depends(get_current_user)):
    """Execute a BigQuery SELECT for the voice agent's tool calls.
    Body: { sql: "SELECT …" }. Returns { result: "tab-formatted text" }."""
    sql = (body.get("sql") or "").strip()
    if not sql:
        return {"result": "No SQL provided."}
    up = sql.upper().lstrip()
    if not (up.startswith("SELECT") or up.startswith("WITH")):
        return {"result": "Only SELECT queries are allowed."}
    forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TRUNCATE", "MERGE"]
    if any(w in up.split() for w in forbidden):
        return {"result": "Write statements are not allowed."}
    # Reuse the dashboard SQL autofix so the voice agent gets the same healing
    # (LOWER() filters, name-based joins, no fake 'Late', Flag fixes). Also
    # rewrite legacy project names so SQL the model generates with the wrong
    # project still works.
    sql = normalize_bq_project(sql)
    sql = _autofix_dashboard_sql(sql)
    print(f"[voice] {sql[:240]}{'...' if len(sql) > 240 else ''}")
    r = bq_run_query(sql, max_rows=30)
    if "error" in r:
        return {"result": f"Query error: {r['error']}"}
    rows = r.get("rows") or []
    cols = r.get("columns") or []
    if not rows:
        return {"result": "No records found matching this query."}
    # Tab-formatted text — small, readable for the LLM to summarize aloud.
    header = "\t".join(cols)
    body_lines = ["\t".join(str(row.get(c, "")) for c in cols) for row in rows[:30]]
    suffix = f"\n... ({len(rows)} total rows shown)" if len(rows) == 30 else ""
    return {"result": header + "\n" + "\n".join(body_lines) + suffix}


# ── /api/help — Gemini-powered in-app help bubble ──────────────────────────
_SATORI_HELP_PROMPT = """You are Satori Help, an expert assistant for the Satori v2 platform — TMC's Capability Intelligence Agent.

Satori v2 is an AI-powered analytics platform for managers, HR, and sales leadership at TMC. It connects to a BigQuery warehouse (ai-vertex-mahad.Satori_Project) containing workforce data (Employee_Data, Attendance_Data, Allocation_data, Timesheet_Data) and sales data (Sales_AM_Scorecard, Sales_Accounts, Sales_Pipeline_Health, Sales_Plan_vs_Pipeline, Sales_Hunting_Gap). Powered by Google Gemini 2.5.

KEY FEATURES:
1. **Ask Me Anything** — Natural-language chat. Ask about attendance, allocation, pipeline, AM performance, etc. Replies stream live with citations from BigQuery.
2. **Report Builder** — Conversational builder for tabular reports. Describe what you want, the AI proposes columns + filters, say "generate" to produce a downloadable Excel / PDF.
3. **Dashboard Builder** — Conversational builder for interactive dashboards (KPIs, charts, filters). Re-runs every load against live BigQuery.
4. **Voice Agent** — Floating mic at bottom-right. Tap, then ask questions aloud — Satori speaks the answer back.
5. **Schema Settings** — System Settings → Schema Settings. Admins curate per-table descriptions that get injected into every AI agent's prompt, so Satori knows what each column means.
6. **User Management / Audit Log** — Admin pages.
7. **Dark Mode** — Toggle (Sun/Moon icon) at the top-right corner.

NAVIGATION:
- Sidebar (left): Ask Me Anything, Report Builder, Dashboard Builder, plus Admin pages.
- Top bar: dark mode toggle, profile.
- Floating buttons (bottom-right): green Mic and Help.

DATA SCOPE: All workforce + sales data for TMC. No SAP ERP / inventory data.

Answer concisely in a friendly, helpful tone. Focus on practical "how to" guidance. If the user asks about a specific business question, suggest they use Ask Me Anything. Return plain text (no HTML, no markdown headers) — 2-4 short sentences max."""


@app.post("/api/help")
def satori_help(body: dict):
    """Gemini-powered help bubble. No auth — public help is fine."""
    question = (body.get("question") or "").strip()
    if not question:
        return {"answer": "Please ask a question about how to use Satori."}
    try:
        client = get_genai_client()
        resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[genai.types.Content(role="user", parts=[genai.types.Part(text=question)])],
            config=genai.types.GenerateContentConfig(
                system_instruction=_SATORI_HELP_PROMPT,
                temperature=0.3,
                max_output_tokens=600,
            ),
        )
        return {"answer": (resp.text or "I'm not sure how to answer that.").strip()}
    except Exception as e:
        return {"answer": f"Help service unavailable: {e}"}


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
    text = refine_dashboard(safe_msg, history, existing, scope_addon=_user_context_addon(user))
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

    # Fix 4 — Convert plain `JOIN Employee_Data` to `LEFT JOIN`, and move any
    # `LOWER(<alias>.Employee_Type) IN (...)` predicate from the WHERE clause
    # into the JOIN's ON clause. This makes the outer query preserve attendance
    # rows even when the lookup table doesn't have a matching row, AND prevents
    # a missing Employee_Type from dropping the row. The AI keeps generating
    # INNER joins that throw out every row when the Employee_Data side is
    # incomplete or the join-key types don't align (e.g. STRING vs INT64
    # zero-padding).
    join_re = _re.compile(
        r"\b(?<!LEFT\s)JOIN\s+`?(?:ai-vertex-mahad\.Satori_Project\.Employee_Data)`?\s+(?P<alias>[A-Za-z_][A-Za-z0-9_]*)\s+ON\s+(?P<on>[^\n]+?)(?=\s+(?:WHERE|GROUP|ORDER|LIMIT|LEFT\s+JOIN|JOIN)\b|$)",
        _re.IGNORECASE,
    )
    m = join_re.search(sql)
    if m:
        alias = m.group("alias")
        on_clause = m.group("on").rstrip()
        emp_type_re = _re.compile(
            r"(?:\s+AND\s+|\s+WHERE\s+)LOWER\(\s*" + _re.escape(alias) + r"\.Employee_Type\s*\)\s+IN\s*\([^)]+\)",
            _re.IGNORECASE,
        )
        emp_type_m = emp_type_re.search(sql)
        if emp_type_m:
            predicate = emp_type_m.group(0)
            predicate_body = _re.sub(r"^\s*(?:AND|WHERE)\s+", "", predicate, flags=_re.IGNORECASE).strip()
            if predicate.lstrip().upper().startswith("WHERE"):
                sql = _re.sub(
                    r"\s+WHERE\s+LOWER\(\s*" + _re.escape(alias) + r"\.Employee_Type\s*\)\s+IN\s*\([^)]+\)\s+AND\s+",
                    " WHERE ", sql, flags=_re.IGNORECASE,
                )
                sql = _re.sub(
                    r"\s+WHERE\s+LOWER\(\s*" + _re.escape(alias) + r"\.Employee_Type\s*\)\s+IN\s*\([^)]+\)\s*",
                    " ", sql, flags=_re.IGNORECASE,
                )
            else:
                sql = sql.replace(predicate, "")
            new_on = on_clause + " AND " + predicate_body
            sql = sql.replace(m.group(0), f"LEFT JOIN `{BQ_FULL}.Employee_Data` " + alias + " ON " + new_on)
        else:
            sql = sql.replace(m.group(0), f"LEFT JOIN `{BQ_FULL}.Employee_Data` " + alias + " ON " + on_clause)

    # Fix 5 — Normalize the Employee_Code ↔ employee_id join key.
    # The two columns are stored in different formats: Employee_Code looks like
    # "E-2141" while employee_id is the numeric "2141" (or zero-padded). The
    # CAST-to-STRING join used by the AI doesn't bridge that gap, so every join
    # returns zero matches and EmployeeHierarchyNode comes back NULL → 'Unspecified'.
    # Rewrite the comparison to strip non-digits + leading zeros on both sides.
    def _norm_key(col_expr):
        return f"LTRIM(REGEXP_REPLACE(CAST({col_expr} AS STRING), r'[^0-9]', ''), '0')"

    # CAST(<x>.Employee_Code AS STRING) = CAST(<y>.<id_col> AS STRING)
    # (or the reverse order). Match either side that mentions Employee_Code.
    join_key_re = _re.compile(
        r"CAST\(\s*([A-Za-z_][A-Za-z0-9_]*\.Employee_Code)\s+AS\s+STRING\s*\)"
        r"\s*=\s*"
        r"CAST\(\s*([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s+AS\s+STRING\s*\)",
        _re.IGNORECASE,
    )
    sql = join_key_re.sub(lambda m: f"{_norm_key(m.group(1))} = {_norm_key(m.group(2))}", sql)
    # Reverse order: CAST(employee_id...) = CAST(Employee_Code...)
    join_key_re2 = _re.compile(
        r"CAST\(\s*([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s+AS\s+STRING\s*\)"
        r"\s*=\s*"
        r"CAST\(\s*([A-Za-z_][A-Za-z0-9_]*\.Employee_Code)\s+AS\s+STRING\s*\)",
        _re.IGNORECASE,
    )
    sql = join_key_re2.sub(lambda m: f"{_norm_key(m.group(1))} = {_norm_key(m.group(2))}", sql)

    # Fix 6 — Swap the digit-normalized Employee_Code/employee_id join for a
    # name-based join. The diagnostic snapshot showed only 1/1199 rows match
    # on digit-stripped IDs, but Resource_Name <-> employee_name overlaps for
    # almost every employee. Same for Allocation_data.emp_name.
    name_join_re = _re.compile(
        r"LTRIM\(REGEXP_REPLACE\(CAST\(([A-Za-z_][A-Za-z0-9_]*)\.Employee_Code\s+AS\s+STRING\),\s*r'\[\^0-9\]',\s*''\),\s*'0'\)"
        r"\s*=\s*"
        r"LTRIM\(REGEXP_REPLACE\(CAST\(([A-Za-z_][A-Za-z0-9_]*)\.(employee_id|TICKET_USER_ID)\s+AS\s+STRING\),\s*r'\[\^0-9\]',\s*''\),\s*'0'\)",
        _re.IGNORECASE,
    )
    def _to_name_join(m):
        e_alias = m.group(1)
        a_alias = m.group(2)
        a_col = m.group(3)
        # employee_id -> employee_name; TICKET_USER_ID has no name -> fallback to digit join
        name_col = {"employee_id": "employee_name", "TICKET_USER_ID": None}.get(a_col)
        if not name_col:
            # No name column on the other side — keep the original digit match.
            return m.group(0)
        return f"UPPER(TRIM({e_alias}.Resource_Name)) = UPPER(TRIM({a_alias}.{name_col}))"
    sql = name_join_re.sub(_to_name_join, sql)
    # Reverse order
    name_join_re2 = _re.compile(
        r"LTRIM\(REGEXP_REPLACE\(CAST\(([A-Za-z_][A-Za-z0-9_]*)\.(employee_id|TICKET_USER_ID)\s+AS\s+STRING\),\s*r'\[\^0-9\]',\s*''\),\s*'0'\)"
        r"\s*=\s*"
        r"LTRIM\(REGEXP_REPLACE\(CAST\(([A-Za-z_][A-Za-z0-9_]*)\.Employee_Code\s+AS\s+STRING\),\s*r'\[\^0-9\]',\s*''\),\s*'0'\)",
        _re.IGNORECASE,
    )
    def _to_name_join2(m):
        a_alias = m.group(1)
        a_col = m.group(2)
        e_alias = m.group(3)
        name_col = {"employee_id": "employee_name", "TICKET_USER_ID": None}.get(a_col)
        if not name_col:
            return m.group(0)
        return f"UPPER(TRIM({a_alias}.{name_col})) = UPPER(TRIM({e_alias}.Resource_Name))"
    sql = name_join_re2.sub(_to_name_join2, sql)

    # Also rewrite plain CAST-based joins (in case Fix 5 didn't catch them) the
    # same way. Pre-Fix-5 dashboards had `CAST(e.Employee_Code AS STRING) = CAST(a.employee_id AS STRING)`
    # which Fix 5 would normalize; if the user is on a stale config from before
    # Fix 5 we still want to handle it. Belt-and-braces.
    cast_join_re = _re.compile(
        r"CAST\(\s*([A-Za-z_][A-Za-z0-9_]*)\.Employee_Code\s+AS\s+STRING\s*\)"
        r"\s*=\s*"
        r"CAST\(\s*([A-Za-z_][A-Za-z0-9_]*)\.(employee_id|TICKET_USER_ID)\s+AS\s+STRING\s*\)",
        _re.IGNORECASE,
    )
    def _to_name_cast(m):
        e_alias = m.group(1)
        a_alias = m.group(2)
        a_col = m.group(3)
        name_col = {"employee_id": "employee_name", "TICKET_USER_ID": None}.get(a_col)
        if not name_col:
            return m.group(0)
        return f"UPPER(TRIM({e_alias}.Resource_Name)) = UPPER(TRIM({a_alias}.{name_col}))"
    sql = cast_join_re.sub(_to_name_cast, sql)

    # Fix 7 — There is no 'Late' attendance_status_text. The Late filter the
    # AI keeps emitting returns 0 rows. Replace it with 'missing punch', which
    # is the closest real status. (If the user wants something different they
    # can edit the dashboard with AI.)
    sql = _re.sub(
        r"LOWER\(([^)]*attendance_status_text[^)]*)\)\s*=\s*'late'",
        r"LOWER(\1) = 'missing punch'",
        sql, flags=_re.IGNORECASE,
    )
    sql = _re.sub(
        r"LOWER\(([^)]*attendance_status_text[^)]*)\)\s+IN\s*\(\s*'late'\s*\)",
        r"LOWER(\1) IN ('missing punch')",
        sql, flags=_re.IGNORECASE,
    )

    # Fix 8 — Allocation_data.Flag values are 'Allocated' / 'Bench', NOT
    # 'Actual' / 'Forecast'. Rewrite IN-list filters that include 'Actual'
    # or 'Forecast' to use 'Allocated' / 'Bench' instead.
    def _fix_flag_in(m):
        prefix = m.group(1) or ""
        values_raw = m.group(2)
        # Map old terms to new
        if _re.search(r"'\s*Actual\s*'", values_raw, _re.IGNORECASE) or _re.search(r"'\s*Forecast\s*'", values_raw, _re.IGNORECASE):
            return f"{prefix}Flag IN ('Allocated','Bench')"
        return m.group(0)
    sql = _re.sub(
        r"(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*\.)?Flag\s+IN\s*\(([^)]+)\)",
        _fix_flag_in, sql, flags=_re.IGNORECASE,
    )
    sql = _re.sub(
        r"(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*\.)?Flag\s*=\s*'Actual'",
        lambda m: f"{m.group(1) or ''}Flag = 'Allocated'", sql, flags=_re.IGNORECASE,
    )
    sql = _re.sub(
        r"(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*\.)?Flag\s*=\s*'Forecast'",
        lambda m: f"{m.group(1) or ''}Flag = 'Bench'", sql, flags=_re.IGNORECASE,
    )

    # Fix 9 — REPLACE() wrapped around numeric arguments throws "No matching
    # signature for function REPLACE Argument types: FLOAT64, STRING, STRING".
    # The AI keeps wrapping SAFE_CAST(... AS FLOAT64) or already-numeric columns
    # like Coverage_Ratio / Hist_Win_Rate / win_rate_by in REPLACE(x,',','').
    # Strip the REPLACE wrapper so the inner numeric expression is used directly.
    NUMERIC_NATIVE_COLUMNS = (
        "Coverage_Ratio", "Hist_Win_Rate", "Open_Deals", "Win_Rate_by",
        "is_present", "is_absent", "is_on_leave", "is_remote", "is_holiday",
        "is_weekend", "Q1_Visits", "Jan_Visits", "Feb_Visits", "Mar_Visits",
    )
    # 9a) REPLACE(SAFE_CAST(<x> AS FLOAT64|INT64|NUMERIC), 'anything', 'anything') → SAFE_CAST(<x> AS …)
    sql = _re.sub(
        r"REPLACE\(\s*(SAFE_CAST\s*\([^()]*?\s+AS\s+(?:FLOAT64|INT64|NUMERIC|BIGNUMERIC)\s*\))\s*,\s*'[^']*'\s*,\s*'[^']*'\s*\)",
        r"\1", sql, flags=_re.IGNORECASE,
    )
    # 9b) REPLACE(<bare_native_numeric_column>, '…', '…') → <bare_native_numeric_column>
    cols_pat = "|".join(_re.escape(c) for c in NUMERIC_NATIVE_COLUMNS)
    sql = _re.sub(
        r"REPLACE\(\s*((?:[A-Za-z_][A-Za-z0-9_]*\.)?(?:" + cols_pat + r"))\s*,\s*'[^']*'\s*,\s*'[^']*'\s*\)",
        r"\1", sql, flags=_re.IGNORECASE,
    )
    # 9c) REPLACE(CAST(<x> AS FLOAT64|INT64|NUMERIC), ...) → CAST(<x> AS …)
    sql = _re.sub(
        r"REPLACE\(\s*(CAST\s*\([^()]*?\s+AS\s+(?:FLOAT64|INT64|NUMERIC|BIGNUMERIC)\s*\))\s*,\s*'[^']*'\s*,\s*'[^']*'\s*\)",
        r"\1", sql, flags=_re.IGNORECASE,
    )

    # Fix 10 — SAFE_CAST wrapped around an already-numeric column. Native
    # numeric columns can be cast safely (it's a no-op) but if the AI nests
    # SAFE_CAST AS FLOAT64 around a REPLACE that we just unwrapped, the result
    # is fine. Leave this as documentation — no rewrite needed because BQ
    # accepts SAFE_CAST(FLOAT64 → FLOAT64).

    # Fix 11 — Common COUNT(*) misuse for headcount. The AI keeps writing
    # `COUNT(*) AS value` on Attendance_Data to mean "total employees", which
    # actually counts attendance rows (~30× too high). Rewrite naive headcount
    # patterns to COUNT(DISTINCT employee_id) when the alias hints at it.
    sql = _re.sub(
        r"COUNT\(\s*\*\s*\)\s+AS\s+(total_employees|employees|headcount|emp_count|employee_count)\b",
        lambda m: f"COUNT(DISTINCT employee_id) AS {m.group(1)}",
        sql, flags=_re.IGNORECASE,
    )

    # Fix 12 — When the AI puts a numeric filter like `Coverage_Ratio > '1'`
    # (string-compared to a number) BQ throws a type error. Strip the quotes
    # from numeric comparisons on the known-numeric columns.
    for col in NUMERIC_NATIVE_COLUMNS:
        sql = _re.sub(
            r"(?<![A-Za-z0-9_])((?:[A-Za-z_][A-Za-z0-9_]*\.)?" + _re.escape(col) + r")\s*(=|<|>|<=|>=|!=|<>)\s*'(-?\d+(?:\.\d+)?)'",
            r"\1 \2 \3", sql, flags=_re.IGNORECASE,
        )

    return sql


_REPAIR_PROMPT = """You are a BigQuery SQL repair assistant. The query below failed with the given error against the TMC Satori warehouse. Output ONLY the fixed SQL — no prose, no markdown fence, no commentary.

═══ TMC SCHEMA (use ONLY these tables/columns) ═══
- `{BQ_FULL}.Employee_Data` — Employee_Code (STRING "E-2141"), Resource_Name, EmployeePosition, EmployeeHierarchyNode (department), EmployeeLocation, Employee_Type, Employee_Status.
- `{BQ_FULL}.Attendance_Data` — attendance_date (DATE), employee_id (INT64), employee_name (STRING), checkin_time, checkout_time, attendance_status_text, is_present/is_absent/is_on_leave/is_remote/is_holiday/is_weekend (INT64 0/1).
- `{BQ_FULL}.Allocation_data` — project_id, employee_id (STRING "E-1234"), allocation_percent (STRING), emp_competency, Flag ('Allocated'/'Bench'), Date.
- `{BQ_FULL}.Timesheet_Data` — TICKET_USER_ID, TICKET_PROJECT_LABEL, TICKET_HOURS (STRING), TICKET_STATUS, DATE_KEY (INT64 YYYYMMDD).
- `{BQ_FULL}.Sales_AM_Scorecard` — VP, AM, Role, City, col_2026_Target (STRING), Q1_ACH (STRING), Open_Pipeline (STRING), Hist_Win_Rate (FLOAT64 decimal 0-1 — NEVER REPLACE).
- `{BQ_FULL}.Sales_Plan_vs_Pipeline` — AM, col_2026_Target, Q1_Target, Q1_ACH, CRM_Pipeline, Coverage_Ratio (FLOAT64 — NEVER REPLACE), Status, Action.
- `{BQ_FULL}.Sales_Pipeline_Health` — Salesperson, Open_Pipeline (STRING), Open_Deals (INT64), Win_Rate_by (FLOAT64).
- `{BQ_FULL}.Sales_Accounts` — VP, AM, Location, Account, Tier, Dormant, Q1_Visits (STRING).
- `{BQ_FULL}.Sales_Hunting_Gap` — AM, City, Hunting_Target, Hunting_Achieved, Hunting_Gap.

═══ HARD RULES ═══
- NEVER wrap a FLOAT64/INT64 column in REPLACE() — REPLACE only accepts STRINGs. Coverage_Ratio, Hist_Win_Rate, Open_Deals, Win_Rate_by, and is_* columns are already numeric.
- Only STRING-typed columns need REPLACE/SAFE_CAST: Open_Pipeline, Q1_ACH, col_2026_Target, allocation_percent, TICKET_HOURS, Q1_Visits.
- Active employees: LOWER(Employee_Type) IN ('mto','permanent','probation').
- Joins: LEFT JOIN with UPPER(TRIM(Resource_Name)) = UPPER(TRIM(employee_name)) for Employee↔Attendance.
- LIMIT 50 on chart queries.
- KPI must SELECT exactly one row with the metric aliased AS `value`.
- KEEP the {{where}} placeholder in the same position the failed query had it.
- Output ONLY raw SQL — one statement, no explanation."""


_DRILLDOWN_PROMPT = """You generate BigQuery DRILL-DOWN SQL for the TMC Satori warehouse.

GOAL: The user clicked one category on a dashboard chart. Show them the row-level
detail behind that single category so they understand WHO/WHAT makes up the number.

═══ TMC SCHEMA ═══
- `{BQ_FULL}.Employee_Data` — Employee_Code (STRING "E-2141"), Resource_Name, EmployeePosition, EmployeeHierarchyNode (department), EmployeeLocation, Employee_Type, Employee_Status.
- `{BQ_FULL}.Attendance_Data` — attendance_date (DATE), employee_id (INT64), employee_name (STRING), checkin_time, checkout_time, attendance_status_text, is_present/is_absent/is_on_leave/is_remote/is_holiday/is_weekend (INT64 0/1).
- `{BQ_FULL}.Allocation_data` — project_id, employee_id (STRING), allocation_percent (STRING), emp_competency, Flag, Date.
- `{BQ_FULL}.Timesheet_Data` — TICKET_USER_ID, TICKET_PROJECT_LABEL, TICKET_HOURS (STRING), TICKET_STATUS, DATE_KEY (INT64 YYYYMMDD).
- `{BQ_FULL}.Sales_AM_Scorecard` — VP, AM, Role, City, col_2026_Target (STRING), Q1_ACH (STRING), Open_Pipeline (STRING), Hist_Win_Rate (FLOAT64 — NEVER REPLACE).
- `{BQ_FULL}.Sales_Plan_vs_Pipeline` — AM, col_2026_Target, Q1_Target, Q1_ACH, CRM_Pipeline, Coverage_Ratio (FLOAT64 — NEVER REPLACE), Status, Action.
- `{BQ_FULL}.Sales_Pipeline_Health` — Salesperson, Open_Pipeline, Open_Deals, Win_Rate_by.
- `{BQ_FULL}.Sales_Accounts` — VP, AM, Location, Account, Tier, Dormant, Jan_Visits, Feb_Visits, Mar_Visits, Q1_Visits.

═══ HARD RULES ═══
- Active employees only: LOWER(Employee_Type) IN ('mto','permanent','probation').
- Working days only for attendance: AND is_weekend=0 AND is_holiday=0.
- Employee → Attendance join: UPPER(TRIM(Resource_Name)) = UPPER(TRIM(employee_name)).
- NEVER wrap Coverage_Ratio/Hist_Win_Rate/Open_Deals/Win_Rate_by/is_* in REPLACE() — they're already numeric.
- LIMIT 200 rows.
- Output ONLY raw SQL — one SELECT statement, no markdown, no commentary.

═══ DRILL-DOWN RECIPES ═══
When the parent chart is grouped by DEPARTMENT (EmployeeHierarchyNode) and the user clicks department='Qlik':
  SELECT
    e.Resource_Name AS employee,
    e.EmployeePosition AS position,
    SUM(a.is_present)  AS present_days,
    SUM(a.is_absent)   AS absent_days,
    SUM(a.is_on_leave) AS leave_days,
    ROUND(100.0*SUM(a.is_present)/NULLIF(SUM(CASE WHEN a.is_weekend=0 AND a.is_holiday=0 THEN 1 ELSE 0 END),0),1) AS attendance_pct
  FROM `{BQ_FULL}.Employee_Data` e
  LEFT JOIN `{BQ_FULL}.Attendance_Data` a
    ON UPPER(TRIM(e.Resource_Name)) = UPPER(TRIM(a.employee_name))
   AND a.is_weekend=0 AND a.is_holiday=0
   AND a.attendance_date BETWEEN <parent_start> AND <parent_end>
  WHERE COALESCE(NULLIF(TRIM(e.EmployeeHierarchyNode),''),'Unspecified') = 'Qlik'
    AND LOWER(e.Employee_Type) IN ('mto','permanent','probation')
  GROUP BY employee, position
  ORDER BY attendance_pct DESC
  LIMIT 200

When the parent is grouped by AM (Sales_AM_Scorecard) and the user clicks AM='Ali Tareen':
  SELECT
    a.Account, a.Tier, a.Location,
    SAFE_CAST(a.Q1_Visits AS INT64) AS q1_visits,
    a.Dormant
  FROM `{BQ_FULL}.Sales_Accounts` a
  WHERE LOWER(a.AM) = 'ali tareen'
  ORDER BY q1_visits DESC NULLS LAST
  LIMIT 200

When the parent is a daily-trend LINE chart and the user clicks a specific date, e.g. 2026-03-12:
  SELECT employee_name, attendance_status_text, checkin_time, checkout_time
  FROM `{BQ_FULL}.Attendance_Data`
  WHERE attendance_date = DATE '2026-03-12' AND is_weekend=0 AND is_holiday=0
  ORDER BY attendance_status_text, employee_name
  LIMIT 200

GENERAL APPROACH:
1. Identify the dimension the parent chart was grouped on (department, AM, date, city, etc.).
2. Identify the matching column in the parent's source table.
3. Write a row-level SELECT that returns the underlying entities (employees, accounts, deals, days)
   that contributed to the clicked category, plus 2-4 useful metrics.
4. Apply the same active-employees / working-days defaults the parent dashboard uses.
5. Order by the most informative metric DESC, LIMIT 200."""


def _generate_drilldown_sql(parent_sql: str, parent_title: str, parent_type: str,
                            label_key: str, label_value, value_keys: list) -> str:
    """Ask Gemini Flash to produce a row-level breakdown for one clicked
    category of a chart. Returns the SQL string, or "" on failure."""
    if not parent_sql or label_value in (None, ""):
        return ""
    try:
        client = get_genai_client()
        user_msg = (
            f"Parent chart title: {parent_title or '(untitled)'}\n"
            f"Parent chart type: {parent_type or 'bar'}\n"
            f"Parent group-by column (labelKey): {label_key}\n"
            f"Parent metric columns (valueKeys): {', '.join(value_keys or [])}\n"
            f"User clicked the value: {label_value!r}\n\n"
            f"Parent SQL:\n{parent_sql}\n\n"
            f"Generate the row-level drill-down SQL. Output ONLY the SQL."
        )
        resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[genai.types.Content(role="user", parts=[genai.types.Part(text=user_msg)])],
            config=genai.types.GenerateContentConfig(
                system_instruction=_DRILLDOWN_PROMPT.format(BQ_FULL=BQ_FULL),
                temperature=0.1,
                max_output_tokens=1024,
            ),
        )
        out = (resp.text or "").strip()
        if out.startswith("```"):
            out = out.strip("`")
            if out.lower().startswith("sql"):
                out = out[3:].strip()
            if out.endswith("```"):
                out = out[:-3].strip()
        if not out.upper().lstrip().startswith(("SELECT", "WITH")):
            return ""
        return out
    except Exception as e:
        print(f"[drilldown] gen failed: {e}")
        return ""


@app.post("/api/dashboard/drill")
def dashboard_drill(body: dict, user: dict = Depends(get_current_user)):
    """Generate + run a row-level drill-down for one clicked chart category.

    Body: {
      parent_sql:    "<the chart's SQL>",
      parent_title:  "Attendance Rate by Department",
      parent_type:   "bar" | "line" | "pie",
      label_key:     "department",
      label_value:   "Qlik",
      value_keys:    ["attendance_pct"]
    }
    Returns: {
      title:   "<auto-generated drill title>",
      sql:     "<the SQL we ran>",
      columns: [...],
      rows:    [...],
      error?:  "<bq error if any>"
    }
    """
    parent_sql = (body.get("parent_sql") or "").strip()
    parent_title = (body.get("parent_title") or "").strip()
    parent_type = (body.get("parent_type") or "bar").strip()
    label_key = (body.get("label_key") or "").strip()
    label_value = body.get("label_value")
    value_keys = body.get("value_keys") or []

    if not parent_sql or label_value in (None, ""):
        return {"error": "Missing parent SQL or clicked value.", "rows": [], "columns": []}

    sql = _generate_drilldown_sql(parent_sql, parent_title, parent_type, label_key, label_value, value_keys)
    if not sql:
        return {"error": "Could not generate a drill-down query for this chart.", "rows": [], "columns": []}

    # Same safety net as the dashboard runner
    sql = normalize_bq_project(sql)
    sql = _autofix_dashboard_sql(sql)
    print(f"[drilldown] running: {sql[:300]}{'...' if len(sql) > 300 else ''}")

    r = bq_run_query(sql, max_rows=200)
    drill_title = f"{parent_title} — {label_value}" if parent_title else f"Breakdown for {label_value}"
    out = {
        "title":   drill_title,
        "sql":     sql,
        "columns": r.get("columns") or [],
        "rows":    r.get("rows") or [],
    }
    if "error" in r:
        # One repair attempt
        repaired = _repair_widget_sql(sql, r["error"], {"kind": "drilldown", "title": drill_title})
        if repaired and repaired.strip() and repaired.strip() != sql.strip():
            repaired = normalize_bq_project(repaired)
            repaired = _autofix_dashboard_sql(repaired)
            r2 = bq_run_query(repaired, max_rows=200)
            if "error" not in r2:
                out["sql"]     = repaired
                out["columns"] = r2.get("columns") or []
                out["rows"]    = r2.get("rows") or []
                out["recovered"] = True
                return out
        out["error"] = r["error"]
    return out


def _repair_widget_sql(failed_sql: str, error_msg: str, widget_meta: dict) -> str:
    """Ask Gemini Flash to rewrite a single widget's SQL given the BQ error.

    Returns the repaired SQL string, or "" on failure. Best-effort — never
    raises. Used as a last-resort safety net so transient AI-generated bugs
    don't break the whole dashboard. We pass widget intent (title + chart
    type) so the model preserves the original meaning.
    """
    if not failed_sql or not error_msg:
        return ""
    try:
        client = get_genai_client()
        intent = (widget_meta.get("title") or "").strip()
        kind = widget_meta.get("kind") or "widget"  # 'kpi' or 'chart'
        user_msg = (
            f"Widget kind: {kind}\n"
            f"Widget title: {intent}\n\n"
            f"BigQuery error:\n{error_msg}\n\n"
            f"Failed SQL:\n{failed_sql}\n\n"
            f"Return ONLY the fixed SQL."
        )
        resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[genai.types.Content(role="user", parts=[genai.types.Part(text=user_msg)])],
            config=genai.types.GenerateContentConfig(
                system_instruction=_REPAIR_PROMPT.format(BQ_FULL=BQ_FULL),
                temperature=0.1,
                max_output_tokens=1024,
            ),
        )
        out = (resp.text or "").strip()
        # Strip fenced code blocks
        if out.startswith("```"):
            out = out.strip("`")
            if out.lower().startswith("sql"):
                out = out[3:].strip()
            if out.endswith("```"):
                out = out[:-3].strip()
        # Sanity: must look like a SELECT
        if not out.upper().lstrip().startswith(("SELECT", "WITH")):
            return ""
        return out
    except Exception as e:
        print(f"[dashboard] repair attempt failed: {e}")
        return ""


# Map of dashboard filter "alias" names → real column expressions. The AI is
# instructed to use these alias names in the `filters` config; runtime maps
# them to the actual columns so `{where}` substitution produces valid SQL.
# Order matters: most-specific aliases first so partial matches don't shadow.
_FILTER_FIELD_MAP = {
    # workforce — labels users see vs columns in BQ
    "department":         "COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''),'Unspecified')",
    "EmployeeHierarchyNode": "EmployeeHierarchyNode",
    "employee_type":      "LOWER(Employee_Type)",
    "Employee_Type":      "LOWER(Employee_Type)",
    "location":           "EmployeeLocation",
    "EmployeeLocation":  "EmployeeLocation",
    "position":           "EmployeePosition",
    "EmployeePosition":  "EmployeePosition",
    # sales
    "AM":  "AM",  "am":  "AM",
    "VP":  "VP",  "vp":  "VP",
    "City": "City", "city": "City",
    "Tier": "Tier", "tier": "Tier",
    "attendance_status_text": "LOWER(attendance_status_text)",
}


def _substitute_where(sql: str, user_filters: dict) -> str:
    """Substitute the `{where}` placeholder. Supports two contracts:

    A) Older shape — `FROM t {where} GROUP BY ...`. We inject `WHERE f='v' AND ...`.
    B) Newer shape — `... WHERE attendance_date BETWEEN ... {where} GROUP BY ...`.
       We inject `AND f='v' AND ...`.

    If no filters apply the placeholder becomes ''.
    Filter values are matched case-insensitively against the columns they
    target so users see real data even when the table stores mixed case.
    """
    if "{where}" not in sql:
        return sql
    parts = []
    for f, v in (user_filters or {}).items():
        if v is None or str(v).strip() == "":
            continue
        safe_v = str(v).replace("'", "\\'")
        col_expr = _FILTER_FIELD_MAP.get(f, f)
        # If the column expression already lowercases the column, lowercase
        # the literal too so the comparison matches.
        if col_expr.startswith("LOWER("):
            parts.append(f"{col_expr} = '{safe_v.lower()}'")
        else:
            parts.append(f"{col_expr} = '{safe_v}'")
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

    def _exec(sql_template, tag, widget_meta=None):
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
        sql = normalize_bq_project(sql)
        sql = _autofix_dashboard_sql(sql)
        print(f"[dashboard] {tag}: {sql[:300]}{'...' if len(sql) > 300 else ''}")
        r = bq_run_query(sql, max_rows=200)
        r["sql"] = sql  # always include the substituted SQL so the frontend can show it on error
        if "error" in r:
            err = r["error"]
            print(f"[dashboard]   {tag} ERROR: {err}")
            # Repair attempt — ask Gemini to rewrite the failing SQL given the
            # BQ error message. Cheap, scoped to one widget. Returns nothing
            # if repair fails, in which case the original error is surfaced.
            repaired = _repair_widget_sql(sql, err, widget_meta or {})
            if repaired and repaired.strip() and repaired.strip() != sql.strip():
                repaired = normalize_bq_project(repaired)
                repaired = _autofix_dashboard_sql(repaired)
                print(f"[dashboard]   {tag} retry with repaired SQL: {repaired[:200]}…")
                r2 = bq_run_query(repaired, max_rows=200)
                if "error" not in r2:
                    print(f"[dashboard]   {tag} ok on retry — {len(r2.get('rows') or [])} rows")
                    r2["sql"] = repaired
                    r2["recovered"] = True
                    return r2
                else:
                    print(f"[dashboard]   {tag} retry also failed: {r2.get('error')}")
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
        r = _exec(k.get("sql"), f"kpi[{kid}]", {"kind": "kpi", "title": k.get("title")})
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
        r = _exec(c.get("sql"), f"chart[{cid}]", {"kind": "chart", "title": c.get("title"), "type": c.get("type")})
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

    # ── Populate filter dropdown options ──
    # The frontend reads data.filterOptions[field] to render dropdown choices.
    # For each filter in the config we probe distinct values from the most
    # likely source table. Without this the filters render as empty dropdowns.
    import re as _re
    filter_options = {}
    field_to_probe = {
        "department":         "SELECT DISTINCT COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''),'Unspecified') AS v FROM `ai-vertex-mahad.Satori_Project.Employee_Data` WHERE EmployeeHierarchyNode IS NOT NULL ORDER BY v",
        "EmployeeHierarchyNode": "SELECT DISTINCT COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''),'Unspecified') AS v FROM `ai-vertex-mahad.Satori_Project.Employee_Data` WHERE EmployeeHierarchyNode IS NOT NULL ORDER BY v",
        "employee_type":      "SELECT DISTINCT Employee_Type AS v FROM `ai-vertex-mahad.Satori_Project.Employee_Data` WHERE Employee_Type IS NOT NULL ORDER BY v",
        "Employee_Type":      "SELECT DISTINCT Employee_Type AS v FROM `ai-vertex-mahad.Satori_Project.Employee_Data` WHERE Employee_Type IS NOT NULL ORDER BY v",
        "location":           "SELECT DISTINCT EmployeeLocation AS v FROM `ai-vertex-mahad.Satori_Project.Employee_Data` WHERE EmployeeLocation IS NOT NULL ORDER BY v",
        "EmployeeLocation":  "SELECT DISTINCT EmployeeLocation AS v FROM `ai-vertex-mahad.Satori_Project.Employee_Data` WHERE EmployeeLocation IS NOT NULL ORDER BY v",
        "position":           "SELECT DISTINCT EmployeePosition AS v FROM `ai-vertex-mahad.Satori_Project.Employee_Data` WHERE EmployeePosition IS NOT NULL ORDER BY v",
        "EmployeePosition":  "SELECT DISTINCT EmployeePosition AS v FROM `ai-vertex-mahad.Satori_Project.Employee_Data` WHERE EmployeePosition IS NOT NULL ORDER BY v",
        "AM":                 "SELECT DISTINCT AM AS v FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` WHERE AM IS NOT NULL ORDER BY v",
        "am":                 "SELECT DISTINCT AM AS v FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` WHERE AM IS NOT NULL ORDER BY v",
        "VP":                 "SELECT DISTINCT VP AS v FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` WHERE VP IS NOT NULL ORDER BY v",
        "vp":                 "SELECT DISTINCT VP AS v FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` WHERE VP IS NOT NULL ORDER BY v",
        "City":               "SELECT DISTINCT City AS v FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` WHERE City IS NOT NULL ORDER BY v",
        "city":               "SELECT DISTINCT City AS v FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` WHERE City IS NOT NULL ORDER BY v",
        "Tier":               "SELECT DISTINCT Tier AS v FROM `ai-vertex-mahad.Satori_Project.Sales_Accounts` WHERE Tier IS NOT NULL ORDER BY v",
        "tier":               "SELECT DISTINCT Tier AS v FROM `ai-vertex-mahad.Satori_Project.Sales_Accounts` WHERE Tier IS NOT NULL ORDER BY v",
        "attendance_status_text":
                              "SELECT DISTINCT attendance_status_text AS v FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` WHERE attendance_status_text IS NOT NULL ORDER BY v",
    }
    for f in (config.get("filters") or [])[:8]:
        field = f.get("field") if isinstance(f, dict) else None
        if not field:
            continue
        probe_sql = field_to_probe.get(field)
        if not probe_sql:
            safe_col = _re.sub(r"[^A-Za-z0-9_]", "", field)
            if safe_col:
                probe_sql = (
                    "SELECT DISTINCT " + safe_col + " AS v "
                    "FROM `ai-vertex-mahad.Satori_Project.Employee_Data` "
                    "WHERE " + safe_col + " IS NOT NULL ORDER BY v LIMIT 100"
                )
        if probe_sql:
            # Filter probes also need the project autofix so dropdown options
            # populate on the new project after migration.
            probe_sql = normalize_bq_project(probe_sql)
        if not probe_sql:
            continue
        try:
            res = bq_run_query(probe_sql, max_rows=100)
            if "error" not in res:
                vals = [row.get("v") for row in (res.get("rows") or []) if row.get("v") not in (None, "")]
                filter_options[field] = vals
            else:
                print(f"[dashboard] filter probe {field} error: {res['error']}")
                filter_options[field] = []
        except Exception as e:
            print(f"[dashboard] filter probe {field} exception: {e}")
            filter_options[field] = []

    return {"kpis": kpis_out, "charts": charts_out, "filterOptions": filter_options}


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
#  AVAILABILITY ENGINE  ──  KPIs + skill tags + employee cards + AI Find Best Fit
#  ----------------------------------------------------------------------------
#  Surfaces the "who's free, who's loaded, who fits this project" view. KPIs:
#  Total / On Bench / Partial / Allocated / High Activity / No Timesheet.
#  Status bands:
#    Bench     = MAX(allocation_percent) over last 90 days = 0
#    Partial   = 0 < MAX(alloc%) < 100
#    Allocated = MAX(alloc%) >= 100
#  Engagement bands (last-90-days timesheet hours):
#    High Activity = hrs_90d >= 120
#    No Timesheet  = hrs_90d = 0
#  All queries respect the active-employees filter (Employee_Type IN mto /
#  permanent / probation). SQL is sent through normalize_bq_project +
#  _autofix_dashboard_sql so the migration story (capability-agent-prod env
#  flip) and the predictable-AI-mistake autofixes both still apply.
# ═══════════════════════════════════════════════════════════════════════════════

def _bq_avail(prefix: str) -> str:
    """Backtick-wrapped fully-qualified table reference for the Availability
    Engine SQL helpers below. Centralised so we don't sprinkle string-formatted
    `BQ_FULL` references across the module."""
    return f"`{BQ_FULL}.{prefix}`"


def _dept_scope_clause(dept_scope: list | None) -> str:
    """Produce the ' AND EmployeeHierarchyNode IN (...)' fragment to append to
    the active-employees WHERE clause. Returns empty string for unrestricted
    users (admins, or non-admins with no scope rows). Values are quoted with
    BigQuery's safe-quote rules (' replaced with '')."""
    if not dept_scope:
        return ""
    quoted = ", ".join("'" + str(v).replace("'", "''") + "'" for v in dept_scope)
    return f" AND COALESCE(NULLIF(TRIM(EmployeeHierarchyNode), ''), 'Unspecified') IN ({quoted})"


def _norm_emp_id(col: str) -> str:
    """Normalize an employee-ID column for cross-table joining.

    Different source systems write the same employee with different shapes
    (confirmed via /api/availability/_diag on capability-agent-prod):
      - Employee_Data.Employee_Code        = 'E-1712' (letter prefix + dash)
      - Allocation_data.employee_id        = 'E-2141', 'I-2024' (varies)
      - Timesheet_Data.TICKET_USER_ID      = '1643'   (digits only — no prefix)

    REGEXP_EXTRACT pulls the first run of digits out of the value, which
    canonicalises all three shapes to the same numeric string ('1712',
    '2141', '1643'). LTRIM('0') then collapses zero-padded variants so
    '00001234' and '1234' also match.

    Wrapped with NULLIF + COALESCE so a value with no digits at all
    (or an all-zero value like '000') falls to '0' instead of '' — empty
    string would join every padless row to every other padless row."""
    return (
        f"COALESCE(NULLIF(LTRIM("
        f"REGEXP_EXTRACT(CAST({col} AS STRING), r'\\d+'), '0'), ''), '0')"
    )


def _avail_kpis_sql(dept_scope: list | None = None) -> str:
    emp_id_emp   = _norm_emp_id("Employee_Code")
    emp_id_alloc = _norm_emp_id("employee_id")
    emp_id_ts    = _norm_emp_id("TICKET_USER_ID")
    return f"""
        WITH active_emp AS (
          SELECT {emp_id_emp} AS emp_id
          FROM {_bq_avail('Employee_Data')}
          WHERE LOWER(COALESCE(Employee_Type, '')) IN ('mto', 'permanent', 'probation')
                {_dept_scope_clause(dept_scope)}
        ),
        emp_alloc AS (
          -- 90-day window anchored to MAX(Date) in Allocation_data so the
          -- bench/partial/allocated bands reflect CURRENT state, not lifetime.
          -- Without this filter, anyone who's ever hit 100% gets stuck in
          -- 'Allocated' forever (1,096/1,139 rows on prod). NULL-safe: if
          -- Allocation_data.Date is entirely unparseable, fall back to
          -- lifetime aggregation so we don't blank everyone.
          SELECT {emp_id_alloc} AS emp_id,
                 MAX(SAFE_CAST(allocation_percent AS FLOAT64)) AS max_pct
          FROM {_bq_avail('Allocation_data')}
          WHERE (SELECT MAX(COALESCE(
                   SAFE_CAST(CAST(Date AS STRING) AS DATE),
                   SAFE.PARSE_DATE('%Y%m%d', CAST(Date AS STRING))
                 )) FROM {_bq_avail('Allocation_data')}) IS NULL
             OR COALESCE(
                  SAFE_CAST(CAST(Date AS STRING) AS DATE),
                  SAFE.PARSE_DATE('%Y%m%d', CAST(Date AS STRING))
                ) >= DATE_SUB(
                  (SELECT MAX(COALESCE(
                    SAFE_CAST(CAST(Date AS STRING) AS DATE),
                    SAFE.PARSE_DATE('%Y%m%d', CAST(Date AS STRING))
                  )) FROM {_bq_avail('Allocation_data')}),
                  INTERVAL 90 DAY
                )
          GROUP BY emp_id
        ),
        emp_ts AS (
          -- DATE_KEY type varies across environments: docs say
          -- INT64 YYYYMMDD but capability-agent-prod actually stores
          -- it as DATE. COALESCE of two parses handles both shapes.
          --
          -- Window is anchored to MAX(date) in the data, not CURRENT_DATE,
          -- so the "last 90 days" stays meaningful even when the data
          -- is older than the server clock (e.g. a year-old QVD import).
          --
          -- TICKET_USER_ID is normalised via _norm_emp_id so leading
          -- zeros / float-cast suffixes don't break the join to active_emp.
          SELECT {emp_id_ts} AS emp_id,
                 SUM(SAFE_CAST(TICKET_HOURS AS FLOAT64)) AS hrs_90d
          FROM {_bq_avail('Timesheet_Data')}
          WHERE COALESCE(
                  SAFE_CAST(CAST(DATE_KEY AS STRING) AS DATE),
                  SAFE.PARSE_DATE('%Y%m%d', CAST(DATE_KEY AS STRING))
                ) >= (
                  SELECT DATE_SUB(MAX(COALESCE(
                    SAFE_CAST(CAST(DATE_KEY AS STRING) AS DATE),
                    SAFE.PARSE_DATE('%Y%m%d', CAST(DATE_KEY AS STRING))
                  )), INTERVAL 90 DAY)
                  FROM {_bq_avail('Timesheet_Data')}
                )
          GROUP BY emp_id
        )
        SELECT
          (SELECT COUNT(DISTINCT emp_id) FROM active_emp) AS total_employees,
          (SELECT COUNT(DISTINCT ae.emp_id) FROM active_emp ae
             LEFT JOIN emp_alloc ea ON ea.emp_id = ae.emp_id
             WHERE COALESCE(ea.max_pct, 0) = 0) AS on_bench,
          (SELECT COUNT(DISTINCT ae.emp_id) FROM active_emp ae
             JOIN emp_alloc ea ON ea.emp_id = ae.emp_id
             WHERE ea.max_pct > 0 AND ea.max_pct < 100) AS partial,
          (SELECT COUNT(DISTINCT ae.emp_id) FROM active_emp ae
             JOIN emp_alloc ea ON ea.emp_id = ae.emp_id
             WHERE ea.max_pct >= 100) AS allocated,
          (SELECT COUNT(DISTINCT ae.emp_id) FROM active_emp ae
             JOIN emp_ts et ON et.emp_id = ae.emp_id
             WHERE et.hrs_90d >= 120) AS high_activity,
          (SELECT COUNT(DISTINCT ae.emp_id) FROM active_emp ae
             LEFT JOIN emp_ts et ON et.emp_id = ae.emp_id
             WHERE COALESCE(et.hrs_90d, 0) = 0) AS no_timesheet
    """


def _avail_skills_sql(limit: int = 50, min_count: int = 5, dept_scope: list | None = None) -> str:
    """Combined skill/competency tag list. Union of Allocation_data.emp_competency
    (latest per employee) and Employee_Data.EmployeePosition, with per-tag
    DISTINCT-employee counts. Tags with fewer than min_count employees are
    hidden to keep the row digestible."""
    emp_id_emp   = _norm_emp_id("Employee_Code")
    emp_id_alloc = _norm_emp_id("employee_id")
    return f"""
        WITH active_emp AS (
          SELECT {emp_id_emp} AS emp_id,
                 COALESCE(NULLIF(TRIM(EmployeePosition), ''), '') AS position
          FROM {_bq_avail('Employee_Data')}
          WHERE LOWER(COALESCE(Employee_Type, '')) IN ('mto', 'permanent', 'probation')
                {_dept_scope_clause(dept_scope)}
        ),
        latest_alloc AS (
          -- One competency per employee. ANY_VALUE instead of ROW_NUMBER
          -- because Allocation_data.Date type varies across environments
          -- and ORDER BY Date errors on capability-agent-prod. ANY_VALUE
          -- picks a representative competency per employee non-deterministically,
          -- which is fine for the tag-count aggregation downstream.
          SELECT {emp_id_alloc} AS emp_id,
                 ANY_VALUE(TRIM(emp_competency)) AS emp_competency
          FROM {_bq_avail('Allocation_data')}
          WHERE emp_competency IS NOT NULL AND TRIM(emp_competency) != ''
          GROUP BY emp_id
        ),
        emp_tags AS (
          SELECT ae.emp_id, TRIM(la.emp_competency) AS tag
          FROM active_emp ae
          LEFT JOIN latest_alloc la ON la.emp_id = ae.emp_id
          WHERE la.emp_competency IS NOT NULL AND TRIM(la.emp_competency) != ''
          UNION ALL
          SELECT emp_id, position AS tag FROM active_emp WHERE position != ''
        )
        SELECT tag AS skill, COUNT(DISTINCT emp_id) AS count
        FROM emp_tags
        WHERE tag IS NOT NULL AND tag != ''
        GROUP BY tag
        HAVING COUNT(DISTINCT emp_id) >= {int(min_count)}
        ORDER BY count DESC
        LIMIT {int(limit)}
    """


def _avail_employees_sql(limit: int = 500, dept_scope: list | None = None) -> str:
    """Per-employee card data. One row per active employee with allocation %,
    project count, latest competency, 90d timesheet hours, and a derived
    status band (Bench / Partial / Allocated)."""
    emp_id_emp   = _norm_emp_id("Employee_Code")
    emp_id_alloc = _norm_emp_id("employee_id")
    emp_id_ts    = _norm_emp_id("TICKET_USER_ID")
    return f"""
        WITH active_emp AS (
          SELECT {emp_id_emp} AS emp_id,
                 Employee_Code AS code,
                 Resource_Name AS name,
                 COALESCE(NULLIF(TRIM(EmployeePosition), ''), '') AS position,
                 COALESCE(NULLIF(TRIM(EmployeeHierarchyNode), ''), 'Unspecified') AS department,
                 COALESCE(NULLIF(TRIM(EmployeeLocation), ''), '') AS location
          FROM {_bq_avail('Employee_Data')}
          WHERE LOWER(COALESCE(Employee_Type, '')) IN ('mto', 'permanent', 'probation')
                {_dept_scope_clause(dept_scope)}
        ),
        alloc AS (
          -- 90-day window matching emp_alloc in _avail_kpis_sql so cards
          -- and KPI counts agree. NULL-safe fallback to lifetime aggregation
          -- if Allocation_data.Date is entirely unparseable.
          SELECT {emp_id_alloc} AS emp_id,
                 MAX(SAFE_CAST(allocation_percent AS FLOAT64)) AS max_pct,
                 COUNT(DISTINCT project_id) AS project_count,
                 ANY_VALUE(emp_competency) AS competency
          FROM {_bq_avail('Allocation_data')}
          WHERE (SELECT MAX(COALESCE(
                   SAFE_CAST(CAST(Date AS STRING) AS DATE),
                   SAFE.PARSE_DATE('%Y%m%d', CAST(Date AS STRING))
                 )) FROM {_bq_avail('Allocation_data')}) IS NULL
             OR COALESCE(
                  SAFE_CAST(CAST(Date AS STRING) AS DATE),
                  SAFE.PARSE_DATE('%Y%m%d', CAST(Date AS STRING))
                ) >= DATE_SUB(
                  (SELECT MAX(COALESCE(
                    SAFE_CAST(CAST(Date AS STRING) AS DATE),
                    SAFE.PARSE_DATE('%Y%m%d', CAST(Date AS STRING))
                  )) FROM {_bq_avail('Allocation_data')}),
                  INTERVAL 90 DAY
                )
          GROUP BY emp_id
        ),
        emp_ts AS (
          -- Same MAX-date-anchored 90-day window as _avail_kpis_sql so
          -- the engine reflects whatever data is loaded rather than the
          -- server's wall-clock relative to it. TICKET_USER_ID is normalised
          -- (leading zeros stripped, '.0' float suffix removed) so the join
          -- back to active_emp matches regardless of column type / padding.
          SELECT {emp_id_ts} AS emp_id,
                 SUM(SAFE_CAST(TICKET_HOURS AS FLOAT64)) AS hrs_90d
          FROM {_bq_avail('Timesheet_Data')}
          WHERE COALESCE(
                  SAFE_CAST(CAST(DATE_KEY AS STRING) AS DATE),
                  SAFE.PARSE_DATE('%Y%m%d', CAST(DATE_KEY AS STRING))
                ) >= (
                  SELECT DATE_SUB(MAX(COALESCE(
                    SAFE_CAST(CAST(DATE_KEY AS STRING) AS DATE),
                    SAFE.PARSE_DATE('%Y%m%d', CAST(DATE_KEY AS STRING))
                  )), INTERVAL 90 DAY)
                  FROM {_bq_avail('Timesheet_Data')}
                )
          GROUP BY emp_id
        )
        SELECT
          ae.code,
          ae.name,
          ae.position,
          ae.department,
          ae.location,
          COALESCE(a.max_pct, 0) AS allocation_pct,
          COALESCE(a.project_count, 0) AS project_count,
          COALESCE(NULLIF(TRIM(a.competency), ''), ae.position) AS competency,
          COALESCE(et.hrs_90d, 0) AS hrs_90d,
          CASE
            WHEN COALESCE(a.max_pct, 0) = 0 THEN 'Bench'
            WHEN a.max_pct >= 100 THEN 'Allocated'
            ELSE 'Partial'
          END AS status
        FROM active_emp ae
        LEFT JOIN alloc a ON a.emp_id = ae.emp_id
        LEFT JOIN emp_ts et ON et.emp_id = ae.emp_id
        ORDER BY ae.name
        LIMIT {int(limit)}
    """


def _avail_departments_sql(dept_scope: list | None = None) -> str:
    """Distinct department list for the Create-Task modal dropdown."""
    return f"""
        SELECT DISTINCT COALESCE(NULLIF(TRIM(EmployeeHierarchyNode), ''), 'Unspecified') AS department
        FROM {_bq_avail('Employee_Data')}
        WHERE LOWER(COALESCE(Employee_Type, '')) IN ('mto', 'permanent', 'probation')
              {_dept_scope_clause(dept_scope)}
        ORDER BY department
    """


@app.get("/api/availability/kpis")
def availability_kpis(user: dict = Depends(get_current_user)):
    """Return the 6 KPI counts shown at the top of the engine."""
    dept_scope = _get_user_dept_scope(int(user["sub"]))
    sql = normalize_bq_project(_autofix_dashboard_sql(_avail_kpis_sql(dept_scope=dept_scope)))
    r = bq_run_query(sql, max_rows=1)
    if "error" in r:
        print(f"[/api/availability/kpis] BQ error: {r['error']}")
        raise HTTPException(status_code=500, detail=r["error"])
    rows = r.get("rows") or []
    if not rows:
        return {"total_employees": 0, "on_bench": 0, "partial": 0, "allocated": 0, "high_activity": 0, "no_timesheet": 0}
    row = rows[0]
    return {
        "total_employees": int(row.get("total_employees") or 0),
        "on_bench":        int(row.get("on_bench") or 0),
        "partial":         int(row.get("partial") or 0),
        "allocated":       int(row.get("allocated") or 0),
        "high_activity":   int(row.get("high_activity") or 0),
        "no_timesheet":    int(row.get("no_timesheet") or 0),
    }


@app.get("/api/availability/skills")
def availability_skills(user: dict = Depends(get_current_user)):
    """Return the skill/competency tag row with per-tag DISTINCT-employee counts."""
    dept_scope = _get_user_dept_scope(int(user["sub"]))
    sql = normalize_bq_project(_autofix_dashboard_sql(_avail_skills_sql(dept_scope=dept_scope)))
    r = bq_run_query(sql, max_rows=100)
    if "error" in r:
        print(f"[/api/availability/skills] BQ error: {r['error']}")
        raise HTTPException(status_code=500, detail=r["error"])
    skills = [{"skill": row.get("skill"), "count": int(row.get("count") or 0)} for row in (r.get("rows") or []) if row.get("skill")]
    return {"skills": skills}


@app.get("/api/availability/departments")
def availability_departments(user: dict = Depends(get_current_user)):
    """Distinct department list, used by the Create-Task / Project modal dropdown."""
    dept_scope = _get_user_dept_scope(int(user["sub"]))
    sql = normalize_bq_project(_autofix_dashboard_sql(_avail_departments_sql(dept_scope=dept_scope)))
    r = bq_run_query(sql, max_rows=500)
    if "error" in r:
        print(f"[/api/availability/departments] BQ error: {r['error']}")
        raise HTTPException(status_code=500, detail=r["error"])
    return {"departments": [row.get("department") for row in (r.get("rows") or []) if row.get("department")]}


@app.get("/api/availability/employees")
def availability_employees(
    status: Optional[str] = None,
    skill: Optional[str] = None,
    department: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 500,
    user: dict = Depends(get_current_user),
):
    """Return employee cards.

    Optional query parameters:
      status      — 'Bench' | 'Partial' | 'Allocated'
      skill       — matches competency OR position (case-insensitive)
      department  — exact department (EmployeeHierarchyNode)
      q           — free-text substring matched against name / position / department / location / competency
      limit       — hard cap on rows returned (default 500)

    Filtering happens in Python over the full result set because the dashboard
    UI typically wants the full list paged client-side. If we ever scale past
    ~3k active employees we'd push these into the SQL WHERE clause instead.
    """
    dept_scope = _get_user_dept_scope(int(user["sub"]))
    sql = normalize_bq_project(_autofix_dashboard_sql(_avail_employees_sql(limit=max(50, min(int(limit), 2000)), dept_scope=dept_scope)))
    r = bq_run_query(sql, max_rows=2000)
    if "error" in r:
        print(f"[/api/availability/employees] BQ error: {r['error']}")
        raise HTTPException(status_code=500, detail=r["error"])
    rows = r.get("rows") or []

    # Coerce numerics to plain Python types so JSON ships cleanly.
    out = []
    for row in rows:
        out.append({
            "code":           row.get("code"),
            "name":           row.get("name"),
            "position":       row.get("position") or "",
            "department":     row.get("department") or "",
            "location":       row.get("location") or "",
            "allocation_pct": float(row.get("allocation_pct") or 0),
            "project_count":  int(row.get("project_count") or 0),
            "competency":     row.get("competency") or "",
            "hrs_90d":        float(row.get("hrs_90d") or 0),
            "status":         row.get("status") or "Bench",
        })

    # Apply server-side filters.
    if status:
        s = status.strip().lower()
        out = [e for e in out if (e["status"] or "").lower() == s]
    if department:
        d = department.strip().lower()
        out = [e for e in out if (e["department"] or "").lower() == d]
    if skill:
        sk = skill.strip().lower()
        out = [e for e in out if sk in (e["competency"] or "").lower() or sk in (e["position"] or "").lower()]
    if q:
        ql = q.strip().lower()
        out = [
            e for e in out
            if ql in (e["name"] or "").lower()
            or ql in (e["position"] or "").lower()
            or ql in (e["department"] or "").lower()
            or ql in (e["location"] or "").lower()
            or ql in (e["competency"] or "").lower()
        ]

    return {"employees": out, "total": len(out)}


@app.get("/api/availability/_diag")
def availability_diag(_: dict = Depends(require_admin)):
    """Admin-only diagnostic endpoint — surfaces raw row counts and a small
    sample of IDs from each upstream table, plus the count of rows that join
    successfully under the normalised-ID rule. If a join shows 0 overlap,
    the per-table sample makes the format mismatch obvious (leading zeros,
    `.0` suffixes, weird prefixes, etc.). Intentionally cheap — total budget
    well under one BQ slot-minute."""
    norm_emp   = _norm_emp_id("Employee_Code")
    norm_alloc = _norm_emp_id("employee_id")
    norm_ts    = _norm_emp_id("TICKET_USER_ID")
    sql = f"""
        WITH emp_sample AS (
          SELECT DISTINCT
            CAST(Employee_Code AS STRING) AS raw,
            {norm_emp} AS norm
          FROM {_bq_avail('Employee_Data')}
          WHERE Employee_Code IS NOT NULL
          LIMIT 5
        ),
        alloc_sample AS (
          SELECT DISTINCT
            CAST(employee_id AS STRING) AS raw,
            {norm_alloc} AS norm
          FROM {_bq_avail('Allocation_data')}
          WHERE employee_id IS NOT NULL
          LIMIT 5
        ),
        ts_sample AS (
          SELECT DISTINCT
            CAST(TICKET_USER_ID AS STRING) AS raw,
            {norm_ts} AS norm
          FROM {_bq_avail('Timesheet_Data')}
          WHERE TICKET_USER_ID IS NOT NULL
          LIMIT 5
        ),
        emp_norm AS (
          SELECT DISTINCT {norm_emp} AS emp_id
          FROM {_bq_avail('Employee_Data')}
          WHERE Employee_Code IS NOT NULL
        ),
        alloc_norm AS (
          SELECT DISTINCT {norm_alloc} AS emp_id
          FROM {_bq_avail('Allocation_data')}
          WHERE employee_id IS NOT NULL
        ),
        ts_norm AS (
          SELECT DISTINCT {norm_ts} AS emp_id
          FROM {_bq_avail('Timesheet_Data')}
          WHERE TICKET_USER_ID IS NOT NULL
        )
        SELECT
          (SELECT COUNT(*) FROM {_bq_avail('Employee_Data')})                AS emp_total_rows,
          (SELECT COUNT(*) FROM {_bq_avail('Allocation_data')})              AS alloc_total_rows,
          (SELECT COUNT(*) FROM {_bq_avail('Timesheet_Data')})               AS ts_total_rows,
          (SELECT COUNT(*) FROM emp_norm)                                    AS emp_distinct_norm,
          (SELECT COUNT(*) FROM alloc_norm)                                  AS alloc_distinct_norm,
          (SELECT COUNT(*) FROM ts_norm)                                     AS ts_distinct_norm,
          (SELECT COUNT(*) FROM emp_norm e JOIN alloc_norm a USING (emp_id)) AS emp_alloc_join,
          (SELECT COUNT(*) FROM emp_norm e JOIN ts_norm    t USING (emp_id)) AS emp_ts_join,
          ARRAY(SELECT AS STRUCT raw, norm FROM emp_sample)                  AS emp_sample,
          ARRAY(SELECT AS STRUCT raw, norm FROM alloc_sample)                AS alloc_sample,
          ARRAY(SELECT AS STRUCT raw, norm FROM ts_sample)                   AS ts_sample
    """
    sql = normalize_bq_project(sql)
    r = bq_run_query(sql, max_rows=1)
    if "error" in r:
        return {"error": r["error"], "project": BQ_PROJECT, "dataset": BQ_DATASET}
    rows = r.get("rows") or []
    return {
        "project": BQ_PROJECT,
        "dataset": BQ_DATASET,
        "summary": rows[0] if rows else None,
    }


@app.get("/api/availability/employees/{code}/detail")
def availability_employee_detail(code: str, user: dict = Depends(get_current_user)):
    """Return drill-down detail for one employee: projects + timesheet
    breakdown over the last 90 days. The card-level data the frontend
    already has (name, position, status, allocation %) is NOT re-shipped
    — the caller passes its existing card object alongside this response.
    """
    emp_code = (code or "").strip()
    if not emp_code:
        raise HTTPException(status_code=400, detail="Employee code is required.")
    # Defensive: escape single quotes in the code to prevent SQL injection.
    safe_code = emp_code.replace("'", "''")

    # Honour department scope: a scoped user can only drill into employees
    # in their own department. One small lookup against Employee_Data to
    # check; cheap and correct.
    dept_scope = _get_user_dept_scope(int(user["sub"]))
    if dept_scope:
        check_sql = normalize_bq_project(f"""
            SELECT COALESCE(NULLIF(TRIM(EmployeeHierarchyNode), ''), 'Unspecified') AS dept
            FROM {_bq_avail('Employee_Data')}
            WHERE CAST(Employee_Code AS STRING) = '{safe_code}'
            LIMIT 1
        """)
        cr = bq_run_query(check_sql, max_rows=1)
        if "error" not in cr:
            crows = cr.get("rows") or []
            if crows:
                emp_dept = (crows[0].get("dept") or "").strip()
                if emp_dept and emp_dept not in dept_scope:
                    raise HTTPException(
                        status_code=403,
                        detail=f"You're scoped to {', '.join(dept_scope)} and don't have access to this employee.",
                    )

    # Normalised lookup key: stripped of leading zeros + trailing '.0' so a
    # `1234` code matches `00001234` or `1234.0` in feeder tables.
    norm_target = _norm_emp_id(f"'{safe_code}'")
    # Project allocations — every project this employee has touched, with
    # peak allocation % and the competency they brought to it. No Date
    # filter (Allocation_data.Date type unreliable on prod, see _avail_kpis_sql).
    alloc_sql = f"""
        SELECT
          COALESCE(NULLIF(TRIM(CAST(project_id AS STRING)), ''), 'Unspecified') AS project_id,
          COALESCE(NULLIF(TRIM(emp_competency), ''), '') AS competency,
          MAX(SAFE_CAST(allocation_percent AS FLOAT64)) AS allocation_pct,
          COUNT(*) AS records
        FROM {_bq_avail('Allocation_data')}
        WHERE {_norm_emp_id('employee_id')} = {norm_target}
        GROUP BY project_id, competency
        ORDER BY allocation_pct DESC, records DESC
        LIMIT 50
    """
    alloc_sql = normalize_bq_project(_autofix_dashboard_sql(alloc_sql))
    r1 = bq_run_query(alloc_sql, max_rows=100)
    if "error" in r1:
        print(f"[/api/availability/employees/detail] alloc BQ error: {r1['error']}")
        raise HTTPException(status_code=500, detail=r1["error"])
    projects = [
        {
            "project_id":     row.get("project_id") or "Unspecified",
            "competency":     row.get("competency") or "",
            "allocation_pct": float(row.get("allocation_pct") or 0),
            "records":        int(row.get("records") or 0),
        }
        for row in (r1.get("rows") or [])
    ]

    # Timesheet breakdown over last 90d — top projects by hours, with
    # ticket counts and last-entry date. Uses the same type-agnostic
    # DATE_KEY filter as the list endpoints (handles DATE + INT64 shapes).
    # TICKET_USER_ID match is normalised so leading zeros / `.0` suffixes
    # don't break the per-employee lookup.
    ts_sql = f"""
        WITH t AS (
          SELECT
            COALESCE(NULLIF(TRIM(TICKET_PROJECT_LABEL), ''), 'Unspecified') AS project,
            SAFE_CAST(TICKET_HOURS AS FLOAT64) AS hours,
            COALESCE(
              SAFE_CAST(CAST(DATE_KEY AS STRING) AS DATE),
              SAFE.PARSE_DATE('%Y%m%d', CAST(DATE_KEY AS STRING))
            ) AS d
          FROM {_bq_avail('Timesheet_Data')}
          WHERE {_norm_emp_id('TICKET_USER_ID')} = {norm_target}
        )
        SELECT
          project,
          ROUND(SUM(hours), 1) AS hrs,
          COUNT(*) AS tickets,
          MAX(d) AS last_entry
        FROM t
        WHERE d >= (SELECT DATE_SUB(MAX(d), INTERVAL 90 DAY) FROM t)
        GROUP BY project
        ORDER BY hrs DESC
        LIMIT 20
    """
    ts_sql = normalize_bq_project(_autofix_dashboard_sql(ts_sql))
    r2 = bq_run_query(ts_sql, max_rows=50)
    timesheet_by_project = []
    total_hrs_90d = 0.0
    if "error" in r2:
        # Don't 500 the whole detail view — log + return empty timesheet.
        print(f"[/api/availability/employees/detail] timesheet BQ error: {r2['error']}")
    else:
        for row in (r2.get("rows") or []):
            hrs = float(row.get("hrs") or 0)
            total_hrs_90d += hrs
            last_entry = row.get("last_entry")
            timesheet_by_project.append({
                "project":    row.get("project") or "Unspecified",
                "hrs":        hrs,
                "tickets":    int(row.get("tickets") or 0),
                "last_entry": str(last_entry) if last_entry else None,
            })

    return {
        "code": emp_code,
        "projects": projects,
        "timesheet": {
            "total_hrs_90d": round(total_hrs_90d, 1),
            "by_project":    timesheet_by_project,
        },
    }


_FIND_BEST_FIT_PROMPT = """You are Satori AI, a senior staffing analyst at TMC. A project owner is creating a new task / project and you have to recommend the BEST 5 employees for it, ranked.

You will receive:
  - The project: name, target department, description, and skills/keywords needed.
  - A pre-filtered candidate pool of available employees in the chosen department (or adjacent departments if the department was 'Unspecified'). Each candidate row tells you their name, position, latest competency, current MAX allocation % over the last 90 days, project count, timesheet hours in the last 90 days, and location.

Rank the candidates against the project using these signals, weighted in this order:

  1. **Availability** — prefer Bench (max alloc% = 0) first, then Partial (>0 and <100). Avoid Allocated (>=100) unless the skill match is so strong that pulling them off something matters.
  2. **Skill match** — does competency or position contain the requested skills/keywords (case-insensitive substring)? More matches = better.
  3. **Recent engagement** — prefer recent timesheet hours > 0 (they're actively working, not dormant) but not absurdly high (avoid >300 hrs/90d unless skill is a near-perfect match).
  4. **Tie-breakers** — same location as project owner's department if known; otherwise prefer fewer concurrent projects.

Return EXACTLY this JSON shape (no markdown, no commentary outside the JSON):

{
  "recommendations": [
    {
      "code": "<employee_code from input>",
      "rank": 1,
      "match_score": 0-100,
      "reasoning": "<1-2 sentences. Mention the specific skill match, availability state, and any caveat.>"
    },
    ... (exactly 5 recommendations, ranked 1-5)
  ]
}

Hard rules:
  - If fewer than 5 candidates are provided, return as many as you got (don't fabricate).
  - Use the exact `code` value from the input (don't guess Employee_Code strings).
  - `match_score` is an integer 0-100. A pure-bench, perfect-skill-match candidate should be ~90-95. Reserve 100 for "exactly this person and they're free now". Skill mismatch + Allocated = below 30.
  - Reasoning must be SPECIFIC (cite the matched skill keyword and the allocation state). Generic praise like "strong candidate" is not acceptable.
"""


@app.post("/api/availability/find-best-fit")
def availability_find_best_fit(body: dict, user: dict = Depends(get_current_user)):
    """Rank candidates for a new project using Gemini Flash.

    Body: {
      name: str,
      department: str,
      description: str,
      skills_keywords: str,            # comma- or space-separated keywords
      max_candidates_to_rank: int = 25 # how many to feed to Gemini
    }
    Returns: {
      candidates_considered: int,
      recommendations: [
        {code, rank, match_score, reasoning, employee: <full card>}
      ]
    }
    """
    name = (body.get("name") or "").strip()
    department = (body.get("department") or "").strip()
    description = (body.get("description") or "").strip()
    skills_keywords = (body.get("skills_keywords") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Project name is required.")
    if not department:
        raise HTTPException(status_code=400, detail="Department is required.")
    max_to_rank = max(5, min(int(body.get("max_candidates_to_rank") or 25), 50))

    # Honour department scope: a practice-head user can only Find Best Fit
    # for projects in their own practice. Block at the door rather than
    # silently returning an empty pool.
    dept_scope = _get_user_dept_scope(int(user["sub"]))
    if dept_scope and department not in dept_scope:
        raise HTTPException(
            status_code=403,
            detail=f"You're scoped to {', '.join(dept_scope)} — can't create tasks for {department!r}.",
        )

    # 1) Pull the candidate pool — active employees in this department, sorted
    #    by availability (Bench first) then by light skill-match heuristic.
    sql = normalize_bq_project(_autofix_dashboard_sql(_avail_employees_sql(limit=2000, dept_scope=dept_scope)))
    r = bq_run_query(sql, max_rows=2000)
    if "error" in r:
        raise HTTPException(status_code=500, detail=r["error"])
    all_rows = r.get("rows") or []
    pool = [row for row in all_rows if (row.get("department") or "").lower() == department.lower()]
    if not pool:
        # Department had no active employees — surface a friendly empty result.
        return {"candidates_considered": 0, "recommendations": []}

    # Light pre-filter — keep Bench + Partial preferentially, then top up with
    # Allocated if we don't have enough. Within each band sort by skill-match
    # count (substring hits) then by hrs_90d descending.
    keywords = [k.strip().lower() for k in re.split(r"[,\n]+", skills_keywords) if k.strip()]
    def _hit_count(emp):
        haystack = (
            (emp.get("competency") or "") + " " +
            (emp.get("position") or "") + " " +
            (emp.get("location") or "")
        ).lower()
        return sum(1 for k in keywords if k in haystack)
    for emp in pool:
        emp["_hits"] = _hit_count(emp)

    bench = sorted([e for e in pool if (e.get("status") or "") == "Bench"], key=lambda e: (-e["_hits"], -(float(e.get("hrs_90d") or 0))))
    partial = sorted([e for e in pool if (e.get("status") or "") == "Partial"], key=lambda e: (-e["_hits"], -(float(e.get("hrs_90d") or 0))))
    allocated = sorted([e for e in pool if (e.get("status") or "") == "Allocated"], key=lambda e: (-e["_hits"], -(float(e.get("hrs_90d") or 0))))
    ranked_pool = (bench + partial + allocated)[:max_to_rank]

    # 2) Build the compact candidate payload for Gemini.
    compact = [
        {
            "code":          e.get("code"),
            "name":          e.get("name"),
            "position":      e.get("position") or "",
            "competency":    e.get("competency") or "",
            "allocation_pct": float(e.get("allocation_pct") or 0),
            "status":        e.get("status") or "",
            "project_count": int(e.get("project_count") or 0),
            "hrs_90d":       float(e.get("hrs_90d") or 0),
            "location":      e.get("location") or "",
        }
        for e in ranked_pool
    ]

    project_payload = {
        "name": name,
        "department": department,
        "description": description,
        "skills_keywords": skills_keywords,
    }

    # 3) Call Gemini Flash with ANALYST_COMMON_SENSE + _FIND_BEST_FIT_PROMPT.
    client = get_genai_client()
    system_instruction = ANALYST_COMMON_SENSE + "\n\n" + _FIND_BEST_FIT_PROMPT
    user_msg = (
        "PROJECT:\n" + json.dumps(project_payload, indent=2) +
        "\n\nCANDIDATES (pre-filtered):\n" + json.dumps(compact, indent=2) +
        "\n\nReturn ONLY the JSON object described in the system instruction."
    )
    try:
        resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[genai.types.Content(role="user", parts=[genai.types.Part(text=user_msg)])],
            config=genai.types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=0.3,
                max_output_tokens=2048,
                response_mime_type="application/json",
            ),
        )
        text = resp.text or "{}"
    except Exception as e:
        print(f"[/api/availability/find-best-fit] Gemini error: {e}")
        raise HTTPException(status_code=502, detail=f"AI ranking failed: {e}")

    # 4) Parse Gemini's response. With response_mime_type=json the model
    #    *should* return raw JSON, but in practice it sometimes returns
    #    empty / truncated text (token-budget), fenced code blocks, or
    #    JSON wrapped in prose. Be tolerant: try direct parse, then
    #    balanced-brace extraction, and fall through to a deterministic
    #    ranker below if both fail so the modal never errors out.
    parsed = None
    raw_for_log = text
    try:
        text = (text or "").strip()
        if text.startswith("```"):
            text = text.lstrip("`")
            if text.lower().startswith("json"):
                text = text[4:]
            text = text.strip()
            if text.endswith("```"):
                text = text[:-3].strip()
        try:
            parsed = json.loads(text)
        except Exception:
            start = text.find("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                parsed = json.loads(text[start:end + 1])
    except Exception as e:
        print(f"[/api/availability/find-best-fit] parse error: {e}; raw: {raw_for_log[:400]!r}")
        parsed = None

    recs = (parsed or {}).get("recommendations") or []
    if not isinstance(recs, list):
        recs = []

    # 4b) Deterministic fallback — when Gemini fails or returns nothing
    #     usable. Score = 50 base + status bonus + capped skill-hit bonus.
    #     Reasoning text is built from the candidate's facts directly so
    #     it stays specific (matched keywords, allocation %, recent hours)
    #     even without the LLM.
    if not recs:
        print("[/api/availability/find-best-fit] using deterministic fallback ranker")
        for i, e in enumerate(ranked_pool[:5]):
            hits = int(e.get("_hits") or 0)
            status = e.get("status") or ""
            score = 50
            if status == "Bench":
                score += 35
            elif status == "Partial":
                score += 20
            else:
                score += 5
            score += min(20, hits * 7)
            score = max(20, min(95, score))
            comp = (e.get("competency") or "").strip() or "—"
            pos = (e.get("position") or "").strip() or "—"
            alloc = round(float(e.get("allocation_pct") or 0))
            hrs = round(float(e.get("hrs_90d") or 0))
            haystack = ((e.get("competency", "") or "") + " " + (e.get("position", "") or "") + " " + (e.get("location", "") or "")).lower()
            keyword_hits = [k for k in keywords if k in haystack]
            if status == "Bench":
                avail_note = "Currently on Bench (0% allocated) — available immediately."
            elif status == "Partial":
                avail_note = f"Partially allocated at {alloc}% — has remaining capacity."
            else:
                avail_note = f"Currently allocated at {alloc}% — would need to be reassigned."
            if keyword_hits:
                skill_note = f"Matches keyword{'s' if len(keyword_hits) > 1 else ''}: {', '.join(keyword_hits[:3])} (in {comp} / {pos})."
            else:
                skill_note = f"No direct keyword match — {comp} role in {e.get('location') or '—'}."
            ts_note = "No timesheet activity in last 90 days." if hrs == 0 else f"Active: {hrs}h logged in last 90 days."
            recs.append({
                "code": e.get("code"),
                "rank": i + 1,
                "match_score": score,
                "reasoning": f"{avail_note} {skill_note} {ts_note}",
            })

    # 5) Hydrate each recommendation with the full employee record.
    pool_by_code = {(e.get("code") or ""): e for e in ranked_pool}
    enriched = []
    for rec in recs:
        code = (rec or {}).get("code") or ""
        emp = pool_by_code.get(code)
        if not emp:
            # Skip recs that point to codes that aren't in the pool (defensive).
            continue
        enriched.append({
            "code":        code,
            "rank":        int(rec.get("rank") or len(enriched) + 1),
            "match_score": int(rec.get("match_score") or 0),
            "reasoning":   rec.get("reasoning") or "",
            "employee": {
                "code":           emp.get("code"),
                "name":           emp.get("name"),
                "position":       emp.get("position") or "",
                "department":     emp.get("department") or "",
                "location":       emp.get("location") or "",
                "competency":     emp.get("competency") or "",
                "allocation_pct": float(emp.get("allocation_pct") or 0),
                "project_count":  int(emp.get("project_count") or 0),
                "hrs_90d":        float(emp.get("hrs_90d") or 0),
                "status":         emp.get("status") or "Bench",
            },
        })
    enriched.sort(key=lambda r: r["rank"])

    return {
        "candidates_considered": len(ranked_pool),
        "recommendations": enriched[:5],
    }


@app.get("/api/availability/tasks")
def availability_list_tasks(user: dict = Depends(get_current_user)):
    """List the current user's Availability Engine tasks."""
    uid = int(user["sub"])
    db = get_db(); cur = db.cursor()
    try:
        cur.execute(
            "SELECT id, name, department, description, skills_keywords, status, "
            "assigned_employee_codes, ai_reasoning, created_at, updated_at "
            "FROM availability_tasks WHERE user_id = ? ORDER BY created_at DESC",
            (uid,),
        )
        rows = [dict(r) for r in cur.fetchall()]
    except Exception as e:
        print(f"[/api/availability/tasks] error: {e}")
        rows = []
    db.close()
    # Deserialise JSON columns for the frontend.
    for r in rows:
        for k in ("assigned_employee_codes", "ai_reasoning"):
            v = r.get(k)
            if isinstance(v, str):
                try:
                    r[k] = json.loads(v)
                except Exception:
                    r[k] = [] if k == "assigned_employee_codes" else {}
    return {"tasks": rows}


@app.post("/api/availability/tasks")
def availability_create_task(body: dict, user: dict = Depends(get_current_user)):
    """Persist a Create-Task / Project entry.
    Body: { name, department, description, skills_keywords, assigned_employee_codes: [], ai_reasoning: {} }
    """
    from database import USE_POSTGRES
    uid = int(user["sub"])
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Task name is required.")
    department = (body.get("department") or "").strip()
    description = (body.get("description") or "").strip()
    skills_keywords = (body.get("skills_keywords") or "").strip()
    assigned = body.get("assigned_employee_codes") or []
    if not isinstance(assigned, list):
        assigned = []
    reasoning = body.get("ai_reasoning") or {}
    if not isinstance(reasoning, (dict, list)):
        reasoning = {}
    status = (body.get("status") or "open").strip() or "open"

    assigned_json = json.dumps(assigned)
    reasoning_json = json.dumps(reasoning)

    db = get_db(); cur = db.cursor()
    if USE_POSTGRES:
        cur.execute(
            "INSERT INTO availability_tasks "
            "(user_id, name, department, description, skills_keywords, status, "
            " assigned_employee_codes, ai_reasoning) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            (uid, name, department, description, skills_keywords, status, assigned_json, reasoning_json),
        )
        row = cur.fetchone()
        new_id = row["id"] if isinstance(row, dict) else row[0]
    else:
        cur.execute(
            "INSERT INTO availability_tasks "
            "(user_id, name, department, description, skills_keywords, status, "
            " assigned_employee_codes, ai_reasoning) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (uid, name, department, description, skills_keywords, status, assigned_json, reasoning_json),
        )
        new_id = cur.lastrowid
    db.commit(); db.close()
    return {"id": new_id, "ok": True}


@app.put("/api/availability/tasks/{task_id}")
def availability_update_task(task_id: int, body: dict, user: dict = Depends(get_current_user)):
    """Update a task — typically status changes (open → in_progress → done) or reassignment."""
    from database import USE_POSTGRES
    uid = int(user["sub"])
    sets, params = [], []
    if "name" in body:
        sets.append("name = ?");        params.append((body.get("name") or "").strip())
    if "department" in body:
        sets.append("department = ?");  params.append((body.get("department") or "").strip())
    if "description" in body:
        sets.append("description = ?"); params.append((body.get("description") or "").strip())
    if "skills_keywords" in body:
        sets.append("skills_keywords = ?"); params.append((body.get("skills_keywords") or "").strip())
    if "status" in body:
        sets.append("status = ?");      params.append((body.get("status") or "open").strip())
    if "assigned_employee_codes" in body:
        sets.append("assigned_employee_codes = ?"); params.append(json.dumps(body.get("assigned_employee_codes") or []))
    if "ai_reasoning" in body:
        sets.append("ai_reasoning = ?"); params.append(json.dumps(body.get("ai_reasoning") or {}))
    if not sets:
        return {"ok": True, "note": "nothing to update"}
    sets.append("updated_at = " + ("NOW()" if USE_POSTGRES else "datetime('now')"))
    params.extend([task_id, uid])
    db = get_db(); cur = db.cursor()
    cur.execute(f"UPDATE availability_tasks SET {', '.join(sets)} WHERE id = ? AND user_id = ?", tuple(params))
    db.commit(); db.close()
    return {"ok": True}


@app.delete("/api/availability/tasks/{task_id}")
def availability_delete_task(task_id: int, user: dict = Depends(get_current_user)):
    uid = int(user["sub"])
    db = get_db(); cur = db.cursor()
    cur.execute("DELETE FROM availability_tasks WHERE id = ? AND user_id = ?", (task_id, uid))
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
    Employee_Code, Resource_Name, EmployeePosition, EmployeeHierarchyNode (= department),
    EmployeeLocation, Employee_Type, Joining_Date, Gender.
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
- Joins: Employee_Code is stored like 'E-2141'; employee_id / TICKET_USER_ID are bare numbers. Use LTRIM(REGEXP_REPLACE(CAST(<col> AS STRING), r'[^0-9]', ''), '0') on both sides. Always LEFT JOIN, never plain JOIN. EmployeeHierarchyNode = department.
- For department grouping: COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''), 'Unspecified').
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
                system_instruction=(
                    ANALYST_COMMON_SENSE + "\n\n" +
                    _REPORT_SYSTEM_PROMPT + "\n\n" +
                    _load_schema_settings_block() + "\n\n" +
                    live_schema.render_context_block() +
                    _user_context_addon(user)
                ),
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

    # Rewrite legacy project/dataset refs from saved configs, then apply the
    # same dashboard-style autofix (backticks, dataset prefixes, etc.).
    sql = normalize_bq_project(sql)
    sql = _autofix_dashboard_sql(sql)

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

# ═══════════════════════════════════════════════════════════════════════════════
#  SCHEMA SETTINGS  ──  user-curated descriptions per table that get injected
#  into every agent's system prompt. Lets admins teach Satori what each table
#  contains (column types, business meaning, join hints) so the AI doesn't
#  have to rediscover the warehouse on every call.
# ═══════════════════════════════════════════════════════════════════════════════

_DEFAULT_SCHEMA_SETTINGS = [
    {
        "table_name": "Employee_Data",
        "sort_order": 10,
        "description": (
            "Master employee records (1,199 rows).\n"
            "Columns: Employee_Code (STRING, e.g. 'E-2141'), Resource_Name (STRING — full name), "
            "EmployeePosition (STRING), EmployeeEmail (STRING), EmployeeHierarchyNode (STRING = department), "
            "EmployeeLocation (STRING — city), Employee_Status (STRING), Employee_Type (STRING — Permanent / MTO / Probation / Contractual Fixed term / Contractor / Freelancer / Internship), "
            "Joining_Date, Gender.\n"
            "JOIN with Attendance_Data on UPPER(TRIM(Resource_Name)) = UPPER(TRIM(employee_name)) — "
            "Employee_Code does NOT match employee_id.\n"
            "Department grouping: COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''),'Unspecified') AS department."
        ),
    },
    {
        "table_name": "Attendance_Data",
        "sort_order": 20,
        "description": (
            "Daily attendance per employee (~208k rows, date range Dec 2025 → Apr 2026).\n"
            "Columns: attendance_date (DATE), employee_id (STRING), employee_name (STRING), employee_email, "
            "checkin_time / checkout_time (STRING HH:MM:SS), attendance_status_text (STRING — values: "
            "Present, Weekend, Absent, Missing Punch, Holiday, On Leave, Remote Work, and their 'Submitted …' variants — there is NO 'Late' status), "
            "is_present, is_absent, is_on_leave, is_remote, is_holiday, is_weekend (all 0/1 INT), leave_type_name.\n"
            "Attendance % = ROUND(100.0*SUM(is_present)/NULLIF(COUNT(*),0),1).\n"
            "JOIN with Employee_Data on UPPER(TRIM(employee_name)) = UPPER(TRIM(Resource_Name))."
        ),
    },
    {
        "table_name": "Allocation_data",
        "sort_order": 30,
        "description": (
            "Weekly project allocation (~385k rows).\n"
            "Columns: project_id (STRING), employee_id (STRING), emp_name (STRING — JOIN key to Employee_Data.Resource_Name), "
            "allocation_percent (INT64 or STRING — use SAFE_CAST AS FLOAT64), emp_competency (STRING), "
            "Flag (STRING — values: 'Allocated' / 'Bench' — NOT 'Actual' / 'Forecast'), Forecast_Flag, "
            "week_id, year_id, Week, Date (DATE), Year, Month (STRING), Data_Type.\n"
            "Bench classification: MAX(SAFE_CAST(allocation_percent AS FLOAT64)) per employee = 0 or NULL."
        ),
    },
    {
        "table_name": "Timesheet_Data",
        "sort_order": 40,
        "description": (
            "Ticket / project hours (~279k rows).\n"
            "Columns: FLAG (STRING), Key (STRING), TICKET_USER_ID (INT64 — employee), TICKET_ID (INT64), "
            "TICKET_NUMBER (STRING), TICKET_PROJECT_CODE (STRING), TICKET_PROJECT_LABEL (STRING), "
            "TICKET_DESCRIPTION, TICKET_STATUS (STRING), TICKET_WEEK_NO, TICKET_PRIORITY, "
            "TICKET_HOURS (STRING — SAFE_CAST AS FLOAT64), DATE_KEY (INT64 — YYYYMMDD).\n"
            "Timesheet has no name field — joining to Employee_Data is unreliable. Prefer to report against "
            "TICKET_PROJECT_LABEL / TICKET_USER_ID directly."
        ),
    },
    {
        "table_name": "Sales_AM_Scorecard",
        "sort_order": 50,
        "description": (
            "Account Manager performance (8 AMs).\n"
            "Columns: VP, AM, Role, City, col_2026_Target (USD — STRING, SAFE_CAST), Q1_ACH (USD), "
            "Open_Pipeline (USD), Hist_Win_Rate (decimal 0-1 — multiply by 100 for %)."
        ),
    },
    {
        "table_name": "Sales_Accounts",
        "sort_order": 60,
        "description": (
            "Customer accounts (~359 rows).\n"
            "Columns: VP, AM, Location, Account, Tier ('A' / 'B' / 'C' / '-'), Dormant ('Yes' / 'No'), "
            "Jan_Visits, Feb_Visits, Mar_Visits, Q1_Visits (STRING — SAFE_CAST AS INT64), Zero_Visit ('Yes' / 'No')."
        ),
    },
    {
        "table_name": "Sales_Pipeline_Health",
        "sort_order": 70,
        "description": (
            "Salesperson pipeline (14 rows).\n"
            "Columns: Salesperson, Open_Pipeline (USD — STRING, SAFE_CAST), Open_Deals, Win_Rate_by (decimal 0-1)."
        ),
    },
    {
        "table_name": "Sales_Plan_vs_Pipeline",
        "sort_order": 80,
        "description": (
            "Revenue plan vs pipeline (10 rows).\n"
            "Columns: AM, col_2026_Target, Q1_Target, Q1_ACH, CRM_Pipeline, Coverage_Ratio, Status, Action."
        ),
    },
    {
        "table_name": "Sales_Hunting_Gap",
        "sort_order": 90,
        "description": (
            "New-business quotas + gaps per AM (14 rows).\n"
            "Columns: AM, City, Hunting_Target, Hunting_Achieved, Hunting_Gap."
        ),
    },
]


def _ensure_default_schema_settings():
    """Seed the schema_settings table with TMC defaults the first time the
    table is empty (or any specific table is missing). Idempotent — safe to
    call on every startup. Existing user-edited rows are never overwritten."""
    try:
        db = get_db(); cur = db.cursor()
        from database import USE_POSTGRES
        for s in _DEFAULT_SCHEMA_SETTINGS:
            cur.execute("SELECT id FROM schema_settings WHERE table_name = ?", (s["table_name"],))
            if cur.fetchone():
                continue
            if USE_POSTGRES:
                cur.execute(
                    "INSERT INTO schema_settings (table_name, description, sort_order) VALUES (?, ?, ?)",
                    (s["table_name"], s["description"], s["sort_order"]),
                )
            else:
                cur.execute(
                    "INSERT INTO schema_settings (table_name, description, sort_order) VALUES (?, ?, ?)",
                    (s["table_name"], s["description"], s["sort_order"]),
                )
        db.commit(); db.close()
    except Exception as e:
        print(f"[schema_settings] default-seed error: {e}")


_ensure_default_schema_settings()


def _load_schema_settings_block() -> str:
    """Concatenate every saved schema_settings.description into a single text
    block to inject into agent system prompts. Empty if the table is missing
    or no rows exist."""
    try:
        db = get_db(); cur = db.cursor()
        cur.execute("SELECT table_name, description FROM schema_settings ORDER BY sort_order, table_name")
        rows = cur.fetchall()
        db.close()
    except Exception as e:
        print(f"[schema_settings] load error: {e}")
        return ""
    if not rows:
        return ""
    parts = ["=== TABLE-LEVEL SCHEMA NOTES (admin-curated; refer here for column meanings and join keys) ===\n"]
    for r in rows:
        tn = r["table_name"] if isinstance(r, dict) else r[0]
        desc = r["description"] if isinstance(r, dict) else r[1]
        if not (tn and desc):
            continue
        parts.append(f"\n• `ai-vertex-mahad.Satori_Project.{tn}`\n{desc}\n")
    parts.append("\n=== END SCHEMA NOTES ===\n")
    rendered = "".join(parts)
    if BQ_PROJECT != "ai-vertex-mahad":
        rendered = rendered.replace("ai-vertex-mahad", BQ_PROJECT)
    return rendered


# ─── Project-name interpolation ───────────────────────────────────────────────
# Every prompt + seed-description literal above hardcodes the legacy project
# name 'ai-vertex-mahad'. When BQ_PROJECT is overridden (e.g. for the
# capability-agent-prod migration), swap the literal at module load so the AI
# generates SQL against the right project AND the autofix regexes have less to
# fix. Idempotent — no-op when BQ_PROJECT stays 'ai-vertex-mahad'.
if BQ_PROJECT != "ai-vertex-mahad":
    _PROMPT_NAMES = [
        "SYSTEM_PROMPT", "VOICE_SYSTEM_PROMPT_EN", "VOICE_SYSTEM_PROMPT_URDU",
        "DASHBOARD_REFINE_PROMPT", "DASHBOARD_EDIT_PROMPT",
        "_REPORT_SYSTEM_PROMPT", "_SATORI_HELP_PROMPT",
        "_DASHBOARD_SAP_SCHEMAS",
    ]
    for _name in _PROMPT_NAMES:
        _v = globals().get(_name)
        if isinstance(_v, str):
            globals()[_name] = _v.replace("ai-vertex-mahad", BQ_PROJECT)
    # _DEFAULT_SCHEMA_SETTINGS is a list[dict] — swap inside each description.
    try:
        for _s in _DEFAULT_SCHEMA_SETTINGS:
            if isinstance(_s.get("description"), str):
                _s["description"] = _s["description"].replace("ai-vertex-mahad", BQ_PROJECT)
    except NameError:
        pass


@app.get("/api/admin/schema-settings")
def get_schema_settings(user: dict = Depends(get_current_user)):
    db = get_db(); cur = db.cursor()
    cur.execute("SELECT id, table_name, description, sort_order, updated_at FROM schema_settings ORDER BY sort_order, table_name")
    rows = [dict(r) for r in cur.fetchall()]
    db.close()
    return {"settings": rows}


@app.put("/api/admin/schema-settings")
def save_schema_settings(body: dict, user: dict = Depends(get_current_user)):
    """Replace the entire schema_settings table with the rows the user sent.
    Body: { settings: [{table_name, description, sort_order?}] }."""
    from database import USE_POSTGRES
    settings = body.get("settings") or []
    db = get_db(); cur = db.cursor()
    cur.execute("DELETE FROM schema_settings")
    for i, s in enumerate(settings):
        tn = (s.get("table_name") or "").strip()
        if not tn:
            continue
        desc = s.get("description") or ""
        order = s.get("sort_order") or (10 * (i + 1))
        cur.execute(
            "INSERT INTO schema_settings (table_name, description, sort_order) VALUES (?, ?, ?)",
            (tn, desc, order),
        )
    db.commit(); db.close()
    return {"ok": True, "count": len(settings)}


@app.post("/api/admin/schema-settings/reset")
def reset_schema_settings(user: dict = Depends(get_current_user)):
    """Wipe + re-seed schema_settings from _DEFAULT_SCHEMA_SETTINGS."""
    db = get_db(); cur = db.cursor()
    cur.execute("DELETE FROM schema_settings")
    db.commit(); db.close()
    _ensure_default_schema_settings()
    return {"ok": True}


@app.post("/api/admin/schema-settings/auto-detect")
def auto_detect_schema(body: dict, user: dict = Depends(get_current_user)):
    """Pull live column metadata for a single table from BigQuery and return
    a formatted description string the UI can drop into the text area.
    Body: { table_name: 'Employee_Data' } (case-sensitive)."""
    from bigquery_client import get_table_schema, _project, _dataset
    table_name = (body.get("table_name") or "").strip()
    if not table_name:
        raise HTTPException(status_code=400, detail="table_name is required")
    full_id = f"{_project()}.{_dataset()}.{table_name}"
    schema = get_table_schema(full_id)
    if not schema:
        raise HTTPException(status_code=404, detail=f"Schema lookup failed for {full_id}")
    cols_str = ", ".join(f"{f['name']} ({f['type']})" for f in schema[:80])
    return {"table_name": table_name, "description": f"Columns: {cols_str}", "fields": schema}


@app.get("/api/admin/schema-tables")
def list_schema_tables(user: dict = Depends(get_current_user)):
    """List every table in the warehouse so the UI can offer them to add."""
    from bigquery_client import discover_tables
    tables = discover_tables()
    return {"tables": [t["table"] for t in tables]}


@app.get("/api/admin/live-schema")
def live_schema_endpoint(refresh: int = 0):
    """Return the live BQ snapshot the agents currently see. Pass ?refresh=1
    to force a refresh from BigQuery (otherwise hourly cache)."""
    if refresh:
        live_schema.reset_cache()
    snap = live_schema.get_snapshot()
    rendered = live_schema.render_context_block()
    return {"snapshot": snap, "rendered": rendered}


@app.get("/api/admin/schema-probe")
def schema_probe():
    """One-shot sanity probe for debugging empty dashboards.

    NOTE: auth intentionally NOT required — returns aggregate counts and
    distinct values only (no PII), and we want it browser-accessible.

    Returns five small result sets that together tell you whether the
    join keys match, what Employee_Type values actually exist, the
    attendance_date range, the distinct attendance status values, and
    a per-month row count. Run this once when a saved dashboard is
    empty and you can see exactly which assumption is broken.
    """
    probes = {
        "employee_type_values": (
            "SELECT Employee_Type, COUNT(*) AS n "
            "FROM `ai-vertex-mahad.Satori_Project.Employee_Data` "
            "GROUP BY Employee_Type ORDER BY n DESC LIMIT 30"
        ),
        "attendance_date_range": (
            "SELECT MIN(attendance_date) AS min_date, "
            "MAX(attendance_date) AS max_date, COUNT(*) AS total_rows "
            "FROM `ai-vertex-mahad.Satori_Project.Attendance_Data`"
        ),
        "attendance_by_month": (
            "COUNT(*) AS rows, COUNT(DISTINCT employee_id) AS employees "
            "FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` "
            "GROUP BY month ORDER BY month DESC LIMIT 24"
        ),
        "attendance_status_values": (
            "SELECT attendance_status_text, COUNT(*) AS n "
            "FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` "
            "GROUP BY attendance_status_text ORDER BY n DESC LIMIT 30"
        ),
        "join_compatibility": (
            "WITH e AS (SELECT DISTINCT CAST(Employee_Code AS STRING) AS code "
            "  FROM `ai-vertex-mahad.Satori_Project.Employee_Data`), "
            "a AS (SELECT DISTINCT CAST(employee_id AS STRING) AS eid "
            "  FROM `ai-vertex-mahad.Satori_Project.Attendance_Data`) "
            "  (SELECT COUNT(*) FROM e) AS employee_data_distinct, "
            "  (SELECT COUNT(*) FROM a) AS attendance_distinct, "
            "  (SELECT COUNT(*) FROM e JOIN a ON e.code = a.eid) AS overlap, "
            "  (SELECT code FROM e LIMIT 1) AS sample_employee_code, "
            "  (SELECT eid FROM a LIMIT 1) AS sample_employee_id"
        ),
    }
    out = {}
    for name, sql in probes.items():
        r = bq_run_query(sql, max_rows=40)
        out[name] = r
    return {"probes": out}


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
