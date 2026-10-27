"""Offer-state service for the food rescue broker: a small HTTP API over Cloud SQL.

The agent's tools call it (agent/state_tools.py), and so can the coordinator console. It
remembers grocer requests, who each one was offered to and what they said, and answers the
question the matcher asks before every run: who to leave out, how much of the load is still
unclaimed, and how many hours are left.

Every write to a request's offers first locks that request's row, so two replies landing at
once cannot both claim the same pallets.

Run locally:
    DATABASE_URL=postgresql+pg8000://postgres@localhost:5432/food_rescue \
        uvicorn main:app --port 8080 --app-dir state_service
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError

from db import make_engine

Storage = Literal["refrigerated", "frozen", "shelf-stable"]
ReasonCode = Literal["no_capacity_today", "wrong_food", "storage_down", "closed",
                     "no_transport", "other"]

# What each reply may follow. 'expired' is an offer still 'sent' after its reply_by.
_ALLOWED_FROM = {
    "accepted": {"sent", "expired"},    # a late yes stands only if the load is still free
    "declined": {"sent", "expired"},
    "withdrawn": {"sent", "expired", "accepted"},
    "picked_up": {"accepted"},
}

app = FastAPI(title="Food rescue offer state")
engine = make_engine()


@app.exception_handler(IntegrityError)
async def _integrity_error(_: Request, exc: IntegrityError) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(exc.orig)})


class NewRequest(BaseModel):
    metro: str
    posting_text: str
    required_storage: Storage
    pallets: float = Field(gt=0)
    deadline_hours: float = Field(gt=0, description="Hours from now until the food must be placed")
    donor_name: str | None = None
    food_item: str | None = None
    source_posting_id: int | None = None
    offer_code: str | None = None
    reuse_live: bool = Field(
        default=False,
        description="With offer_code: return the live request with that code instead of a new one")


class NewMatchRun(BaseModel):
    hours_remaining: float
    pallets: float
    excluded_ids: list[int] = []
    ranked: dict[str, Any] | list[Any]


class NewOffer(BaseModel):
    request_id: UUID
    recipient_id: int
    recipient_name: str | None = None
    match_run_id: UUID | None = None
    offered_pallets: float | None = Field(
        default=None, gt=0, description="Defaults to every pallet still unclaimed")
    reply_within_hours: float = Field(default=1.0, gt=0)
    even_if_busy: bool = Field(
        default=False, description="Offer even though another request has this recipient tied up")
    actor: str | None = None


class OfferReply(BaseModel):
    status: Literal["accepted", "declined", "withdrawn", "picked_up"]
    reason_code: ReasonCode | None = None
    reason_text: str | None = None
    actor: str | None = None


class NewHold(BaseModel):
    recipient_id: int
    hours: float = Field(gt=0, description="How long from now the hold lasts")
    reason: str
    storage_scope: Storage | None = None
    created_by: str | None = None


def _plain(row: Any) -> dict[str, Any]:
    """A result row as a dict, with NUMERIC columns as numbers rather than JSON strings."""
    return {k: float(v) if isinstance(v, Decimal) else v for k, v in dict(row).items()}


def _request_row(conn: Connection, request_id: UUID, lock: bool = False) -> dict[str, Any]:
    """The request's request_status row. With lock, holds the request until the transaction ends."""
    if lock:
        conn.execute(text("SELECT 1 FROM grocer_requests WHERE request_id = :id FOR UPDATE"),
                     {"id": request_id})
    row = conn.execute(text("SELECT * FROM request_status WHERE request_id = :id"),
                       {"id": request_id}).mappings().first()
    if row is None:
        raise HTTPException(404, f"no request {request_id}")
    return _plain(row)


def _offers(conn: Connection, request_ids: list[UUID]) -> dict[UUID, list[dict[str, Any]]]:
    rows = conn.execute(
        text("SELECT * FROM offer_status WHERE request_id = ANY(CAST(:ids AS UUID[])) "
             "ORDER BY sent_at"),
        {"ids": [str(i) for i in request_ids]}).mappings().all()
    by_request: dict[UUID, list[dict[str, Any]]] = {i: [] for i in request_ids}
    for r in rows:
        by_request[r["request_id"]].append(_plain(r))
    return by_request


