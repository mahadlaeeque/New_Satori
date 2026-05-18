"""
Data-access audit log.

`record(action, ...)` writes one row to the `data_access_log` table for every
governance-relevant event. Designed to be cheap (single INSERT) and never raise
— if logging fails the caller's main flow continues silently because audit
gaps shouldn't break the product.

Common `action` values:
  dashboard.view           — opening a saved dashboard
  dashboard.run            — executing a dashboard's KPI/chart SQL
  report.preview           — running a report's SQL for the in-browser table
  report.download.excel    — downloading an Excel
  report.download.pdf      — downloading a PDF
  bq.query                 — running ad-hoc SQL via the chat agent (run_sql)
  ai.chat                  — sending a prompt to Gemini text chat
  ai.voice                 — voice WS turn
  share.add                — granting access
  share.remove             — revoking access
  totp.admin_reset         — admin wiped a user's 2FA
  user.export              — GDPR-style data export
  user.delete              — GDPR-style account deletion

`detail` is a free-form JSON string; pass small dicts (row counts, hashes,
filenames). Don't put PII or full SQL in there for sensitive tables — see
the redaction helpers in main.py for that.
"""
import json
import hashlib
from typing import Any

from database import get_db


def record(
    *,
    user: dict | None,
    action: str,
    resource_type: str | None = None,
    resource_id: str | int | None = None,
    detail: dict[str, Any] | None = None,
    request=None,
) -> None:
    """Write one audit row. `user` is the JWT payload (with `sub` and `email`)
    from `get_current_user`, or None for unauthenticated events. `request` is
    the FastAPI Request used to capture IP + user-agent."""
    try:
        uid = None
        email = None
        if user:
            try:
                uid = int(user.get("sub")) if user.get("sub") is not None else None
            except (TypeError, ValueError):
                uid = None
            email = user.get("email")
        ip = None
        ua = None
        if request is not None:
            ip = request.client.host if request.client else None
            ua = request.headers.get("user-agent", "")[:300] if request else None
        detail_str = json.dumps(detail, default=str) if detail else None
        db = get_db()
        cur = db.cursor()
        cur.execute(
            "INSERT INTO data_access_log (user_id, user_email, action, resource_type, resource_id, detail, ip_address, user_agent) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (uid, email, action, resource_type, str(resource_id) if resource_id is not None else None, detail_str, ip, ua),
        )
        db.commit()
        db.close()
    except Exception as e:
        # Never let audit failure break the calling endpoint.
        print(f"[AUDIT] failed to record action={action!r}: {e}")


def sql_hash(sql: str) -> str:
    """Short stable hash of a SQL string — useful for grouping similar queries
    in the audit log without storing the full text (which may carry sensitive
    filter values)."""
    return hashlib.sha256((sql or "").encode("utf-8")).hexdigest()[:16]
