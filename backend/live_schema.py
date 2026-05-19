"""
Live schema snapshot for Satori v2.

Probes BigQuery on first request to discover the actual distinct values that
live in every important categorical column (departments, employee types, AMs,
tiers, etc.) plus a row count and date range per table. This snapshot is
cached in memory for one hour and rendered as a compact context block that
gets injected into the chat / dashboard / report system prompts.

The goal: stop the AI from generating SQL with filter values that "look
right" but don't exist in the data (e.g. `Employee_Type IN ('MTO','Permanent')`
when the real values are `'mto'`/`'permanent'` lowercase, or
`Employee_Hierarchy = 'Engineering'` when the real department is `'Tech'`).
"""
import time
import threading
import json
from bigquery_client import run_query

# ── Cache state ──
_snapshot = None
_snapshot_at = 0.0
_TTL_SECONDS = 60 * 60  # 1 hour
_lock = threading.Lock()

# ── Probe definitions ──
# Each probe is a small SELECT DISTINCT we can run cheaply against the
# warehouse. Keep them short (LIMIT 50) and add new ones as we add tables.
_PROBES = {
    # Workforce dimensions
    "departments": (
        "SELECT DISTINCT COALESCE(NULLIF(TRIM(Employee_Hierarchy),''),'(empty)') AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Employee_Data` "
        "GROUP BY v ORDER BY n DESC LIMIT 50"
    ),
    "employee_types": (
        "SELECT DISTINCT Employee_Type AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Employee_Data` "
        "WHERE Employee_Type IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 30"
    ),
    "positions": (
        "SELECT DISTINCT Employee_Position AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Employee_Data` "
        "WHERE Employee_Position IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 40"
    ),
    "locations": (
        "SELECT DISTINCT Employee_Location AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Employee_Data` "
        "WHERE Employee_Location IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 30"
    ),
    "attendance_statuses": (
        "SELECT DISTINCT attendance_status_text AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` "
        "WHERE attendance_status_text IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 20"
    ),
    "allocation_flags": (
        "SELECT DISTINCT Flag AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Allocation_data` "
        "WHERE Flag IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 10"
    ),
    "competencies": (
        "SELECT DISTINCT emp_competency AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Allocation_data` "
        "WHERE emp_competency IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 40"
    ),
    # Sales dimensions
    "ams": (
        "SELECT DISTINCT AM AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` "
        "WHERE AM IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 30"
    ),
    "vps": (
        "SELECT DISTINCT VP AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` "
        "WHERE VP IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 15"
    ),
    "sales_cities": (
        "SELECT DISTINCT City AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` "
        "WHERE City IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 20"
    ),
    "account_tiers": (
        "SELECT DISTINCT Tier AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Sales_Accounts` "
        "WHERE Tier IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 10"
    ),
    # Date ranges
    "attendance_date_range": (
        "SELECT MIN(attendance_date) AS v, MAX(attendance_date) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Attendance_Data`"
    ),
    # Row counts per table
    "row_counts": (
        "SELECT 'Employee_Data' AS v, COUNT(*) AS n FROM `ai-vertex-mahad.Satori_Project.Employee_Data`"
        " UNION ALL SELECT 'Attendance_Data', COUNT(*) FROM `ai-vertex-mahad.Satori_Project.Attendance_Data`"
        " UNION ALL SELECT 'Allocation_data', COUNT(*) FROM `ai-vertex-mahad.Satori_Project.Allocation_data`"
        " UNION ALL SELECT 'Timesheet_Data', COUNT(*) FROM `ai-vertex-mahad.Satori_Project.Timesheet_Data`"
        " UNION ALL SELECT 'Sales_AM_Scorecard', COUNT(*) FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard`"
        " UNION ALL SELECT 'Sales_Accounts', COUNT(*) FROM `ai-vertex-mahad.Satori_Project.Sales_Accounts`"
        " UNION ALL SELECT 'Sales_Pipeline_Health', COUNT(*) FROM `ai-vertex-mahad.Satori_Project.Sales_Pipeline_Health`"
        " UNION ALL SELECT 'Sales_Plan_vs_Pipeline', COUNT(*) FROM `ai-vertex-mahad.Satori_Project.Sales_Plan_vs_Pipeline`"
        " UNION ALL SELECT 'Sales_Hunting_Gap', COUNT(*) FROM `ai-vertex-mahad.Satori_Project.Sales_Hunting_Gap`"
    ),
    # Join-compatibility sanity (how many distinct codes vs ids overlap)
    "join_compat_attendance": (
        "WITH e AS (SELECT DISTINCT LTRIM(REGEXP_REPLACE(CAST(Employee_Code AS STRING), r'[^0-9]', ''), '0') AS k "
        "  FROM `ai-vertex-mahad.Satori_Project.Employee_Data`), "
        "a AS (SELECT DISTINCT LTRIM(REGEXP_REPLACE(CAST(employee_id AS STRING), r'[^0-9]', ''), '0') AS k "
        "  FROM `ai-vertex-mahad.Satori_Project.Attendance_Data`) "
        "SELECT 'overlap' AS v, COUNT(*) AS n FROM e JOIN a USING (k) "
        "UNION ALL SELECT 'in_employee_only', COUNT(*) FROM e WHERE k NOT IN (SELECT k FROM a) "
        "UNION ALL SELECT 'in_attendance_only', COUNT(*) FROM a WHERE k NOT IN (SELECT k FROM e)"
    ),
}


