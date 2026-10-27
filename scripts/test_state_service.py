#!/usr/bin/env python3
"""Walk the offer-state service through a coordinator's afternoon and check every answer.

Runs against whatever STATE_SERVICE_URL points at, through the agent's own client
(`agent/state_tools.py`), so it checks the auth path too:

    STATE_SERVICE_URL=http://localhost:8080 python3 scripts/test_state_service.py
    STATE_SERVICE_URL=https://food-rescue-state-....run.app python3 scripts/test_state_service.py

It writes real rows. They go under metro 'StateServiceTest', so they never show in a real
metro's queue, and they expire within minutes. Recipient ids 9001+ are made up.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from agent import state_tools as st  # noqa: E402

METRO = "StateServiceTest"
A, B, C, D, E = 9001, 9002, 9003, 9004, 9005
failures: list[str] = []


def check(name: str, passed: bool, detail: object = "") -> None:
    print(f"  {'PASS' if passed else 'FAIL'}  {name}"
          + (f"  ({detail})" if detail and not passed else ""))
    if not passed:
        failures.append(name)


def new_request(pallets: float, hours: float, storage: str = "refrigerated") -> str:
    state = st.create_request(metro=METRO, posting_text=f"test load, {pallets} pallets",
                              required_storage=storage, pallets=pallets, deadline_hours=hours)
    return str(state["request_id"])


def state(request_id: str) -> dict:
    return st.summarize_request(st.get_request_state(request_id))


def main() -> None:
    if not st.state_service_url():
        sys.exit("Set STATE_SERVICE_URL first.")
    print(f"Offer-state service: {st.state_service_url()}")
    print(st.state_call("GET", "/health"))

    print("\n[1] A new request, offered whole to one recipient")
    rid = new_request(0.25, 6)
    s = state(rid)
    check("open with the whole load unclaimed", s["status"] == "open"
          and s["unclaimed_pallets"] == 0.25 and s["excluded_recipient_ids"] == [], s)
    check("clock is about 6 hours", 5.9 <= s["hours_remaining"] <= 6.0, s["hours_remaining"])
    run = st.save_match_run(rid, hours_remaining=6, pallets=0.25, excluded_ids=[],
                            ranked={"ranked": [{"recipient_id": A}]})
    out = st.record_offer(rid, A, "Pantry A", match_run_id=str(run["match_run_id"]))
    check("offer to A holds every pallet", out["status"] == "recorded"
          and out["request"]["unclaimed_pallets"] == 0
          and out["request"]["offers"][0]["offered_pallets"] == 0.25, out)
    check("A can't be offered the same request twice",
          st.record_offer(rid, A)["status"] == "conflict")
    check("nothing is left to offer B while A decides",
          st.record_offer(rid, B)["status"] == "conflict")

    print("\n[2] A declines: who's next leaves A out and frees the load")
    out = st.record_offer_response(rid, A, "declined", "no_capacity_today", "walk-in is full")
    s = out["request"]
    check("decline recorded with its reason", s["offers"][0]["status"] == "declined"
          and s["offers"][0]["reason_code"] == "no_capacity_today", s["offers"][0])
    check("A excluded, load unclaimed again",
          s["excluded_recipient_ids"] == [A] and s["unclaimed_pallets"] == 0.25, s)

    print("\n[3] A split across B and C, both accept")
    st.record_offer(rid, B, "Pantry B", offered_pallets=0.1)
    st.record_offer(rid, C, "Pantry C", offered_pallets=0.15)
    check("no third share once B and C hold it all",
          st.record_offer(rid, D, offered_pallets=0.05)["status"] == "conflict")
    st.record_offer_response(rid, B, "yes")
    s = st.record_offer_response(rid, C, "accepted")["request"]
    check("fulfilled once accepted shares cover the load", s["status"] == "fulfilled"
          and s["accepted_pallets"] == 0.25, s)
    check("a fulfilled request takes no new offers",
          st.record_offer(rid, D)["status"] == "conflict")
    check("picked_up only follows accepted",
          st.record_offer_response(rid, A, "picked_up")["status"] == "conflict")
    s = st.record_offer_response(rid, B, "withdrawn", "other", "van broke down")["request"]
    check("withdrawing an accepted share reopens the request", s["status"] == "open"
          and s["unclaimed_pallets"] == 0.1 and B not in s["excluded_recipient_ids"], s)
    s = st.record_offer_response(rid, C, "picked_up")["request"]
    check("C's load picked up", next(o for o in s["offers"] if o["recipient_id"] == C)["status"]
          == "picked_up", s)

    print("\n[4] No reply by the reply-by time")
    rid2 = new_request(0.5, 6)
    st.record_offer(rid2, A, offered_pallets=0.5, reply_within_hours=0.0005)   # about 2 seconds
    time.sleep(3)
    s = state(rid2)
    check("unanswered offer reads as expired, still excluded, load freed",
          s["offers"][0]["status"] == "expired" and s["excluded_recipient_ids"] == [A]
          and s["unclaimed_pallets"] == 0.5, s)
    out = st.record_offer_response(rid2, A, "accepted")
    check("a late yes stands while the load is still free", out["status"] == "recorded"
          and out["request"]["status"] == "fulfilled", out)

    rid3 = new_request(0.5, 6)
    st.record_offer(rid3, A, offered_pallets=0.5, reply_within_hours=0.0005)
    time.sleep(3)
    st.record_offer(rid3, B, offered_pallets=0.5)
    out = st.record_offer_response(rid3, A, "accepted")
    check("a late yes after the load went to B is refused", out["status"] == "conflict", out)
    st.record_offer_response(rid3, B, "declined", "storage_down", "compressor failed")
    out = st.record_offer(rid3, A)
    check("once B declines, A's expired offer can be made again", out["status"] == "recorded"
          and next(o for o in out["request"]["offers"] if o["recipient_id"] == A)["status"]
          == "sent", out)

    print("\n[5] Holds outlast one request")
    hold = st.record_recipient_hold(E, 24, "walk-in down until Friday", "refrigerated")
    check("hold recorded", hold["status"] == "recorded", hold)
    cold = state(new_request(0.2, 6, "refrigerated"))
    dry = state(new_request(0.2, 6, "shelf-stable"))
    check("held for cold loads", E in cold["excluded_recipient_ids"], cold["excluded_recipient_ids"])
    check("still offered dry loads", E not in dry["excluded_recipient_ids"],
          dry["excluded_recipient_ids"])

    print("\n[6] The clock runs out")
    rid4 = new_request(0.2, 0.0005)
    time.sleep(3)
    s = state(rid4)
    check("past its deadline the request reads as expired", s["status"] == "expired"
          and s["hours_remaining"] == 0, s)
    check("an expired request takes no offers", st.record_offer(rid4, A)["status"] == "conflict")

    print("\n[7] The queue and bad input")
    queue = st.list_open_requests(METRO)
    open_ids = {str(r["request_id"]) for r in queue["requests"]}
    check("queue lists open requests only", rid in open_ids and rid2 not in open_ids
          and rid4 not in open_ids, len(open_ids))
    check("unknown reply rejected", st.record_offer_response(rid, A, "maybe")["status"] == "invalid")
    check("unknown request is not_found",
          st.record_offer(
              "00000000-0000-0000-0000-000000000000", A)["status"] == "not_found")

    print("\n" + ("All checks passed." if not failures else f"{len(failures)} failed: {failures}"))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    os.environ.setdefault("FOOD_RESCUE_METRO", METRO)
    main()
