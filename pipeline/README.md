# Satori Drive → BigQuery sync pipeline

Keeps `capability-agent-prod.Satori_Project` in sync with a shared Google Drive
folder, every **30 minutes**.

## What it does

```
Cloud Scheduler (*/30 * * * *)
        │  triggers
        ▼
Cloud Run Job  satori-drive-sync   (pipeline/drive_to_bq.py)
        │  1. list the Drive folder
        │  2. pick the 5 target files by name
        │  3. download each CSV
        │  4. load → BigQuery (WRITE_TRUNCATE = full refresh)
        │  5. rebuild the Allocation_Data view
        ▼
BigQuery tables  ← the Satori app reads these (chat, dashboards, reports, Availability)
```

### File → table mapping
| Drive file (matched by name) | BigQuery table |
|---|---|
| Emp Data | `Employee_Data` |
| Project Master | `Project_Master` |
| Time Sheet | `Timesheet_Data` |
| Attendance_Satori | `Attendance_Data` |
| Allocation | `Allocation_Data_Final` → `Allocation_Data` view rebuilt on top |

Matching is by a normalised (lowercase, no spaces/punctuation) substring of the
filename, and picks the **most recently modified** match — so renames like
"Time Sheet (1).csv" still resolve.

## Refresh semantics
- Every run **fully replaces** each table from the current file (`WRITE_TRUNCATE`),
  so BigQuery always mirrors the latest Drive contents — no drift, no dedupe needed.
- The `Allocation_Data` view (what the app queries) is rebuilt each run on top of
  the freshly-loaded `Allocation_Data_Final`. It converts the Excel-serial (or
  ISO) `Date` to a real DATE and joins in `emp_name` — so the app needs no change.
- Schema is auto-detected from each CSV header. A few bad rows are tolerated
  (`max_bad_records=50`) so one malformed line never blocks a refresh.

## One-time setup
1. `gcloud auth login` and `gcloud auth application-default login`.
2. Run `pipeline/deploy.sh` (creates the SA, builds the image, deploys the Cloud
   Run Job, schedules it, runs once).
3. **Share the Drive folder (Viewer) with** `satori-drive-sync@capability-agent-prod.iam.gserviceaccount.com`
   — or set the folder to "Anyone with the link → Viewer".

## Operate
```bash
# run on demand
gcloud run jobs execute satori-drive-sync --region us-central1 --project capability-agent-prod --wait
# recent runs
gcloud run jobs executions list --job satori-drive-sync --region us-central1 --project capability-agent-prod
# logs of the last run
gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=satori-drive-sync' --limit 50 --project capability-agent-prod
# change cadence
gcloud scheduler jobs update http satori-drive-sync-30min --schedule "*/30 * * * *" --location us-central1 --project capability-agent-prod
```

## Notes / tuning
- If a CSV's columns differ from what a view/feature expects, the first run's log
  prints the detected columns per table — adjust the view / a SCHEMA_OVERRIDES map then.
- Job timeout is 30 min and memory 1Gi; bump in `deploy.sh` if the Allocation CSV grows.
