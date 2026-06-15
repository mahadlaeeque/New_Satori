import os
import sqlite3
import bcrypt as _bcrypt

# ── Auto-detect: PostgreSQL on Cloud Run, SQLite locally ──
USE_POSTGRES = bool(os.environ.get("CLOUD_SQL_CONNECTION_NAME"))

if USE_POSTGRES:
    import psycopg2
    from psycopg2.extras import RealDictCursor

# SQLite path (local dev only)
DB_PATH = os.path.join(os.path.dirname(__file__), "growgnition.db")


# ── PostgreSQL wrappers (translate ? → %s so main.py works unchanged) ──

class _PgCursorWrapper:
    def __init__(self, cursor):
        self._cur = cursor

    def execute(self, sql, params=None):
        self._cur.execute(sql.replace("?", "%s"), params)
        return self

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    @property
    def lastrowid(self):
        # Not reliable for PG — use RETURNING in init_db instead
        return None


class _PgConnWrapper:
    def __init__(self, conn):
        self._conn = conn

    def cursor(self):
        return _PgCursorWrapper(self._conn.cursor())

    def execute(self, sql, params=None):
        cur = self.cursor()
        cur.execute(sql, params)
        return cur

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()


# ── Public API ──

def _pg_dsn():
    db_name = os.environ.get("DB_NAME", "satori")
    db_user = os.environ.get("DB_USER", "satori")
    db_password = os.environ.get("DB_PASSWORD", "")
    instance = os.environ.get("CLOUD_SQL_CONNECTION_NAME", "")
    if instance:
        return f"host=/cloudsql/{instance} dbname={db_name} user={db_user} password={db_password}"
    db_host = os.environ.get("DB_HOST", "localhost")
    db_port = os.environ.get("DB_PORT", "5432")
    return f"host={db_host} port={db_port} dbname={db_name} user={db_user} password={db_password}"


def get_db():
    if USE_POSTGRES:
        conn = psycopg2.connect(_pg_dsn(), cursor_factory=RealDictCursor)
        return _PgConnWrapper(conn)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    if USE_POSTGRES:
        _init_postgres()
    else:
        _init_sqlite()
    _migrate_rename_polypack_to_ffc()
    _migrate_rename_ffc_to_sfml()
    _migrate_split_admin_into_superadmin()
    _migrate_add_totp_columns()
    _migrate_add_governance_tables()
    _migrate_add_data_scope_tables()
    _migrate_add_system_settings()
    _migrate_add_availability_tasks()
    _migrate_add_chat_tables()
    _migrate_add_support_tickets()
    _migrate_add_insights()
    _migrate_add_subscriptions()
    _migrate_add_feedback_tables()
    _migrate_rename_sfml_to_tmc()
    _migrate_reset_passwords_to_welcome()
    _migrate_finalize_tmc_superadmin()
    _migrate_add_api_keys()
    _migrate_add_google_calendar()


def _migrate_rename_polypack_to_ffc():
    """One-time migration: rename Poly Pack → FFC in existing installations."""
    try:
        conn = get_db()
        cur = conn.cursor()
        # Rename company
        cur.execute("UPDATE companies SET name = ?, short_code = ? WHERE short_code = ?",
                    ("Fauji Fertilizer Company", "FFC", "POLYPACK"))
        # Rename user emails
        cur.execute("UPDATE users SET email = ? WHERE email = ?",
                    ("admin@ffc.com", "admin@polypack.com"))
        cur.execute("UPDATE users SET email = ? WHERE email = ?",
                    ("user@ffc.com", "user@polypack.com"))
        conn.commit()
        conn.close()
        print("[DB] Migration check: polypack → ffc rename applied if needed")
    except Exception as e:
        print(f"[DB] Migration error (safe to ignore on fresh DB): {e}")


def _migrate_rename_ffc_to_sfml():
    """One-time migration: rename FFC → SFML in existing installations."""
    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("UPDATE companies SET name = ?, short_code = ? WHERE short_code = ?",
                    ("SFML", "SFML", "FFC"))
        cur.execute("UPDATE users SET email = ? WHERE email = ?",
                    ("admin@sfml.com", "admin@ffc.com"))
        cur.execute("UPDATE users SET email = ? WHERE email = ?",
                    ("user@sfml.com", "user@ffc.com"))
        conn.commit()
        conn.close()
        print("[DB] Migration check: ffc -> sfml rename applied if needed")
    except Exception as e:
        print(f"[DB] Migration error (safe to ignore on fresh DB): {e}")


