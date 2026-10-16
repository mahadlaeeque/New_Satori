# How Satori connects to the Google Drive data folder

Every dashboard in Satori is ultimately fed by CSV files in one shared Google
Drive folder. This document answers two questions: **where the credentials
live**, and **how the connection is actually made**.

---

## The short answer

**There is no credential file, anywhere.** No service-account JSON key, no
OAuth client secret, no refresh token, nothing in `.env`, nothing in Secret
Manager, nothing in the repo.

The sync job authenticates as **its own attached service account** using
Application Default Credentials, which Google Cloud injects into the container
at runtime. The only thing a human ever grants is a **Drive folder share** —
the service account's email address is added as a Viewer on the folder, exactly
as you would share it with a colleague.

So if you are looking for "the Drive credentials", the answer is:

| Question | Answer |
|---|---|
| Where is the key file? | There isn't one. Identity comes from the runtime. |
| What grants BigQuery access? | Two IAM roles on the GCP project. |
| What grants Drive access? | A Viewer share on the folder, in Drive's own sharing dialog. |
| What is the identity? | `satori-drive-sync@capability-agent-prod.iam.gserviceaccount.com` |
| Which folder? | Drive folder id `12emVFtakumridd2QSjNm6W4Vd9hIFJ0K` |

---

## The connection chain

```
Cloud Scheduler   satori-drive-sync-30min      (*/30 * * * *)
      │  authenticates with --oauth-service-account-email
      ▼
Cloud Run Job     satori-drive-sync            (pipeline/drive_to_bq.py)
      │  runs AS the service account (--service-account)
      │
      ├──► Google Drive API v3   ── scope: drive.readonly
      │      access granted by a Viewer SHARE on the folder
      │
      └──► BigQuery              ── scope: bigquery
             access granted by IAM roles on the project
```

### 1. The job runs as a service account

`pipeline/deploy.sh` attaches the identity at deploy time:

```bash
gcloud run jobs deploy satori-drive-sync \
  --service-account satori-drive-sync@capability-agent-prod.iam.gserviceaccount.com \
  --set-env-vars "VERTEX_PROJECT=capability-agent-prod,VERTEX_DATASET=Satori_Project,DRIVE_FOLDER_ID=12emVFtakumridd2QSjNm6W4Vd9hIFJ0K"
```

### 2. The code asks the runtime for that identity

`pipeline/drive_to_bq.py`, `get_clients()`:

```python
creds, _ = google_auth_default(scopes=[
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/bigquery",
])
drive = build("drive", "v3", credentials=creds, cache_discovery=False)
bq    = bigquery.Client(project=PROJECT, credentials=creds)
```

`google.auth.default()` finds the attached service account through the
metadata server. Nothing is read from disk or from an environment variable.
The same call falls back to your personal `gcloud auth application-default
login` credentials when run locally, which is how the job is tested by hand.

### 3. Drive access is a share, not an IAM role

**This is the part that trips people up.** GCP IAM has no authority over Google
Drive — they are separate permission systems. Granting the service account
`roles/owner` on the project would still return an empty folder listing.

The folder is shared with `satori-drive-sync@capability-agent-prod.iam.gserviceaccount.com`
as **Viewer**, through the ordinary Drive "Share" dialog. `deploy.sh` cannot do
this and stops to say so:

```
>>> ACTION REQUIRED: share the Drive folder (Viewer) with: satori-drive-sync@...
>>> (or set the folder to 'Anyone with the link -> Viewer')
```

### 4. BigQuery access is IAM

```bash
roles/bigquery.dataEditor    # create/replace tables in the dataset
roles/bigquery.jobUser       # run load jobs
```

Plus `roles/run.invoker` on the job itself, so Cloud Scheduler is allowed to
trigger it.

---

## Complete inventory of what is provisioned

| # | Item | Value / role | Where it is set |
|---|---|---|---|
| 1 | Service account | `satori-drive-sync@capability-agent-prod.iam.gserviceaccount.com` | `deploy.sh` step 2 |
| 2 | BigQuery write | `roles/bigquery.dataEditor` | project IAM |
| 3 | BigQuery jobs | `roles/bigquery.jobUser` | project IAM |
| 4 | Scheduler → Job | `roles/run.invoker` | job IAM |
| 5 | **Drive folder** | **Viewer share on the folder** | **Drive share dialog (manual)** |
| 6 | OAuth scopes | `drive.readonly`, `bigquery` | requested in code |
| 7 | APIs enabled | drive, run, cloudscheduler, cloudbuild, artifactregistry | `deploy.sh` step 1 |
| 8 | Folder id | `DRIVE_FOLDER_ID` env var on the job | `deploy.sh` step 4 |

