#!/usr/bin/env python3
"""
Satori Drive -> BigQuery sync pipeline.

Runs as a Cloud Run Job, triggered by Cloud Scheduler every 30 minutes.
Reads 5 CSV files from a shared Google Drive folder and full-refreshes the
matching BigQuery tables in capability-agent-prod.Satori_Project, then casts
the date/number columns to match what the Satori app expects and rebuilds the
Allocation_Data view.

The 5 source CSVs (uploaded by a Qlik automation) are all-string with a header
row (some with a UTF-8 BOM). BigQuery autodetect can't reliably find a header in
an all-string CSV, so we load with an EXPLICIT schema derived from the header
line (all STRING), then cast the few typed columns in a finalize step. This is
robust to the BOM and to columns being added.

Auth: Application Default Credentials (the job's service account). It needs:
  - Drive read access to the folder (folder shared with the SA, or link-Viewer).
  - roles/bigquery.dataEditor + roles/bigquery.jobUser.

Env: VERTEX_PROJECT, VERTEX_DATASET, DRIVE_FOLDER_ID, DRY_RUN.
"""
import io
import os
import re
import sys
import traceback

from google.auth import default as google_auth_default
from google.cloud import bigquery
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

PROJECT = os.environ.get("VERTEX_PROJECT", "capability-agent-prod")
DATASET = os.environ.get("VERTEX_DATASET", "Satori_Project")
FOLDER_ID = os.environ.get("DRIVE_FOLDER_ID", "12emVFtakumridd2QSjNm6W4Vd9hIFJ0K")
DRY_RUN = os.environ.get("DRY_RUN", "").strip() not in ("", "0", "false", "False")

# Exact normalised (lowercase, alphanumeric-only) base name (no .csv) -> table.
FILE_TARGETS = [
    ("empdata",          "Employee_Data"),
    ("projectmaster",    "Project_Master"),
    ("timesheet",        "Timesheet_Data"),
    ("attendancesatori", "Attendance_Data"),
    ("allocation",       "Allocation_Data_Final"),
    # PF work-package report (~150 MB) — WP master/detail; columns come from
    # the CSV header like everything else and load as STRING (the app
    # SAFE_CASTs). Joins to Timesheet_Data.TICKET_WP_ID on its WP-id column.
    ("pfwpreport",       "WP_Report"),
]

