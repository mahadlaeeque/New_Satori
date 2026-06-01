"""
Live schema snapshot for Satori v2.

Probes BigQuery on first request to discover the actual distinct values that
live in every important categorical column (departments, employee types, AMs,
tiers, etc.) plus a row count and date range per table. Cached for 1h in
memory and rendered into a compact context block injected into the chat /
dashboard / report system prompts.
"""
import time
import threading
from bigquery_client import run_query

_snapshot = None
_snapshot_at = 0.0
_TTL_SECONDS = 60 * 60
_lock = threading.Lock()

_PROBES = {
    "departments": (
        "SELECT DISTINCT COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''),'(empty)') AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Employee_Data` "
        "GROUP BY v ORDER BY n DESC LIMIT 50"
    ),
    "employee_types": (
        "SELECT DISTINCT Employee_Type AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Employee_Data` WHERE Employee_Type IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 30"
    ),
    "positions": (
        "SELECT DISTINCT Employee_Position AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Employee_Data` WHERE Employee_Position IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 40"
    ),
    "locations": (
        "SELECT DISTINCT Employee_Location AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Employee_Data` WHERE Employee_Location IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 30"
    ),
    "attendance_statuses": (
        "SELECT DISTINCT attendance_status_text AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` WHERE attendance_status_text IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 20"
    ),
    "allocation_flags": (
        "SELECT DISTINCT Flag AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Allocation_data` WHERE Flag IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 10"
    ),
    "competencies": (
        "SELECT DISTINCT emp_competency AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Allocation_data` WHERE emp_competency IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 40"
    ),
    "ams": (
        "SELECT DISTINCT AM AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` WHERE AM IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 30"
    ),
    "vps": (
        "SELECT DISTINCT VP AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` WHERE VP IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 15"
    ),
    "sales_cities": (
        "SELECT DISTINCT City AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Sales_AM_Scorecard` WHERE City IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 20"
    ),
    "account_tiers": (
        "SELECT DISTINCT Tier AS v, COUNT(*) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Sales_Accounts` WHERE Tier IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 10"
    ),
    "attendance_date_range": (
        "SELECT MIN(attendance_date) AS v, MAX(attendance_date) AS n "
        "FROM `ai-vertex-mahad.Satori_Project.Attendance_Data`"
    ),
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
    "join_compat_attendance": (
        "WITH e AS (SELECT DISTINCT LTRIM(REGEXP_REPLACE(CAST(Employee_Code AS STRING), r'[^0-9]', ''), '0') AS k "
        "  FROM `ai-vertex-mahad.Satori_Project.Employee_Data`), "
        "a AS (SELECT DISTINCT LTRIM(REGEXP_REPLACE(CAST(employee_id AS STRING), r'[^0-9]', ''), '0') AS k "
        "  FROM `ai-vertex-mahad.Satori_Project.Attendance_Data`) "
        "SELECT 'overlap' AS v, COUNT(*) AS n FROM e JOIN a USING (k) "
        "UNION ALL SELECT 'in_employee_only', COUNT(*) FROM e WHERE k NOT IN (SELECT k FROM a) "
        "UNION ALL SELECT 'in_attendance_only', COUNT(*) FROM a WHERE k NOT IN (SELECT k FROM e)"
    ),
    "join_compat_attendance_name": (
        "WITH e AS (SELECT DISTINCT UPPER(TRIM(Resource_Name)) AS k "
        "  FROM `ai-vertex-mahad.Satori_Project.Employee_Data` WHERE Resource_Name IS NOT NULL), "
        "a AS (SELECT DISTINCT UPPER(TRIM(employee_name)) AS k "
        "  FROM `ai-vertex-mahad.Satori_Project.Attendance_Data` WHERE employee_name IS NOT NULL) "
        "SELECT 'overlap' AS v, COUNT(*) AS n FROM e JOIN a USING (k) "
        "UNION ALL SELECT 'in_employee_only', COUNT(*) FROM e WHERE k NOT IN (SELECT k FROM a) "
        "UNION ALL SELECT 'in_attendance_only', COUNT(*) FROM a WHERE k NOT IN (SELECT k FROM e)"
    ),
}


def _probe_all() -> dict:
    out = {}
    for name, sql in _PROBES.items():
        try:
            r = run_query(sql, max_rows=50)
            out[name] = {"error": r["error"]} if "error" in r else (r.get("rows") or [])
        except Exception as e:
            out[name] = {"error": str(e)}
    return out


def get_snapshot(force: bool = False) -> dict:
    global _snapshot, _snapshot_at
    now = time.time()
    if not force and _snapshot is not None and (now - _snapshot_at) < _TTL_SECONDS:
        return _snapshot
    with _lock:
        if not force and _snapshot is not None and (now - _snapshot_at) < _TTL_SECONDS:
            return _snapshot
        try:
            print("[live_schema] refreshing schema snapshot...")
            _snapshot = _probe_all()
            _snapshot_at = time.time()
            print(f"[live_schema] snapshot refreshed - {len(_snapshot)} probes")
        except Exception as e:
            print(f"[live_schema] snapshot refresh failed: {e}")
            if _snapshot is None:
                _snapshot = {}
    return _snapshot or {}


def _format_distinct(rows, limit=20):
    if not isinstance(rows, list) or not rows:
        return "(none)"
    parts = []
    for row in rows[:limit]:
        v = row.get("v"); n = row.get("n")
        if v is None: continue
        parts.append(f"{v} ({n})" if n is not None else str(v))
    remainder = len(rows) - limit
    if remainder > 0:
        parts.append(f"...+{remainder} more")
    return ", ".join(parts) if parts else "(none)"


