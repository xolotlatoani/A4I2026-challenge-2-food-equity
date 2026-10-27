#!/usr/bin/env bash
#
# Deploy the offer-state service to Cloud Run, private, and let the agent call it.
# Run state_service/setup_cloudsql.sh once first.
#
# Like the agent's deploy.sh, this needs no local Docker: Cloud Build reads
# state_service/Dockerfile remotely.
#
# Usage:
#   bash state_service/deploy.sh
#   STATE_SERVICE_NAME=food-rescue-state SERVICE_NAME=food-rescue-agent bash state_service/deploy.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  PROJECT_ID="qwiklabs-gcp-04-ef48e08bc216"
fi

REGION="${CLOUD_RUN_REGION:-us-central1}"
STATE_SERVICE_NAME="${STATE_SERVICE_NAME:-food-rescue-state}"
AGENT_SERVICE_NAME="${SERVICE_NAME:-food-rescue-agent}"
INSTANCE="${SQL_INSTANCE:-food-rescue-state}"
DB_NAME="${DB_NAME:-food_rescue}"
SA_NAME="${STATE_SERVICE_ACCOUNT:-food-rescue-state}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
DB_IAM_USER="${SA_EMAIL%.gserviceaccount.com}"

INSTANCE_CONNECTION_NAME="$(gcloud sql instances describe "${INSTANCE}" --project "${PROJECT_ID}" \
  --format='value(connectionName)')"

echo "=================================================================="
echo "Deploying ${STATE_SERVICE_NAME} to Cloud Run"
echo "  Project   : ${PROJECT_ID}"
echo "  Region    : ${REGION}"
echo "  Cloud SQL : ${INSTANCE_CONNECTION_NAME} / ${DB_NAME}"
echo "  Runs as   : ${SA_EMAIL}"
echo "=================================================================="

gcloud run deploy "${STATE_SERVICE_NAME}" \
  --source "${HERE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --service-account "${SA_EMAIL}" \
  --no-allow-unauthenticated \
  --min-instances="${STATE_MIN_INSTANCES:-1}" \
  --max-instances=3 \
  --memory=512Mi \
  --cpu=1 \
  --set-env-vars="INSTANCE_CONNECTION_NAME=${INSTANCE_CONNECTION_NAME},DB_NAME=${DB_NAME},DB_IAM_USER=${DB_IAM_USER}"

# Who may call it: the agent's service account (Cloud Run's default compute account unless the
# agent was deployed with another), and you, for local `adk web` runs against this service.
AGENT_SA="$(gcloud run services describe "${AGENT_SERVICE_NAME}" --project "${PROJECT_ID}" \
  --region "${REGION}" --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null || true)"
if [[ -z "${AGENT_SA}" ]]; then
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
  AGENT_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi
INVOKERS=("serviceAccount:${AGENT_SA}")
ME="$(gcloud config get-value account 2>/dev/null || true)"
if [[ -n "${ME}" ]]; then
  if [[ "${ME}" == *.gserviceaccount.com ]]; then
    INVOKERS+=("serviceAccount:${ME}")
  else
    INVOKERS+=("user:${ME}")
  fi
fi
for member in "${INVOKERS[@]}"; do
  gcloud run services add-iam-policy-binding "${STATE_SERVICE_NAME}" --project "${PROJECT_ID}" \
    --region "${REGION}" --member "${member}" --role roles/run.invoker >/dev/null
  echo "  Can call it: ${member}"
done

STATE_SERVICE_URL="$(gcloud run services describe "${STATE_SERVICE_NAME}" --project "${PROJECT_ID}" \
  --region "${REGION}" --format='value(status.url)')"
echo
echo "Deployed: ${STATE_SERVICE_URL}"
echo "Add STATE_SERVICE_URL=${STATE_SERVICE_URL} to .env for local runs."
echo "The agent's deploy.sh finds the service by name, so re-run bash deploy.sh to connect it."