def _probe_all() -> dict:
    """Run every probe and return a {name: rows} dict. Failures are recorded
    as {error: ...} instead of crashing — the snapshot must always render."""
    out = {}
    for name, sql in _PROBES.items():
        try:
            r = run_query(sql, max_rows=50)
            if "error" in r:
                out[name] = {"error": r["error"]}
            else:
                out[name] = r.get("rows") or []
        except Exception as e:
            out[name] = {"error": str(e)}
    return out


def get_snapshot(force: bool = False) -> dict:
    """Return the cached snapshot, building/refreshing it if stale.

    The snapshot is a dict keyed by probe name. Each value is either a list of
    rows (each a {v, n} pair) or a {error} dict.
    """
    global _snapshot, _snapshot_at
    now = time.time()
    if not force and _snapshot is not None and (now - _snapshot_at) < _TTL_SECONDS:
        return _snapshot
    with _lock:
        # Double-check under lock so we only refresh once per stale window.
        if not force and _snapshot is not None and (now - _snapshot_at) < _TTL_SECONDS:
            return _snapshot
        try:
            print("[live_schema] refreshing schema snapshot...")
            _snapshot = _probe_all()
            _snapshot_at = time.time()
            print(f"[live_schema] snapshot refreshed — {len(_snapshot)} probes")
        except Exception as e:
            print(f"[live_schema] snapshot refresh failed: {e}")
            if _snapshot is None:
                _snapshot = {}
    return _snapshot or {}


def _format_distinct(rows, limit=20):
    """Render a list of {v, n} rows as 'value (n=count), value (n=count), ...'."""
    if not isinstance(rows, list) or not rows:
        return "(none)"
    parts = []
    for row in rows[:limit]:
        v = row.get("v")
        n = row.get("n")
        if v is None:
            continue
        if n is not None:
            parts.append(f"{v} ({n})")
        else:
            parts.append(str(v))
    remainder = len(rows) - limit
    if remainder > 0:
        parts.append(f"…+{remainder} more")
    return ", ".join(parts) if parts else "(none)"


def render_context_block() -> str:
    """Render the live snapshot as a compact text block to embed in system
    prompts. Designed to be ~600-1200 tokens. Showing only top values per
    dimension by count.
    """
    snap = get_snapshot()
    if not snap:
        return ""

    def get_rows(key):
        v = snap.get(key)
        return v if isinstance(v, list) else []

    # Special handling for date range (single row with v=min, n=max).
    date_range = get_rows("attendance_date_range")
    if date_range:
        d = date_range[0]
        date_str = f"{d.get('v')} → {d.get('n')}"
    else:
        date_str = "(unknown)"

    # Special handling for row counts table (v=table name, n=count).
    row_counts = get_rows("row_counts")
    if row_counts:
        rc_str = ", ".join(f"{r.get('v')}={r.get('n')}" for r in row_counts)
    else:
        rc_str = "(unknown)"

    join_compat = get_rows("join_compat_attendance")
    if join_compat:
        jc_str = ", ".join(f"{r.get('v')}={r.get('n')}" for r in join_compat)
    else:
        jc_str = "(unknown)"

    return f"""═══ LIVE WAREHOUSE SNAPSHOT (auto-refreshed hourly — these are the REAL values that exist in BigQuery right now) ═══

ROW COUNTS — {rc_str}

ATTENDANCE DATE RANGE — {date_str}

WORKFORCE DIMENSIONS (Employee_Data):
- Departments (Employee_Hierarchy) — {_format_distinct(get_rows("departments"))}
  ⚠ Always use COALESCE(NULLIF(TRIM(Employee_Hierarchy),''),'Unspecified') AS department. Many rows have NULL/empty Employee_Hierarchy.
- Employee_Type values — {_format_distinct(get_rows("employee_types"))}
  ⚠ These are stored case-sensitive. ALWAYS wrap in LOWER() before comparing.
- Positions (Employee_Position) — {_format_distinct(get_rows("positions"))}
- Locations (Employee_Location) — {_format_distinct(get_rows("locations"))}

ATTENDANCE DIMENSIONS (Attendance_Data):
- Status values (attendance_status_text) — {_format_distinct(get_rows("attendance_statuses"))}
  ⚠ Stored case-sensitive. ALWAYS wrap in LOWER() before comparing. 'Late' is a subset of present, not a separate count.

ALLOCATION DIMENSIONS (Allocation_data):
- Flag values — {_format_distinct(get_rows("allocation_flags"))}
- Competencies (emp_competency) — {_format_distinct(get_rows("competencies"))}

SALES DIMENSIONS:
- AMs (account managers) — {_format_distinct(get_rows("ams"))}
- VPs — {_format_distinct(get_rows("vps"))}
- Sales cities — {_format_distinct(get_rows("sales_cities"))}
- Account tiers (Sales_Accounts.Tier) — {_format_distinct(get_rows("account_tiers"))}

JOIN-KEY COMPATIBILITY (Employee_Data.Employee_Code ↔ Attendance_Data.employee_id, both normalized by stripping non-digits + leading zeros):
- {jc_str}
- ALWAYS join with: LTRIM(REGEXP_REPLACE(CAST(<col> AS STRING), r'[^0-9]', ''), '0')
- ALWAYS LEFT JOIN (never INNER) so the outer rows survive when the lookup has no match.

WHEN A USER ASKS ABOUT "DEPARTMENTS" OR "TEAMS" — they mean Employee_Hierarchy. Group by COALESCE(NULLIF(TRIM(Employee_Hierarchy),''),'Unspecified') AS department.

═══ END SNAPSHOT ═══
"""


def reset_cache():
    """Force a refresh on the next get_snapshot() call. Useful for testing."""
    global _snapshot, _snapshot_at
    with _lock:
        _snapshot = None
        _snapshot_at = 0.0