# Per-table finalize: recast the columns the app reads as typed. Everything else
# stays STRING (the app SAFE_CASTs the rest). {t} = fully-qualified table.
FINALIZE_SQL = {
    "Timesheet_Data": """
        CREATE OR REPLACE TABLE `{t}` AS
        SELECT * EXCEPT(DATE_KEY, TICKET_HOURS),
          COALESCE(SAFE.PARSE_DATE('%d-%b-%Y', DATE_KEY),
                   SAFE.PARSE_DATE('%Y-%m-%d', DATE_KEY),
                   SAFE_CAST(DATE_KEY AS DATE))            AS DATE_KEY,
          SAFE_CAST(TICKET_HOURS AS FLOAT64)              AS TICKET_HOURS
        FROM `{t}`
    """,
    "WP_Report": """
        CREATE OR REPLACE TABLE `{t}` AS
        SELECT * EXCEPT(WP_BASELINE_START_DATE, WP_BASELINE_END_DATE, WP_START_DATE,
                        WP_END_DATE, WP_RELEASE_DATE, WP_COMPLETION_DATE,
                        WP_LAST_STATUS_DATE, PLAN),
          COALESCE(SAFE.PARSE_DATE('%d-%b-%Y', WP_BASELINE_START_DATE), SAFE_CAST(WP_BASELINE_START_DATE AS DATE)) AS WP_BASELINE_START_DATE,
          COALESCE(SAFE.PARSE_DATE('%d-%b-%Y', WP_BASELINE_END_DATE),   SAFE_CAST(WP_BASELINE_END_DATE AS DATE))   AS WP_BASELINE_END_DATE,
          COALESCE(SAFE.PARSE_DATE('%d-%b-%Y', WP_START_DATE),          SAFE_CAST(WP_START_DATE AS DATE))          AS WP_START_DATE,
          COALESCE(SAFE.PARSE_DATE('%d-%b-%Y', WP_END_DATE),            SAFE_CAST(WP_END_DATE AS DATE))            AS WP_END_DATE,
          COALESCE(SAFE.PARSE_DATE('%d-%b-%Y', WP_RELEASE_DATE),        SAFE_CAST(WP_RELEASE_DATE AS DATE))        AS WP_RELEASE_DATE,
          COALESCE(SAFE.PARSE_DATE('%d-%b-%Y', WP_COMPLETION_DATE),     SAFE_CAST(WP_COMPLETION_DATE AS DATE))     AS WP_COMPLETION_DATE,
          COALESCE(SAFE.PARSE_DATE('%d-%b-%Y', WP_LAST_STATUS_DATE),    SAFE_CAST(WP_LAST_STATUS_DATE AS DATE))    AS WP_LAST_STATUS_DATE,
          SAFE_CAST(PLAN AS INT64) AS PLAN
        FROM `{t}`
    """,
    "Attendance_Data": """
        CREATE OR REPLACE TABLE `{t}` AS
        SELECT * EXCEPT(attendance_date, is_present, is_absent, is_missing_punch,
                        is_on_leave, is_remote, is_holiday, is_weekend),
          COALESCE(SAFE.PARSE_DATE('%m/%d/%Y', attendance_date),
                   SAFE.PARSE_DATE('%Y-%m-%d', attendance_date),
                   SAFE_CAST(attendance_date AS DATE))     AS attendance_date,
          SAFE_CAST(is_present AS INT64)        AS is_present,
          SAFE_CAST(is_absent AS INT64)         AS is_absent,
          SAFE_CAST(is_missing_punch AS INT64)  AS is_missing_punch,
          SAFE_CAST(is_on_leave AS INT64)       AS is_on_leave,
          SAFE_CAST(is_remote AS INT64)         AS is_remote,
          SAFE_CAST(is_holiday AS INT64)        AS is_holiday,
          SAFE_CAST(is_weekend AS INT64)        AS is_weekend
        FROM `{t}`
    """,
}

# Allocation_Data view over the freshly-loaded single Allocation_Data_Final
# (8-col Qlik feed: Row, project_id, employee_id, allocation_percent,
# emp_competency, Flag, Date, Data_Type). No Forecast_Flag in this feed -> all
# rows are actuals (synthesize Forecast_Flag=0 so the app's filter still works).
ALLOC_VIEW_SQL = """
CREATE OR REPLACE VIEW `{p}.{d}.Allocation_Data` AS
WITH u AS (
  SELECT
    CAST(project_id AS STRING)             AS project_id,
    CAST(employee_id AS STRING)            AS employee_id,
    SAFE_CAST(allocation_percent AS INT64) AS allocation_percent,
    emp_competency,
    Flag,
    0                                      AS Forecast_Flag,
    COALESCE(SAFE.PARSE_DATE('%m/%d/%Y', CAST(Date AS STRING)),
             SAFE.PARSE_DATE('%Y-%m-%d', CAST(Date AS STRING)),
             SAFE_CAST(Date AS DATE))      AS d
  FROM `{p}.{d}.Allocation_Data_Final`
),
emp AS (
  SELECT LTRIM(REGEXP_REPLACE(CAST(employee_code AS STRING), r'[^0-9]', ''), '0') AS k,
         ANY_VALUE(resource_name) AS nm
  FROM `{p}.{d}.Employee_Data`
  GROUP BY k
)
SELECT
  u.project_id, u.employee_id, emp.nm AS emp_name,
  u.allocation_percent, u.emp_competency, u.Flag, u.Forecast_Flag,
  u.d AS Date,
  EXTRACT(YEAR    FROM u.d) AS Year,
  EXTRACT(MONTH   FROM u.d) AS Month,
  EXTRACT(ISOWEEK FROM u.d) AS Week
FROM u
LEFT JOIN emp
  ON LTRIM(REGEXP_REPLACE(CAST(u.employee_id AS STRING), r'[^0-9]', ''), '0') = emp.k
"""


def _log(msg):
    print(f"[drive-sync] {msg}", flush=True)


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _sanitize_col(name: str) -> str:
    name = name.lstrip("﻿").strip()                 # strip BOM + whitespace
    name = re.sub(r"[^A-Za-z0-9_]", "_", name)           # BQ-safe identifier
    name = re.sub(r"_+", "_", name).strip("_")
    if not name:
        name = "col"
    if name[0].isdigit():
        name = "_" + name
    return name


