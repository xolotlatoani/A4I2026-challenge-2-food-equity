"""Grocer and Pantry portal routes (`/api/offers/*`), over the shared offer-state service."""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from agent import state_tools
from agent.tools import _infer_food_item, _recipient_facts
from api.catalog import METRO, METRO_TZ, OFFERS_CATALOG
from api.dispatch_routes import console_request, offer_on, seed_offer_for

pages_router = APIRouter()

_INVITE_STATUS = {
    "sent": "offered",
    "expired": "expired",
    "accepted": "accepted",
    "picked_up": "accepted",
    "declined": "declined",
    "withdrawn": "expired",
}
_KEEP = {
    "refrigerated": " It has to go straight into a fridge.",
    "frozen": " It has to go straight into a freezer.",
}


class GrocerPost(BaseModel):
    store_id: str
    donor_label: str | None = None
    pickup_point: str | None = None
    posting_text: str = Field(min_length=1)
    storage: Literal["refrigerated", "frozen", "shelf-stable"]
    must_leave_by: datetime
    quantity_text: str | None = None


class InviteAnswer(BaseModel):
    decision: Literal["accept", "decline"]
    reason: Literal["no_capacity_today", "closed", "wrong_food", "other"] | None = None


def _page_error(exc: Exception) -> JSONResponse:
    """A failure as the pages read it."""
    if isinstance(exc, state_tools.StateServiceError):
        if not state_tools.state_service_url():
            return JSONResponse(status_code=501, content={"detail": exc.detail})
        if exc.status:
            return JSONResponse(status_code=exc.status, content={"detail": exc.detail})
    return JSONResponse(status_code=503, content={"detail": f"offer-state service unavailable: {exc}"})


def _page_request(offer_id: str) -> dict[str, Any]:
    """A request by its id, or by a console offer key ('deli', 'posting-5')."""
    item = OFFERS_CATALOG.get(offer_id.lower()) or seed_offer_for(offer_id.lower())
    if item is not None:
        request = console_request(item, create=False)
        if request is None:
            raise state_tools.StateServiceError(404, f"{item['offer_code']} has no live request")
        return request
    try:
        UUID(offer_id)
    except ValueError:
        raise state_tools.StateServiceError(404, f"no offer {offer_id}") from None
    return state_tools.get_request_state(offer_id)


def _grocer_offer(r: dict[str, Any]) -> dict[str, Any]:
    """A request as the grocer page tracks it."""
    taken = [o for o in r["offers"] if o["current_status"] in ("accepted", "picked_up")]
    if taken and all(o["current_status"] == "picked_up" for o in taken):
        status = "picked_up"
    elif taken:
        status = "matched"
    elif r["current_status"] in ("expired", "cancelled"):
        status = "expired"
    else:
        status = "posted"
    return {
        "offer_id": str(r["request_id"]),
        "offer_code": r["offer_code"],
        "posted_at": r["received_at"],
        "store_id": r.get("store_id"),
        "donor_label": r["donor_name"],
        "pickup_point": r.get("pickup_point"),
        "posting_text": r["posting_text"],
        "storage": r["required_storage"],
        "must_leave_by": r["deadline_at"],
        "quantity_text": r.get("quantity_text"),
        "status": status,
        "matched_at": min((o["responded_at"] for o in taken if o["responded_at"]), default=None),
        "recipient_name": ", ".join(
            o["recipient_name"] or f"Recipient #{o['recipient_id']}" for o in taken
        )
        or None,
        "driver_assigned_at": None,
        "driver_first_name": None,
        "picked_up_at": max(
            (o["picked_up_at"] for o in taken if o.get("picked_up_at")), default=None
        )
        if status == "picked_up"
        else None,
    }


def _invite(r: dict[str, Any], o: dict[str, Any]) -> dict[str, Any]:
    """One pantry's offer as the pantry page shows it."""
    name = o["recipient_name"]
    if not name:
        try:
            name = _recipient_facts([o["recipient_id"]]).get(o["recipient_id"], {}).get("name")
        except Exception:  # noqa: BLE001
            name = None
    pallets = float(o["offered_pallets"])
    donor = r["donor_name"] or ""
    first_clause = r["posting_text"].split(",")[0].strip()
    return {
        "offer_id": str(r["request_id"]),
        "offer_code": r["offer_code"],
        "recipient_id": o["recipient_id"],
        "recipient_name": name,
        "item_title": first_clause[:1].upper() + first_clause[1:],
        "donor_area": donor.split("·")[-1].strip() if "·" in donor else None,
        "posting_text": r["posting_text"],
        "storage": r["required_storage"],
        "must_leave_by": r["deadline_at"],
        "quantity_text": r.get("quantity_text"),
        "pallets": pallets,
        "tags": [],
        "why_you": None,
        "delivery_note": f"It waits at {r['pickup_point']}." if r.get("pickup_point") else None,
        "space_note": f"About {pallets:g} pallet{'' if pallets == 1 else 's'}."
        + _KEEP.get(r["required_storage"], ""),
        "sent_at": o["sent_at"],
        "respond_by": o["reply_by"],
        "status": _INVITE_STATUS[o["current_status"]],
        "decline_reason": o["reason_code"] if o["current_status"] == "declined" else None,
        "responded_at": o["responded_at"],
    }