def _migrate_split_admin_into_superadmin():
    """One-time migration: demote admin@sfml.com to a regular user and ensure
    superadmin@sfml.com (admin role) exists. Idempotent."""
    try:
        conn = get_db()
        cur = conn.cursor()

        # Find the SFML company
        cur.execute("SELECT id FROM companies WHERE short_code = ?", ("SFML",))
        company_row = cur.fetchone()
        if not company_row:
            conn.close()
            return
        company_id = company_row["id"]

        # If admin@sfml.com still has role='admin', demote to user and grant
        # the same default features the seed user has.
        cur.execute("SELECT id, role FROM users WHERE email = ?", ("admin@sfml.com",))
        admin_row = cur.fetchone()
        if admin_row and (admin_row["role"] or "").lower() == "admin":
            admin_id = admin_row["id"]
            cur.execute("UPDATE users SET role = ? WHERE id = ?", ("user", admin_id))
            for fid in ("agent", "dashboards"):
                if USE_POSTGRES:
                    cur.execute(
                        "INSERT INTO user_features (user_id, feature_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
                        (admin_id, fid),
                    )
                else:
                    cur.execute(
                        "INSERT OR IGNORE INTO user_features (user_id, feature_id) VALUES (?, ?)",
                        (admin_id, fid),
                    )
            print("[DB] Migration: demoted admin@sfml.com to user role")

        # Create superadmin@sfml.com if it doesn't exist
        cur.execute("SELECT id FROM users WHERE email = ?", ("superadmin@sfml.com",))
        if not cur.fetchone():
            pw_hash = _bcrypt.hashpw(b"blackmouse", _bcrypt.gensalt()).decode()
            cur.execute(
                "INSERT INTO users (email, password, full_name, role, company_id) VALUES (?, ?, ?, ?, ?)",
                ("superadmin@sfml.com", pw_hash, "Super Admin", "admin", company_id),
            )
            print("[DB] Migration: created superadmin@sfml.com (role=admin)")

        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[DB] Migration error (safe to ignore on fresh DB): {e}")


