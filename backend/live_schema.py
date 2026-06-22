"""
Live schema snapshot for Satori v2.

Probes BigQuery on first request to discover the actual distinct values that
live in every important categorical column (departments, employee types, AMs,
tiers, etc.) plus a row count and date range per table. Cached for 1h in
memory and rendered into a compact context block injected into the chat /
dashboard / report system prompts.
"""
import os
import time
import threading
from bigquery_client import run_query

# Live BQ target, env-driven so this module follows the same project as the
# rest of the app (capability-agent-prod on prod). The probe SQL below is
# written against the canonical name and rewritten to _BQ_FULL at run time.
_BQ_FULL = f"{os.environ.get('VERTEX_PROJECT', 'capability-agent-prod')}.{os.environ.get('VERTEX_DATASET', 'Satori_Project')}"

_snapshot = None
_snapshot_at = 0.0
_TTL_SECONDS = 60 * 60
_lock = threading.Lock()

_PROBES = {
    "departments": (
        "SELECT DISTINCT COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''),'(empty)') AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.Employee_Data` "
        "GROUP BY v ORDER BY n DESC LIMIT 50"
    ),
    "employee_types": (
        "SELECT DISTINCT Employee_Type AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.Employee_Data` WHERE Employee_Type IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 30"
    ),
    "positions": (
        "SELECT DISTINCT EmployeePosition AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.Employee_Data` WHERE EmployeePosition IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 40"
    ),
    "locations": (
        "SELECT DISTINCT EmployeeLocation AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.Employee_Data` WHERE EmployeeLocation IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 30"
    ),
    "growth_levels": (
        "SELECT DISTINCT Employee_GL AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.Employee_Data` WHERE Employee_GL IS NOT NULL "
        "GROUP BY v ORDER BY v LIMIT 30"
    ),
    "attendance_statuses": (
        "SELECT DISTINCT attendance_status_text AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.Attendance_Data` WHERE attendance_status_text IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 20"
    ),
    "allocation_flags": (
        "SELECT DISTINCT Flag AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.Allocation_Data` WHERE Flag IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 10"
    ),
    "competencies": (
        "SELECT DISTINCT emp_competency AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.Allocation_Data` WHERE emp_competency IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 40"
    ),
    "ams": (
        "SELECT DISTINCT AM AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.Sales_AM_Scorecard` WHERE AM IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 30"
    ),
    "vps": (
        "SELECT DISTINCT VP AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.Sales_AM_Scorecard` WHERE VP IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 15"
    ),
    "sales_cities": (
        "SELECT DISTINCT City AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.Sales_AM_Scorecard` WHERE City IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 20"
    ),
    "account_tiers": (
        "SELECT DISTINCT Tier AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.Sales_Accounts` WHERE Tier IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 10"
    ),
    "attendance_date_range": (
        "SELECT MIN(attendance_date) AS v, MAX(attendance_date) AS n "
        "FROM `capability-agent-prod.Satori_Project.Attendance_Data`"
    ),
    "row_counts": (
        "SELECT 'Employee_Data' AS v, COUNT(*) AS n FROM `capability-agent-prod.Satori_Project.Employee_Data`"
        " UNION ALL SELECT 'Attendance_Data', COUNT(*) FROM `capability-agent-prod.Satori_Project.Attendance_Data`"
        " UNION ALL SELECT 'Allocation_Data', COUNT(*) FROM `capability-agent-prod.Satori_Project.Allocation_Data`"
        " UNION ALL SELECT 'Timesheet_Data', COUNT(*) FROM `capability-agent-prod.Satori_Project.Timesheet_Data`"
        " UNION ALL SELECT 'Sales_AM_Scorecard', COUNT(*) FROM `capability-agent-prod.Satori_Project.Sales_AM_Scorecard`"
        " UNION ALL SELECT 'Sales_Accounts', COUNT(*) FROM `capability-agent-prod.Satori_Project.Sales_Accounts`"
        " UNION ALL SELECT 'Sales_Pipeline_Health', COUNT(*) FROM `capability-agent-prod.Satori_Project.Sales_Pipeline_Health`"
        " UNION ALL SELECT 'Sales_Plan_vs_Pipeline', COUNT(*) FROM `capability-agent-prod.Satori_Project.Sales_Plan_vs_Pipeline`"
        " UNION ALL SELECT 'Sales_Hunting_Gap', COUNT(*) FROM `capability-agent-prod.Satori_Project.Sales_Hunting_Gap`"
    ),
    "join_compat_attendance": (
        "WITH e AS (SELECT DISTINCT LTRIM(REGEXP_REPLACE(CAST(Employee_Code AS STRING), r'[^0-9]', ''), '0') AS k "
        "  FROM `capability-agent-prod.Satori_Project.Employee_Data`), "
        "a AS (SELECT DISTINCT LTRIM(REGEXP_REPLACE(CAST(personal_no AS STRING), r'[^0-9]', ''), '0') AS k "
        "  FROM `capability-agent-prod.Satori_Project.Attendance_Data`) "
        "SELECT 'overlap' AS v, COUNT(*) AS n FROM e JOIN a USING (k) "
        "UNION ALL SELECT 'in_employee_only', COUNT(*) FROM e WHERE k NOT IN (SELECT k FROM a) "
        "UNION ALL SELECT 'in_attendance_only', COUNT(*) FROM a WHERE k NOT IN (SELECT k FROM e)"
    ),
    # WP_Report columns straight from INFORMATION_SCHEMA — the table arrives
    # as a raw header-derived CSV load, so the LIVE column list is the only
    # trustworthy source (never hardcode WP column names in prompts). Probe
    # fails soft until the pipeline has loaded the table the first time.
    "wp_report_columns": (
        "SELECT column_name AS v, ordinal_position AS n "
        "FROM `capability-agent-prod.Satori_Project.INFORMATION_SCHEMA.COLUMNS` "
        "WHERE table_name = 'WP_Report' ORDER BY ordinal_position LIMIT 80"
    ),
    "wp_report_rows": (
        "SELECT 'WP_Report' AS v, COUNT(*) AS n FROM `capability-agent-prod.Satori_Project.WP_Report`"
    ),
    "wp_progress_statuses": (
        "SELECT DISTINCT Progress_Status AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.WP_Report` WHERE Progress_Status IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 15"
    ),
    "wp_portal_statuses": (
        "SELECT DISTINCT WP_PORTAL_STATUS AS v, COUNT(*) AS n "
        "FROM `capability-agent-prod.Satori_Project.WP_Report` WHERE WP_PORTAL_STATUS IS NOT NULL "
        "GROUP BY v ORDER BY n DESC LIMIT 15"
    ),
    "join_compat_attendance_name": (
        "WITH e AS (SELECT DISTINCT UPPER(TRIM(Resource_Name)) AS k "
        "  FROM `capability-agent-prod.Satori_Project.Employee_Data` WHERE Resource_Name IS NOT NULL), "
        "a AS (SELECT DISTINCT UPPER(TRIM(employee_name)) AS k "
        "  FROM `capability-agent-prod.Satori_Project.Attendance_Data` WHERE employee_name IS NOT NULL) "
        "SELECT 'overlap' AS v, COUNT(*) AS n FROM e JOIN a USING (k) "
        "UNION ALL SELECT 'in_employee_only', COUNT(*) FROM e WHERE k NOT IN (SELECT k FROM a) "
        "UNION ALL SELECT 'in_attendance_only', COUNT(*) FROM a WHERE k NOT IN (SELECT k FROM e)"
    ),
}


