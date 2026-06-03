#!/usr/bin/env python3
"""
Satori Drive → BigQuery sync pipeline.

Runs as a Cloud Run Job, triggered by Cloud Scheduler every 30 minutes.
Reads a fixed set of CSV files from a shared Google Drive folder and full-
refreshes the matching BigQuery tables in capability-agent-prod.Satori_Project,
then rebuilds the Allocation_Data compatibility view the app reads.

Auth: uses Application Default Credentials (the Cloud Run Job's attached service
account). That SA needs:
  - Drive read access to the folder (share the folder with the SA email, OR set
    the folder to "Anyone with the link → Viewer").
  - roles/bigquery.dataEditor + roles/bigquery.jobUser on the project.

Env:
  VERTEX_PROJECT   (default capability-agent-prod)
  VERTEX_DATASET   (default Satori_Project)
  DRIVE_FOLDER_ID  (default the shared folder in the request)
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

# The ONLY files we pull. Each entry: (name keywords matched against the Drive
# filename, lowercased+despaced; destination BigQuery table). First match wins.
FILE_TARGETS = [
    (("empdata", "employeedata", "emp_data"),          "Employee_Data"),
    (("projectmaster", "project_master"),               "Project_Master"),
    (("timesheet", "time_sheet"),                       "Timesheet_Data"),
    (("attendance",),                                   "Attendance_Data"),   # "Attendance_Satori"
    (("allocation",),                                   "Allocation_Data_Final"),
]

SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/bigquery",
]


def _log(msg):
    print(f"[drive-sync] {msg}", flush=True)


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def get_clients():
    creds, _ = google_auth_default(scopes=SCOPES)
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    bq = bigquery.Client(project=PROJECT, credentials=creds)
    return drive, bq


def list_folder(drive, folder_id):
    """All non-trashed files in the folder (handles shared drives + paging)."""
    files, page = [], None
    while True:
        resp = drive.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="nextPageToken, files(id, name, mimeType, modifiedTime, size)",
            pageToken=page, pageSize=200,
            supportsAllDrives=True, includeItemsFromAllDrives=True,
            orderBy="modifiedTime desc",
        ).execute()
        files.extend(resp.get("files", []))
        page = resp.get("nextPageToken")
        if not page:
            break
    return files


def match_targets(files):
    """Map each FILE_TARGETS entry to the best matching Drive file (most recently
    modified). Returns list of (file, table)."""
    chosen = {}
    for f in files:  # files already ordered newest-first
        nf = _norm(f["name"])
        for keywords, table in FILE_TARGETS:
            if table in chosen:
                continue
            if any(k in nf for k in keywords):
                chosen[table] = f
                break
    return [(chosen[t], t) for (_, t) in FILE_TARGETS if t in chosen], \
           [t for (_, t) in FILE_TARGETS if t not in chosen]


def download_csv_bytes(drive, file) -> bytes:
    """Download a CSV upload, or export a native Google Sheet as CSV."""
    fid = file["id"]
    if file["mimeType"] == "application/vnd.google-apps.spreadsheet":
        return drive.files().export(fileId=fid, mimeType="text/csv").execute()
    buf = io.BytesIO()
    req = drive.files().get_media(fileId=fid, supportsAllDrives=True)
    dl = MediaIoBaseDownload(buf, req, chunksize=10 * 1024 * 1024)
    done = False
    while not done:
        _, done = dl.next_chunk()
    return buf.getvalue()


def load_csv_to_table(bq, table, data_bytes):
    table_id = f"{PROJECT}.{DATASET}.{table}"
    job_config = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.CSV,
        skip_leading_rows=1,
        autodetect=True,                 # infer schema from header + sample
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,  # full refresh
        allow_quoted_newlines=True,
        allow_jagged_rows=True,
        max_bad_records=50,              # tolerate a few malformed rows, don't fail the run
        encoding="UTF-8",
    )
    job = bq.load_table_from_file(io.BytesIO(data_bytes), table_id, job_config=job_config)
    job.result()
    tbl = bq.get_table(table_id)
    return tbl.num_rows, [f.name for f in tbl.schema]


# The Allocation_Data view the app reads — rebuilt on top of the freshly-loaded
# single Allocation_Data_Final table. Tolerant of the Date column being either an
# Excel serial (INT) or a real date string. emp_name is dedup-joined (no fan-out).
_ALLOC_VIEW_SQL = """
CREATE OR REPLACE VIEW `{p}.{d}.Allocation_Data` AS
WITH u AS (
  SELECT
    CAST(project_id AS STRING)            AS project_id,
    CAST(employee_id AS STRING)           AS employee_id,
    SAFE_CAST(allocation_percent AS INT64) AS allocation_percent,
    emp_competency,
    Flag,
    SAFE_CAST(Forecast_Flag AS INT64)     AS Forecast_Flag,
    Date, Week, Year, Month, WeekYear_KEY
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
  COALESCE(
    SAFE.PARSE_DATE('%Y-%m-%d', CAST(u.Date AS STRING)),
    DATE_ADD(DATE '1899-12-30', INTERVAL SAFE_CAST(u.Date AS INT64) DAY)
  ) AS Date,
  u.Week, u.Year, u.Month, u.WeekYear_KEY
FROM u
LEFT JOIN emp
  ON LTRIM(REGEXP_REPLACE(CAST(u.employee_id AS STRING), r'[^0-9]', ''), '0') = emp.k
"""


def rebuild_allocation_view(bq):
    bq.query(_ALLOC_VIEW_SQL.format(p=PROJECT, d=DATASET)).result()


def main():
    _log(f"start — project={PROJECT} dataset={DATASET} folder={FOLDER_ID}")
    drive, bq = get_clients()

    files = list_folder(drive, FOLDER_ID)
    _log(f"folder has {len(files)} files: " + ", ".join(f["name"] for f in files[:25]))
    matched, missing = match_targets(files)
    if missing:
        _log(f"WARNING: no Drive file matched for: {missing}")

    errors = []
    loaded_allocation = False
    for f, table in matched:
        try:
            data = download_csv_bytes(drive, f)
            rows, cols = load_csv_to_table(bq, table, data)
            _log(f"loaded {table} <- '{f['name']}' ({len(data)} bytes, {rows} rows). cols={cols}")
            if table == "Allocation_Data_Final":
                loaded_allocation = True
        except Exception as e:
            errors.append(table)
            _log(f"ERROR loading {table} from '{f['name']}': {e}\n{traceback.format_exc()}")

    if loaded_allocation:
        try:
            rebuild_allocation_view(bq)
            _log("rebuilt Allocation_Data view over Allocation_Data_Final")
        except Exception as e:
            errors.append("Allocation_Data view")
            _log(f"ERROR rebuilding Allocation_Data view: {e}\n{traceback.format_exc()}")

    if errors:
        _log(f"FAILED for: {errors}")
        sys.exit(1)
    _log("done — all targets synced")


if __name__ == "__main__":
    main()
