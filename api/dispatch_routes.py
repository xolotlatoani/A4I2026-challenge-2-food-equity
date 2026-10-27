"""Offer-state dispatch routes (`/api/dispatches/*`), seed postings, and shared state helpers."""

from __future__ import annotations

import hashlib
import logging
import os
import re
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Body

from agent import state_tools
from agent.tools import _normalize_storage_requirement
from api.catalog import DATASET, METRO_TZ, OFFERS_CATALOG, PROJECT_ID
from state_service.pallets import estimate_pallets

logger = logging.getLogger(__name__)

dispatch_router = APIRouter()

_CATALOG_ORDER = ("deli", "spinach", "dairy", "bread")
_CATALOG_POSTING_IDS = {item["posting_id"] for item in OFFERS_CATALOG.values()}
_TRACK_LABELS = {
    "RETAIL": ("Grocery store", "Retail"),
    "FARM": ("Farm", "Farm surplus"),
    "ESSENTIALS": ("Essentials donor", "Essentials"),
}
_SEED_ROWS: list[dict[str, Any]] | None = None


def seed_rows() -> list[dict[str, Any]]:
    """BigQuery's seed postings outside the catalog, once per process; none when BigQuery doesn't answer."""
    global _SEED_ROWS
    if _SEED_ROWS is None:
        try:
            from google.cloud import bigquery

            rows = (
                bigquery.Client(project=PROJECT_ID)
                .query(f"SELECT * FROM `{PROJECT_ID}.{DATASET}.surplus_postings` ORDER BY posting_id")
                .result()
            )
            _SEED_ROWS = [dict(r) for r in rows if r["posting_id"] not in _CATALOG_POSTING_IDS]
        except Exception as exc:  # noqa: BLE001
            logger.info(
                "BigQuery unavailable (%s); the queue shows the catalog only.",
                type(exc).__name__,
            )
            return []
    return _SEED_ROWS


