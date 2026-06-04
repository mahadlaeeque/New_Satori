# Satori v2 — Cloud Run Hosting Runbook

This runbook bootstraps the **satori-v2** Cloud Run service, Cloud SQL Postgres database, and IAM plumbing it needs. Run it once per GCP project. After that, `cloudbuild.yaml` deploys every commit to `main` automatically.

## What you're creating

| Resource | Purpose |
| --- | --- |
| Cloud SQL Postgres instance `satori-v2-db` | Stores users, dashboards, audit logs, saved reports. |
| Cloud Run service `satori-v2` | Hosts the FastAPI backend + React frontend. |
| Service account `satori-runtime` | Identity the container runs as (BigQuery + Firestore + Cloud SQL + Secret Manager). |
| Secret Manager secret `satori-v2-jwt-secret` | Random JWT signing key for the auth system. |
| Artifact Registry repo `satori` | Container images (already exists if you set up Satori v1). |
| Cloud Build trigger | Auto-deploys on every push to `main`. |

## Prerequisites

- `gcloud` CLI authenticated as a Project Owner / Editor of `ai-vertex-mahad`.
- Artifact Registry repo `satori` in `us-central1` (already exists from Satori v1).
- Secret Manager secret `satori-gemini-api-key` already populated (from Satori v1).
- The new GitHub repo at `https://github.com/mahadlaeeque/New_Satori` connected as a Cloud Build source.

## One-time bootstrap

Run these in PowerShell, top to bottom. Idempotent — re-runs are safe.

### 1. Set variables

```powershell
$PROJECT_ID = "ai-vertex-mahad"
$REGION = "us-central1"
$SERVICE = "satori-v2"
$DB_INSTANCE = "satori-v2-db"
$DB_NAME = "satori"
$DB_USER = "satori"
$RUNTIME_SA = "satori-runtime"
$RUNTIME_SA_EMAIL = "$RUNTIME_SA@$PROJECT_ID.iam.gserviceaccount.com"

gcloud config set project $PROJECT_ID
gcloud config set run/region $REGION
```

### 2. Enable required APIs

```powershell
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firestore.googleapis.com bigquery.googleapis.com cloudtrace.googleapis.com sqladmin.googleapis.com servicenetworking.googleapis.com
```

### 3. Create the JWT signing secret

```powershell
$JWT_SECRET = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
echo $JWT_SECRET | gcloud secrets create satori-v2-jwt-secret --replication-policy="automatic" --data-file=-
```

If the secret already exists, add a new version:

```powershell
echo $JWT_SECRET | gcloud secrets versions add satori-v2-jwt-secret --data-file=-
```

### 4. Create Cloud SQL Postgres instance (~10 min — go grab coffee)

```powershell
gcloud sql instances create $DB_INSTANCE --database-version=POSTGRES_15 --tier=db-f1-micro --region=$REGION --root-password=temp-set-below
```

After the instance is up, set a proper postgres password and create the application user:

```powershell
$DB_PASSWORD = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})

# Save this password in Secret Manager so Cloud Run can read it.
echo $DB_PASSWORD | gcloud secrets create satori-v2-db-password --replication-policy="automatic" --data-file=-

# Create the application database + user
gcloud sql databases create $DB_NAME --instance=$DB_INSTANCE
gcloud sql users create $DB_USER --instance=$DB_INSTANCE --password=$DB_PASSWORD
```

### 5. Reuse / verify the runtime service account

The `satori-runtime` SA already exists from Satori v1 with BigQuery, Firestore, Secret Manager bindings. We need to add **Cloud SQL Client** so the container can connect to Postgres.

```powershell
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$RUNTIME_SA_EMAIL" --role="roles/cloudsql.client"

# Verify the existing bindings are still in place
gcloud projects get-iam-policy $PROJECT_ID --flatten="bindings[].members" --filter="bindings.members:$RUNTIME_SA_EMAIL" --format="table(bindings.role)"
```

You should see at minimum:
- roles/bigquery.dataViewer
- roles/bigquery.jobUser
- roles/datastore.user
- roles/cloudsql.client
- roles/cloudtrace.agent

### 6. Grant runtime SA access to the new secrets

```powershell
gcloud secrets add-iam-policy-binding satori-v2-jwt-secret --member="serviceAccount:$RUNTIME_SA_EMAIL" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding satori-v2-db-password --member="serviceAccount:$RUNTIME_SA_EMAIL" --role="roles/secretmanager.secretAccessor"
```

### 7. Grant Cloud Build SA the deploy roles

The Cloud Build service account in this project is `vertex-express@ai-vertex-mahad.iam.gserviceaccount.com`. It needs Cloud Run admin + the ability to act-as the runtime SA.