def _migrate_add_governance_tables():
    """One-time, idempotent migration for the data-governance rollout. Creates
    `data_access_log` and `user_settings` tables on existing databases that
    were initialised before these tables existed (anything deployed before
    the governance commit). The CREATE TABLE IF NOT EXISTS shape is safe to
    re-run."""
    try:
        conn = get_db()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS data_access_log (
                    id            SERIAL PRIMARY KEY,
                    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    user_email    TEXT,
                    action        TEXT NOT NULL,
                    resource_type TEXT,
                    resource_id   TEXT,
                    detail        TEXT,
                    ip_address    TEXT,
                    user_agent    TEXT,
                    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_data_access_log_user_id ON data_access_log(user_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_data_access_log_action ON data_access_log(action)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_data_access_log_created_at ON data_access_log(created_at)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS user_settings (
                    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    ai_opt_out INTEGER NOT NULL DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
        else:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS data_access_log (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    user_email    TEXT,
                    action        TEXT NOT NULL,
                    resource_type TEXT,
                    resource_id   TEXT,
                    detail        TEXT,
                    ip_address    TEXT,
                    user_agent    TEXT,
                    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_data_access_log_user_id ON data_access_log(user_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_data_access_log_action ON data_access_log(action)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_data_access_log_created_at ON data_access_log(created_at)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS user_settings (
                    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    ai_opt_out INTEGER NOT NULL DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
        conn.commit()
        conn.close()
        print("[DB] Migration: governance tables present (data_access_log, user_settings)")
    except Exception as e:
        print(f"[DB] Governance migration error (safe to ignore on fresh DB): {e}")


def _migrate_add_google_calendar():
    """Idempotent migration: per-user Google Calendar OAuth tokens. One row per
    user; refresh_token is the long-lived credential, access_token/token_expiry
    are the short-lived cache we refresh on demand. Read-only scope. Safe to
    re-run on both SQLite and Postgres."""
    try:
        conn = get_db()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS user_google_tokens (
                    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    refresh_token TEXT,
                    access_token  TEXT,
                    token_expiry  TEXT,
                    google_email  TEXT,
                    scope         TEXT,
                    connected_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
        else:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS user_google_tokens (
                    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    refresh_token TEXT,
                    access_token  TEXT,
                    token_expiry  TEXT,
                    google_email  TEXT,
                    scope         TEXT,
                    connected_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
        conn.commit()
        conn.close()
        print("[DB] Migration: user_google_tokens table present")
    except Exception as e:
        print(f"[DB] Google Calendar migration error (safe to ignore on fresh DB): {e}")


def _migrate_add_data_scope_tables():
    """Idempotent migration: add the three data-scope tables and seed the plant
    dimension as enabled for TMC. Safe to re-run on both SQLite and Postgres."""
    try:
        conn = get_db()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS company_data_scope_dimensions (
                    company_id  TEXT NOT NULL,
                    dimension   TEXT NOT NULL,
                    enabled     INTEGER NOT NULL DEFAULT 0,
                    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (company_id, dimension)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS user_data_scope_policy (
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    dimension  TEXT NOT NULL,
                    enforced   INTEGER NOT NULL DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, dimension)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS user_data_scope (
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    dimension  TEXT NOT NULL,
                    value      TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, dimension, value)
                )
            """)
            cur.execute(
                "INSERT INTO company_data_scope_dimensions (company_id, dimension, enabled) "
                "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                ("TMC", "plant", 1),
            )
        else:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS company_data_scope_dimensions (
                    company_id  TEXT NOT NULL,
                    dimension   TEXT NOT NULL,
                    enabled     INTEGER NOT NULL DEFAULT 0,
                    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (company_id, dimension)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS user_data_scope_policy (
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    dimension  TEXT NOT NULL,
                    enforced   INTEGER NOT NULL DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, dimension)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS user_data_scope (
                    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    dimension  TEXT NOT NULL,
                    value      TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, dimension, value)
                )
            """)
            cur.execute(
                "INSERT OR IGNORE INTO company_data_scope_dimensions (company_id, dimension, enabled) VALUES (?, ?, ?)",
                ("TMC", "plant", 1),
            )
        conn.commit()
        conn.close()
        print("[DB] Migration: data scope tables present (company_data_scope_dimensions, user_data_scope_policy, user_data_scope)")
    except Exception as e:
        print(f"[DB] Data scope migration error (safe to ignore on fresh DB): {e}")


def _migrate_add_totp_columns():
    """One-time, idempotent migration for the 2FA rollout.

    Adds:
      users.totp_secret_enc  TEXT   — Fernet-encrypted base32 secret (nullable)
      users.totp_verified_at TIMESTAMP — when the user finished enrollment

    SQLite has no `ADD COLUMN IF NOT EXISTS`, so we probe `PRAGMA
    table_info(users)` first. Postgres has `ADD COLUMN IF NOT EXISTS`
    natively (PG 9.6+).

    Mandatory rollout policy: any existing user where `totp_verified_at IS
    NULL` is forced through enrollment on next login. We don't pre-flag
    seed users — they enroll on their next sign-in like everyone else.
    """
    try:
        conn = get_db()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT")
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_verified_at TIMESTAMP")
        else:
            # Probe schema so we don't ALTER twice (sqlite would raise).
            cur.execute("PRAGMA table_info(users)")
            cols = {row["name"] for row in cur.fetchall()}
            if "totp_secret_enc" not in cols:
                cur.execute("ALTER TABLE users ADD COLUMN totp_secret_enc TEXT")
            if "totp_verified_at" not in cols:
                cur.execute("ALTER TABLE users ADD COLUMN totp_verified_at TIMESTAMP")
        conn.commit()
        conn.close()
        print("[DB] Migration: TOTP columns present on users")
    except Exception as e:
        print(f"[DB] TOTP migration error (safe to ignore on fresh DB): {e}")


def _init_sqlite():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS companies (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            short_code  TEXT UNIQUE NOT NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            email             TEXT UNIQUE NOT NULL,
            password          TEXT NOT NULL,
            full_name         TEXT NOT NULL,
            role              TEXT NOT NULL DEFAULT 'user',
            company_id        INTEGER NOT NULL REFERENCES companies(id),
            is_active         INTEGER NOT NULL DEFAULT 1,
            totp_secret_enc   TEXT,
            totp_verified_at  TIMESTAMP,
            created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_backup_codes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            code_hash   TEXT NOT NULL,
            used_at     TIMESTAMP,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS login_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER REFERENCES users(id),
            email       TEXT NOT NULL,
            success     INTEGER NOT NULL,
            ip_address  TEXT,
            timestamp   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id),
            query       TEXT NOT NULL,
            response    TEXT,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS saved_dashboards (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL REFERENCES users(id),
            name         TEXT NOT NULL,
            description  TEXT,
            config       TEXT NOT NULL,
            is_favorite  INTEGER NOT NULL DEFAULT 0,
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS saved_reports (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL REFERENCES users(id),
            name         TEXT NOT NULL,
            description  TEXT,
            config       TEXT NOT NULL,
            is_favorite  INTEGER NOT NULL DEFAULT 0,
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS schema_settings (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name    TEXT UNIQUE NOT NULL,
            description   TEXT NOT NULL DEFAULT '',
            sort_order    INTEGER NOT NULL DEFAULT 100,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_conversations (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title         TEXT NOT NULL DEFAULT 'New conversation',
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            role            TEXT NOT NULL,
            content         TEXT NOT NULL,
            created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_features (
            user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            feature_id   TEXT NOT NULL,
            granted_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, feature_id)
        )
    """)
    # Sharing: one row per (item, recipient). Role is "viewer" only for now —
    # kept as a column so we can add "editor" later without a migration.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS dashboard_shares (
            dashboard_id   INTEGER NOT NULL REFERENCES saved_dashboards(id) ON DELETE CASCADE,
            user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role           TEXT NOT NULL DEFAULT 'viewer',
            shared_by      INTEGER NOT NULL REFERENCES users(id),
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (dashboard_id, user_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS report_shares (
            report_id      INTEGER NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
            user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role           TEXT NOT NULL DEFAULT 'viewer',
            shared_by      INTEGER NOT NULL REFERENCES users(id),
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (report_id, user_id)
        )
    """)
    # Practice-head-assigned skills per employee (keyed by warehouse Employee_Code
    # like 'E-210', NOT a users.id). Composite PK prevents duplicate skills per
    # employee. Used by the Availability Engine "find best fit" ranking.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS employee_skills (
            employee_code  TEXT NOT NULL,
            skill          TEXT NOT NULL,
            added_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (employee_code, skill)
        )
    """)
    # Audit log of every data-touching action: dashboard view, report preview,
    # SQL query, file download, AI prompt. Surfaced to admins in
    # /api/admin/audit. Retained for 1 year (see _retention_sweep).
    # Fields:
    #   action        — short verb: "dashboard.view", "report.preview",
    #                   "report.download.excel", "report.download.pdf",
    #                   "bq.query", "ai.chat", "ai.voice", "share.add",
    #                   "share.remove", "totp.reset"
    #   resource_type — dashboard / report / sql / ai / share / user
    #   resource_id   — numeric id, free-form (e.g. SQL hash)
    #   detail        — JSON blob: row_count, bytes, sql_hash, etc.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS data_access_log (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
            user_email    TEXT,
            action        TEXT NOT NULL,
            resource_type TEXT,
            resource_id   TEXT,
            detail        TEXT,
            ip_address    TEXT,
            user_agent    TEXT,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_data_access_log_user_id ON data_access_log(user_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_data_access_log_action ON data_access_log(action)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_data_access_log_created_at ON data_access_log(created_at)")
    # Per-user settings (kept flat for now — one row per user).
    # ai_opt_out=1 makes find_relevant_data skip the AI context injection
    # so the user's prompts go to Gemini without business data attached.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            ai_opt_out INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # ── Data Scope tables ──
    # company_data_scope_dimensions: which filter dimensions are admin-enabled
    # at company level. Plant is seeded enabled=1; others default off.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS company_data_scope_dimensions (
            company_id  TEXT NOT NULL,
            dimension   TEXT NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 0,
            updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (company_id, dimension)
        )
    """)
    # user_data_scope_policy: per-user per-dimension enforcement flag.
    # enforced=0 (default) → "see all"; enforced=1 → restricted to the
    # values in user_data_scope.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_data_scope_policy (
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            dimension  TEXT NOT NULL,
            enforced   INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, dimension)
        )
    """)
    # user_data_scope: the specific allowed values per enforced dimension.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_data_scope (
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            dimension  TEXT NOT NULL,
            value      TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, dimension, value)
        )
    """)
    conn.commit()

    if cur.execute("SELECT COUNT(*) AS count FROM companies").fetchone()["count"] == 0:
        cur.execute(
            "INSERT INTO companies (name, short_code) VALUES (?, ?)",
            ("TMC", "TMC"),
        )
        company_id = cur.lastrowid

        # superadmin: the only admin role at seed time
        cur.execute(
            "INSERT INTO users (email, password, full_name, role, company_id) VALUES (?, ?, ?, ?, ?)",
            ("superadmin@tmcltd.com", _bcrypt.hashpw(b"welcome", _bcrypt.gensalt()).decode(), "Super Admin", "admin", company_id),
        )

        # admin@tmcltd.com: regular user (despite the legacy email name)
        cur.execute(
            "INSERT INTO users (email, password, full_name, role, company_id) VALUES (?, ?, ?, ?, ?)",
            ("admin@tmcltd.com", _bcrypt.hashpw(b"welcome", _bcrypt.gensalt()).decode(), "Anas", "user", company_id),
        )
        admin_user_id = cur.lastrowid

        # second regular user
        cur.execute(
            "INSERT INTO users (email, password, full_name, role, company_id) VALUES (?, ?, ?, ?, ?)",
            ("user@tmcltd.com", _bcrypt.hashpw(b"welcome", _bcrypt.gensalt()).decode(), "Bilal", "user", company_id),
        )
        bilal_user_id = cur.lastrowid

        # Seed default features for both regular users. Admins ignore this list.
        for uid in (admin_user_id, bilal_user_id):
            for fid in ("agent", "dashboards"):
                cur.execute(
                    "INSERT OR IGNORE INTO user_features (user_id, feature_id) VALUES (?, ?)",
                    (uid, fid),
                )
        # Seed plant dimension as the default enabled scope dimension for TMC.
        cur.execute(
            "INSERT OR IGNORE INTO company_data_scope_dimensions (company_id, dimension, enabled) VALUES (?, ?, ?)",
            ("TMC", "plant", 1),
        )
        conn.commit()
    conn.close()


def _init_postgres():
    conn = psycopg2.connect(_pg_dsn(), cursor_factory=RealDictCursor)
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS companies (
            id          SERIAL PRIMARY KEY,
            name        TEXT NOT NULL,
            short_code  TEXT UNIQUE NOT NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id                SERIAL PRIMARY KEY,
            email             TEXT UNIQUE NOT NULL,
            password          TEXT NOT NULL,
            full_name         TEXT NOT NULL,
            role              TEXT NOT NULL DEFAULT 'user',
            company_id        INTEGER NOT NULL REFERENCES companies(id),
            is_active         INTEGER NOT NULL DEFAULT 1,
            totp_secret_enc   TEXT,
            totp_verified_at  TIMESTAMP,
            created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_backup_codes (
            id          SERIAL PRIMARY KEY,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            code_hash   TEXT NOT NULL,
            used_at     TIMESTAMP,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS login_log (
            id          SERIAL PRIMARY KEY,
            user_id     INTEGER REFERENCES users(id),
            email       TEXT NOT NULL,
            success     INTEGER NOT NULL,
            ip_address  TEXT,
            timestamp   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_history (
            id          SERIAL PRIMARY KEY,
            user_id     INTEGER NOT NULL REFERENCES users(id),
            query       TEXT NOT NULL,
            response    TEXT,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS saved_dashboards (
            id           SERIAL PRIMARY KEY,
            user_id      INTEGER NOT NULL REFERENCES users(id),
            name         TEXT NOT NULL,
            description  TEXT,
            config       TEXT NOT NULL,
            is_favorite  INTEGER NOT NULL DEFAULT 0,
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS saved_reports (
            id           SERIAL PRIMARY KEY,
            user_id      INTEGER NOT NULL REFERENCES users(id),
            name         TEXT NOT NULL,
            description  TEXT,
            config       TEXT NOT NULL,
            is_favorite  INTEGER NOT NULL DEFAULT 0,
            created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS schema_settings (
            id            SERIAL PRIMARY KEY,
            table_name    TEXT UNIQUE NOT NULL,
            description   TEXT NOT NULL DEFAULT '',
            sort_order    INTEGER NOT NULL DEFAULT 100,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_conversations (
            id            SERIAL PRIMARY KEY,
            user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title         TEXT NOT NULL DEFAULT 'New conversation',
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS chat_messages (
            id              SERIAL PRIMARY KEY,
            conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            role            TEXT NOT NULL,
            content         TEXT NOT NULL,
            created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_features (
            user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            feature_id   TEXT NOT NULL,
            granted_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, feature_id)
        )
    """)
    # Sharing tables (Postgres mirror of the SQLite definitions above).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS dashboard_shares (
            dashboard_id   INTEGER NOT NULL REFERENCES saved_dashboards(id) ON DELETE CASCADE,
            user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role           TEXT NOT NULL DEFAULT 'viewer',
            shared_by      INTEGER NOT NULL REFERENCES users(id),
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (dashboard_id, user_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS report_shares (
            report_id      INTEGER NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
            user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role           TEXT NOT NULL DEFAULT 'viewer',
            shared_by      INTEGER NOT NULL REFERENCES users(id),
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (report_id, user_id)
        )
    """)
    # Practice-head-assigned skills per employee (keyed by warehouse Employee_Code
    # like 'E-210', NOT a users.id). Composite PK prevents duplicate skills per
    # employee. Used by the Availability Engine "find best fit" ranking.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS employee_skills (
            employee_code  TEXT NOT NULL,
            skill          TEXT NOT NULL,
            added_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (employee_code, skill)
        )
    """)
    # Data-access audit log (Postgres mirror of the SQLite definition above).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS data_access_log (
            id            SERIAL PRIMARY KEY,
            user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
            user_email    TEXT,
            action        TEXT NOT NULL,
            resource_type TEXT,
            resource_id   TEXT,
            detail        TEXT,
            ip_address    TEXT,
            user_agent    TEXT,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_data_access_log_user_id ON data_access_log(user_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_data_access_log_action ON data_access_log(action)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_data_access_log_created_at ON data_access_log(created_at)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            ai_opt_out INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # ── Data Scope tables (Postgres mirror) ──
    cur.execute("""
        CREATE TABLE IF NOT EXISTS company_data_scope_dimensions (
            company_id  TEXT NOT NULL,
            dimension   TEXT NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 0,
            updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (company_id, dimension)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_data_scope_policy (
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            dimension  TEXT NOT NULL,
            enforced   INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, dimension)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_data_scope (
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            dimension  TEXT NOT NULL,
            value      TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, dimension, value)
        )
    """)
    conn.commit()

    cur.execute("SELECT COUNT(*) AS count FROM companies")
    if cur.fetchone()["count"] == 0:
        cur.execute(
            "INSERT INTO companies (name, short_code) VALUES (%s, %s) RETURNING id",
            ("TMC", "TMC"),
        )
        company_id = cur.fetchone()["id"]

        # superadmin: the only admin role at seed time
        cur.execute(
            "INSERT INTO users (email, password, full_name, role, company_id) VALUES (%s, %s, %s, %s, %s)",
            ("superadmin@tmcltd.com", _bcrypt.hashpw(b"welcome", _bcrypt.gensalt()).decode(), "Super Admin", "admin", company_id),
        )

        # admin@tmcltd.com: regular user (despite the legacy email name)
        cur.execute(
            "INSERT INTO users (email, password, full_name, role, company_id) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            ("admin@tmcltd.com", _bcrypt.hashpw(b"welcome", _bcrypt.gensalt()).decode(), "Anas", "user", company_id),
        )
        admin_user_id = cur.fetchone()["id"]

        # second regular user
        cur.execute(
            "INSERT INTO users (email, password, full_name, role, company_id) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            ("user@tmcltd.com", _bcrypt.hashpw(b"welcome", _bcrypt.gensalt()).decode(), "Bilal", "user", company_id),
        )
        bilal_user_id = cur.fetchone()["id"]

        for uid in (admin_user_id, bilal_user_id):
            for fid in ("agent", "dashboards"):
                cur.execute(
                    "INSERT INTO user_features (user_id, feature_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (uid, fid),
                )
        # Seed plant dimension as the default enabled scope dimension for TMC.
        cur.execute(
            "INSERT INTO company_data_scope_dimensions (company_id, dimension, enabled) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
            ("TMC", "plant", 1),
        )
        conn.commit()
    conn.close()


def _migrate_add_system_settings():
    """Idempotent — creates the system_settings key-value store if it doesn't exist."""
    try:
        conn = get_db()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS system_settings (
                    key        TEXT PRIMARY KEY,
                    value      TEXT NOT NULL DEFAULT '',
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cur.execute(
                "INSERT INTO system_settings (key, value) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                ("bypass_otp", "121212"),
            )
        else:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS system_settings (
                    key        TEXT PRIMARY KEY,
                    value      TEXT NOT NULL DEFAULT '',
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cur.execute(
                "INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)",
                ("bypass_otp", "121212"),
            )
        conn.commit()
        conn.close()
        print("[DB] Migration: system_settings table ready")
    except Exception as e:
        print(f"[DB] system_settings migration error: {e}")


def _migrate_add_availability_tasks():
    """Idempotent — creates the availability_tasks table used by the
    Availability Engine page. Stores Create-Task / Project entries with their
    assigned-employee picks and the AI's per-candidate reasoning. JSON fields
    are stored as TEXT for portability across SQLite + Postgres."""
    try:
        conn = get_db()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS availability_tasks (
                    id                       SERIAL PRIMARY KEY,
                    user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name                     TEXT NOT NULL,
                    department               TEXT NOT NULL DEFAULT '',
                    description              TEXT NOT NULL DEFAULT '',
                    skills_keywords          TEXT NOT NULL DEFAULT '',
                    status                   TEXT NOT NULL DEFAULT 'open',
                    assigned_employee_codes  TEXT NOT NULL DEFAULT '[]',
                    ai_reasoning             TEXT NOT NULL DEFAULT '{}',
                    created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_availability_tasks_user ON availability_tasks(user_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_availability_tasks_status ON availability_tasks(status)")
        else:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS availability_tasks (
                    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name                     TEXT NOT NULL,
                    department               TEXT NOT NULL DEFAULT '',
                    description              TEXT NOT NULL DEFAULT '',
                    skills_keywords          TEXT NOT NULL DEFAULT '',
                    status                   TEXT NOT NULL DEFAULT 'open',
                    assigned_employee_codes  TEXT NOT NULL DEFAULT '[]',
                    ai_reasoning             TEXT NOT NULL DEFAULT '{}',
                    created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_availability_tasks_user ON availability_tasks(user_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_availability_tasks_status ON availability_tasks(status)")
        conn.commit()
        conn.close()
        print("[DB] Migration: availability_tasks table ready")
    except Exception as e:
        print(f"[DB] availability_tasks migration error: {e}")


def _migrate_add_chat_tables():
    """Idempotent — ensures chat_conversations, chat_messages, and the legacy
    chat_history table exist. These ARE defined inside _init_postgres()
    already, but if anything earlier in that single-transaction init fails
    the chat tables silently never get created — and the chat handler's
    try/except hides the missing-table error, so the UI just shows an
    empty history list. This standalone migration creates them with its
    own connection so it succeeds independently of any earlier failure."""
    try:
        conn = get_db()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS chat_conversations (
                    id            SERIAL PRIMARY KEY,
                    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    title         TEXT NOT NULL DEFAULT 'New conversation',
                    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id              SERIAL PRIMARY KEY,
                    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
                    role            TEXT NOT NULL,
                    content         TEXT NOT NULL,
                    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_chat_conversations_user ON chat_conversations(user_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated ON chat_conversations(updated_at DESC)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS chat_history (
                    id          SERIAL PRIMARY KEY,
                    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    query       TEXT NOT NULL,
                    response    TEXT,
                    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
        else:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS chat_conversations (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    title         TEXT NOT NULL DEFAULT 'New conversation',
                    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
                    role            TEXT NOT NULL,
                    content         TEXT NOT NULL,
                    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_chat_conversations_user ON chat_conversations(user_id)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS chat_history (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    query       TEXT NOT NULL,
                    response    TEXT,
                    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
        conn.commit()
        conn.close()
        print("[DB] Migration: chat_conversations + chat_messages + chat_history tables ready")
    except Exception as e:
        print(f"[DB] chat_tables migration error: {e}")


def _migrate_add_support_tickets():
    """Idempotent — creates support_tickets (the "Report an Issue" capture)."""
    try:
        conn = get_db()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS support_tickets (
                    id          SERIAL PRIMARY KEY,
                    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    user_email  TEXT,
                    category    TEXT,
                    message     TEXT NOT NULL,
                    page        TEXT,
                    url         TEXT,
                    user_agent  TEXT,
                    status      TEXT NOT NULL DEFAULT 'open',
                    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
        else:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS support_tickets (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    user_email  TEXT,
                    category    TEXT,
                    message     TEXT NOT NULL,
                    page        TEXT,
                    url         TEXT,
                    user_agent  TEXT,
                    status      TEXT NOT NULL DEFAULT 'open',
                    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON support_tickets(created_at DESC)")
        conn.commit()
        conn.close()
        print("[DB] Migration: support_tickets table ready")
    except Exception as e:
        print(f"[DB] support_tickets migration error: {e}")


def _migrate_add_insights():
    """Idempotent — insights (the proactive 'Satori noticed' feed). One row per
    finding per generation day; the UNIQUE constraint makes regeneration
    idempotent (ON CONFLICT DO NOTHING works on both PG and SQLite ≥3.24)."""
    try:
        conn = get_db()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS insights (
                    id           SERIAL PRIMARY KEY,
                    insight_date TEXT NOT NULL,
                    category     TEXT NOT NULL,
                    severity     TEXT NOT NULL DEFAULT 'info',
                    department   TEXT NOT NULL DEFAULT '',
                    title        TEXT NOT NULL,
                    body         TEXT,
                    metric       TEXT,
                    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (insight_date, category, department, title)
                )
            """)
        else:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS insights (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    insight_date TEXT NOT NULL,
                    category     TEXT NOT NULL,
                    severity     TEXT NOT NULL DEFAULT 'info',
                    department   TEXT NOT NULL DEFAULT '',
                    title        TEXT NOT NULL,
                    body         TEXT,
                    metric       TEXT,
                    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (insight_date, category, department, title)
                )
            """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_insights_date ON insights(insight_date)")
        conn.commit()
        conn.close()
        print("[DB] Migration: insights table ready")
    except Exception as e:
        print(f"[DB] insights migration error: {e}")


def _migrate_add_subscriptions():
    """Idempotent — item_subscriptions (scheduled email delivery of saved
    dashboards/reports). One row per user × item; the runner dedupes per day
    via last_sent_key."""
    try:
        conn = get_db()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS item_subscriptions (
                    id            SERIAL PRIMARY KEY,
                    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    kind          TEXT NOT NULL,
                    item_id       INTEGER NOT NULL,
                    cadence       TEXT NOT NULL DEFAULT 'weekly',
                    day_of_week   INTEGER NOT NULL DEFAULT 0,
                    hour          INTEGER NOT NULL DEFAULT 9,
                    recipients    TEXT,
                    active        INTEGER NOT NULL DEFAULT 1,
                    last_sent_key TEXT,
                    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (user_id, kind, item_id)
                )
            """)
        else:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS item_subscriptions (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    kind          TEXT NOT NULL,
                    item_id       INTEGER NOT NULL,
                    cadence       TEXT NOT NULL DEFAULT 'weekly',
                    day_of_week   INTEGER NOT NULL DEFAULT 0,
                    hour          INTEGER NOT NULL DEFAULT 9,
                    recipients    TEXT,
                    active        INTEGER NOT NULL DEFAULT 1,
                    last_sent_key TEXT,
                    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (user_id, kind, item_id)
                )
            """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_item_subscriptions_active ON item_subscriptions(active)")
        conn.commit()
        conn.close()
        print("[DB] Migration: item_subscriptions table ready")
    except Exception as e:
        print(f"[DB] item_subscriptions migration error: {e}")


def _migrate_add_feedback_tables():
    """Idempotent — response_feedback (thumbs ±) + pulse_responses (pulse survey)."""
    try:
        conn = get_db()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS response_feedback (
                    id              SERIAL PRIMARY KEY,
                    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    message_id      INTEGER,
                    conversation_id INTEGER,
                    rating          TEXT NOT NULL,
                    comment         TEXT,
                    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (user_id, message_id)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS pulse_responses (
                    id          SERIAL PRIMARY KEY,
                    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    score       INTEGER NOT NULL,
                    comment     TEXT,
                    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
        else:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS response_feedback (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    message_id      INTEGER,
                    conversation_id INTEGER,
                    rating          TEXT NOT NULL,
                    comment         TEXT,
                    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (user_id, message_id)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS pulse_responses (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    score       INTEGER NOT NULL,
                    comment     TEXT,
                    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_response_feedback_rating ON response_feedback(rating)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_response_feedback_created ON response_feedback(created_at DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_pulse_responses_created ON pulse_responses(created_at DESC)")
        conn.commit()
        conn.close()
        print("[DB] Migration: response_feedback + pulse_responses tables ready")
    except Exception as e:
        print(f"[DB] feedback tables migration error: {e}")


def _migrate_rename_sfml_to_tmc():
    """Idempotent migration: rename every SFML identifier to TMC on existing
    databases. Covers: companies.short_code + name, seeded user emails
    (superadmin/admin/user @sfml.com -> @tmcltd.com), and
    company_data_scope_dimensions.company_id rows keyed by 'SFML'. Safe to
    re-run - every UPDATE has a WHERE clause that only matches legacy rows."""
    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute(
            "UPDATE companies SET name = ?, short_code = ? WHERE short_code = ?",
            ("TMC", "TMC", "SFML"),
        )
        for old_email, new_email in (
            ("superadmin@sfml.com", "superadmin@tmcltd.com"),
            ("admin@sfml.com",      "admin@tmcltd.com"),
            ("user@sfml.com",       "user@tmcltd.com"),
        ):
            cur.execute("SELECT 1 FROM users WHERE email = ?", (new_email,))
            if cur.fetchone():
                cur.execute("DELETE FROM users WHERE email = ?", (old_email,))
            else:
                cur.execute(
                    "UPDATE users SET email = ? WHERE email = ?",
                    (new_email, old_email),
                )
        cur.execute(
            "UPDATE company_data_scope_dimensions SET company_id = ? WHERE company_id = ?",
            ("TMC", "SFML"),
        )
        conn.commit()
        conn.close()
        print("[DB] Migration: sfml -> tmc rename applied if needed")
    except Exception as e:
        print(f"[DB] Migration error (sfml -> tmc, safe to ignore on fresh DB): {e}")


def _migrate_reset_passwords_to_welcome():
    """One-shot migration: set every user.password to bcrypt('welcome').
    Tracked via a marker row in system_settings (key='password_reset_v1') so
    it only runs once even though init_db() is called on every cold start."""
    MARKER_KEY = "password_reset_v1"
    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT value FROM system_settings WHERE key = ?", (MARKER_KEY,))
        row = cur.fetchone()
        if row:
            conn.close()
            return
        pw_hash = _bcrypt.hashpw(b"welcome", _bcrypt.gensalt()).decode()
        cur.execute("UPDATE users SET password = ?", (pw_hash,))
        if USE_POSTGRES:
            cur.execute(
                "INSERT INTO system_settings (key, value) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (MARKER_KEY, "done"),
            )
        else:
            cur.execute(
                "INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)",
                (MARKER_KEY, "done"),
            )
        conn.commit()
        conn.close()
        print("[DB] Migration: all user passwords reset to 'welcome' (one-time)")
    except Exception as e:
        print(f"[DB] Migration error (reset passwords, safe to ignore on fresh DB): {e}")


def _migrate_finalize_tmc_superadmin():
    """One-time TMC rebrand finalizer for the superadmin account.

    Renames a LEGACY superadmin (@sfml.com / @tmcltd.com) to
    superadmin@tmc.com, resets its password to 'welcome', and clears its TOTP
    so it re-enrolls once.

    CRITICAL — idempotent and NON-DESTRUCTIVE once done: if superadmin@tmc.com
    already exists, this returns immediately WITHOUT touching the password or
    TOTP. The previous version reset the password and wiped
    totp_secret_enc/totp_verified_at on EVERY cold start (i.e. every deploy),
    which is why the QR-code 2FA enrollment had to be redone after each push.
    With this guard, the superadmin's enrollment now survives deploys and
    sessions."""
    try:
        conn = get_db()
        cur = conn.cursor()
        # Company short_code + name -> TMC (idempotent; only matches legacy rows).
        cur.execute(
            "UPDATE companies SET name = ?, short_code = ? "
            "WHERE short_code = ? OR name = ?",
            ("TMC", "TMC", "SFML", "SFML"),
        )

        # If the canonical superadmin already exists, the rebrand is complete.
        # Do NOT reset its password or wipe its TOTP — doing so on every cold
        # start is exactly the bug that reset 2FA on each deploy.
        cur.execute("SELECT id FROM users WHERE email = ?", ("superadmin@tmc.com",))
        if cur.fetchone():
            conn.commit()
            conn.close()
            return

        # No canonical superadmin yet — migrate a legacy row to it (one time).
        super_id = None
        for em in ("superadmin@tmcltd.com", "superadmin@sfml.com"):
            cur.execute("SELECT id FROM users WHERE email = ?", (em,))
            row = cur.fetchone()
            if row:
                super_id = row["id"] if isinstance(row, dict) else row[0]
                break
        if super_id is None:
            # Fall back to the first admin-role row.
            cur.execute("SELECT id FROM users WHERE role = 'admin' "
                        "ORDER BY id ASC LIMIT 1")
            row = cur.fetchone()
            if row:
                super_id = row["id"] if isinstance(row, dict) else row[0]

        if super_id is not None:
            pw_hash = _bcrypt.hashpw(b"welcome", _bcrypt.gensalt()).decode()
            cur.execute(
                "UPDATE users SET email = ?, password = ?, "
                "totp_secret_enc = NULL, totp_verified_at = NULL "
                "WHERE id = ?",
                ("superadmin@tmc.com", pw_hash, super_id),
            )
            print(f"[DB] Migration: superadmin id={super_id} -> "
                  f"superadmin@tmc.com (one-time rebrand; TOTP reset once)")
        else:
            print("[DB] Migration: no superadmin row found to finalize")

        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[DB] Migration error (finalize tmc superadmin, safe to ignore on fresh DB): {e}")


def _migrate_add_api_keys():
    """Idempotent — creates the api_keys table used by external machine-to-machine
    consumers of the read-only usage API (e.g. the TMC monitoring portal).

    Schema: one row per issued key. We store only a SHA-256 hash of the raw key
    so a DB leak can't reveal credentials. The raw key is shared once via
    1Password / one-time-secret link when issued.

    Columns:
      name          unique label (e.g. "monitoring-portal-prod")
      key_hash      sha256 hex digest of the raw key string
      scope         coarse scope tag — currently 'usage_read' only
      created_by    operator email who issued the key
      created_at    issue time
      last_used_at  rolling — bumped on each successful verify
      revoked_at    set when the key is revoked (NULL = active)
    """
    try:
        conn = get_db()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS api_keys (
                    name          TEXT PRIMARY KEY,
                    key_hash      TEXT NOT NULL UNIQUE,
                    scope         TEXT NOT NULL DEFAULT 'usage_read',
                    created_by    TEXT,
                    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_used_at  TIMESTAMP,
                    revoked_at    TIMESTAMP
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)")
        else:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS api_keys (
                    name          TEXT PRIMARY KEY,
                    key_hash      TEXT NOT NULL UNIQUE,
                    scope         TEXT NOT NULL DEFAULT 'usage_read',
                    created_by    TEXT,
                    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_used_at  TIMESTAMP,
                    revoked_at    TIMESTAMP
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)")
        conn.commit()
        conn.close()
        print("[DB] Migration: api_keys table ready")
    except Exception as e:
        print(f"[DB] api_keys migration error: {e}")
