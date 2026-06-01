"""
Minimal SMTP email sender for Satori (password-reset emails).

Provider-agnostic — configured entirely via env vars, no third-party SDK:
  SMTP_HOST       (default 'smtp.gmail.com')
  SMTP_PORT       (default 587 → STARTTLS; use 465 for implicit SSL)
  SMTP_USER       sender login (e.g. 'noreply@tmcltd.com')
  SMTP_PASSWORD   app password / SMTP password  (store in Secret Manager)
  SMTP_FROM       From: address (defaults to SMTP_USER)
  SMTP_FROM_NAME  display name  (default 'Satori')

send_email() returns (ok: bool, detail: str) and NEVER raises — callers decide
how to surface failure. When SMTP_USER / SMTP_PASSWORD are unset it returns
(False, 'not configured') so the password-reset flow degrades gracefully to its
logged-link fallback instead of 500-ing.
"""
import os
import smtplib
import ssl
from email.message import EmailMessage


def is_configured() -> bool:
    return bool(os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASSWORD"))


def send_email(to_addr: str, subject: str, body_text: str,
               body_html: "str | None" = None) -> "tuple[bool, str]":
    user = os.environ.get("SMTP_USER", "").strip()
    pw = os.environ.get("SMTP_PASSWORD", "")
    if not user or not pw:
        return (False, "SMTP not configured (set SMTP_USER + SMTP_PASSWORD)")

    host = os.environ.get("SMTP_HOST", "smtp.gmail.com").strip()
    try:
        port = int(os.environ.get("SMTP_PORT", "587"))
    except ValueError:
        port = 587
    from_addr = os.environ.get("SMTP_FROM", user).strip()
    from_name = os.environ.get("SMTP_FROM_NAME", "Satori").strip()

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{from_addr}>" if from_name else from_addr
    msg["To"] = to_addr
    msg.set_content(body_text)
    if body_html:
        msg.add_alternative(body_html, subtype="html")

    try:
        ctx = ssl.create_default_context()
        if port == 465:
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=20) as s:
                s.login(user, pw)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=20) as s:
                s.ehlo()
                s.starttls(context=ctx)
                s.login(user, pw)
                s.send_message(msg)
        return (True, "sent")
    except Exception as e:
        return (False, f"{type(e).__name__}: {e}")
