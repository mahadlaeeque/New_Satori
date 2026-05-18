"""
BigQuery integration for Satori — TMC Capability Intelligence platform.

Queries the TMC workforce + sales data warehouse and provides results as
context for the AI chat agent.

Dataset: ai-vertex-mahad.Satori_Project (10 tables)
  Workforce: Employee_Data, Attendance_Data, Allocation_data, Timesheet_Data
  Sales:     Sales_Accounts, Sales_AM_Scorecard, Sales_Plan_vs_Pipeline,
             Sales_Pipeline_Health, Sales_Hunting_Gap, Sales_KPI_Scorecard,
             Sales_Dormant_Accounts, Sales_Workload_Feasibility
"""
import os
from google.cloud import bigquery
from google.oauth2 import service_account

# ── Configuration (read lazily after dotenv loads) ──
_client = None

# These defaults match TMC's production data layout. Override via env vars in
# non-prod / dev environments.
DEFAULT_PROJECT = "ai-vertex-mahad"
DEFAULT_DATASET = "Satori_Project"


def get_bq_client():
    global _client
    if _client is None:
        project_id = os.environ.get("VERTEX_PROJECT", DEFAULT_PROJECT)
        sa_key_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")
        print(f"[BQ] Initializing client: project={project_id}, "
              f"sa_key={sa_key_path}, exists={os.path.exists(sa_key_path) if sa_key_path else False}")
        if sa_key_path and os.path.exists(sa_key_path):
            credentials = service_account.Credentials.from_service_account_file(sa_key_path)
            _client = bigquery.Client(project=project_id, credentials=credentials)
        else:
            # On Cloud Run, ADC resolves to the attached runtime service account
            _client = bigquery.Client(project=project_id)
    return _client


def _project() -> str:
    return os.environ.get("VERTEX_PROJECT", DEFAULT_PROJECT)


def _dataset() -> str:
    return os.environ.get("VERTEX_DATASET", DEFAULT_DATASET)


def discover_tables(dataset: str = None) -> list[dict]:
    """List all tables / views in the TMC Satori dataset."""
    client = get_bq_client()
    tables = []
    try:
        ds_name = dataset or _dataset()
        ds = client.dataset(ds_name)
        for table in client.list_tables(ds):
            tables.append({
                "dataset": ds_name,
                "table": table.table_id,
                "type": table.table_type,  # TABLE, VIEW, etc.
                "full_id": f"{_project()}.{ds_name}.{table.table_id}",
            })
    except Exception as e:
        print(f"[BQ] Error discovering tables: {e}")
    return tables


def get_table_schema(full_table_id: str) -> list[dict]:
    """Return the schema (columns) of a specific table."""
    client = get_bq_client()
    try:
        table = client.get_table(full_table_id)
        return [{"name": f.name, "type": f.field_type, "description": f.description or ""}
                for f in table.schema]
    except Exception as e:
        print(f"[BQ] Error getting schema for {full_table_id}: {e}")
        return []


def run_query(sql: str, max_rows: int = 100) -> dict:
    """Execute a SELECT and return results as {columns, rows, total_rows}."""
    client = get_bq_client()
    try:
        query_job = client.query(sql)
        results = query_job.result()
        columns = [f.name for f in results.schema]
        rows = []
        for i, row in enumerate(results):
            if i >= max_rows:
                break
            rows.append({col: str(row[col]) if row[col] is not None else None for col in columns})
        return {"columns": columns, "rows": rows, "total_rows": results.total_rows}
    except Exception as e:
        return {"error": str(e)}


def query_table_sample(full_table_id: str, limit: int = 20) -> dict:
    """Return a sample of rows from a table — used by admin UI."""
    sql = f"SELECT * FROM `{full_table_id}` LIMIT {limit}"
    return run_query(sql, max_rows=limit)


# ──────────────────────────────────────────────────────────────────────────────
#  QUERY_MAP — keyword-driven prebuilt analytics
# ──────────────────────────────────────────────────────────────────────────────
# Each category has:
#   * keywords: strings that trigger the category when found in a user message
#   * queries:  list of {name, sql} pairs run when the category fires
# {project} and {dataset} placeholders are filled at call time so the SQL is
# portable across environments.

