# `data/` — CSV staging for BigQuery uploads

Drop CSV files here and run `python ../drive_sync.py` from the repo root
to push each one into BigQuery as a table.

## Quick usage

```bash
# from satori_SFML-main/
python drive_sync.py                       # upload every CSV in data/
python drive_sync.py --dry-run             # show what would happen, change nothing
python drive_sync.py --table Employee_Data # upload only data/Employee_Data.csv
python drive_sync.py --append              # add rows instead of replacing
```

## Where files end up

```
data/Employee_Data.csv      ->  capability-agent-prod.Satori_Project.Employee_Data
data/Sales Accounts.csv     ->  capability-agent-prod.Satori_Project.Sales_Accounts
data/sales-pipeline.csv     ->  capability-agent-prod.Satori_Project.sales_pipeline
```

Table name = CSV filename minus `.csv`, with anything that isn't
`[A-Za-z0-9_]` converted to `_` (so spaces and hyphens become
underscores).

## Auth

The script needs credentials with `bigquery.dataEditor` +
`bigquery.jobUser` on `capability-agent-prod`. Either:

```bash
# 1) Service-account key (recommended for headless runs)
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/sa-key.json"

# 2) Or your own gcloud identity (one-time)
gcloud auth application-default login
gcloud config set project capability-agent-prod
```

## Overriding the target

```bash
python drive_sync.py --project some-other-proj --dataset Some_Dataset
```

Or set `VERTEX_PROJECT` / `VERTEX_DATASET` env vars (same names the
backend uses — see `backend/main.py`).

## What's skipped

- Files starting with `.` or `_` (so this README, `.gitkeep`, scratch
  templates etc. don't get uploaded)
- Anything that isn't a `.csv`
- Subdirectories inside `data/` (keep CSVs flat)

## Schema

By default BigQuery autodetects the schema from your CSV header + a
sample of rows. If you need a column forced to a specific type (e.g.
`Employee_Code` as `STRING` even though it looks numeric), edit the
`SCHEMA_OVERRIDES` dict near the top of `drive_sync.py`.

## Write mode

Default is **REPLACE** (`WRITE_TRUNCATE`): re-uploading
`Employee_Data.csv` replaces the existing table. Use `--append` to add
rows to an existing table instead.
