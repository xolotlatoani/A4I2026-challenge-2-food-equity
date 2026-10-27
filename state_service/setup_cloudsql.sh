#!/usr/bin/env bash
#
# One-time setup for the offer-state database: a Cloud SQL for PostgreSQL instance, its
# database, the service account the state service signs in as, and the tables.
#
# Safe to re-run: every step skips what already exists, and the schema step only adds.
# The schema step runs apply_schema.py on this machine, so first:
#   pip install -r state_service/requirements.txt
#
# Usage:
#   bash state_service/setup_cloudsql.sh
#   SQL_INSTANCE=food-rescue-state SQL_REGION=us-central1 bash state_service/setup_cloudsql.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  PROJECT_ID="qwiklabs-gcp-04-ef48e08bc216"
fi

REGION="${SQL_REGION:-${CLOUD_RUN_REGION:-us-central1}}"
INSTANCE="${SQL_INSTANCE:-food-rescue-state}"
DB_NAME="${DB_NAME:-food_rescue}"
SA_NAME="${STATE_SERVICE_ACCOUNT:-food-rescue-state}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
DB_IAM_USER="${SA_EMAIL%.gserviceaccount.com}"   # Postgres IAM users drop this suffix
PYTHON="${PYTHON:-python3}"

echo "=================================================================="
echo "Setting up offer-state Cloud SQL"
echo "  Project  : ${PROJECT_ID}"
echo "  Instance : ${INSTANCE} (${REGION})"
echo "  Database : ${DB_NAME}"
echo "  Signs in : ${SA_EMAIL}"
echo "=================================================================="

gcloud services enable sqladmin.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com --project "${PROJECT_ID}"

if ! gcloud sql instances describe "${INSTANCE}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Creating instance ${INSTANCE}; this takes about 10 minutes..."
  # The smallest shared-core tier, which only the Enterprise edition offers, is plenty for a
  # few writes a minute.
  gcloud sql instances create "${INSTANCE}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --database-version=POSTGRES_16 \
    --edition=ENTERPRISE \
    --tier=db-f1-micro \
    --storage-size=10 \
    --database-flags=cloudsql.iam_authentication=on
fi

if ! gcloud sql databases describe "${DB_NAME}" --instance "${INSTANCE}" \
     --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud sql databases create "${DB_NAME}" --instance "${INSTANCE}" --project "${PROJECT_ID}"
fi

if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" --project "${PROJECT_ID}" \
    --display-name "Food rescue offer-state service"
fi
for role in roles/cloudsql.client roles/cloudsql.instanceUser; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${SA_EMAIL}" --role "${role}" --condition=None --quiet >/dev/null
done

if ! gcloud sql users list --instance "${INSTANCE}" --project "${PROJECT_ID}" \
     --format='value(name)' | grep -qx "${DB_IAM_USER}"; then
  gcloud sql users create "${DB_IAM_USER}" --instance "${INSTANCE}" --project "${PROJECT_ID}" \
    --type=cloud_iam_service_account
fi

# The tables are created as the built-in postgres user, which owns the schema. Its password is
# set fresh on every run and never written down: run this script again to change the schema.
ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"
gcloud sql users set-password postgres --instance "${INSTANCE}" --project "${PROJECT_ID}" \
  --password "${ADMIN_PASSWORD}" >/dev/null
INSTANCE_CONNECTION_NAME="$(gcloud sql instances describe "${INSTANCE}" --project "${PROJECT_ID}" \
  --format='value(connectionName)')"

INSTANCE_CONNECTION_NAME="${INSTANCE_CONNECTION_NAME}" DB_NAME="${DB_NAME}" \
  DB_IAM_USER="${DB_IAM_USER}" DB_ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
  "${PYTHON}" "${HERE}/apply_schema.py"

echo
echo "Cloud SQL is ready: ${INSTANCE_CONNECTION_NAME}"
echo "Next: bash state_service/deploy.sh"