def live_requests() -> dict[int, dict[str, Any]] | None:
    """Each seed posting's live request from one call. None without an offer-state service."""
    if not state_tools.state_service_url():
        return None
    try:
        rows = state_tools.state_call(
            "GET",
            "/requests",
            params={
                "status": "all",
                "metro": os.environ.get("FOOD_RESCUE_METRO", "Atlanta"),
                "limit": 1000,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Offer-state service unavailable (%s); showing catalog status.", exc)
        return None
    live: dict[int, dict[str, Any]] = {}
    for r in sorted(rows, key=lambda r: r["received_at"]):
        if r["source_posting_id"] is not None and r["current_status"] in ("open", "fulfilled"):
            live[int(r["source_posting_id"])] = r
    return live


def seed_offer(row: dict[str, Any], request: dict[str, Any] | None) -> dict[str, Any]:
    """A seed posting as a console offer, in OFFERS_CATALOG's shape."""
    pid = row["posting_id"]
    storage = _normalize_storage_requirement(row["storage_state"], row["posting_text"])
    if request:
        pallets, quantity = float(request["pallets"]), request.get("quantity_text")
        guessed = request.get("pallets_source") == "guessed"
        hours = float(request["hours_remaining"])
    else:
        read = estimate_pallets(None, row["posting_text"])
        pallets, quantity, guessed = read.pallets, read.quantity_text, read.source == "guessed"
        hours = float(row["hours_remaining"] or row["hours_available"])
    donor, category = _TRACK_LABELS.get(row["track"], ("Donor", str(row["track"]).title()))
    mins = max(0, round(hours * 60))
    now = datetime.now(METRO_TZ)
    deadline = now + timedelta(minutes=mins)
    metro = os.environ.get("FOOD_RESCUE_METRO", "Atlanta")
    return {
        "offer_key": f"posting-{pid}",
        "posting_id": pid,
        "offer_code": f"OFFER #{metro[:3].upper()}-P{pid:02d}",
        "track": row["track"],
        "status": "Match ready",
        "status_type": "ready",
        "donor_label": f"{donor} · seed posting #{pid}",
        "posting_text": row["posting_text"],
        "category_tag": category,
        "storage_tag": {"refrigerated": "Keep cold", "frozen": "Keep frozen"}.get(
            storage, "Shelf-stable"
        ),
        "needs_cold": storage in ("refrigerated", "frozen"),
        "needs_frozen": storage == "frozen",
        "pallets": pallets,
        "pallets_label": (
            f"quantity unknown (~{pallets:g} pallet)"
            if guessed
            else f"about {pallets:g} pallet{'' if pallets == 1 else 's'}"
            + (f" ({quantity})" if quantity and "pallet" not in quantity else "")
        ),
        "hours_remaining": round(hours, 2),
        "countdown_label": (
            f"{mins // 1440}d {mins % 1440 // 60}h left"
            if mins >= 2880
            else f"{mins // 60}h {mins % 60:02d}m left"
        ),
        "dock_shutoff": deadline.strftime(
            "%I:%M %p" if deadline.date() == now.date() else "%a %I:%M %p"
        ).lstrip("0"),
        "brief_url": "match-brief-spinach.html",
        "pipeline": {
            "found_by_meaning": 0,
            "viable_count": 0,
            "ruled_out_count": 0,
            "recommended_count": 0,
        },
        "candidates": [],
        "split_plan": [],
        "ruled_out": [],
    }


def seed_offer_for(key: str) -> dict[str, Any] | None:
    """The seed offer a 'posting-<id>' key names, with its live request's clock, or None."""
    m = re.fullmatch(r"posting-(\d+)", key or "")
    row = next((r for r in seed_rows() if m and r["posting_id"] == int(m.group(1))), None)
    if row is None:
        return None
    request = None
    if state_tools.state_service_url():
        try:
            request = state_tools.find_live_request(source_posting_id=row["posting_id"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("Offer-state service unavailable (%s); using the posting's clock.", exc)
    return seed_offer(row, request)


def console_offer(payload: dict[str, Any]) -> dict[str, Any]:
    """The catalog offer a payload refers to, or a custom posting built from the payload."""
    key = str(payload.get("offer_key") or "").lower()
    code = str(payload.get("offer_code") or "")
    text = str(payload.get("posting_text") or "").strip()
    for item in OFFERS_CATALOG.values():
        if (
            (key and item["offer_key"] == key)
            or (code and item["offer_code"] == code)
            or (text and item["posting_text"].lower() == text.lower())
        ):
            return item
    seed = seed_offer_for(key)
    if seed is not None:
        return seed
    storage = str(payload.get("required_storage") or "") or _normalize_storage_requirement("", text)
    return {
        "posting_text": text,
        "offer_code": "CUSTOM-" + hashlib.sha1(text.lower().encode()).hexdigest()[:8].upper(),
        "posting_id": None,
        "needs_cold": storage in ("refrigerated", "frozen"),
        "needs_frozen": storage == "frozen",
        "pallets": float(payload.get("pallets") or payload.get("pallets_claimed") or 0.2),
        "hours_remaining": float(payload.get("hours_remaining") or 6.0),
    }


def console_request(offer: dict[str, Any], create: bool) -> dict[str, Any] | None:
    """The live request for a console offer; with create, saved on first use."""
    if not create:
        return state_tools.find_live_request(
            offer["offer_code"], source_posting_id=offer.get("posting_id")
        )
    storage = (
        "frozen"
        if offer["needs_frozen"]
        else "refrigerated"
        if offer["needs_cold"]
        else "shelf-stable"
    )
    return state_tools.create_request(
        metro=os.environ.get("FOOD_RESCUE_METRO", "Atlanta"),
        posting_text=offer["posting_text"],
        required_storage=storage,
        pallets=float(offer["pallets"]),
        deadline_hours=float(offer["hours_remaining"]),
        source_posting_id=offer.get("posting_id"),
        offer_code=offer["offer_code"],
        reuse_live=True,
    )


def offer_on(request: dict[str, Any], recipient_id: int) -> dict[str, Any] | None:
    return next((o for o in request["offers"] if o["recipient_id"] == recipient_id), None)


def dispatch_exclusions(offer: dict[str, Any]) -> tuple[list[int], list[dict[str, Any]]]:
    """Who the console's Match Brief leaves out for an offer, and who is tied up elsewhere."""
    if not state_tools.state_service_url():
        return [], []
    try:
        request = console_request(offer, create=False)
        if request is None:
            busy = state_tools.live_offers()
            return [int(b["recipient_id"]) for b in busy], [
                state_tools.dispatch_entry(b) for b in busy
            ]
        said_no = [
            o["recipient_id"]
            for o in request["offers"]
            if o["current_status"] in ("declined", "expired")
        ]
        excluded = set(said_no) | set(request["held_ids"]) | set(request["busy_ids"])
        return sorted(excluded), [
            state_tools.dispatch_entry(b) for b in request["busy_elsewhere"]
        ]
    except Exception as exc:  # noqa: BLE001
        logger.warning("Offer-state service unavailable (%s); matching without it.", exc)
        return [], []


def active_dispatches() -> dict[str, Any]:
    active = [state_tools.dispatch_entry(o) for o in state_tools.live_offers()]
    return {"status": "ok", "active_count": len(active), "active_dispatches": active}


def live_status(
    offer: dict[str, Any], live_reqs: dict[int, dict[str, Any]] | None = None
) -> dict[str, Any] | None:
    """Where a console offer stands in the offer-state service, in the console's words."""
    if not state_tools.state_service_url():
        return None
    if live_reqs is not None:
        request = live_reqs.get(offer["posting_id"])
    else:
        try:
            request = console_request(offer, create=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Offer-state service unavailable (%s); showing catalog status.", exc)
            return None
    offers = request["offers"] if request else []

    def names(statuses: tuple[str, ...]) -> str:
        return ", ".join(
            o["recipient_name"] or f"Recipient #{o['recipient_id']}"
            for o in offers
            if o["current_status"] in statuses
        )

    taken = [o for o in offers if o["current_status"] in ("accepted", "picked_up")]
    if taken and all(o["current_status"] == "picked_up" for o in taken):
        status_type, status = "donated", f"Picked up by {names(('picked_up',))}"
    elif taken:
        status_type, status = "accepted", f"Accepted by {names(('accepted', 'picked_up'))}"
    elif any(o["current_status"] == "sent" for o in offers):
        status_type, status = "awaiting", f"Offered to {names(('sent',))}, awaiting reply"
    elif offer.get("status_type") == "urgent":
        status_type, status = "urgent", "Needs a match"
    else:
        top = (offer.get("candidates") or [{}])[0].get("name")
        status_type, status = "ready", f"Match ready: {top}" if top else "Match ready"
    return {
        "status_type": status_type,
        "status": status,
        "request_id": str(request["request_id"]) if request else None,
        "offers": [
            {
                "recipient_id": o["recipient_id"],
                "recipient_name": o["recipient_name"],
                "status": o["current_status"],
                "offered_pallets": o["offered_pallets"],
                "reply_by": o["reply_by"],
            }
            for o in offers
        ],
    }


@dispatch_router.get("/api/dispatches")
def api_get_dispatches() -> dict[str, Any]:
    """Every recipient tied up by a live offer right now, across postings."""
    try:
        return active_dispatches()
    except Exception as exc:  # noqa: BLE001
        return state_tools.failure(exc) | {"active_count": 0, "active_dispatches": []}


@dispatch_router.post("/api/dispatches/claim")
def api_claim_dispatch(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Record an offer to a recipient, its acceptance, or its pickup."""
    recipient_id = int(payload.get("recipient_id") or 0)
    name = str(payload.get("recipient_name") or "") or f"Recipient #{recipient_id}"
    try:
        request = console_request(console_offer(payload), create=True)
        mine = offer_on(request, recipient_id)
        if mine is not None and mine["current_status"] in ("declined", "picked_up"):
            return {
                "status": "conflict",
                "detail": f"{name} already {mine['current_status'].replace('_', ' ')} {request['offer_code']}",
            }
        if mine is None or mine["current_status"] in ("withdrawn", "expired"):
            pallets = float(payload.get("pallets_claimed") or 0)
            unclaimed = float(request["unclaimed_pallets"])
            request = state_tools.state_call(
                "POST",
                "/offers",
                {
                    "request_id": str(request["request_id"]),
                    "recipient_id": recipient_id,
                    "recipient_name": name,
                    "offered_pallets": min(pallets, unclaimed) if pallets and unclaimed > 0 else None,
                    "actor": "console",
                },
            )
            mine = offer_on(request, recipient_id)
        target = payload.get("status")
        if target in ("accepted", "picked_up") and mine["current_status"] != "accepted":
            request = state_tools.state_call(
                "POST",
                f"/offers/{mine['offer_id']}/response",
                {"status": "accepted", "actor": "recipient"},
            )
            mine = offer_on(request, recipient_id)
        if target == "picked_up":
            request = state_tools.state_call(
                "POST",
                f"/offers/{mine['offer_id']}/response",
                {"status": "picked_up", "actor": "console"},
            )
            mine = offer_on(request, recipient_id)
        entry = state_tools.dispatch_entry(
            mine | {"posting_text": request["posting_text"], "offer_code": request["offer_code"]}
        )
        return {
            "status": "ok",
            "message": (
                f"{name} picked up their share of {request['offer_code']}."
                if target == "picked_up"
                else f"Locked {name} (ID {recipient_id}) for {request['offer_code']}. Other "
                "postings leave them out until this offer ends."
            ),
            "claimed_entry": entry,
            "active_dispatches": active_dispatches()["active_dispatches"],
        }
    except Exception as exc:  # noqa: BLE001
        return state_tools.failure(exc)


@dispatch_router.post("/api/dispatches/release")
def api_release_dispatch(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """A recipient said no (reason=declined) or the coordinator took the offer back (reason=withdrawn)."""
    recipient_id = int(payload.get("recipient_id") or 0)
    withdraw = payload.get("reason") == "withdrawn"
    try:
        if payload.get("offer_key") or payload.get("offer_code") or payload.get("posting_text"):
            request = console_request(console_offer(payload), create=True)
            if offer_on(request, recipient_id) is None:
                request = state_tools.state_call(
                    "POST",
                    "/offers",
                    {
                        "request_id": str(request["request_id"]),
                        "recipient_id": recipient_id,
                        "recipient_name": payload.get("recipient_name") or None,
                        "even_if_busy": True,
                        "actor": "console",
                    },
                )
            offers = [offer_on(request, recipient_id)]
        else:
            offers = state_tools.live_offers(recipient_id)
        released = 0
        for o in offers:
            status = "withdrawn" if withdraw or o["current_status"] == "accepted" else "declined"
            try:
                state_tools.state_call(
                    "POST",
                    f"/offers/{o['offer_id']}/response",
                    {
                        "status": status,
                        "reason_code": payload.get("reason_code") or None,
                        "reason_text": payload.get("reason_text") or None,
                        "actor": "console",
                    },
                )
                released += 1
            except state_tools.StateServiceError as exc:
                if exc.status != 409:
                    raise
        return {
            "status": "ok",
            "released_recipient_id": recipient_id,
            "removed_count": released,
            "active_dispatches": active_dispatches()["active_dispatches"],
        }
    except Exception as exc:  # noqa: BLE001
        return state_tools.failure(exc)
