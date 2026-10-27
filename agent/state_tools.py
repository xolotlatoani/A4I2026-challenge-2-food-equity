"""Offer-state tools: remember grocer requests, who each was offered to, and what they said.

The state lives in Cloud SQL behind the offer-state service (`state_service/`), which this
module calls over HTTP. `match_surplus_posting` (agent/tools.py) reads it before every match
of a recorded request: who has already been asked, how much of the load is still unclaimed,
and how many hours are left. So "they said no, who's next?" survives a new conversation,
a second coordinator, and a redeploy.

It is also the double-booking guard the dispatch ledger used to be: a recipient with a live
offer on one request (waiting on a reply, or accepted and not yet picked up) is left out of
every other request until that offer ends. `dispatch_entry` keeps the ledger's old entry shape
for the coordinator console (server.py) and the Match Brief.

`STATE_SERVICE_URL` points at the service. On Cloud Run the agent signs each call with an ID
token for its own service account; locally, with `gcloud auth print-identity-token`. A
localhost URL gets no token. With `STATE_SERVICE_URL` unset every tool here returns
status 'unavailable' and the agent carries on without memory.
"""

from __future__ import annotations

import os
import subprocess
import time
from typing import Any
from urllib.parse import urlparse

import google.auth.transport.requests
import requests
from google.oauth2 import id_token

_REPLIES = {
    "accepted": "accepted", "accept": "accepted", "yes": "accepted",
    "declined": "declined", "decline": "declined", "rejected": "declined", "no": "declined",
    "withdrawn": "withdrawn", "withdraw": "withdrawn", "cancelled": "withdrawn",
    "picked_up": "picked_up", "picked up": "picked_up", "collected": "picked_up",
}
_REASON_CODES = {"no_capacity_today", "wrong_food", "storage_down", "closed", "no_transport",
                 "other"}
_STORAGE = {"refrigerated": "refrigerated", "frozen": "frozen", "shelf-stable": "shelf-stable",
            "pantry": "shelf-stable", "dry": "shelf-stable"}

_tokens: dict[str, tuple[str, float]] = {}


class StateServiceError(RuntimeError):
    """The offer-state service said no, or could not be reached (status 0)."""

    def __init__(self, status: int, detail: Any):
        super().__init__(f"{status}: {detail}")
        self.status = status
        self.detail = detail


def state_service_url() -> str:
    return os.environ.get("STATE_SERVICE_URL", "").strip().rstrip("/")


def _id_token(url: str) -> str | None:
    if urlparse(url).hostname in ("localhost", "127.0.0.1", "::1"):
        return None
    cached = _tokens.get(url)
    if cached and cached[1] > time.time():
        return cached[0]
    try:
        token = id_token.fetch_id_token(google.auth.transport.requests.Request(), url)
    except Exception:  # noqa: BLE001
        # Your own gcloud login can't mint a token for an audience, but Cloud Run accepts
        # gcloud's identity token from anyone granted run.invoker.
        token = subprocess.run(["gcloud", "auth", "print-identity-token"], check=True,
                               capture_output=True, text=True).stdout.strip()
    _tokens[url] = (token, time.time() + 45 * 60)   # tokens last an hour
    return token


def state_call(method: str, path: str, payload: dict[str, Any] | None = None,
               params: dict[str, Any] | None = None) -> Any:
    """Call the offer-state service and return its JSON, or raise StateServiceError."""
    url = state_service_url()
    if not url:
        raise StateServiceError(0, "STATE_SERVICE_URL is not set")
    token = _id_token(url)
    try:
        resp = requests.request(
            method, url + path, json=payload, params=params, timeout=15,
            headers={"Authorization": f"Bearer {token}"} if token else {})
    except requests.RequestException as exc:
        raise StateServiceError(0, f"offer-state service unreachable: {exc}") from exc
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text)
        except ValueError:
            detail = resp.text
        raise StateServiceError(resp.status_code, detail)
    return resp.json()


def failure(exc: Exception) -> dict[str, Any]:
    """What a tool returns when the service refuses or is missing, in words the agent can relay."""
    if isinstance(exc, StateServiceError) and exc.status == 0:
        return {
            "status": "unavailable",
            "detail": exc.detail,
            "what_to_do": (
                "Offers are not being saved. Keep track of who was asked in this conversation "
                "and pass them to match_surplus_posting as exclude_recipient_ids."),
        }
    if isinstance(exc, StateServiceError):
        kind = {404: "not_found", 409: "conflict", 422: "invalid"}.get(exc.status, "error")
        return {"status": kind, "detail": exc.detail}
    return {"status": "error", "detail": str(exc)}


