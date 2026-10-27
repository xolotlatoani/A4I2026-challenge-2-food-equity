"""Static HTML and JavaScript asset routes for the Coordinator Console & Partner Pages."""

from __future__ import annotations

from fastapi import APIRouter, FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api.catalog import FRONTEND_DIR

static_router = APIRouter()


@static_router.get("/queue.html", include_in_schema=False)
def serve_queue() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "queue.html")


@static_router.get("/match-brief-spinach.html", include_in_schema=False)
def serve_spinach() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "match-brief-spinach.html")


@static_router.get("/match-brief-deli.html", include_in_schema=False)
def serve_deli() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "match-brief-deli.html")


@static_router.get("/grocer-post.html", include_in_schema=False)
def serve_grocer_post() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "grocer-post.html")


@static_router.get("/pantry-offer.html", include_in_schema=False)
def serve_pantry_offer() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "pantry-offer.html")


@static_router.get("/driver-request.html", include_in_schema=False)
def serve_driver_request() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "driver-request.html")


@static_router.get("/app.js", include_in_schema=False)
def serve_app_js() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "app.js", media_type="application/javascript")


@static_router.get("/grocer.js", include_in_schema=False)
def serve_grocer_js() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "grocer.js", media_type="application/javascript")


@static_router.get("/pantry.js", include_in_schema=False)
def serve_pantry_js() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "pantry.js", media_type="application/javascript")


@static_router.get("/driver.js", include_in_schema=False)
def serve_driver_js() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "driver.js", media_type="application/javascript")


@static_router.get("/map.html", include_in_schema=False)
def serve_map() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "map.html")


@static_router.get("/console-js/{filename}", include_in_schema=False)
def serve_console_module(filename: str) -> FileResponse:
    target = (FRONTEND_DIR / "console" / filename).resolve()
    if not str(target).startswith(str((FRONTEND_DIR / "console").resolve())) or not target.exists():
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(target, media_type="application/javascript")


def mount_frontend_assets(app: FastAPI) -> None:
    """Mount `/console`, `/console-js`, and `/map` static directories and HTML page routes."""
    app.include_router(static_router)
    if (FRONTEND_DIR / "console").exists():
        app.mount(
            "/console-js",
            StaticFiles(directory=str(FRONTEND_DIR / "console")),
            name="console_js",
        )
    if FRONTEND_DIR.exists():
        app.mount("/console", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="console")
    if (FRONTEND_DIR / "map").exists():
        app.mount("/map", StaticFiles(directory=str(FRONTEND_DIR / "map")), name="map_assets")
