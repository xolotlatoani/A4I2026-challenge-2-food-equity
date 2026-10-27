# ==============================================================================
# WHY THIS DOCKERFILE EXISTS (No Local Docker Installation Required!)
# ==============================================================================
# 1. Local Development: You do NOT need Docker locally. Just run `adk web .`
#    directly in your Python environment or Google Cloud Shell.
# 2. Cloud Run Deployment: Google Cloud Run is a serverless container platform.
#    When you run `bash deploy.sh` (`gcloud run deploy --source .`), Google
#    Cloud uploads the repo and uses this Dockerfile REMOTELY in Google Cloud
#    Build to package our Python ADK agent, open CORS (`--allow_origins '*'`)
#    for the Frontend lane, and bind `adk web` to `$PORT` (8080) with
#    `--min-instances=1` so the live demo has zero cold-start latency.
# ==============================================================================

FROM python:3.11-slim

WORKDIR /app

# Install system dependencies if needed
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy repository contents (including agent/, sql/, and data/)
COPY . .

ENV PORT=8080
ENV PYTHONUNBUFFERED=1

EXPOSE 8080

# Launch the unified FastAPI server (serves both ADK Web UI at /dev-ui/ and Coordinator Console at /console/ + /api/*)
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080}"]