```powershell
$BUILD_SA = "vertex-express@$PROJECT_ID.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$BUILD_SA" --role="roles/run.admin"
gcloud iam service-accounts add-iam-policy-binding $RUNTIME_SA_EMAIL --member="serviceAccount:$BUILD_SA" --role="roles/iam.serviceAccountUser"
```

### 8. Connect the GitHub repo to Cloud Build

In the GCP Console: Cloud Build → Triggers → Connect Repository → GitHub → select `mahadlaeeque/New_Satori`. Approve the OAuth flow.

Then create the trigger:

```powershell
gcloud builds triggers create github --name="satori-v2-main-build" --repo-name="New_Satori" --repo-owner="mahadlaeeque" --branch-pattern="^main$" --build-config="cloudbuild.yaml" --included-files="**"
```

### 9. First deploy

Submit a manual build (auto-creates the Cloud Run service on first deploy):

```powershell
$SHORT_SHA = git rev-parse --short HEAD
gcloud builds submit --config=cloudbuild.yaml --substitutions=_TAG=$SHORT_SHA
```

This run takes 8–10 minutes the first time (frontend npm install isn't cached). Subsequent pushes will be ~4–5 min.

### 10. Set the database connection env vars

Once Cloud Run service exists, we need to point the container at Cloud SQL. The Cloud Build deploy step already includes `--add-cloudsql-instances`, but we need to set the DB env vars too:

```powershell
gcloud run services update $SERVICE --region=$REGION --update-env-vars="CLOUD_SQL_CONNECTION_NAME=$PROJECT_ID:$REGION:$DB_INSTANCE,DB_NAME=$DB_NAME,DB_USER=$DB_USER" --update-secrets="DB_PASSWORD=satori-v2-db-password:latest,JWT_SECRET=satori-v2-jwt-secret:latest,GEMINI_API_KEY=satori-gemini-api-key:latest"
```

### 11. Verify

```powershell
$URL = gcloud run services describe $SERVICE --region=$REGION --format="value(status.url)"
Write-Host "Satori v2 is live at: $URL"
Write-Host "Health: $URL/api/health"

curl.exe "$URL/api/health"
```

You should see something like:
```json
{"ok": true, "service": "Satori v2", "project": "ai-vertex-mahad", "dataset": "Satori_Project"}
```

Open `$URL` in your browser. You'll get the Satori v2 login screen. To create your first admin user:

```powershell
# Shell into the Postgres instance and seed an admin row
gcloud sql connect $DB_INSTANCE --user=$DB_USER --database=$DB_NAME

# (At the psql prompt — replace the email + bcrypt hash for your admin)
INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES ('admin@tmcltd.ai', '$2b$12$REPLACE_WITH_BCRYPT_HASH', 'TMC Admin', 'admin', true);
\q
```

To generate a bcrypt hash locally:
```powershell
pip install bcrypt
python -c "import bcrypt; print(bcrypt.hashpw(b'YourPasswordHere', bcrypt.gensalt()).decode())"
```

## Day-2 operations

### Tail logs
```powershell
gcloud run services logs read $SERVICE --region=$REGION --limit=100
```

### Roll back
```powershell
gcloud run services update-traffic $SERVICE --region=$REGION --to-revisions=<REVISION_NAME>=100
```

### Pause Cloud SQL when not in use (cost saving)
The `db-f1-micro` instance runs ~$10/month. To stop it overnight:
```powershell
gcloud sql instances patch $DB_INSTANCE --activation-policy=NEVER
```
Re-enable:
```powershell
gcloud sql instances patch $DB_INSTANCE --activation-policy=ALWAYS
```

## Known v1 limitations (rebuild before public launch)

- **`/ws/voice` is a stub** that returns a "pending rebuild" status. Text chat works fully; voice does not. Reconstructing the full Gemini Live audio proxy is a 1–2 day workstream.
- `/api/chat/history` exists but persisted history is not wired in v1 (user explicitly OK with this).
- `/api/reports/*` endpoints stub-return 501 — reports feature pending rebuild.
- `/api/admin/audit`, `/api/admin/retention-sweep`, `/api/admin/users/{id}/export` are stubs returning empty payloads.
- Some helper SQL strings in the chat tool descriptions still reference the old SAP dataset names — these are inert (the SYSTEM_PROMPT is authoritative and points to TMC) but should be tidied in a polish pass.

## Future: Vertex AI Agent Engine

When v1 is stable and demo-traffic-tested, lift the chat agent out of the FastAPI process and into a managed Vertex AI Agent Engine deployment. The text chat path in `main.py` becomes a thin adapter; chat/voice flows become a LangGraph graph; tools register through the Plugin Bus pattern. Estimated effort: 5–7 working days.