Items 1–4 and 6–8 are all in `pipeline/deploy.sh` and reproducible from it.
Item 5 exists only in Drive and is invisible to `gcloud` — it is the single
piece of this setup with no record in the repo.

---

## Reading from a Shared Drive

If the folder lives on a Shared Drive rather than someone's My Drive, both
API calls need the shared-drive flags or they return nothing:

```python
drive.files().list(
    q=f"'{folder_id}' in parents and trashed = false",
    fields="nextPageToken, files(id, name, mimeType, size, md5Checksum, modifiedTime)",
    supportsAllDrives=True, includeItemsFromAllDrives=True,
).execute()

drive.files().get_media(fileId=file["id"], supportsAllDrives=True)
```

An empty listing with no error is the classic symptom of either a missing share
or a missing `includeItemsFromAllDrives`. Check the share first.

---

## Verifying the live setup

None of the below is destructive.

```bash
PROJECT=capability-agent-prod
REGION=us-central1

# which identity is actually attached to the job right now
gcloud run jobs describe satori-drive-sync --region $REGION --project $PROJECT \
  --format="value(template.template.serviceAccount)"

# which folder id the job is pointed at
gcloud run jobs describe satori-drive-sync --region $REGION --project $PROJECT \
  --format="yaml(template.template.containers[0].env)"

# what roles that SA holds on the project
gcloud projects get-iam-policy $PROJECT \
  --flatten="bindings[].members" \
  --filter="bindings.members:satori-drive-sync@${PROJECT}.iam.gserviceaccount.com" \
  --format="value(bindings.role)"

# is the schedule live
gcloud scheduler jobs describe satori-drive-sync-30min --location $REGION --project $PROJECT

# last few runs and their logs
gcloud run jobs executions list --job satori-drive-sync --region $REGION --project $PROJECT
gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=satori-drive-sync' \
  --limit 50 --project $PROJECT
```

To confirm the **Drive share** specifically, open the folder in Drive and look
for the service-account address in the people list. There is no gcloud command
for this.

A dry run proves the whole read path without writing to BigQuery:

```bash
gcloud run jobs execute satori-drive-sync --region $REGION --project $PROJECT \
  --update-env-vars DRY_RUN=1 --wait
```

`DRY_RUN=1` lists the folder, downloads each CSV header and prints the detected
columns, then stops before loading.

---

## Rotating or re-pointing

* **Different folder** — update the `DRIVE_FOLDER_ID` env var on the job and
  share the new folder with the same service account.
* **Different service account** — create it, grant items 2–4, share the folder
  with the new address, then redeploy the job with `--service-account`.
* **Revoking access** — remove the Viewer share in Drive. The IAM roles are
  irrelevant to Drive and removing them will not stop the job reading files.

Because there is no key material, there is nothing to rotate on a schedule and
nothing that can leak through the repo. Keep it that way: if you ever find
yourself downloading a service-account JSON key for this, stop and use the
attached-identity path instead.

---

## A trap in this repo

There is a second file called **`drive_sync.py` at the repository root. It has
nothing to do with Google Drive.** Despite the name, it contains no Drive API
code at all — it is a manual helper that uploads CSVs from a local `./data/`
directory straight to BigQuery.

It is also the one script here that *does* accept a service-account key file:

```python
sa_key = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
```

If someone goes looking for "the Drive credentials" and lands on this file,
they will conclude a JSON key is required. It is not, for the Drive pipeline.
The Drive pipeline is `pipeline/drive_to_bq.py` and it uses no key.

---

## Known weakness worth fixing

Each run replaces every table with `WRITE_TRUNCATE` and there is **no row-count
check**. If an upstream export produces a short file, good data is silently
replaced with less data and the job still reports success.

This is not hypothetical: the timesheet feed is currently ~8% short of the Qlik
source in *every* month, and the pipeline had no way to notice — it loads
whatever the CSV contains, verbatim. See `docs/TIMESHEET_DASHBOARD.md`.

Suggested guard before the truncate: compare the incoming row count with the
current table and refuse the load (or stage it and alert) on a drop beyond a
few per cent.

---

## Reference

| File | Role |
|---|---|
| `pipeline/drive_to_bq.py` | the sync job — auth, Drive listing, download, BigQuery load |
| `pipeline/deploy.sh` | one-time provisioning: SA, roles, image, job, schedule |
| `pipeline/README.md` | operating notes and the file→table mapping |
| `pipeline/Dockerfile` | python:3.11-slim, three dependencies |
| `.env.example` | documents `DRIVE_FOLDER_ID` / `DRY_RUN` (Cloud Run Job only) |