QUERY_MAP = {
    # ────────────────── WORKFORCE ──────────────────
    "headcount": {
        "keywords": [
            "headcount", "how many employees", "team size", "company size",
            "total people", "active employees", "workforce size", "employee count",
        ],
        "queries": [
            {
                "name": "Active Headcount by Department",
                "sql": """SELECT
  COALESCE(NULLIF(TRIM(Employee_Hierarchy), ''), 'Unspecified') AS department,
  COUNT(*) AS headcount
FROM `{project}.{dataset}.Employee_Data`
WHERE LOWER(COALESCE(Employee_Type, '')) IN ('mto', 'permanent', 'probation')
GROUP BY department
ORDER BY headcount DESC""",
            },
            {
                "name": "Headcount by Position",
                "sql": """SELECT
  COALESCE(NULLIF(TRIM(Employee_Position), ''), 'Unspecified') AS position,
  COUNT(*) AS headcount
FROM `{project}.{dataset}.Employee_Data`
WHERE LOWER(COALESCE(Employee_Type, '')) IN ('mto', 'permanent', 'probation')
GROUP BY position
ORDER BY headcount DESC
LIMIT 25""",
            },
        ],
    },

    "attendance": {
        "keywords": [
            "attendance", "present", "absent", "absences", "absenteeism", "late",
            "lateness", "tardy", "checkin", "check-in", "punctuality", "showed up",
            "on leave", "remote", "wfh", "work from home",
        ],
        "queries": [
            {
                "name": "Attendance Rate (last 30 days)",
                "sql": """SELECT
  ROUND(100.0 * SUM(is_present) / NULLIF(COUNT(*), 0), 1) AS attendance_rate_pct,
  COUNT(DISTINCT employee_id)                              AS unique_employees,
  SUM(is_present)                                          AS present_days,
  SUM(is_absent)                                           AS absent_days,
  SUM(is_on_leave)                                         AS leave_days,
  SUM(is_remote)                                           AS remote_days,
  COUNTIF(LOWER(attendance_status_text) = 'late')          AS late_count
FROM `{project}.{dataset}.Attendance_Data`
WHERE attendance_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)""",
            },
            {
                "name": "Daily Attendance Trend (last 14 days)",
                "sql": """SELECT
  attendance_date,
  COUNT(*)                                                       AS total,
  SUM(is_present)                                                AS present,
  SUM(is_absent)                                                 AS absent,
  COUNTIF(LOWER(attendance_status_text) = 'late')                AS late,
  ROUND(100.0 * SUM(is_present) / NULLIF(COUNT(*), 0), 1)        AS rate_pct
FROM `{project}.{dataset}.Attendance_Data`
WHERE attendance_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
GROUP BY attendance_date
ORDER BY attendance_date""",
            },
            {
                "name": "Top 10 Absentees (last 30 days)",
                "sql": """SELECT
  employee_name,
  COUNT(*) AS absent_days
FROM `{project}.{dataset}.Attendance_Data`
WHERE attendance_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  AND is_absent = 1
  AND employee_name IS NOT NULL
GROUP BY employee_name
ORDER BY absent_days DESC
LIMIT 10""",
            },
            {
                "name": "Top 10 Late Arrivals (last 30 days)",
                "sql": """SELECT
  employee_name,
  COUNT(*) AS late_count
FROM `{project}.{dataset}.Attendance_Data`
WHERE attendance_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  AND LOWER(attendance_status_text) = 'late'
  AND employee_name IS NOT NULL
GROUP BY employee_name
ORDER BY late_count DESC
LIMIT 10""",
            },
        ],
    },

    "timesheets": {
        "keywords": [
            "timesheet", "timesheets", "hours logged", "hours billed", "billable",
            "ticket hours", "project hours", "tickets", "ticket",
        ],
        "queries": [
            {
                "name": "Hours Logged Per Project (last 30 days)",
                "sql": """SELECT
  COALESCE(NULLIF(TRIM(TICKET_PROJECT_LABEL), ''), 'Unassigned') AS project,
  ROUND(SUM(SAFE_CAST(TICKET_HOURS AS FLOAT64)), 1)              AS total_hours,
  COUNT(DISTINCT TICKET_USER_ID)                                 AS contributors,
  COUNT(*)                                                        AS ticket_entries
FROM `{project}.{dataset}.Timesheet_Data`
WHERE SAFE.PARSE_DATE('%Y-%m-%d', CAST(DATE_KEY AS STRING)) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
GROUP BY project
ORDER BY total_hours DESC
LIMIT 25""",
            },
            {
                "name": "Top 10 Contributors by Hours (last 30 days)",
                "sql": """SELECT
  t.TICKET_USER_ID,
  e.Resource_Name,
  ROUND(SUM(SAFE_CAST(t.TICKET_HOURS AS FLOAT64)), 1) AS hours
FROM `{project}.{dataset}.Timesheet_Data` t
LEFT JOIN `{project}.{dataset}.Employee_Data` e
  ON CAST(e.Employee_Code AS STRING) = CAST(t.TICKET_USER_ID AS STRING)
WHERE SAFE.PARSE_DATE('%Y-%m-%d', CAST(t.DATE_KEY AS STRING)) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
GROUP BY t.TICKET_USER_ID, e.Resource_Name
ORDER BY hours DESC
LIMIT 10""",
            },
        ],
    },

    "allocation": {
        "keywords": [
            "allocation", "allocated", "assigned", "project assignment",
            "bench", "on bench", "free capacity", "partial", "availability",
            "available", "utilisation", "utilization", "capacity",
        ],
        "queries": [
            {
                "name": "Availability Breakdown (current)",
                "sql": """WITH latest_alloc AS (
  SELECT
    employee_id,
    AVG(SAFE_CAST(allocation_percent AS FLOAT64)) AS avg_pct,
    MAX(SAFE_CAST(allocation_percent AS FLOAT64)) AS max_pct
  FROM `{project}.{dataset}.Allocation_data`
  WHERE Flag IN ('Actual', 'Forecast')
  GROUP BY employee_id
)
SELECT
  CASE
    WHEN max_pct >= 90 THEN 'Allocated'
    WHEN max_pct BETWEEN 1 AND 89 THEN 'Partial'
    ELSE 'Bench'
  END AS status,
  COUNT(*) AS employees
FROM latest_alloc
GROUP BY status
ORDER BY employees DESC""",
            },
            {
                "name": "Top Allocations by Project",
                "sql": """SELECT
  project_id,
  COUNT(DISTINCT employee_id)                                AS people,
  ROUND(AVG(SAFE_CAST(allocation_percent AS FLOAT64)), 1)    AS avg_allocation_pct
FROM `{project}.{dataset}.Allocation_data`
WHERE Flag = 'Actual'
GROUP BY project_id
ORDER BY people DESC
LIMIT 20""",
            },
            {
                "name": "On-Bench Employees (current snapshot)",
                "sql": """WITH latest AS (
  SELECT
    employee_id,
    MAX(SAFE_CAST(allocation_percent AS FLOAT64)) AS max_pct,
    STRING_AGG(DISTINCT emp_competency, ' | ' ORDER BY emp_competency LIMIT 3) AS competencies
  FROM `{project}.{dataset}.Allocation_data`
  WHERE Flag IN ('Actual', 'Forecast')
  GROUP BY employee_id
)
SELECT
  l.employee_id,
  e.Resource_Name,
  e.Employee_Position,
  l.competencies
FROM latest l
LEFT JOIN `{project}.{dataset}.Employee_Data` e
  ON CAST(e.Employee_Code AS STRING) = CAST(l.employee_id AS STRING)
WHERE l.max_pct = 0 OR l.max_pct IS NULL
ORDER BY e.Resource_Name
LIMIT 25""",
            },
        ],
    },

    "capability": {
        "keywords": [
            "skill", "skills", "competency", "competencies", "capability",
            "expertise", "react developer", "python developer", "sap", "consultant",
            "rating", "score",
        ],
        "queries": [
            {
                "name": "Top Competencies in the Workforce",
                "sql": """SELECT
  emp_competency AS competency,
  COUNT(DISTINCT employee_id) AS employees
FROM `{project}.{dataset}.Allocation_data`
WHERE emp_competency IS NOT NULL AND TRIM(emp_competency) <> ''
GROUP BY competency
ORDER BY employees DESC
LIMIT 25""",
            },
        ],
    },

    # ────────────────── SALES ──────────────────
    "accounts": {
        "keywords": [
            "account", "accounts", "customer", "customers", "client", "clients",
            "coverage", "visits", "visit", "dormant", "tier",
        ],
        "queries": [
            {
                "name": "Account Coverage by AM",
                "sql": """SELECT
  AM,
  Location,
  COUNT(*) AS accounts,
  SUM(CASE WHEN Tier = 'A' THEN 1 ELSE 0 END) AS tier_a,
  SUM(CASE WHEN Tier = 'B' THEN 1 ELSE 0 END) AS tier_b,
  SUM(CASE WHEN Tier = 'C' THEN 1 ELSE 0 END) AS tier_c,
  SUM(CASE WHEN Zero_Visit = 'Yes' THEN 1 ELSE 0 END) AS zero_visit_accounts,
  SUM(SAFE_CAST(Q1_Visits AS INT64))                  AS q1_visits
FROM `{project}.{dataset}.Sales_Accounts`
GROUP BY AM, Location
ORDER BY accounts DESC""",
            },
            {
                "name": "Dormant Accounts",
                "sql": """SELECT *
FROM `{project}.{dataset}.Sales_Dormant_Accounts`
LIMIT 25""",
            },
        ],
    },

    "pipeline": {
        "keywords": [
            "pipeline", "open pipeline", "open deals", "win rate", "win-rate",
            "coverage ratio", "deals", "opportunities",
        ],
        "queries": [
            {
                "name": "Pipeline Health by Salesperson",
                "sql": """SELECT
  Salesperson,
  ROUND(SAFE_CAST(Open_Pipeline AS FLOAT64), 0) AS open_pipeline_usd,
  SAFE_CAST(Open_Deals AS INT64)                AS open_deals,
  ROUND(SAFE_CAST(Win_Rate_by AS FLOAT64) * 100, 1) AS win_rate_pct
FROM `{project}.{dataset}.Sales_Pipeline_Health`
ORDER BY open_pipeline_usd DESC""",
            },
            {
                "name": "Plan vs Pipeline Coverage",
                "sql": """SELECT
  AM,
  ROUND(SAFE_CAST(col_2026_Target AS FLOAT64), 0) AS target_2026_usd,
  ROUND(SAFE_CAST(Q1_Target AS FLOAT64), 0)       AS q1_target_usd,
  ROUND(SAFE_CAST(Q1_ACH AS FLOAT64), 0)          AS q1_ach_usd,
  ROUND(SAFE_CAST(CRM_Pipeline AS FLOAT64), 0)    AS crm_pipeline_usd,
  ROUND(SAFE_CAST(Coverage_Ratio AS FLOAT64), 2)  AS coverage_ratio,
  Status,
  Action
FROM `{project}.{dataset}.Sales_Plan_vs_Pipeline`
ORDER BY coverage_ratio DESC""",
            },
        ],
    },

    "am_scorecard": {
        "keywords": [
            "scorecard", "am scorecard", "account manager", "ams", "vp",
            "target", "targets", "achievement", "ach", "performance",
        ],
        "queries": [
            {
                "name": "AM Scorecard — full ranking",
                "sql": """SELECT
  VP,
  AM,
  Role,
  City,
  ROUND(SAFE_CAST(col_2026_Target AS FLOAT64), 0) AS target_2026_usd,
  ROUND(SAFE_CAST(Q1_ACH AS FLOAT64), 0)          AS q1_ach_usd,
  ROUND(SAFE_CAST(Open_Pipeline AS FLOAT64), 0)   AS open_pipeline_usd,
  ROUND(SAFE_CAST(Hist_Win_Rate AS FLOAT64) * 100, 1) AS hist_win_rate_pct
FROM `{project}.{dataset}.Sales_AM_Scorecard`
ORDER BY q1_ach_usd DESC""",
            },
        ],
    },

    "hunting_gap": {
        "keywords": [
            "hunting", "new business", "new logos", "hunting gap", "logo",
            "quota",
        ],
        "queries": [
            {
                "name": "New-Business Hunting Gap",
                "sql": """SELECT *
FROM `{project}.{dataset}.Sales_Hunting_Gap`
LIMIT 25""",
            },
        ],
    },

    "kpi_definitions": {
        "keywords": [
            "kpi", "kpis", "definition", "definitions", "what is", "metric",
            "metrics",
        ],
        "queries": [
            {
                "name": "Sales KPI Definitions",
                "sql": """SELECT *
FROM `{project}.{dataset}.Sales_KPI_Scorecard`
LIMIT 25""",
            },
        ],
    },

    "workload": {
        "keywords": [
            "workload", "field days", "field capacity", "feasibility", "utilisation",
            "utilization",
        ],
        "queries": [
            {
                "name": "Sales Workload Feasibility",
                "sql": """SELECT *
FROM `{project}.{dataset}.Sales_Workload_Feasibility`
LIMIT 25""",
            },
        ],
    },
}


