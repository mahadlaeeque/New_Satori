#!/bin/bash
# ────────────────────────────────────────────────────────────────
# Cognigrow SFML — Google Cloud Deployment Script
# Project: sfml-491907 | Region: us-central1 | Minimal cost setup
# Separate Cloud Run services + separate Cloud SQL DB from the
# existing cognigrow-api / cognigrow-web in satori-dwh.
# ────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration ──
PROJECT_ID="sfml-491907"
REGION="us-central1"
REPO="cognigrow-sfml"
BACKEND_SVC="cognigrow-sfml-api"
FRONTEND_SVC="cognigrow-sfml-web"
DB_INSTANCE="cognigrow-sfml-db"
DB_NAME="satori"
DB_USER="satori"

AR_HOST="${REGION}-docker.pkg.dev"
BACKEND_IMAGE="${AR_HOST}/${PROJECT_ID}/${REPO}/${BACKEND_SVC}"
FRONTEND_IMAGE="${AR_HOST}/${PROJECT_ID}/${REPO}/${FRONTEND_SVC}"
INSTANCE_CONN="${PROJECT_ID}:${REGION}:${DB_INSTANCE}"

echo "═══════════════════════════════════════════════"
echo "  Deploying Cognigrow SFML to Google Cloud"
echo "  Project: ${PROJECT_ID}  Region: ${REGION}"
echo "═══════════════════════════════════════════════"

# ── Step 1: Set project & enable APIs ──
echo -e "\n[1/8] Setting project and enabling APIs..."
gcloud config set project "${PROJECT_ID}"
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  compute.googleapis.com \
  aiplatform.googleapis.com \
  bigquery.googleapis.com

# ── Step 2: Create Artifact Registry repo ──
echo -e "\n[2/8] Creating Artifact Registry repository..."
gcloud artifacts repositories describe "${REPO}" \
  --location="${REGION}" 2>/dev/null || \
gcloud artifacts repositories create "${REPO}" \
  --repository-format=docker \
  --location="${REGION}" \
  --description="Cognigrow SFML container images"

# ── Step 3: Create Cloud SQL PostgreSQL instance (minimal cost) ──
echo -e "\n[3/8] Creating Cloud SQL instance (db-f1-micro)..."
if ! gcloud sql instances describe "${DB_INSTANCE}" --project="${PROJECT_ID}" 2>/dev/null; then
  gcloud sql instances create "${DB_INSTANCE}" \
    --database-version=POSTGRES_15 \
    --tier=db-f1-micro \
    --region="${REGION}" \
    --storage-size=10 \
    --storage-type=HDD \
    --availability-type=zonal \
    --assign-ip \
    --no-storage-auto-increase

  echo "  Waiting for instance to be ready..."
  gcloud sql instances describe "${DB_INSTANCE}" --format="value(state)"
else
  echo "  Instance ${DB_INSTANCE} already exists — skipping."
fi

# ── Step 4: Create database & user, store secrets ──
echo -e "\n[4/8] Setting up database, user, and secrets..."

# Create database (ignore error if exists)
gcloud sql databases create "${DB_NAME}" \
  --instance="${DB_INSTANCE}" 2>/dev/null || echo "  Database '${DB_NAME}' already exists."

# Generate passwords
DB_PASSWORD=$(openssl rand -base64 20 | tr -d '=/+' | head -c 24)
JWT_SECRET=$(openssl rand -base64 32)

# Create or update DB user
gcloud sql users create "${DB_USER}" \
  --instance="${DB_INSTANCE}" \
  --password="${DB_PASSWORD}" 2>/dev/null || \
gcloud sql users set-password "${DB_USER}" \
  --instance="${DB_INSTANCE}" \
  --password="${DB_PASSWORD}"

# Store in Secret Manager (create or update)
for secret_name in "cognigrow-sfml-db-password" "cognigrow-sfml-jwt-secret"; do
  gcloud secrets describe "${secret_name}" 2>/dev/null || \
  gcloud secrets create "${secret_name}" --replication-policy="automatic"
done

echo -n "${DB_PASSWORD}" | gcloud secrets versions add "cognigrow-sfml-db-password" --data-file=-
echo -n "${JWT_SECRET}" | gcloud secrets versions add "cognigrow-sfml-jwt-secret" --data-file=-

# TOTP secret-at-rest encryption key. CRITICAL: this must be generated ONCE
# and persisted across deploys. Rotating it makes every enrolled user's
# TOTP secret undecryptable (they'd all have to re-enroll via admin reset).
# So: create the secret only if it doesn't exist, and only seed an initial
# version on first creation.
if ! gcloud secrets describe "cognigrow-sfml-totp-key" 2>/dev/null; then
  echo "  Generating TOTP_ENCRYPTION_KEY (one-time)..."
  gcloud secrets create "cognigrow-sfml-totp-key" --replication-policy="automatic"
  # Fernet keys are 32 url-safe-base64 bytes (44 chars including padding).
  TOTP_KEY=$(python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" 2>/dev/null \
            || "D:/TMC/cognigrow-sfml/.venv/Scripts/python.exe" -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" 2>/dev/null \
            || openssl rand -base64 32 | tr '+/' '-_' | head -c 44)
  echo -n "${TOTP_KEY}" | gcloud secrets versions add "cognigrow-sfml-totp-key" --data-file=-
