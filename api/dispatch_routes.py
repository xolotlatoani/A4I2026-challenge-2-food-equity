"""Offer-state dispatch routes (`/api/dispatches/*`) and shared state helpers."""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Any

from fastapi import APIRouter, Body

from agent import state_tools
from agent.tools import _normalize_storage_requirement
from api.catalog import OFFERS_CATALOG

logger = logging.getLogger(__name__)

dispatch_router = APIRouter()


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


def live_status(offer: dict[str, Any]) -> dict[str, Any] | None:
    """Where a console offer stands in the offer-state service, in the console's words."""
    if not state_tools.state_service_url():
        return None
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