def _probe_all() -> dict:
    out = {}
    for name, sql in _PROBES.items():
        try:
            # Follow the configured project if it differs from the default.
            sql = sql.replace("capability-agent-prod.Satori_Project", _BQ_FULL)
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

    # WP_Report is a raw header-derived load — the live column list is the
    # only trustworthy source of its column names (empty until first sync).
    wp_cols = get_rows("wp_report_columns")
    wp_rows = get_rows("wp_report_rows")

    return (
        "=== LIVE WAREHOUSE SNAPSHOT (auto-refreshed hourly - these are the REAL values that exist in BigQuery right now) ===\n\n"
        f"ROW COUNTS - {rc_str}\n\n"
        f"ATTENDANCE DATE RANGE - {date_str}\n\n"
        "WORKFORCE DIMENSIONS (Employee_Data):\n"
        f"- Departments (EmployeeHierarchyNode) - {_format_distinct(get_rows('departments'))}\n"
        "  Always use COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''),'Unspecified') AS department. Many rows have NULL/empty EmployeeHierarchyNode.\n"
        f"- Employee_Type values - {_format_distinct(get_rows('employee_types'))}\n"
        "  These are stored case-sensitive. ALWAYS wrap in LOWER() before comparing.\n"
        f"- Positions (EmployeePosition) - {_format_distinct(get_rows('positions'))}\n"
        f"- Locations (EmployeeLocation) - {_format_distinct(get_rows('locations'))}\n"
        f"- Growth Levels (Employee_GL) - {_format_distinct(get_rows('growth_levels'))}\n"
        "  Seniority band: GL-1 = MOST senior, higher number = more junior. Rank/sort by seniority via SAFE_CAST(REGEXP_EXTRACT(Employee_GL,r'([0-9]+)') AS INT64) ASC (NOT the raw string).\n\n"
        "ATTENDANCE DIMENSIONS (Attendance_Data):\n"
        f"- Status values (attendance_status_text) - {_format_distinct(get_rows('attendance_statuses'))}\n"
        "  Stored case-sensitive. ALWAYS wrap in LOWER() before comparing. There is NO 'Late' status VALUE - a late arrival = check-in after 09:30 on a worked day: TIME(SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%E*S', checkin_time)) > TIME '09:30:00'.\n"
        "- Permitted-location punch: checkin_is_permitted_location / checkout_is_permitted_location are STRING '1'/'0'. PunchInLocationStatus = IF(SAFE_CAST(checkin_is_permitted_location AS INT64)=1,'Permitted','Not Permitted'); same for checkout → PunchOutLocationStatus.\n\n"
        + (
            (
                "WORK PACKAGES (WP_Report) - the PF work-package master/detail report"
                + (f", {wp_rows[0].get('n')} rows" if wp_rows else "")
                + " (~10k distinct WPs across ~108 projects; MANY rows per WP - one per deliverable line).\n"
                f"- EXACT live columns (the ONLY valid names - NEVER invent WP column names): {_format_distinct(wp_cols, limit=80)}\n"
                "- 'How many work packages' = COUNT(DISTINCT WP_CODE), NEVER COUNT(*) (rows are deliverable lines). Per-WP attributes -> GROUP BY WP_CODE + ANY_VALUE(...).\n"
                "- JOIN to Timesheet (VERIFIED 885/886): WP_Report.WP_CODE = REGEXP_REPLACE(UPPER(TRIM(t.TICKET_WP_ID)), r'(-[0-9]{4,})+$', '') "
                "- TICKET_WP_ID is WP_CODE plus a numeric task-id suffix; NEVER join the two columns directly (0 matches). Wrap WP_CODE in UPPER(TRIM(...)) too.\n"
                "- PROJECT JOIN: the WP's project = WP_CODE's LEADING NUMBER - REGEXP_EXTRACT(WP_CODE, r'^([0-9]+)') = CAST(Project_Master.Project_Code AS STRING) (verified 4321/4329 active WPs). ⚠️ PROJECT_ID is an INTERNAL id (e.g. 5861) that matches NOTHING - never join on it.\n"
                f"- Progress_Status values - {_format_distinct(get_rows('wp_progress_statuses'))}\n"
                f"- WP_PORTAL_STATUS values - {_format_distinct(get_rows('wp_portal_statuses'))}\n"
                "- PLAN = planned progress percent 0-100 (INT64 after finalize; SAFE_CAST if STRING). ⚠️ ACTUAL is '?' in the source feed - UNUSABLE; "
                "actual effort/progress comes from Timesheet hours (GROUP BY the stripped WP code). Date columns (WP_START_DATE etc.) are DATE after finalize; "
                "if still STRING parse with SAFE.PARSE_DATE('%d-%b-%Y', col). Use the type-agnostic COALESCE(SAFE_CAST(CAST(col AS STRING) AS DATE), SAFE.PARSE_DATE('%d-%b-%Y', CAST(col AS STRING))).\n\n"
            )
            if wp_cols else
            "WORK PACKAGES: the WP_Report table has not been loaded yet - if asked about work-package details beyond Timesheet_Data's TICKET_WP_ID, say the WP report isn't available rather than guessing.\n\n"
        )
        + "ALLOCATION DIMENSIONS (Allocation_Data):\n"
        f"- Flag values - {_format_distinct(get_rows('allocation_flags'))}  (NOT 'Actual'/'Forecast' - use 'Allocated'/'Bench')\n"
        f"- Competencies (emp_competency) - {_format_distinct(get_rows('competencies'))}\n\n"
        "SALES DIMENSIONS:\n"
        f"- AMs (account managers) - {_format_distinct(get_rows('ams'))}\n"
        f"- VPs - {_format_distinct(get_rows('vps'))}\n"
        f"- Sales cities - {_format_distinct(get_rows('sales_cities'))}\n"
        f"- Account tiers (Sales_Accounts.Tier) - {_format_distinct(get_rows('account_tiers'))}\n\n"
        "CRITICAL JOIN RULE - join Employee_Data to Attendance_Data / Allocation_Data / Timesheet_Data on the DIGIT-NORMALISED employee code. NOT on names, NOT on employee_id.\n"
        "  Let norm(x) = LTRIM(REGEXP_REPLACE(CAST(x AS STRING), r'[^0-9]', ''), '0').\n"
        f"- norm(Employee_Code) <-> norm(personal_no) overlap: {jc_str}  -> THIS is the working join. USE IT.\n"
        f"- UPPER(TRIM(Resource_Name)) <-> UPPER(TRIM(employee_name)) overlap: {jc_name_str}  -> BROKEN. DO NOT USE. Employee_Data.Resource_Name carries a code prefix (e.g. 'E-1571 Mahad Laeeque'), so it never equals Attendance_Data.employee_name ('Mahad Laeeque').\n\n"
        "  CORRECT JOIN PATTERN (Attendance):\n"
        "      JOIN Attendance_Data a\n"
        "        ON norm(e.Employee_Code) = norm(a.personal_no)\n"
        "  DO NOT join Attendance_Data on a.employee_id (an unrelated INT64 sequence) -> ~0 matches.\n"
        "  DO NOT join Attendance_Data on employee_name = Resource_Name -> ~0 matches (code prefix).\n\n"
        "- Allocation_Data -> Employee_Data: ON norm(e.Employee_Code) = norm(al.employee_id)  (Allocation_Data.employee_id holds the 'E-2141' code).\n"
        "- Timesheet_Data  -> Employee_Data: ON norm(e.Employee_Code) = norm(t.EMPLOYEE_CODE)  (Timesheet's EMPLOYEE_CODE holds the 'E-1571' code; DO NOT join on TICKET_USER_ID, an unrelated internal id -> ~0 matches). DATE_KEY is a DATE; filter via COALESCE(SAFE_CAST(CAST(DATE_KEY AS STRING) AS DATE), SAFE.PARSE_DATE('%Y%m%d', CAST(DATE_KEY AS STRING))).\n"
        "- SINGLE-EMPLOYEE lookup: FIRST resolve the person on Employee_Data — SELECT Employee_Code, Resource_Name, EmployeeHierarchyNode FROM Employee_Data WHERE LOWER(Resource_Name) LIKE '%<name>%' (active filter). If MULTIPLE employees match the name (namesakes — several 'Hamza's), do NOT pick one: list the candidates (full name, code, department) and ASK the user which one they mean before answering. If exactly ONE matches, proceed (filter Attendance_Data by the digit-normalised code or the now-unambiguous employee_name) and state who you resolved to.\n"
        "- Use INNER JOIN when a department-scope filter on Employee_Data must apply; otherwise LEFT JOIN so attendance rows survive a missing lookup.\n\n"
        "WHEN A USER ASKS ABOUT 'DEPARTMENTS' OR 'TEAMS' - they mean EmployeeHierarchyNode. Group by COALESCE(NULLIF(TRIM(EmployeeHierarchyNode),''),'Unspecified') AS department. The departments above are the REAL ones (SAP Supply Chain, SAP Finance, SAP ABAP & Fiori, etc.) - never invent department names like 'Engineering' or 'Tech' that don't exist.\n\n"
        "STATUS / FLAG GOTCHAS - use ONLY the values listed in the snapshot above:\n"
        "- attendance_status_text values: Present, Weekend, Absent, Missing Punch, Holiday, On Leave, Remote Work (and 'Submitted ...' variants). NO 'Late' value - a late arrival = a check-in after 09:30: TIME(SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%E*S', checkin_time)) > TIME '09:30:00' (any day with a check-in, incl. Missing Punch; filter checkin_time IS NOT NULL, not a status whitelist). NEVER filter status='late'.\n"
        "- Attendance_Data HAS the is_present / is_absent / is_on_leave / is_remote / is_holiday / is_weekend / is_missing_punch flag columns (INT64 0/1) AND attendance_status_text — SUM(is_present) and COUNTIF(LOWER(attendance_status_text)='present') are equivalent; use either.\n"
        "- WORKING-DAY COUNT for a period = the COMPANY attendance calendar, computed in SQL (majority vote per date; period filter only, NO employee filter): WITH days AS (SELECT attendance_date, COUNTIF(is_weekend=1 OR is_holiday=1) AS off_rows, COUNT(*) AS n FROM Attendance_Data WHERE <period> GROUP BY attendance_date) SELECT COUNTIF(off_rows < n/2) AS working_days FROM days. NEVER count weekdays arithmetically and NEVER derive it from one employee's own weekend/holiday rows — those methods disagree (21 vs 20 for the same month). Use the SAME working_days for every employee, every attendance rate, and any hours-per-working-day timesheet math in that period.\n"
        "- Allocation_Data.Flag values: 'Allocated' and 'Bench'. NO 'Actual' or 'Forecast'.\n\n"
        "=== END SNAPSHOT ===\n"
    )


def reset_cache():
    global _snapshot, _snapshot_at
    with _lock:
        _snapshot = None
        _snapshot_at = 0.0