def dispatch_entry(offer: dict[str, Any]) -> dict[str, Any]:
    """A live offer in the shape the dispatch ledger used: who is tied up, by which posting."""
    return {
        "recipient_id": offer["recipient_id"],
        "recipient_name": offer.get("recipient_name") or f"Recipient #{offer['recipient_id']}",
        "posting_text": offer.get("posting_text"),
        "offer_code": offer.get("offer_code"),
        "pallets_claimed": offer.get("offered_pallets"),
        "status": offer.get("current_status"),
        "request_id": offer.get("request_id"),
        "reply_by": offer.get("reply_by"),
    }


def summarize_request(state: dict[str, Any]) -> dict[str, Any]:
    """The parts of a request's state the agent needs, without the database bookkeeping."""
    return {
        "request_id": state["request_id"],
        "status": state["current_status"],
        "posting_text": state["posting_text"],
        "required_storage": state["required_storage"],
        "pallets": state["pallets"],
        "deadline_at": state["deadline_at"],
        "hours_remaining": state["hours_remaining"],
        "unclaimed_pallets": state["unclaimed_pallets"],
        "accepted_pallets": state["accepted_pallets"],
        "pending_pallets": state["pending_pallets"],
        "excluded_recipient_ids": state.get("exclude_ids", []),
        "busy_elsewhere": [dispatch_entry(b) for b in state.get("busy_elsewhere", [])],
        "offers": [
            {
                "offer_id": o["offer_id"],
                "recipient_id": o["recipient_id"],
                "recipient_name": o["recipient_name"],
                "status": o["current_status"],
                "offered_pallets": o["offered_pallets"],
                "reply_by": o["reply_by"],
                "reason_code": o["reason_code"],
                "reason_text": o["reason_text"],
            }
            for o in state.get("offers", [])
        ],
    }


# ---------------------------------------------------------------------------
# Calls agent/tools.py makes around the matcher
# ---------------------------------------------------------------------------
def create_request(**fields: Any) -> dict[str, Any]:
    return state_call("POST", "/requests", fields)


def get_request_state(request_id: str) -> dict[str, Any]:
    return state_call("GET", f"/requests/{request_id.strip()}")


def find_live_request(offer_code: str) -> dict[str, Any] | None:
    """The newest open or fulfilled request saved under an offer code, or None."""
    rows = state_call("GET", "/requests", params={"status": "all", "offer_code": offer_code})
    live = [r for r in rows if r["current_status"] in ("open", "fulfilled")]
    if not live:
        return None
    newest = max(live, key=lambda r: r["received_at"])
    return get_request_state(str(newest["request_id"]))


def live_offers(recipient_id: int | None = None) -> list[dict[str, Any]]:
    """Every offer tying a recipient up right now, across all requests."""
    params = {"recipient_id": int(recipient_id)} if recipient_id is not None else None
    return state_call("GET", "/offers/live", params=params)


def save_match_run(request_id: str, hours_remaining: float, pallets: float,
                   excluded_ids: list[int], ranked: dict[str, Any]) -> dict[str, Any]:
    return state_call("POST", f"/requests/{request_id.strip()}/match-runs", {
        "hours_remaining": hours_remaining, "pallets": pallets,
        "excluded_ids": excluded_ids, "ranked": ranked,
    })


# ---------------------------------------------------------------------------
# Tools the agent calls directly
# ---------------------------------------------------------------------------
def record_offer(
    request_id: str,
    recipient_id: int,
    recipient_name: str = "",
    offered_pallets: float = 0.0,
    reply_within_hours: float = 1.0,
    match_run_id: str = "",
    even_if_busy: bool = False,
) -> dict[str, Any]:
    """Record that a recipient has been offered (part of) a grocer request.

    Call this when you write the outreach message for a recipient, once per recipient. The
    offer holds its share of the load until it is answered or its reply-by time passes, so
    later matches neither offer the same pallets twice nor ask the same recipient again. While
    it is live, every other request leaves this recipient out, so two grocers never book the
    same van or fridge at once.

    Args:
        request_id: The request's id, from `record_grocer_request` or `match_surplus_posting`.
        recipient_id: The recipient's `recipient_id`.
        recipient_name: The recipient's name, so the offer queue reads without a lookup.
        offered_pallets: The share offered, e.g. a stop's pallets in the split plan. 0 offers
            every pallet still unclaimed.
        reply_within_hours: How long they have to answer; never past the request's deadline.
        match_run_id: The `match_run_id` of the match this recipient came from.
        even_if_busy: Offer even though another request has this recipient tied up. Only
            when the coordinator confirms they can take both loads.

    Returns:
        The request's state after the offer (`status` 'recorded'), or `status` 'conflict' with
        the reason when the recipient was already asked, is tied up by another request, or
        nothing is left to offer.
    """
    try:
        state = state_call("POST", "/offers", {
            "request_id": request_id.strip(),
            "recipient_id": int(recipient_id),
            "recipient_name": recipient_name or None,
            "match_run_id": match_run_id.strip() or None,
            "offered_pallets": float(offered_pallets) if offered_pallets else None,
            "reply_within_hours": float(reply_within_hours or 1.0),
            "even_if_busy": bool(even_if_busy),
            "actor": "agent",
        })
    except Exception as exc:  # noqa: BLE001
        return failure(exc)
    return {"status": "recorded", "request": summarize_request(state)}


