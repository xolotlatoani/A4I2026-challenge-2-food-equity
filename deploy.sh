#!/usr/bin/env bash
#
# Deploy the Resilient Food Equity & Surplus Broker ADK Agent to Google Cloud Run
# Owned by Person B (Agent Lane)
#
# NOTE ON DOCKER: You do NOT need Docker installed on your laptop or Cloud Shell.
# `gcloud run deploy --source .` uploads the code to Google Cloud Build, which
# reads our `Dockerfile` remotely in the cloud to build and run the container
# on Cloud Run (`--min-instances=1`).
#
# Usage:
#   bash deploy.sh
#   SERVICE_NAME=food-rescue-agent METRO=Atlanta bash deploy.sh

set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  PROJECT_ID="qwiklabs-gcp-04-ef48e08bc216"
fi

REGION="${CLOUD_RUN_REGION:-us-central1}"
VERTEX_LOCATION="${GOOGLE_CLOUD_LOCATION:-global}"
SERVICE_NAME="${SERVICE_NAME:-food-rescue-agent}"
METRO="${FOOD_RESCUE_METRO:-Atlanta}"
BQ_DATASET="${BIGQUERY_DATASET:-${BQ_DATASET:-a4i_food}}"
BQ_LOCATION="${BIGQUERY_LOCATION:-${BQ_LOCATION:-US}}"
EMBED_ENDPOINT="${EMBED_ENDPOINT:-gemini-embedding-2}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.8-flash}"
MCP_TOOLBOX_URL="${MCP_TOOLBOX_URL:-}"
ENABLE_MANAGED_BQ_MCP="${ENABLE_MANAGED_BQ_MCP:-true}"
# The offer-state service (state_service/deploy.sh), found by name when not given. Without it
# the agent still matches, but forgets every offer between conversations.
STATE_SERVICE_NAME="${STATE_SERVICE_NAME:-food-rescue-state}"
STATE_SERVICE_URL="${STATE_SERVICE_URL:-$(gcloud run services describe "${STATE_SERVICE_NAME}" \
  --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)' 2>/dev/null || true)}"

echo "=================================================================="
echo "Deploying ${SERVICE_NAME} to Cloud Run"
echo "  Project        : ${PROJECT_ID}"
echo "  Region         : ${REGION}"
echo "  Metro          : ${METRO}"
echo "  BigQuery Data  : ${PROJECT_ID}.${BQ_DATASET} (${BQ_LOCATION})"
echo "  Embed Endpoint : ${EMBED_ENDPOINT}"
echo "  Gemini Model   : ${GEMINI_MODEL}"
echo "  Managed BQ MCP : ${ENABLE_MANAGED_BQ_MCP}"
echo "  Offer state    : ${STATE_SERVICE_URL:-(none: offers are not saved)}"
echo "  Min Instances  : 1 (prevents cold-start delay during live demo)"
echo "=================================================================="

# ------------------------------------------------------------------
# Pre-flight BigQuery Database & View Check
# ------------------------------------------------------------------
echo "[1/4] Verifying BigQuery base tables (${PROJECT_ID}:${BQ_DATASET})..."
if ! bq --project_id="${PROJECT_ID}" show "${PROJECT_ID}:${BQ_DATASET}.recipients" >/dev/null 2>&1; then
  echo "  -> Base tables not found; running scripts/load.sh ${METRO,,}..."
  bash scripts/load.sh "${METRO,,}"
else
  echo "  -> Base tables present."
fi

echo "[2/4] Verifying BigQuery vector embeddings (${PROJECT_ID}:${BQ_DATASET}.recipient_embeddings)..."
if ! bq --project_id="${PROJECT_ID}" show "${PROJECT_ID}:${BQ_DATASET}.recipient_embeddings" >/dev/null 2>&1; then
  echo "  -> Building recipient_embeddings via sql/01_build_recipient_embeddings.sql..."
  bq --project_id="${PROJECT_ID}" --location="${BQ_LOCATION}" query --use_legacy_sql=false < sql/01_build_recipient_embeddings.sql
else
  echo "  -> recipient_embeddings present."
fi

echo "[3/4] Verifying geocoded census tracts & recipient_facts view..."
if ! bq --project_id="${PROJECT_ID}" show "${PROJECT_ID}:${BQ_DATASET}.recipient_tracts" >/dev/null 2>&1; then
  echo "  -> Running scripts/geocode_recipients.py..."
  python3 scripts/geocode_recipients.py
elif ! bq --project_id="${PROJECT_ID}" show "${PROJECT_ID}:${BQ_DATASET}.recipient_facts" >/dev/null 2>&1; then
  echo "  -> Creating recipient_facts view via sql/05_recipient_facts.sql..."
  bq --project_id="${PROJECT_ID}" --location="${BQ_LOCATION}" query --use_legacy_sql=false < sql/05_recipient_facts.sql
else
  echo "  -> recipient_tracts and recipient_facts present."
fi

echo "[4/4] Deploying unified ADK + Coordinator Console server to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=5 \
  --memory=1Gi \
  --cpu=1 \
  --set-env-vars="GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${VERTEX_LOCATION},FOOD_RESCUE_METRO=${METRO},BIGQUERY_DATASET=${BQ_DATASET},BQ_DATASET=${BQ_DATASET},BIGQUERY_LOCATION=${BQ_LOCATION},BQ_LOCATION=${BQ_LOCATION},EMBED_ENDPOINT=${EMBED_ENDPOINT},GEMINI_MODEL=${GEMINI_MODEL},MCP_TOOLBOX_URL=${MCP_TOOLBOX_URL},ENABLE_MANAGED_BQ_MCP=${ENABLE_MANAGED_BQ_MCP},STATE_SERVICE_URL=${STATE_SERVICE_URL}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"
echo
echo "Deployed successfully!"
echo "Live Endpoint URL: ${SERVICE_URL}"