else
  echo "  TOTP_ENCRYPTION_KEY already exists in Secret Manager — leaving it untouched."
fi

# Retention-sweep shared secret. The Cloud Scheduler job posts to the
# /api/internal/retention-sweep endpoint with this token in an X-Cron-Token
# header — backend rejects requests without it. Generate-once-then-reuse,
# like the TOTP key (rotating would just break the next scheduled run until
# the scheduler picks up the new value).
if ! gcloud secrets describe "cognigrow-sfml-cron-token" 2>/dev/null; then
  echo "  Generating RETENTION_CRON_TOKEN (one-time)..."
  gcloud secrets create "cognigrow-sfml-cron-token" --replication-policy="automatic"
  CRON_TOKEN=$(openssl rand -base64 32 | tr -d '=/+' | head -c 40)
  echo -n "${CRON_TOKEN}" | gcloud secrets versions add "cognigrow-sfml-cron-token" --data-file=-
else
  CRON_TOKEN=$(gcloud secrets versions access latest --secret="cognigrow-sfml-cron-token")
  echo "  RETENTION_CRON_TOKEN already exists in Secret Manager — leaving it untouched."
fi

echo "  Secrets stored in Secret Manager."

# ── Step 5: Grant Cloud Run service account access ──
echo -e "\n[5/8] Configuring IAM permissions..."
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

# Cloud Build SAs need Artifact Registry writer + logging
for BUILD_SA in "${CLOUDBUILD_SA}" "${SA}"; do
  for BUILD_ROLE in "roles/artifactregistry.writer" "roles/logging.logWriter" "roles/storage.objectViewer"; do
    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="serviceAccount:${BUILD_SA}" \
      --role="${BUILD_ROLE}" \
      --condition=None \
      --quiet 2>/dev/null || true
  done
done

# Secret access
for secret in "cognigrow-sfml-db-password" "cognigrow-sfml-jwt-secret" "cognigrow-sfml-totp-key" "cognigrow-sfml-cron-token"; do
  gcloud secrets add-iam-policy-binding "${secret}" \
    --member="serviceAccount:${SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet 2>/dev/null || true
done

# Cloud SQL client
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA}" \
  --role="roles/cloudsql.client" \
  --quiet 2>/dev/null || true

# BigQuery access (read)
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA}" \
  --role="roles/bigquery.dataViewer" \
  --quiet 2>/dev/null || true
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA}" \
  --role="roles/bigquery.jobUser" \
  --quiet 2>/dev/null || true

# Vertex AI user
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA}" \
  --role="roles/aiplatform.user" \
  --quiet 2>/dev/null || true

echo "  IAM bindings configured."

# ── Step 6: Build & deploy backend ──
echo -e "\n[6/8] Building and deploying backend..."
gcloud builds submit ./backend --tag="${BACKEND_IMAGE}" --quiet

gcloud run deploy "${BACKEND_SVC}" \
  --image="${BACKEND_IMAGE}" \
  --region="${REGION}" \
  --platform=managed \
  --allow-unauthenticated \
  --add-cloudsql-instances="${INSTANCE_CONN}" \
  --set-env-vars="CLOUD_SQL_CONNECTION_NAME=${INSTANCE_CONN},DB_NAME=${DB_NAME},DB_USER=${DB_USER},VERTEX_PROJECT=${PROJECT_ID},VERTEX_LOCATION=${REGION}" \
  --set-secrets="DB_PASSWORD=cognigrow-sfml-db-password:latest,JWT_SECRET=cognigrow-sfml-jwt-secret:latest,TOTP_ENCRYPTION_KEY=cognigrow-sfml-totp-key:latest,RETENTION_CRON_TOKEN=cognigrow-sfml-cron-token:latest" \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3 \
  --timeout=3600 \
  --port=8080 \
  --quiet

BACKEND_URL=$(gcloud run services describe "${BACKEND_SVC}" \
  --region="${REGION}" --format="value(status.url)")
echo "  Backend deployed at: ${BACKEND_URL}"

# ── Step 7: Build & deploy frontend ──
echo -e "\n[7/8] Building and deploying frontend..."

