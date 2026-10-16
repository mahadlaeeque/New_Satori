#!/usr/bin/env bash
# One-time setup for the Satori Drive→BigQuery sync pipeline.
# Run AFTER `gcloud auth login` (+ application-default) and AFTER the Drive
# folder has been shared (Viewer) with the service account created in step 2.
set -euo pipefail

PROJECT=capability-agent-prod
REGION=us-central1
REPO=satori                       # existing Artifact Registry repo (holds satori-v2)
SA_NAME=satori-drive-sync
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
FOLDER_ID=12emVFtakumridd2QSjNm6W4Vd9hIFJ0K
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/drive-sync:latest"

# 1) APIs
gcloud services enable drive.googleapis.com run.googleapis.com \
  cloudscheduler.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com --project="$PROJECT"

# 2) Service account + BigQuery roles
gcloud iam service-accounts create "$SA_NAME" \
  --display-name="Satori Drive -> BigQuery sync" --project="$PROJECT" || true
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA}" --role="roles/bigquery.dataEditor" --condition=None
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA}" --role="roles/bigquery.jobUser" --condition=None
echo ">>> ACTION REQUIRED: share the Drive folder (Viewer) with: ${SA}"
echo ">>> (or set the folder to 'Anyone with the link -> Viewer')"

# 3) Build the job image
gcloud builds submit pipeline --tag "$IMAGE" --project="$PROJECT"

# 4) Cloud Run Job
#    Reverse geocoding of punch cells (geocode_cells.py) runs inside this job.
#    Default provider is OpenStreetMap Nominatim (no key, throttled to 1 req/s,
#    GEOCODE_CONTACT is the address shown in its User-Agent as its policy asks).
#    To use Google instead add GEOCODE_PROVIDER=google,MAPS_API_KEY=<key> to the
#    env list above (Geocoding API enabled on the project; results re-resolve
#    every 30 days per Google's caching terms).
gcloud run jobs deploy "$SA_NAME" \
  --image "$IMAGE" --region "$REGION" --project "$PROJECT" \
  --service-account "$SA" \
  --set-env-vars "VERTEX_PROJECT=${PROJECT},VERTEX_DATASET=Satori_Project,DRIVE_FOLDER_ID=${FOLDER_ID},GEOCODE_CONTACT=${GEOCODE_CONTACT:-satori@tmcltd.com}" \
  --max-retries 1 --task-timeout 1800s --memory 1Gi

# 5) Let the SA trigger the job, then schedule it every 30 minutes
gcloud run jobs add-iam-policy-binding "$SA_NAME" --region "$REGION" --project "$PROJECT" \
  --member="serviceAccount:${SA}" --role="roles/run.invoker"

gcloud scheduler jobs create http "${SA_NAME}-30min" \
  --location "$REGION" --project "$PROJECT" \
  --schedule "*/30 * * * *" \
  --uri "https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${SA_NAME}:run" \
  --http-method POST \
  --oauth-service-account-email "$SA" \
  || gcloud scheduler jobs update http "${SA_NAME}-30min" \
       --location "$REGION" --project "$PROJECT" --schedule "*/30 * * * *"

# 6) Kick off one run now to validate
gcloud run jobs execute "$SA_NAME" --region "$REGION" --project "$PROJECT" --wait
echo "Done. Logs: gcloud run jobs executions list --job=${SA_NAME} --region=${REGION} --project=${PROJECT}"