@pages_router.post("/api/offers", status_code=201)
def api_post_grocer_offer(body: GrocerPost) -> Any:
    """A grocer posts surplus: saved as a request, which the agent and the console then match."""
    if body.must_leave_by.tzinfo is None:
        return JSONResponse(status_code=422, content={"detail": "must_leave_by needs a time zone"})
    hours = (body.must_leave_by - datetime.now(timezone.utc)).total_seconds() / 3600
    if hours <= 0:
        return JSONResponse(
            status_code=422,
            content={"detail": "That time has already passed. Pick a later one."},
        )
    try:
        request = state_tools.create_request(
            metro=METRO,
            posting_text=body.posting_text,
            required_storage=body.storage,
            deadline_hours=hours,
            quantity_text=body.quantity_text,
            donor_name=body.donor_label,
            store_id=body.store_id,
            pickup_point=body.pickup_point,
            food_item=_infer_food_item(body.posting_text),
            offer_code=f"OFFER #{METRO[:3].upper()}-{secrets.token_hex(2).upper()}",
        )
    except Exception as exc:  # noqa: BLE001
        return _page_error(exc)
    return _grocer_offer(request)


@pages_router.get("/api/offers")
def api_list_grocer_offers(store: str = Query(..., description="The grocer page's store_id")) -> Any:
    """One store's posts from today, newest first."""
    try:
        rows = state_tools.state_call(
            "GET",
            "/requests",
            params={"status": "all", "metro": METRO, "store_id": store, "limit": 200},
        )
    except Exception as exc:  # noqa: BLE001
        return _page_error(exc)
    today = datetime.now(METRO_TZ).date()
    todays = [
        r
        for r in rows
        if datetime.fromisoformat(r["received_at"]).astimezone(METRO_TZ).date() == today
    ]
    todays.sort(key=lambda r: r["received_at"], reverse=True)
    return {"offers": [_grocer_offer(r) for r in todays]}


@pages_router.get("/api/offers/{offer_id}")
def api_get_grocer_offer(offer_id: str) -> Any:
    try:
        return _grocer_offer(_page_request(offer_id))
    except Exception as exc:  # noqa: BLE001
        return _page_error(exc)


@pages_router.get("/api/offers/{offer_id}/invites/{recipient_id}")
def api_get_invite(offer_id: str, recipient_id: int) -> Any:
    """What one pantry is being offered. 404 when it was never offered this one."""
    try:
        request = _page_request(offer_id)
        offer = offer_on(request, recipient_id)
        if offer is None:
            return JSONResponse(
                status_code=404,
                content={
                    "detail": f"{request['offer_code'] or 'this offer'} was not offered to recipient {recipient_id}"
                },
            )
        return _invite(request, offer)
    except Exception as exc:  # noqa: BLE001
        return _page_error(exc)


@pages_router.post("/api/offers/{offer_id}/invites/{recipient_id}/response")
def api_answer_invite(offer_id: str, recipient_id: int, body: InviteAnswer) -> Any:
    """A pantry accepts or declines, with the reason."""
    if body.decision == "decline" and not body.reason:
        return JSONResponse(status_code=422, content={"detail": "Pick a reason to decline."})
    try:
        request = _page_request(offer_id)
        offer = offer_on(request, recipient_id)
        if offer is None:
            return JSONResponse(
                status_code=404,
                content={
                    "detail": f"{request['offer_code'] or 'this offer'} was not offered to recipient {recipient_id}"
                },
            )
        request = state_tools.state_call(
            "POST",
            f"/offers/{offer['offer_id']}/response",
            {
                "status": "accepted" if body.decision == "accept" else "declined",
                "reason_code": body.reason if body.decision == "decline" else None,
                "actor": "recipient",
            },
        )
        return _invite(request, offer_on(request, recipient_id))
    except Exception as exc:  # noqa: BLE001
        return _page_error(exc)