# Build with backend URL baked in (write config to temp file — stdin heredoc
# is unreliable with gcloud on Windows Git Bash)
FRONTEND_BUILD_YAML=$(mktemp -t frontend-cloudbuild.XXXXXX.yaml)
cat > "${FRONTEND_BUILD_YAML}" <<CLOUDBUILD
steps:
  - name: 'gcr.io/cloud-builders/docker'
    args:
      - 'build'
      - '--build-arg'
      - 'VITE_API_BASE=${BACKEND_URL}'
      - '-t'
      - '${FRONTEND_IMAGE}'
      - '.'
images:
  - '${FRONTEND_IMAGE}'
CLOUDBUILD

gcloud builds submit ./frontend --config="${FRONTEND_BUILD_YAML}" --quiet
rm -f "${FRONTEND_BUILD_YAML}"

gcloud run deploy "${FRONTEND_SVC}" \
  --image="${FRONTEND_IMAGE}" \
  --region="${REGION}" \
  --platform=managed \
  --allow-unauthenticated \
  --memory=256Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=2 \
  --port=8080 \
  --quiet

FRONTEND_URL=$(gcloud run services describe "${FRONTEND_SVC}" \
  --region="${REGION}" --format="value(status.url)")
echo "  Frontend deployed at: ${FRONTEND_URL}"

# Cloud Run serves a service on TWO hostnames: the project-id form
# (returned by status.url, e.g. "<svc>-bicslpuxqq-uc.a.run.app") and the
# project-number form ("<svc>-<project_number>.<region>.run.app"). Allow both.
FRONTEND_URL_NUM="https://${FRONTEND_SVC}-${PROJECT_NUMBER}.${REGION}.run.app"

# ── Step 7b: Wire frontend origin into backend CORS allowlist ──
# Backend deploy in step 6 doesn't know the frontend URL yet, so we update
# ALLOWED_ORIGINS here. ^|^ delimiter lets the value itself contain commas.
echo -e "\n[7b/8] Updating backend ALLOWED_ORIGINS with frontend URL..."
gcloud run services update "${BACKEND_SVC}" \
  --region="${REGION}" \
  --update-env-vars="^|^ALLOWED_ORIGINS=${FRONTEND_URL},${FRONTEND_URL_NUM},http://localhost:5173,http://localhost:3000" \
  --quiet

# ── Step 7c: Retention sweep Cloud Scheduler job ──
# Runs daily at 03:15 UTC, POSTs to /api/internal/retention-sweep with the
# shared secret header. Idempotent: created on first run, updated on later
# runs so changes to the schedule/URL/token take effect without manual
# work. Requires Cloud Scheduler API; enabled here in case it wasn't.
echo -e "\n[7c/8] Configuring daily retention sweep (Cloud Scheduler)..."
gcloud services enable cloudscheduler.googleapis.com --quiet
RETENTION_JOB="cognigrow-sfml-retention-sweep"
if gcloud scheduler jobs describe "${RETENTION_JOB}" --location="${REGION}" 2>/dev/null; then
  gcloud scheduler jobs update http "${RETENTION_JOB}" \
    --location="${REGION}" \
    --schedule="15 3 * * *" \
    --time-zone="UTC" \
    --uri="${BACKEND_URL}/api/internal/retention-sweep" \
    --http-method=POST \
    --headers="X-Cron-Token=${CRON_TOKEN}" \
    --quiet || echo "  (retention job update skipped — check Cloud Scheduler console)"
else
  gcloud scheduler jobs create http "${RETENTION_JOB}" \
    --location="${REGION}" \
    --schedule="15 3 * * *" \
    --time-zone="UTC" \
    --uri="${BACKEND_URL}/api/internal/retention-sweep" \
    --http-method=POST \
    --headers="X-Cron-Token=${CRON_TOKEN}" \
    --description="Purge old login_log / data_access_log / chat_history rows per Satori retention policy." \
    --quiet || echo "  (retention job create skipped — check Cloud Scheduler console)"
fi
echo "  Retention sweep scheduled daily at 03:15 UTC."

# ── Step 8: Summary ──
echo -e "\n[8/8] Deployment complete!"
echo ""
echo "═══════════════════════════════════════════════"
echo "  Cognigrow SFML is live!"
echo ""
echo "  Frontend : ${FRONTEND_URL}"
echo "  Backend  : ${BACKEND_URL}"
echo "  Database : Cloud SQL '${DB_INSTANCE}' (PostgreSQL 15) in ${PROJECT_ID}"
echo ""
echo "  Default logins:"
echo "    Admin    : superadmin@sfml.com / blackmouse"
echo "    User     : admin@sfml.com / blackmouse"
echo "    User     : user@sfml.com / user123"
echo "═══════════════════════════════════════════════"
echo ""
echo "Estimated monthly cost (minimal traffic):"
echo "  Cloud SQL (db-f1-micro)  ~\$8/month"
echo "  Cloud Run (idle)         ~\$0/month (scale to zero)"
echo "  Artifact Registry        ~\$0/month (< 500MB free)"
echo "  Total                    ~\$8-10/month"
