from datetime import datetime, timedelta, timezone
from jose import jwt, JWTError
import bcrypt as _bcrypt
import os

SECRET_KEY = os.environ.get("JWT_SECRET", "satori-secret-key-change-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 480  # 8 hours

# Short-lived intermediate tokens used by the 2FA flow.
TOTP_SETUP_EXPIRE_MINUTES = 15      # window to complete fresh enrollment
TOTP_CHALLENGE_EXPIRE_MINUTES = 10  # window between password + TOTP step
TRUST_DEVICE_EXPIRE_DAYS = 30       # "remember this device" cookie lifetime


def verify_password(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode(), hashed.encode())


def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode["exp"] = expire
    # Tag access tokens so they can't be reused where a setup/challenge token
    # is required (and vice versa).
    to_encode.setdefault("typ", "access")
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def create_typed_token(data: dict, typ: str, *, minutes: int | None = None, days: int | None = None) -> str:
    """Generic typed-JWT factory used by the 2FA flow.

    Tokens always carry `typ` and `exp`. The caller specifies either minutes
    or days for the expiry. Used for `totp_setup`, `totp_challenge`, and
    `trust_device` token types.
    """
    to_encode = data.copy()
    if minutes is not None:
        expire = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    elif days is not None:
        expire = datetime.now(timezone.utc) + timedelta(days=days)
    else:
        raise ValueError("create_typed_token requires either minutes= or days=")
    to_encode["exp"] = expire
    to_encode["typ"] = typ
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None


def decode_typed_token(token: str, expected_typ: str) -> dict | None:
    """Decode and only return the payload if `typ` matches. Anything else
    (expired, wrong typ, invalid signature) returns None."""
    payload = decode_token(token)
    if not payload:
        return None
    if payload.get("typ") != expected_typ:
        return None
    return payload