# ──────────────────────────────────────────────────────────────────────────────
#  Schema context for the chat agent's system prompt
# ──────────────────────────────────────────────────────────────────────────────
def get_schema_context(dataset: str = None) -> str:
    """Build a human-readable description of the tables for the system prompt."""
    tables = discover_tables(dataset)
    if not tables:
        return ""
    lines = ["The tables available in the Satori warehouse are:"]
    for t in tables:
        schema = get_table_schema(t["full_id"])
        cols = ", ".join(s["name"] for s in schema[:15])
        if len(schema) > 15:
            cols += f" (+{len(schema)-15} more)"
        lines.append(f"  - {t['table']} ({t['type']}): {cols}")
    return (
        "\n─── AVAILABLE DATA SOURCES ───\n"
        "You are connected to TMC's BigQuery data warehouse. Below are the available "
        "tables and their columns. Use them to answer the user's question. If you need "
        "specific numbers and they aren't already in your context, generate a SELECT "
        "query and use the run_sql tool to fetch them.\n\n"
        + "\n".join(lines)
        + "\n─── END ───\n"
    )


def get_all_key_data(dataset: str = None) -> str:
    """
    Pre-load a summary of all key data. Used by the voice agent for context.
    """
    project_id = _project()
    dataset_name = dataset or _dataset()

    all_data = []
    for category, config in QUERY_MAP.items():
        for q in config["queries"]:
            sql = q["sql"].format(project=project_id, dataset=dataset_name)
            result = run_query(sql, max_rows=25)
            if "error" not in result and result.get("rows"):
                header = " | ".join(result["columns"])
                rows_text = "\n".join(
                    " | ".join(str(row.get(c, "")) for c in result["columns"])
                    for row in result["rows"][:25]
                )
                all_data.append(
                    f"### {q['name']}\n"
                    f"Total rows: {result.get('total_rows', 'unknown')}\n"
                    f"{header}\n{rows_text}"
                )

    if all_data:
        return (
            "\n\n─── TMC ENTERPRISE DATA ───\n"
            "You have access to TMC's live workforce + sales data, summarised below. "
            "Use it to answer questions accurately with specific numbers.\n\n"
            + "\n\n".join(all_data)
            + "\n─── END ───\n"
        )
    return ""


