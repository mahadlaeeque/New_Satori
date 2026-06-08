"""
seed_api_key.py — issue, list, or revoke API keys for the read-only
/api/satori-usage endpoint.

Usage:
  python seed_api_key.py issue  --name monitoring-portal-prod --by you@tmcltd.ai
  python seed_api_key.py list
  python seed_api_key.py revoke --name monitoring-portal-prod

`issue` PRINTS the raw key ONCE to stdout. Only the SHA-256 hash goes into
the database, so this is your only chance to copy it. Share with the consumer
via 1Password or a one-time-secret link — NEVER email it.

Run from inside the backend/ directory so `import database` resolves locally.
On Cloud Run, exec it via:
  gcloud run services proxy satori-v2 --port 8080
  ... then in a separate shell, hit the running container's terminal, or just
  run this once locally against the same Cloud SQL DB.
"""
import argparse
import hashlib
import secrets
import sys

from database import get_db, USE_POSTGRES


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def issue(name: str, by: str) -> int:
    raw = "satori_live_" + secrets.token_urlsafe(28)
    h = _sha256(raw)
    db = get_db()
    try:
        cur = db.cursor()
        cur.execute("SELECT name FROM api_keys WHERE name = ?", (name,))
        if cur.fetchone():
            print(f"ERROR: a key named {name!r} already exists. "
                  "Pick a different name or revoke the old one first.",
                  file=sys.stderr)
            return 2
        if USE_POSTGRES:
            cur.execute(
                "INSERT INTO api_keys (name, key_hash, scope, created_by) "
                "VALUES (?, ?, ?, ?)",
                (name, h, "usage_read", by),
            )
        else:
            cur.execute(
                "INSERT INTO api_keys (name, key_hash, scope, created_by) "
                "VALUES (?, ?, ?, ?)",
                (name, h, "usage_read", by),
            )
        db.commit()
    finally:
        db.close()

    print("=" * 72)
    print("API key issued. Copy this NOW — it is not stored anywhere else.")
    print("=" * 72)
    print(f"Name:       {name}")
    print(f"Created by: {by}")
    print(f"Key:        {raw}")
    print("=" * 72)
    print("Send to the consumer via 1Password or a one-time-secret link.")
    return 0


def list_keys() -> int:
    db = get_db()
    try:
        cur = db.cursor()
        cur.execute(
            "SELECT name, scope, created_by, created_at, last_used_at, revoked_at "
            "FROM api_keys ORDER BY created_at DESC"
        )
        rows = cur.fetchall() or []
    finally:
        db.close()
    if not rows:
        print("(no api keys issued yet)")
        return 0
    print(f"{'NAME':28} {'SCOPE':12} {'CREATED BY':24} {'CREATED':20} "
          f"{'LAST USED':20} STATE")
    for r in rows:
        if isinstance(r, dict):
            name, scope, by, created, last, rev = (
                r["name"], r["scope"], r.get("created_by") or "",
                r["created_at"], r.get("last_used_at") or "",
                r.get("revoked_at"),
            )
        else:
            name, scope, by, created, last, rev = r
        state = "REVOKED" if rev else "active"
        print(f"{name:28.28} {scope:12.12} {(by or '-'):24.24} "
              f"{str(created)[:19]:20.20} {str(last)[:19] if last else '-':20.20} {state}")
    return 0


def revoke(name: str) -> int:
    db = get_db()
    try:
        cur = db.cursor()
        if USE_POSTGRES:
            cur.execute("UPDATE api_keys SET revoked_at = NOW() WHERE name = ?", (name,))
        else:
            cur.execute(
                "UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE name = ?",
                (name,),
            )
        db.commit()
    finally:
        db.close()
    print(f"Revoked {name!r} (if it existed).")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("issue", help="Issue a new API key (prints raw key once)")
    pi.add_argument("--name", required=True,
                    help="Unique label (e.g. monitoring-portal-prod)")
    pi.add_argument("--by", required=True,
                    help="Operator email — for audit (e.g. et@tmcltd.ai)")

    sub.add_parser("list", help="List all keys + status")

    pr = sub.add_parser("revoke", help="Revoke a key by name")
    pr.add_argument("--name", required=True)

    args = p.parse_args()
    if args.cmd == "issue":
        return issue(args.name, args.by)
    if args.cmd == "list":
        return list_keys()
    if args.cmd == "revoke":
        return revoke(args.name)
    return 1


if __name__ == "__main__":
    sys.exit(main())