def render_context_block() -> str:
    snap = get_snapshot()
    if not snap:
        return ""

    def get_rows(key):
        v = snap.get(key)
        return v if isinstance(v, list) else []

    date_range = get_rows("attendance_date_range")
    date_str = f"{date_range[0].get('v')} -> {date_range[0].get('n')}" if date_range else "(unknown)"

    row_counts = get_rows("row_counts")
    rc_str = ", ".join(f"{r.get('v')}={r.get('n')}" for r in row_counts) if row_counts else "(unknown)"

    jc = get_rows("join_compat_attendance")
    jc_str = ", ".join(f"{r.get('v')}={r.get('n')}" for r in jc) if jc else "(unknown)"
    jc_name = get_rows("join_compat_attendance_name")
    jc_name_str = ", ".join(f"{r.get('v')}={r.get('n')}" for r in jc_name) if jc_name else "(unknown)"

    return (
        "=== LIVE WAREHOUSE SNAPSHOT (auto-refreshed hourly - these are the REAL values that exist in BigQuery right now) ===\n\n"
        f"ROW COUNTS - {rc_str}\n\n"
        f"ATTENDANCE DATE RANGE - {date_str}\n\n"
        "WORKFORCE DIMENSIONS (Employee_Data):\n"
        f"- Departments (EmployeeHierarchyNode) - {_format_distinct(get_rows('departments'))}\n"
        "  Always use COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''),'Unspecified') AS department. Many rows have NULL/empty EmployeeHierarchyNode.\n"
        f"- Employee_Type values - {_format_distinct(get_rows('employee_types'))}\n"
        "  These are stored case-sensitive. ALWAYS wrap in LOWER() before comparing.\n"
        f"- Positions (Employee_Position) - {_format_distinct(get_rows('positions'))}\n"
        f"- Locations (Employee_Location) - {_format_distinct(get_rows('locations'))}\n\n"
        "ATTENDANCE DIMENSIONS (Attendance_Data):\n"
        f"- Status values (attendance_status_text) - {_format_distinct(get_rows('attendance_statuses'))}\n"
        "  Stored case-sensitive. ALWAYS wrap in LOWER() before comparing. There is NO 'Late' status - the closest real value is 'Missing Punch'.\n\n"
        "ALLOCATION DIMENSIONS (Allocation_data):\n"
        f"- Flag values - {_format_distinct(get_rows('allocation_flags'))}  (NOT 'Actual'/'Forecast' - use 'Allocated'/'Bench')\n"
        f"- Competencies (emp_competency) - {_format_distinct(get_rows('competencies'))}\n\n"
        "SALES DIMENSIONS:\n"
        f"- AMs (account managers) - {_format_distinct(get_rows('ams'))}\n"
        f"- VPs - {_format_distinct(get_rows('vps'))}\n"
        f"- Sales cities - {_format_distinct(get_rows('sales_cities'))}\n"
        f"- Account tiers (Sales_Accounts.Tier) - {_format_distinct(get_rows('account_tiers'))}\n\n"
        "CRITICAL JOIN RULE - Employee_Data <-> Attendance_Data uses NAMES, not IDs:\n"
        f"- Digit-stripped Employee_Code <-> employee_id overlap: {jc_str}  -> VIRTUALLY ZERO. DO NOT USE.\n"
        f"- Resource_Name <-> employee_name overlap (UPPER+TRIM): {jc_name_str}  -> THIS is the working join.\n\n"
        "  CORRECT JOIN PATTERN:\n"
        "      LEFT JOIN `ai-vertex-mahad.Satori_Project.Employee_Data` e\n"
        "        ON UPPER(TRIM(e.Resource_Name)) = UPPER(TRIM(a.employee_name))\n\n"
        "  DO NOT USE: CAST(e.Employee_Code AS STRING) = CAST(a.employee_id AS STRING)  - returns ~0 matches.\n"
        "  DO NOT USE: LTRIM(REGEXP_REPLACE(...digits...)) on Employee_Code/employee_id - also returns ~0 matches.\n\n"
        "- For Allocation_data -> Employee_Data, also join on name:\n"
        "      LEFT JOIN `ai-vertex-mahad.Satori_Project.Employee_Data` e\n"
        "        ON UPPER(TRIM(e.Resource_Name)) = UPPER(TRIM(al.emp_name))\n"
        "- ALWAYS LEFT JOIN (never INNER) so the outer rows survive when the lookup has no match.\n\n"
        "WHEN A USER ASKS ABOUT 'DEPARTMENTS' OR 'TEAMS' - they mean EmployeeHierarchyNode. Group by COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''),'Unspecified') AS department. The departments above are the REAL ones (SAP Supply Chain, SAP Finance, SAP ABAP & Fiori, etc.) - never invent department names like 'Engineering' or 'Tech' that don't exist.\n\n"
        "STATUS / FLAG GOTCHAS - use ONLY the values listed in the snapshot above:\n"
        "- attendance_status_text values: Present, Weekend, Absent, Missing Punch, Holiday, On Leave, Remote Work (and 'Submitted ...' variants). NO 'Late' - do not filter on 'late'. Use is_present=1 for attendance rate.\n"
        "- Allocation_data.Flag values: 'Allocated' and 'Bench'. NO 'Actual' or 'Forecast'.\n\n"
        "=== END SNAPSHOT ===\n"
    )


def reset_cache():
    global _snapshot, _snapshot_at
    with _lock:
        _snapshot = None
        _snapshot_at = 0.0