# ──────────────────────────────────────────────────────────────────────────────
#  Scope notice — keeps the model honest about what data it actually has
# ──────────────────────────────────────────────────────────────────────────────
_SCOPE_NOTICE = (
    "\n\n─── SATORI DATA SCOPE (read this BEFORE answering) ───\n"
    "The TMC Satori warehouse covers WORKFORCE INTELLIGENCE and SALES OPERATIONS. "
    "It contains: employee master data (positions, departments, locations, types), "
    "daily attendance (presence, absences, late arrivals, leave types), "
    "project allocation (% allocated per employee, bench status, competencies), "
    "timesheet entries (hours logged per project/ticket), "
    "and sales operations (account coverage, pipeline health, AM scorecards, "
    "new-business hunting gaps, dormant accounts, workload feasibility).\n"
    "It does NOT contain: SAP ERP modules (inventory, AR/AP, GL), customer billing, "
    "purchase orders, manufacturing data, or HR-payroll detail (salaries, bonuses).\n"
    "If the user asks about something outside scope, state clearly that the dataset "
    "does not include it and suggest the closest available proxy.\n"
    "─── END SCOPE NOTICE ───\n"
)

# Out-of-scope keyword hints — trigger the scope notice so the model doesn't fabricate
_OUT_OF_SCOPE_KEYWORDS = (
    "inventory", "stock", "warehouse", "plant", "material",
    "purchase order", "po ", " po,", "accounts payable", "accounts receivable",
    "ap ", " ap,", "ar ", " ar,", "general ledger", "journal entry",
    "manufacturing", "production order",
    "salary", "salaries", "bonus", "payroll", "compensation",
)