def _live_offers(conn: Connection, recipient_ids: list[int] | None = None,
                 other_than: UUID | None = None) -> list[dict[str, Any]]:
    """Offers that tie a recipient up (the live_offers view), optionally for some recipients,
    leaving out one request's own."""
    rows = conn.execute(text("""
        SELECT * FROM live_offers
        WHERE (CAST(:ids AS INT[]) IS NULL OR recipient_id = ANY(CAST(:ids AS INT[])))
          AND (CAST(:other_than AS UUID) IS NULL OR request_id <> CAST(:other_than AS UUID))
        ORDER BY sent_at
    """), {"ids": recipient_ids, "other_than": str(other_than) if other_than else None})
    return [_plain(r) for r in rows.mappings().all()]


def _state(conn: Connection, request_id: UUID) -> dict[str, Any]:
    """A request with its offers and the recipients the matcher should leave out: everyone
    already asked, on hold, or tied up by a live offer on another request."""
    req = _request_row(conn, request_id)
    req["offers"] = _offers(conn, [request_id])[request_id]
    req["busy_elsewhere"] = (_live_offers(conn, req["busy_ids"], other_than=request_id)
                             if req["busy_ids"] else [])
    req["exclude_ids"] = sorted(
        set(req["offered_ids"]) | set(req["held_ids"]) | set(req["busy_ids"]))
    return req


def _record_event(conn: Connection, offer_id: UUID, status: str, reply: OfferReply | None,
                  actor: str | None) -> None:
    conn.execute(
        text("INSERT INTO offer_events (offer_id, status, reason_code, reason_text, actor) "
             "VALUES (:offer_id, :status, :reason_code, :reason_text, :actor)"),
        {"offer_id": offer_id, "status": status,
         "reason_code": reply.reason_code if reply else None,
         "reason_text": reply.reason_text if reply else None, "actor": actor})


def _settle_request(conn: Connection, request_id: UUID) -> None:
    """Fulfilled once accepted shares cover the load; open again if a withdrawal uncovers it."""
    conn.execute(text("""
        UPDATE grocer_requests r
        SET status = CASE WHEN s.accepted_pallets >= r.pallets THEN 'fulfilled' ELSE 'open' END
        FROM request_status s
        WHERE r.request_id = :id AND s.request_id = r.request_id
          AND r.status IN ('open', 'fulfilled')
    """), {"id": request_id})


# Not /healthz: Cloud Run keeps some paths ending in "z" for itself.
@app.get("/health")
def health() -> dict[str, str]:
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    return {"status": "ok"}


@app.post("/requests", status_code=201)
def create_request(body: NewRequest) -> dict[str, Any]:
    with engine.begin() as conn:
        if body.reuse_live and body.offer_code:
            # One live request per console offer, even when two clicks land at once.
            conn.execute(text("SELECT pg_advisory_xact_lock(1, hashtext(:code))"),
                         {"code": body.offer_code})
            live = conn.execute(text("""
                SELECT request_id FROM request_status
                WHERE offer_code = :code AND current_status IN ('open', 'fulfilled')
                ORDER BY received_at DESC LIMIT 1
            """), {"code": body.offer_code}).scalar()
            if live is not None:
                return _state(conn, live) | {"reused": True}
        request_id = conn.execute(text("""
            INSERT INTO grocer_requests (metro, donor_name, posting_text, food_item,
                                         required_storage, pallets, deadline_at,
                                         source_posting_id, offer_code)
            VALUES (:metro, :donor_name, :posting_text, :food_item, :required_storage, :pallets,
                    now() + make_interval(secs => CAST(:deadline_hours AS FLOAT8) * 3600),
                    :source_posting_id, :offer_code)
            RETURNING request_id
        """), body.model_dump(exclude={"reuse_live"})).scalar_one()
        return _state(conn, request_id) | {"reused": False}