def record_offer_response(
    request_id: str,
    recipient_id: int,
    response: str,
    reason_code: str = "",
    reason_text: str = "",
) -> dict[str, Any]:
    """Record a recipient's answer to an offer, or a change to it.

    Call this as soon as the coordinator reports a reply. Then, after a decline, call
    `match_surplus_posting` again with the same `request_id` for who's next: it leaves out
    everyone already asked and uses the clock and pallets actually left.

    Args:
        request_id: The request the offer belongs to.
        recipient_id: The recipient who answered.
        response: 'accepted', 'declined', 'withdrawn' (the coordinator takes the offer back),
            or 'picked_up' (an accepted load was collected).
        reason_code: Why, for a decline or withdrawal: 'no_capacity_today', 'wrong_food',
            'storage_down', 'closed', 'no_transport', or 'other'.
        reason_text: The reason in the coordinator's or recipient's words.

    Returns:
        The request's state after the answer (`status` 'recorded'), or `status` 'conflict'
        when the answer doesn't fit, e.g. a late yes after the load went to someone else.
    """
    reply = _REPLIES.get((response or "").strip().lower())
    if reply is None:
        return {"status": "invalid",
                "detail": "response must be accepted, declined, withdrawn or picked_up"}
    code = (reason_code or "").strip().lower() or None
    if code and code not in _REASON_CODES:
        reason_text = " ".join(t for t in (reason_code, reason_text) if t)
        code = "other"
    try:
        state = get_request_state(request_id)
        offer = next((o for o in state["offers"] if o["recipient_id"] == int(recipient_id)), None)
        if offer is None:
            return {"status": "not_found",
                    "detail": f"recipient {recipient_id} has no offer on this request; "
                              "record_offer first",
                    "request": summarize_request(state)}
        state = state_call("POST", f"/offers/{offer['offer_id']}/response", {
            "status": reply, "reason_code": code, "reason_text": reason_text or None,
            "actor": "agent",
        })
    except Exception as exc:  # noqa: BLE001
        return failure(exc)
    return {"status": "recorded", "request": summarize_request(state)}


def record_recipient_hold(
    recipient_id: int,
    hold_hours: float,
    reason: str,
    storage_scope: str = "",
) -> dict[str, Any]:
    """Stop offering to a recipient for a while, across every request.

    Only for a reason that outlasts one offer: "our walk-in is down until Friday", "closed
    for the holiday week". A plain "no thanks" is a decline (`record_offer_response`), never
    a hold: small pantries say no most often for lack of room, and holding them would steer
    food away from the neighborhoods that need it most.

    Args:
        recipient_id: The recipient's `recipient_id`.
        hold_hours: How long from now the hold lasts, e.g. 72 for three days.
        reason: Why, in the recipient's or coordinator's words.
        storage_scope: 'refrigerated', 'frozen' or 'shelf-stable' to hold only offers that need
            that storage (a broken walk-in still takes bread); empty holds every offer.

    Returns:
        The hold, with when it ends.
    """
    scope = (storage_scope or "").strip().lower()
    if scope and scope not in _STORAGE:
        return {"status": "invalid",
                "detail": "storage_scope must be refrigerated, frozen, shelf-stable or empty"}
    try:
        hold = state_call("POST", "/holds", {
            "recipient_id": int(recipient_id), "hours": float(hold_hours), "reason": reason,
            "storage_scope": _STORAGE.get(scope), "created_by": "agent",
        })
    except Exception as exc:  # noqa: BLE001
        return failure(exc)
    return {"status": "recorded", "hold": hold}


def list_open_requests(metro: str = "") -> dict[str, Any]:
    """List grocer requests still waiting to be placed, soonest deadline first.

    Answers "what's still open?" and "who haven't we heard back from?": each request comes
    with its hours left, unclaimed pallets, and every offer's status ('sent' is waiting on a
    reply, 'expired' passed its reply-by time unanswered).

    Args:
        metro: Only this metro's requests; empty for the agent's own (`FOOD_RESCUE_METRO`).

    Returns:
        Dictionary with `requests`, a list of request summaries.
    """
    try:
        rows = state_call("GET", "/requests", params={
            "status": "open", "metro": metro or os.environ.get("FOOD_RESCUE_METRO", "Atlanta")})
    except Exception as exc:  # noqa: BLE001
        return failure(exc)
    return {"status": "ok", "requests": [summarize_request(r) for r in rows]}


TOOLS = [record_offer, record_offer_response, record_recipient_hold, list_open_requests]