def find_relevant_data(user_message: str, dataset: str = None) -> str:
    """
    Given a user's question, find and query relevant BigQuery data.
    Returns a formatted string of data context to inject into the AI prompt.
    """
    message_lower = user_message.lower()
    matched_data = []
    print(f"[BQ] find_relevant_data called with: '{user_message[:60]}...'")

    dataset_name = dataset or _dataset()
    project_id = _project()

    # Scope guard: if user asks about out-of-scope topics, inject a notice up front.
    scope_notice = ""
    if any(kw in message_lower for kw in _OUT_OF_SCOPE_KEYWORDS):
        scope_notice = _SCOPE_NOTICE
        print(f"[BQ] Out-of-scope keyword detected — injecting scope notice")

    matched_categories = set()
    for category, config in QUERY_MAP.items():
        if any(kw in message_lower for kw in config["keywords"]):
            matched_categories.add(category)

    # Speed cap: only fire context-injection queries for AT MOST 2 categories, and
    # only the FIRST (lightest) query per category. The previous behaviour ran every
    # query in every matched category up-front (often 8+ BQ round-trips before
    # Gemini even saw the question). The LLM has a run_sql tool — let it ask for
    # exactly what it needs instead of guessing for it. Pre-execution is just for
    # cheap orientation, not exhaustive coverage.
    MAX_CATEGORIES = 2
    MAX_QUERIES_PER_CATEGORY = 1
    capped_categories = list(matched_categories)[:MAX_CATEGORIES]

    for category in capped_categories:
        config = QUERY_MAP[category]
        print(f"[BQ] Matched category: {category}")
        for q in config["queries"][:MAX_QUERIES_PER_CATEGORY]:
            sql = q["sql"].format(project=project_id, dataset=dataset_name)
            print(f"[BQ] Running query: {sql[:100]}...")
            result = run_query(sql, max_rows=15)
            if "error" in result:
                print(f"[BQ] Query error: {result['error']}")
                continue
            if not result.get("rows"):
                print(f"[BQ] Query returned 0 rows")
                continue
            header = " | ".join(result["columns"])
            rows_text = "\n".join(
                " | ".join(str(row.get(c, "")) for c in result["columns"])
                for row in result["rows"][:15]
            )
            matched_data.append(
                f"### {q['name']} (from BigQuery)\n"
                f"Total rows: {result.get('total_rows', 'unknown')}\n\n"
                f"{header}\n{'─' * min(len(header), 100)}\n{rows_text}"
            )

    if not matched_data:
        print("[BQ] No QUERY_MAP match found for this message")

    if matched_data:
        return (
            scope_notice
            + "\n\n─── TMC LIVE DATA (from BigQuery) ───\n"
            "The following is real data from the TMC Satori warehouse, pre-computed for you. "
            "POLICY: If a figure in this block directly answers the user's question, state that "
            "figure verbatim — do NOT rerun a custom SQL query just to recompute it. Only call "
            "`run_sql` if this block does not already cover the exact filter/dimension asked.\n\n"
            + "\n\n".join(matched_data)
            + "\n─── END OF DATA ───\n"
        )
    # Even with no matched queries, still surface the scope notice for out-of-scope asks
    if scope_notice:
        return scope_notice
    return ""
