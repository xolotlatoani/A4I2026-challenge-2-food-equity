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
  echo "ERROR: No GCP project configured. Run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

REGION="${GOOGLE_CLOUD_LOCATION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-food-rescue-agent}"
METRO="${FOOD_RESCUE_METRO:-Atlanta}"
BQ_DATASET="${BQ_DATASET:-a4i_food}"
BQ_LOCATION="${BQ_LOCATION:-US}"
EMBED_ENDPOINT="${EMBED_ENDPOINT:-gemini-embedding-2}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.8-flash}"
MCP_TOOLBOX_URL="${MCP_TOOLBOX_URL:-}"

echo "=================================================================="
echo "Deploying ${SERVICE_NAME} to Cloud Run"
echo "  Project        : ${PROJECT_ID}"
echo "  Region         : ${REGION}"
echo "  Metro          : ${METRO}"
echo "  BigQuery Data  : ${PROJECT_ID}.${BQ_DATASET} (${BQ_LOCATION})"
echo "  Embed Endpoint : ${EMBED_ENDPOINT}"
echo "  Gemini Model   : ${GEMINI_MODEL}"
echo "  Min Instances  : 1 (prevents cold-start delay during live demo)"
echo "=================================================================="

gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=5 \
  --memory=1Gi \
  --cpu=1 \
  --set-env-vars="GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION},FOOD_RESCUE_METRO=${METRO},BQ_DATASET=${BQ_DATASET},BQ_LOCATION=${BQ_LOCATION},EMBED_ENDPOINT=${EMBED_ENDPOINT},GEMINI_MODEL=${GEMINI_MODEL},MCP_TOOLBOX_URL=${MCP_TOOLBOX_URL}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"
echo
echo "Deployed successfully!"
echo "Live Endpoint URL: ${SERVICE_URL}"
