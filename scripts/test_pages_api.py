#!/usr/bin/env python3
"""Walk the grocer and pantry pages' API (server.py's /api/offers routes) and check every answer.

Plays all three parts: the grocer posting through the page's route, the desk offering through
the offer-state service, and the pantry answering through the page's route. Needs server.py
running against an offer-state service, and that service's URL for the desk's part:

    STATE_SERVICE_URL=http://localhost:8089 FOOD_RESCUE_METRO=PageTest \\
        uvicorn server:app --port 8095
    CONSOLE_URL=http://localhost:8095 STATE_SERVICE_URL=http://localhost:8089 \\
        python3 scripts/test_pages_api.py

It writes real rows under whatever metro server.py runs as, so point it at a test metro, not
the demo's. Its store and recipient ids are made up and fresh each run.
"""

from __future__ import annotations

import json
import os
import random
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from agent import state_tools as st  # noqa: E402

BASE = os.environ.get("CONSOLE_URL", "http://localhost:8080").rstrip("/")
RUN = random.randrange(10_000, 99_999)
STORE = f"test-store-{RUN}"
P1, P2 = 800_000 + RUN * 2, 800_001 + RUN * 2      # made-up pantries
failures: list[str] = []


def call(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as err:
        return err.code, json.load(err)


def check(name: str, passed: bool, detail: object = "") -> None:
    print(f"  {'PASS' if passed else 'FAIL'}  {name}" + (f"  ({detail})" if not passed else ""))
    if not passed:
        failures.append(name)


def main() -> None:
    if not st.state_service_url():
        sys.exit("Set STATE_SERVICE_URL to the service server.py uses.")
    print(f"Pages API: {BASE}   offer-state service: {st.state_service_url()}")

    print("\n[1] The grocer posts")
    leave_by = (datetime.now(timezone.utc) + timedelta(hours=3)).astimezone()
    post = {"store_id": STORE, "donor_label": "Grocery store · Test Point",
            "pickup_point": "Test grocery store · loading dock",
            "posting_text": "12 crates of romaine and kale, needs cold storage",
            "storage": "refrigerated", "must_leave_by": leave_by.isoformat(timespec="seconds"),
            "quantity_text": "12 crates"}
    code, g = call("POST", "/api/offers", post)
    check("201 with status posted, a code, and the pickup point", code == 201
          and g["status"] == "posted" and g["offer_code"].startswith("OFFER #")
          and g["pickup_point"] == post["pickup_point"], (code, g))
    oid = g["offer_id"]
    code, mine = call("GET", f"/api/offers?store={STORE}")
    check("listed under its store", code == 200 and [o["offer_id"] for o in mine["offers"]] == [oid],
          mine)
    code, other = call("GET", f"/api/offers?store={STORE}-other")
    check("not under another store", oid not in [o["offer_id"] for o in other["offers"]])
    code, past = call("POST", "/api/offers", post | {"must_leave_by": "2020-01-01T10:00:00-05:00"})
    check("a time already gone is refused, with why", code == 422 and "passed" in past["detail"], past)
    saved = st.get_request_state(oid)
    check("pallets read from the grocer's quantity", saved["pallets"] == 0.22
          and saved["pallets_source"] == "read", saved["pallets_basis"])

    print("\n[2] The pantry answers")
    code, none = call("GET", f"/api/offers/{oid}/invites/{P1}")
    check("no invite before the desk offers it: 404", code == 404, none)
    st.record_offer(oid, P1, "Pantry One", offered_pallets=0.1)
    st.record_offer(oid, P2, "Pantry Two", offered_pallets=0.12)
    code, inv = call("GET", f"/api/offers/{oid}/invites/{P1}")
    check("the invite, offered, with its answer-by time", code == 200 and inv["status"] == "offered"
          and inv["pallets"] == 0.1 and inv["respond_by"] and inv["donor_area"] == "Test Point", inv)
    code, bad = call("POST", f"/api/offers/{oid}/invites/{P1}/response", {"decision": "decline"})
    check("declining needs a reason", code == 422, bad)
    code, d = call("POST", f"/api/offers/{oid}/invites/{P1}/response",
                   {"decision": "decline", "reason": "no_capacity_today"})
    check("decline kept with its reason", code == 200 and d["status"] == "declined"
          and d["decline_reason"] == "no_capacity_today", d)
    code, again = call("POST", f"/api/offers/{oid}/invites/{P1}/response", {"decision": "accept"})
    check("a second answer is refused", code == 409, again)
    check("the grocer still sees posted", call("GET", f"/api/offers/{oid}")[1]["status"] == "posted")
    code, a = call("POST", f"/api/offers/{oid}/invites/{P2}/response", {"decision": "accept"})
    check("another pantry accepts", code == 200 and a["status"] == "accepted", a)

    print("\n[3] The grocer's tracker moves")
    g2 = call("GET", f"/api/offers/{oid}")[1]
    check("matched, with who and when", g2["status"] == "matched"
          and g2["recipient_name"] == "Pantry Two" and g2["matched_at"], g2)
    st.record_offer_response(oid, P2, "picked_up")
    g3 = call("GET", f"/api/offers/{oid}")[1]
    check("picked up, with when", g3["status"] == "picked_up" and g3["picked_up_at"], g3)
    code, junk = call("GET", "/api/offers/not-an-id")
    check("an unknown offer is 404", code == 404, junk)

    print("\n" + ("All checks passed." if not failures else f"{len(failures)} failed: {failures}"))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