@app.get("/requests")
def list_requests(status: str | None = "open", metro: str | None = None,
                  offer_code: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    """Requests by current status ('open', 'expired', 'fulfilled', 'cancelled'), soonest
    deadline first, each with its offers. status=all lists every one."""
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT * FROM request_status
            WHERE (CAST(:status AS TEXT) = 'all' OR current_status = :status)
              AND (CAST(:metro AS TEXT) IS NULL OR metro = :metro)
              AND (CAST(:offer_code AS TEXT) IS NULL OR offer_code = :offer_code)
            ORDER BY deadline_at
            LIMIT :limit
        """), {"status": status or "all", "metro": metro, "offer_code": offer_code,
               "limit": limit}).mappings().all()
        requests = [_plain(r) for r in rows]
        offers = _offers(conn, [r["request_id"] for r in requests]) if requests else {}
    for r in requests:
        r["offers"] = offers[r["request_id"]]
    return requests


@app.get("/requests/{request_id}")
def get_request(request_id: UUID) -> dict[str, Any]:
    with engine.connect() as conn:
        return _state(conn, request_id)


@app.post("/requests/{request_id}/match-runs", status_code=201)
def create_match_run(request_id: UUID, body: NewMatchRun) -> dict[str, Any]:
    with engine.begin() as conn:
        _request_row(conn, request_id)
        match_run_id = conn.execute(text("""
            INSERT INTO match_runs (request_id, hours_remaining, pallets, excluded_ids, ranked)
            VALUES (:request_id, :hours_remaining, :pallets, CAST(:excluded_ids AS INT[]),
                    CAST(:ranked AS JSONB))
            RETURNING match_run_id
        """), {"request_id": request_id, "hours_remaining": body.hours_remaining,
               "pallets": body.pallets, "excluded_ids": body.excluded_ids,
               "ranked": json.dumps(body.ranked, default=str)}).scalar_one()
    return {"match_run_id": match_run_id, "request_id": request_id}


@app.get("/offers/live")
def list_live_offers(recipient_id: int | None = None) -> list[dict[str, Any]]:
    """Every offer tying a recipient up right now, across requests: the double-booking guard."""
    with engine.connect() as conn:
        return _live_offers(conn, [recipient_id] if recipient_id is not None else None)


@app.post("/offers", status_code=201)
def create_offer(body: NewOffer) -> dict[str, Any]:
    with engine.begin() as conn:
        req = _request_row(conn, body.request_id, lock=True)
        if req["current_status"] != "open":
            raise HTTPException(409, f"request is {req['current_status']}")
        # Offers to one recipient queue up here, so two requests can't both book them at once.
        conn.execute(text("SELECT pg_advisory_xact_lock(2, CAST(:r AS INT))"),
                     {"r": body.recipient_id})
        busy = _live_offers(conn, [body.recipient_id], other_than=body.request_id)
        if busy and not body.even_if_busy:
            raise HTTPException(409, {
                "message": "recipient is tied up by a live offer on another request; "
                           "pass even_if_busy to offer anyway",
                "busy_elsewhere": json.loads(json.dumps(busy, default=str)),
            })
        existing = conn.execute(
            text("SELECT * FROM offer_status WHERE request_id = :r AND recipient_id = :p"),
            {"r": body.request_id, "p": body.recipient_id}).mappings().first()
        if existing and existing["current_status"] not in ("withdrawn", "expired"):
            raise HTTPException(409, {
                "message": f"already offered to this recipient: {existing['current_status']}",
                "offer": json.loads(json.dumps(_plain(existing), default=str)),
            })

        unclaimed = float(req["unclaimed_pallets"])
        pallets = body.offered_pallets or unclaimed
        if pallets <= 0:
            raise HTTPException(
                409, "nothing left to offer: every pallet is accepted or waiting on a reply")
        if pallets > unclaimed + 1e-9:
            raise HTTPException(
                409, f"only {unclaimed:g} pallets are unclaimed; the rest are accepted or "
                     "waiting on a reply")

        # A withdrawn or expired offer to the same recipient is made again in place.
        offer_id = conn.execute(text("""
            INSERT INTO offers (request_id, recipient_id, recipient_name, match_run_id,
                                offered_pallets, reply_by)
            VALUES (:request_id, :recipient_id, :recipient_name, :match_run_id, :pallets,
                    LEAST(now() + make_interval(
                            secs => CAST(:reply_within_hours AS FLOAT8) * 3600),
                          :deadline_at))
            ON CONFLICT (request_id, recipient_id) DO UPDATE SET
              recipient_name = COALESCE(EXCLUDED.recipient_name, offers.recipient_name),
              match_run_id = EXCLUDED.match_run_id,
              offered_pallets = EXCLUDED.offered_pallets,
              status = 'sent', reason_code = NULL, reason_text = NULL,
              sent_at = now(), reply_by = EXCLUDED.reply_by, responded_at = NULL
            RETURNING offer_id
        """), {"request_id": body.request_id, "recipient_id": body.recipient_id,
               "recipient_name": body.recipient_name, "match_run_id": body.match_run_id,
               "pallets": pallets, "reply_within_hours": body.reply_within_hours,
               "deadline_at": req["deadline_at"]}).scalar_one()
        _record_event(conn, offer_id, "sent", None, body.actor)
        return _state(conn, body.request_id)


@app.post("/offers/{offer_id}/response")
def reply_to_offer(offer_id: UUID, body: OfferReply) -> dict[str, Any]:
    with engine.begin() as conn:
        request_id = conn.execute(text("SELECT request_id FROM offers WHERE offer_id = :id"),
                                  {"id": offer_id}).scalar()
        if request_id is None:
            raise HTTPException(404, f"no offer {offer_id}")
        req = _request_row(conn, request_id, lock=True)
        offer = conn.execute(text("SELECT * FROM offer_status WHERE offer_id = :id"),
                             {"id": offer_id}).mappings().one()
        current = offer["current_status"]

        if current not in _ALLOWED_FROM[body.status]:
            raise HTTPException(409, f"offer is {current}; it can't be marked {body.status}")
        if (body.status == "accepted" and current == "expired"
                and float(req["unclaimed_pallets"]) < float(offer["offered_pallets"])):
            raise HTTPException(409, (
                f"the yes came after the reply-by time ({offer['reply_by']:%H:%M %Z}) and the "
                f"load has since been offered to others: {float(req['unclaimed_pallets']):g} "
                "pallets are unclaimed. Offer them a smaller share, or withdraw another offer."))

        conn.execute(text("""
            UPDATE offers SET
              status = :status,
              reason_code = COALESCE(:reason_code, reason_code),
              reason_text = COALESCE(:reason_text, reason_text),
              responded_at = CASE WHEN :status IN ('accepted', 'declined') THEN now()
                                  ELSE responded_at END
            WHERE offer_id = :id
        """), {"id": offer_id, "status": body.status, "reason_code": body.reason_code,
               "reason_text": body.reason_text})
        _record_event(conn, offer_id, body.status, body, body.actor)
        _settle_request(conn, request_id)
        return _state(conn, request_id)


@app.post("/holds", status_code=201)
def create_hold(body: NewHold) -> dict[str, Any]:
    with engine.begin() as conn:
        row = conn.execute(text("""
            INSERT INTO recipient_holds (recipient_id, storage_scope, ends_at, reason, created_by)
            VALUES (:recipient_id, :storage_scope,
                    now() + make_interval(secs => CAST(:hours AS FLOAT8) * 3600),
                    :reason, :created_by)
            RETURNING *
        """), body.model_dump()).mappings().one()
    return _plain(row)


@app.get("/holds")
def list_holds(active: bool = True, recipient_id: int | None = None) -> list[dict[str, Any]]:
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT * FROM recipient_holds
            WHERE (NOT :active OR (now() >= starts_at AND now() < ends_at))
              AND (CAST(:recipient_id AS INT) IS NULL OR recipient_id = :recipient_id)
            ORDER BY ends_at
        """), {"active": active, "recipient_id": recipient_id}).mappings().all()
    return [_plain(r) for r in rows]
