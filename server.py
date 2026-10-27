"""Unified FastAPI Server for Challenge 2 — Resilient Food Equity & Surplus Broker.

Serves:
  1. Google ADK Web UI & Agent API (`/dev-ui/`, `/list-apps`, `/run`, `/run_sse`)
  2. Atlanta Coordinator Console UI (`/console/*`, `/queue.html`, `/match-brief-spinach.html`,
     `/match-brief-deli.html`, `/map.html`, `/app.js`, `/console-js/*`)
  3. Live BigQuery & Cloud SQL REST Endpoints (`api/`):
     - `api/console_routes.py`: `/api/queue`, `/api/match`, `/api/recipients`, `/api/equity-audit`, `/api/demo/reset`
     - `api/dispatch_routes.py`: `/api/dispatches`, `/api/dispatches/claim`, `/api/dispatches/release`
     - `api/pages_routes.py`: `/api/offers`, `/api/offers/{id}/invites/{recipient_id}/*`
     - `map_routes.py`: `/map/data`
"""

from __future__ import annotations

from fastapi import FastAPI
from google.adk.cli.fast_api import get_fast_api_app

from api.catalog import DATASET, EQUITY_AUDIT_DATA, FRONTEND_DIR, OFFERS_CATALOG, PROJECT_ID, REPO_ROOT, SERVICE_DATE
from api.console_routes import console_router
from api.dispatch_routes import dispatch_router
from api.pages_routes import pages_router
from api.static_routes import mount_frontend_assets
from map_routes import map_router

# Build the base ADK FastAPI application
app: FastAPI = get_fast_api_app(
    agents_dir=str(REPO_ROOT),
    web=True,
    allow_origins=["*"],
)

# Register modular API routers
app.include_router(console_router)
app.include_router(dispatch_router)
app.include_router(pages_router)
app.include_router(map_router)

# Mount frontend static assets and top-level HTML routes
mount_frontend_assets(app)

__all__ = [
    "app",
    "DATASET",
    "EQUITY_AUDIT_DATA",
    "FRONTEND_DIR",
    "OFFERS_CATALOG",
    "PROJECT_ID",
    "REPO_ROOT",
    "SERVICE_DATE",
]