def get_clients():
    creds, _ = google_auth_default(scopes=[
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/bigquery",
    ])
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    bq = bigquery.Client(project=PROJECT, credentials=creds)
    return drive, bq


def list_folder(drive, folder_id):
    files, page = [], None
    while True:
        resp = drive.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="nextPageToken, files(id, name, mimeType, size)",
            pageToken=page, pageSize=200,
            supportsAllDrives=True, includeItemsFromAllDrives=True,
        ).execute()
        files.extend(resp.get("files", []))
        page = resp.get("nextPageToken")
        if not page:
            break
    return files


def match_targets(files):
    by_key = {}
    for f in files:
        name = f["name"]
        if name.lower().endswith(".csv"):
            by_key.setdefault(_norm(name[:-4]), f)
    matched = [(by_key[k], t) for k, t in FILE_TARGETS if k in by_key]
    missing = [t for k, t in FILE_TARGETS if k not in by_key]
    return matched, missing


def download_bytes(drive, file) -> bytes:
    buf = io.BytesIO()
    dl = MediaIoBaseDownload(buf, drive.files().get_media(fileId=file["id"], supportsAllDrives=True),
                             chunksize=20 * 1024 * 1024)
    done = False
    while not done:
        _, done = dl.next_chunk()
    return buf.getvalue()


def header_columns(data: bytes):
    first = data.split(b"\n", 1)[0].decode("utf-8", "replace")
    return [_sanitize_col(c) for c in first.split(",")]


def load_csv(bq, table, data, columns):
    table_id = f"{PROJECT}.{DATASET}.{table}"
    schema = [bigquery.SchemaField(c, "STRING") for c in columns]
    job_config = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.CSV,
        schema=schema,
        skip_leading_rows=1,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        allow_quoted_newlines=True,
        allow_jagged_rows=True,
        max_bad_records=200,
        encoding="UTF-8",
    )
    bq.load_table_from_file(io.BytesIO(data), table_id, job_config=job_config).result()
    return bq.get_table(table_id).num_rows


def main():
    _log(f"start - project={PROJECT} dataset={DATASET} folder={FOLDER_ID} dry_run={DRY_RUN}")
    drive, bq = get_clients()
    files = list_folder(drive, FOLDER_ID)
    matched, missing = match_targets(files)
    if missing:
        _log(f"WARNING: no CSV matched for: {missing}")

    if DRY_RUN:
        for f, table in matched:
            data = download_bytes(drive, f)[:65536]
            cols = header_columns(data)
            _log(f"[{table}] <- '{f['name']}' ({len(cols)} cols): {cols}")
        _log("DRY_RUN done")
        return

    errors = []
    loaded_allocation = False
    for f, table in matched:
        try:
            data = download_bytes(drive, f)
            cols = header_columns(data)
            rows = load_csv(bq, table, data, cols)
            _log(f"loaded {table} <- '{f['name']}' ({len(data)} bytes, {rows} rows, {len(cols)} cols)")
            if table in FINALIZE_SQL:
                try:
                    bq.query(FINALIZE_SQL[table].format(t=f"{PROJECT}.{DATASET}.{table}")).result()
                    _log(f"finalized types for {table}")
                except Exception as fe:
                    _log(f"WARNING: finalize failed for {table} (left as STRING): {fe}")
            if table == "Allocation_Data_Final":
                loaded_allocation = True
        except Exception as e:
            errors.append(table)
            _log(f"ERROR loading {table} from '{f['name']}': {e}\n{traceback.format_exc()}")

    if loaded_allocation:
        try:
            bq.query(ALLOC_VIEW_SQL.format(p=PROJECT, d=DATASET)).result()
            _log("rebuilt Allocation_Data view over Allocation_Data_Final")
        except Exception as e:
            errors.append("Allocation_Data view")
            _log(f"ERROR rebuilding Allocation_Data view: {e}\n{traceback.format_exc()}")

    if errors:
        _log(f"FAILED for: {errors}")
        sys.exit(1)
    _log("done - all targets synced")


if __name__ == "__main__":
    main()
