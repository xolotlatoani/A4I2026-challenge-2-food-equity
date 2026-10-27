"""Dedicated `/map` API Router for the Surplus Broker Map Console (`frontend/map.html`).

All map-related endpoints live under `/map`:
  - `GET /map`              -> Serves `frontend/map.html`
  - `GET /map/data`         -> Returns synchronized surplus postings and geocoded recipients
                               filtered by `track` (`RETAIL`, `FARM`, `ESSENTIALS`, `ALL`),
                               `storage_filter` (`all`, `refrigerated`, `pantry`),
                               `posting_id` (runs `agent.tools.match_surplus_posting`),
                               `preset`, and `q`.
  - `GET /map/postings`     -> Returns live surplus postings (`a4i_food.surplus_postings`
                               merged with Cloud SQL `grocer_requests`).
  - `GET /map/recipients`   -> Returns geocoded recipients from `a4i_food.recipient_facts`.
  - `GET /map/match/{posting_id}` -> Runs `agent.tools.match_surplus_posting` for one posting.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from agent import state_tools
from agent.tools import match_surplus_posting

REPO_ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = REPO_ROOT / "frontend"

PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "qwiklabs-gcp-04-ef48e08bc216")
DATASET = os.environ.get("BIGQUERY_DATASET") or os.environ.get("BQ_DATASET", "a4i_food")

map_router = APIRouter(prefix="/map", tags=["map"])

_BQ_FACTS_CACHE: list[dict[str, Any]] | None = None
_BQ_POSTINGS_CACHE: list[dict[str, Any]] | None = None
_BQ_MATCH_CACHE: dict[tuple[str, tuple[int, ...]], dict[str, Any]] = {}
_OPEN_REQS_CACHE: tuple[float, list[dict[str, Any]]] = (0.0, [])

# Track-to-archetype operational rules from `data/profile_components.json`
TRACK_ARCHETYPE_RULES: dict[str, dict[str, Any]] = {
    "RETAIL": {
        "recommended": {
            "mobile_pantry",
            "soup_kitchen",
            "shelter_kitchen",
            "senior_meals",
            "produce_coop",
        },
        "viable": {
            "mobile_pantry",
            "soup_kitchen",
            "shelter_kitchen",
            "senior_meals",
            "produce_coop",
            "neighborhood_pantry",
            "school_pantry",
            "faith_weekly",
            "halal_kosher",
            "rural_outpost",
        },
        "ruled_out_reasons": {
            "diaper_bank": "Retail track: diaper & infant-supply bank does not handle grocer food lots",
            "community_clinic": "Retail track: medical-grade clinic fridge reserved for clinical prescriptions",
            "disaster_staging": "Retail track: emergency bulk staging warehouse only accepts non-perishable truckloads",
            "regional_foodbank": "Retail track: regional warehouse profile declines small mixed retail lots (<2 pallets)",
        },
    },
    "FARM": {
        "recommended": {
            "regional_foodbank",
            "produce_coop",
            "mobile_pantry",
        },
        "viable": {
            "regional_foodbank",
            "produce_coop",
            "disaster_staging",
            "mobile_pantry",
            "rural_outpost",
            "soup_kitchen",
        },
        "ruled_out_reasons": {
            "neighborhood_pantry": "Farm track: storefront pantry has no dock or pallet capacity for bulk agricultural loads",
            "school_pantry": "Farm track: campus pantry has no dock or bulk produce handling",
            "shelter_kitchen": "Farm track: residential shelter lacks bulk storage for multi-pallet farm loads",
            "faith_weekly": "Farm track: open once weekly with household-scale storage only",
            "halal_kosher": "Farm track: small neighborhood pantry without bulk pallet receiving",
            "senior_meals": "Farm track: portioned senior meal kitchen lacks bulk farm storage",
            "diaper_bank": "Farm track: infant-essentials bank does not handle agricultural produce",
            "community_clinic": "Farm track: clinical facility cannot receive bulk agricultural pallets",
        },
    },
    "ESSENTIALS": {
        "recommended": {
            "diaper_bank",
            "community_clinic",
            "school_pantry",
            "shelter_kitchen",
        },
        "viable": {
            "diaper_bank",
            "community_clinic",
            "school_pantry",
            "shelter_kitchen",
            "neighborhood_pantry",
            "disaster_staging",
            "faith_weekly",
            "rural_outpost",
        },
        "ruled_out_reasons": {
            "produce_coop": "Essentials track: produce co-op handles fresh fruit and vegetables only",
            "soup_kitchen": "Essentials track: congregate hot-meal kitchen does not distribute diapers or clinical supplies",
            "senior_meals": "Essentials track: senior meal delivery program serves prepared meals only",
            "mobile_pantry": "Essentials track: chilled produce van route is not set up for clinical/infant stock",
            "regional_foodbank": "Essentials track: bulk food warehouse; route infant formula/diapers to family & clinic programs",
            "halal_kosher": "Essentials track: dietary food pantry focused on certified groceries",
        },
    },
}


def fetch_live_recipient_facts() -> list[dict[str, Any]]:
    """Query geocoded recipients from `a4i_food.recipient_facts` in BigQuery."""
    global _BQ_FACTS_CACHE
    if _BQ_FACTS_CACHE is not None:
        return _BQ_FACTS_CACHE

    from google.cloud import bigquery

    client = bigquery.Client(project=PROJECT_ID)
    facts_sql = f"""
    SELECT
      recipient_id, ein, name, street, city, state, zip_code, ntee_code,
      archetype, archetype_label, cold_storage, frozen_storage,
      loading_dock, refrigerated_transport, max_pallets, pickup_window_hours,
      weekly_households, reported_income, populations_served, service_days,
      profile_text, profile_source,
      tract_source, geocode_match,
      ROUND(address_latitude, 6) AS address_latitude,
      ROUND(address_longitude, 6) AS address_longitude,
      tract_geo_id,
      CAST(tract_population AS INT64) AS tract_population,
      CAST(tract_median_income AS INT64) AS tract_median_income,
      ROUND(poverty_rate, 3) AS poverty_rate,
      ROUND(no_vehicle_rate, 3) AS no_vehicle_rate,
      ROUND(assistance_rate, 3) AS assistance_rate,
      ROUND(need_score, 3) AS need_score,
      above_metro_need
    FROM `{PROJECT_ID}.{DATASET}.recipient_facts`
    WHERE address_latitude IS NOT NULL AND address_longitude IS NOT NULL
    ORDER BY recipient_id
    """
    _BQ_FACTS_CACHE = [dict(r) for r in client.query(facts_sql).result()]
    return _BQ_FACTS_CACHE


def fetch_live_surplus_postings() -> list[dict[str, Any]]:
    """Query `a4i_food.surplus_postings` from BigQuery and enrich with live Cloud SQL
    `grocer_requests` state (`request_id`, `hours_remaining`, `unclaimed_pallets`, `offers`).
    """
    global _BQ_POSTINGS_CACHE, _OPEN_REQS_CACHE
    if _BQ_POSTINGS_CACHE is None:
        from google.cloud import bigquery

        client = bigquery.Client(project=PROJECT_ID)
        postings_sql = f"""
        SELECT
          posting_id, track, posting_text, foodkeeper_product,
          storage_state, hours_available, shelf_life_hours, hours_remaining
        FROM `{PROJECT_ID}.{DATASET}.surplus_postings`
        ORDER BY posting_id
        """
        _BQ_POSTINGS_CACHE = [dict(r) for r in client.query(postings_sql).result()]

    postings = [dict(p) for p in _BQ_POSTINGS_CACHE]
    by_pid = {int(p["posting_id"]): p for p in postings}

    if state_tools.state_service_url():
        try:
            now = time.time()
            if now - _OPEN_REQS_CACHE[0] > 15.0:
                metro = os.environ.get("FOOD_RESCUE_METRO", "Atlanta")
                fetched_reqs = state_tools.state_call(
                    "GET", "/requests", params={"status": "open", "metro": metro}
                )
                _OPEN_REQS_CACHE = (now, fetched_reqs)
            for req in _OPEN_REQS_CACHE[1]:
                spid = req.get("source_posting_id")
                if spid is not None and int(spid) in by_pid:
                    target = by_pid[int(spid)]
                    target["request_id"] = str(req["request_id"])
                    target["hours_remaining"] = float(req["hours_remaining"])
                    target["pallets"] = float(req["pallets"])
                    target["unclaimed_pallets"] = float(req["unclaimed_pallets"])
                    target["excluded_ids"] = (
                        list(req.get("offered_ids") or [])
                        + list(req.get("held_ids") or [])
                        + list(req.get("busy_ids") or [])
                    )
                    target["offers_count"] = len(req.get("offers") or [])
                else:
                    postings.append(
                        {
                            "posting_id": int(spid) if spid is not None else 100 + len(postings),
                            "request_id": str(req["request_id"]),
                            "track": "RETAIL",
                            "posting_text": req["posting_text"],
                            "foodkeeper_product": req.get("food_item"),
                            "storage_state": (
                                "pantry"
                                if req.get("required_storage") == "shelf-stable"
                                else req.get("required_storage", "refrigerated")
                            ),
                            "hours_available": float(req["hours_remaining"]),
                            "shelf_life_hours": None,
                            "hours_remaining": float(req["hours_remaining"]),
                            "pallets": float(req["pallets"]),
                            "unclaimed_pallets": float(req["unclaimed_pallets"]),
                            "excluded_ids": (
                                list(req.get("offered_ids") or [])
                                + list(req.get("held_ids") or [])
                                + list(req.get("busy_ids") or [])
                            ),
                            "offers_count": len(req.get("offers") or []),
                        }
                    )
        except Exception:
            pass

    return postings


def run_agent_matcher_for_posting(posting: dict[str, Any]) -> dict[str, Any]:
    """Delegate matching for a surplus posting to `agent.tools.match_surplus_posting`."""
    req_id = str(posting.get("request_id") or "")
    pid_key = req_id or f"pid_{posting['posting_id']}"
    excl = tuple(sorted(set(int(x) for x in (posting.get("excluded_ids") or []))))
    cache_key = (pid_key, excl)
    if cache_key in _BQ_MATCH_CACHE:
        return _BQ_MATCH_CACHE[cache_key]

    storage_raw = str(posting.get("storage_state") or "refrigerated")
    storage = "shelf-stable" if storage_raw == "pantry" else storage_raw
    hours = float(posting.get("hours_remaining") or posting.get("hours_available") or 6.0)
    pallets = float(posting.get("unclaimed_pallets") or posting.get("pallets") or 0.25)

    agent_res = match_surplus_posting(
        posting_text=str(posting["posting_text"]),
        required_storage=storage,
        pallets_needed=pallets,
        donor_deadline_hours=hours,
        food_item=str(posting.get("foodkeeper_product") or ""),
        top_k=60,
        request_id=req_id,
    )
    _BQ_MATCH_CACHE[cache_key] = agent_res
    return agent_res


def _evaluate_recipient_for_track_and_storage(
    row: dict[str, Any],
    track: str,
    storage_filter: str,
    active_needs_cold: bool,
    min_posting_hours: float,
) -> tuple[bool, str, bool, str | None]:
    """Evaluate a recipient's viability, status_category, can_self_collect, and ruled_out_reason
    when filtering by Track (`RETAIL`, `FARM`, `ESSENTIALS`, `ALL`) and `storage_filter`.
    """
    arch = str(row.get("archetype") or "")
    cs = str(row.get("cold_storage") or "none")
    pw = int(row.get("pickup_window_hours") or 4)
    max_p = int(row.get("max_pallets") or 1)
    track_up = track.upper()

    # 1. Check Track operational compatibility first
    if track_up in TRACK_ARCHETYPE_RULES:
        rules = TRACK_ARCHETYPE_RULES[track_up]
        if arch in rules["ruled_out_reasons"]:
            # Special case: in ESSENTIALS, community_clinic IS viable even for refrigerated clinical formula
            return False, "ruled_out", False, rules["ruled_out_reasons"][arch]
        if track_up == "FARM" and max_p < 2 and arch not in ("produce_coop", "regional_foodbank"):
            return (
                False,
                "ruled_out",
                False,
                f"Farm track requires multi-pallet capacity (organization max_pallets = {max_p})",
            )

    # 2. Check Storage compatibility
    sf = storage_filter.lower()
    if sf == "refrigerated" or (sf == "all" and active_needs_cold):
        if track_up == "ESSENTIALS":
            # In ESSENTIALS, community_clinic medical cold storage IS valid for clinical supplements!
            viable_storage = cs in ("medical", "commercial", "walk-in", "vehicle", "domestic")
        else:
            viable_storage = cs not in ("none", "medical")
        if not viable_storage:
            reason = (
                "Medical fridge only — reserved for clinical prescriptions, not groceries"
                if cs == "medical"
                else "No refrigeration — cannot store cold perishables"
            )
            return False, "ruled_out", False, reason
    elif sf == "pantry":
        # When specifically filtering for shelf-stable / pantry surplus:
        if arch == "produce_coop":
            return (
                False,
                "ruled_out",
                False,
                "Produce co-op handles fresh fruit & vegetables only, not dry pantry goods",
            )
        if cs == "medical" and track_up != "ESSENTIALS":
            return False, "ruled_out", False, "Clinical facility — not a general dry-goods pantry"

    can_self_collect = pw <= min_posting_hours

    # 3. Classify viable recipient into recommended / split_partner / viable for this Track
    if track_up in TRACK_ARCHETYPE_RULES:
        rec_set = TRACK_ARCHETYPE_RULES[track_up]["recommended"]
        if arch in rec_set and (can_self_collect or track_up in ("FARM", "ESSENTIALS")):
            return True, "recommended", can_self_collect, None
        if cs == "domestic" and track_up == "RETAIL":
            return True, "split_partner", can_self_collect, None
        return True, "viable", can_self_collect, None

    # ALL tracks
    if cs in ("walk-in", "vehicle", "commercial") and can_self_collect:
        return True, "recommended", can_self_collect, None
    if cs == "domestic":
        return True, "split_partner", can_self_collect, None
    return True, "viable", can_self_collect, None


@map_router.get("", include_in_schema=False)
def serve_map_root() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "map.html")


@map_router.get("/postings")
def api_map_postings(
    track: str = Query("ALL", description="Filter by track: RETAIL, FARM, ESSENTIALS, or ALL"),
) -> dict[str, Any]:
    """Return live surplus postings (`a4i_food.surplus_postings` + Cloud SQL `grocer_requests`)."""
    track = track if isinstance(track, str) else "ALL"
    all_postings = fetch_live_surplus_postings()
    filtered = (
        all_postings
        if track.upper() == "ALL"
        else [p for p in all_postings if str(p.get("track") or "").upper() == track.upper()]
    )
    return {"postings": filtered, "count": len(filtered)}


@map_router.get("/recipients")
def api_map_recipients() -> dict[str, Any]:
    """Return all geocoded recipients from `a4i_food.recipient_facts`."""
    rows = fetch_live_recipient_facts()
    return {"recipients": rows, "count": len(rows)}


@map_router.get("/match/{posting_id}")
def api_map_match_posting(posting_id: int) -> dict[str, Any]:
    """Run `agent.tools.match_surplus_posting` for a specific `posting_id`."""
    all_postings = fetch_live_surplus_postings()
    posting = next((p for p in all_postings if int(p["posting_id"]) == posting_id), None)
    if posting is None:
        raise HTTPException(status_code=404, detail=f"No surplus posting with posting_id={posting_id}")
    return run_agent_matcher_for_posting(posting)


@map_router.get("/data")
def api_get_map_data(
    posting_id: int | None = Query(None, description="Selected posting_id from a4i_food.surplus_postings"),
    track: str = Query("RETAIL", description="Filter surplus_postings & recipients by track: RETAIL, FARM, ESSENTIALS, or ALL"),
    storage_filter: str = Query("all", description="Filter surplus_postings & recipients by storage: all, refrigerated, pantry"),
    preset: str = Query("recommended", description="Filter recipients: recommended, self_collect, real_cold, split_partner, high_need, ruled_out, all"),
    q: str = Query("", description="Free-text search filter"),
) -> dict[str, Any]:
    """Return live `a4i_food.surplus_postings` (enriched with Cloud SQL `grocer_requests`) and
    geocoded `a4i_food.recipient_facts` from BigQuery, synchronized with `track`,
    `storage_filter`, and `posting_id`.
    """
    posting_id = posting_id if isinstance(posting_id, int) else None
    track = track if isinstance(track, str) else "RETAIL"
    storage_filter = storage_filter if isinstance(storage_filter, str) else "all"
    preset = preset if isinstance(preset, str) else "recommended"
    q = q if isinstance(q, str) else ""

    all_postings = fetch_live_surplus_postings()

    postings = [
        p
        for p in all_postings
        if (track.upper() == "ALL" or str(p.get("track") or "").upper() == track.upper())
        and (
            storage_filter.lower() == "all"
            or str(p.get("storage_state") or "").lower() == storage_filter.lower()
        )
    ]

    selected_posting = (
        next((p for p in all_postings if int(p["posting_id"]) == posting_id), None)
        if posting_id is not None
        else None
    )

    active_needs_cold = (
        str(selected_posting.get("storage_state") or "") == "refrigerated"
        if selected_posting is not None
        else storage_filter.lower() == "refrigerated"
        or (
            storage_filter.lower() == "all"
            and len(postings) > 0
            and all(str(p.get("storage_state")) == "refrigerated" for p in postings)
        )
    )
    min_posting_hours = (
        float(selected_posting.get("hours_remaining") or 6.0)
        if selected_posting is not None
        else min((float(p.get("hours_remaining") or 24.0) for p in postings), default=24.0)
    )

    agent_match: dict[str, Any] | None = None
    eval_by_rid: dict[int, dict[str, Any]] = {}
    if selected_posting is not None:
        agent_match = run_agent_matcher_for_posting(selected_posting)
        split_by_rid = {
            int(s["recipient_id"]): s for s in (agent_match.get("split_plan") or [])
        }
        for m in agent_match.get("ranked_matches") or []:
            rid = int(m["recipient_id"])
            cc = m.get("clock_compatibility") or {}
            eval_by_rid[rid] = {
                "viable": True,
                "rank": int(m.get("final_rank") or 1),
                "semantic_rank": int(m.get("raw_vector_rank") or 1),
                "tier": int(m.get("tier") or 1),
                "can_self_collect": bool(cc.get("can_self_collect", True)),
                "margin_hours": cc.get("margin_hours"),
                "score": float(m.get("composite_score") or 0.0),
                "split_stop": split_by_rid[rid]["split_stop"] if rid in split_by_rid else None,
                "why_matched": m.get("why_matched"),
                "ruled_out_reason": None,
            }
        for e in (agent_match.get("eliminated_near_misses") or []) + (
            agent_match.get("flagged_contradictions") or []
        ):
            rid = int(e["recipient_id"])
            eval_by_rid[rid] = {
                "viable": False,
                "rank": None,
                "semantic_rank": int(e.get("raw_vector_rank") or 99),
                "tier": 5,
                "can_self_collect": False,
                "margin_hours": None,
                "score": 0.0,
                "split_stop": None,
                "why_matched": None,
                "ruled_out_reason": str(
                    e.get("elimination_reason") or "Filtered out by operational constraints"
                ),
            }

    facts_rows = fetch_live_recipient_facts()
    recipients: list[dict[str, Any]] = []
    for row in facts_rows:
        rid = int(row["recipient_id"])
        cs = str(row.get("cold_storage") or "none")
        pw = int(row.get("pickup_window_hours") or 4)
        ev = eval_by_rid.get(rid)

        if selected_posting is not None:
            if ev is None:
                continue
            viable_flag = bool(ev["viable"])
            can_self_collect = bool(ev["can_self_collect"])
            if ev.get("split_stop") is not None:
                status_cat = "split_partner"
            elif viable_flag and int(ev.get("rank") or 99) <= 5:
                status_cat = "recommended"
            elif viable_flag:
                status_cat = "viable"
            else:
                status_cat = "ruled_out"
            rank_val = ev.get("rank")
            sem_rank_val = ev.get("semantic_rank")
            ruled_reason = ev.get("ruled_out_reason")
            why_matched = ev.get("why_matched")
            margin_hours = ev.get("margin_hours")
        else:
            viable_flag, status_cat, can_self_collect, ruled_reason = (
                _evaluate_recipient_for_track_and_storage(
                    row=row,
                    track=track,
                    storage_filter=storage_filter,
                    active_needs_cold=active_needs_cold,
                    min_posting_hours=min_posting_hours,
                )
            )
            rank_val = None
            sem_rank_val = None
            why_matched = None
            margin_hours = round(min_posting_hours - pw, 1)

        street = (row.get("street") or "").strip()
        city = (row.get("city") or "Atlanta").strip()
        zip_code = (row.get("zip_code") or "").strip()
        address = f"{street.title()}, {city.title()} GA {zip_code}".strip(", ")

        recipients.append(
            {
                "recipient_id": rid,
                "ein": row.get("ein"),
                "name": row["name"],
                "address": address,
                "street": street,
                "city": city,
                "zip_code": zip_code,
                "ntee_code": row.get("ntee_code"),
                "latitude": float(row["address_latitude"]),
                "longitude": float(row["address_longitude"]),
                "tract_source": row.get("tract_source"),
                "geocode_match": row.get("geocode_match"),
                "tract_geo_id": row.get("tract_geo_id"),
                "archetype": row.get("archetype"),
                "archetype_label": row.get("archetype_label"),
                "cold_storage": cs,
                "frozen_storage": bool(row.get("frozen_storage")),
                "loading_dock": bool(row.get("loading_dock")),
                "refrigerated_transport": bool(row.get("refrigerated_transport")),
                "max_pallets": int(row.get("max_pallets") or 1),
                "pickup_window_hours": pw,
                "can_self_collect": can_self_collect,
                "margin_hours": margin_hours,
                "weekly_households": int(row.get("weekly_households") or 0),
                "service_days": row.get("service_days"),
                "poverty_rate": float(row["poverty_rate"]) if row.get("poverty_rate") is not None else None,
                "no_vehicle_rate": float(row["no_vehicle_rate"]) if row.get("no_vehicle_rate") is not None else None,
                "assistance_rate": float(row["assistance_rate"]) if row.get("assistance_rate") is not None else None,
                "need_score": float(row["need_score"]) if row.get("need_score") is not None else None,
                "above_metro_need": bool(row.get("above_metro_need")),
                "viable": viable_flag,
                "status_category": status_cat,
                "rank": rank_val,
                "semantic_rank": sem_rank_val,
                "why_matched": why_matched,
                "ruled_out_reason": ruled_reason,
            }
        )

    recipients.sort(
        key=lambda r: (
            0
            if r["status_category"] == "recommended"
            else 1
            if r["status_category"] == "split_partner"
            else 2
            if r["viable"]
            else 3,
            r["rank"] if r["rank"] is not None else 999,
            -(r["need_score"] or 0.0),
        )
    )

    pf = preset.lower()
    filtered = recipients
    if pf == "recommended":
        filtered = [r for r in filtered if r["status_category"] in ("recommended", "split_partner")]
    elif pf == "self_collect":
        filtered = [r for r in filtered if r["viable"] and r["can_self_collect"]]
    elif pf == "real_cold":
        filtered = [r for r in filtered if r["cold_storage"] in ("walk-in", "commercial", "vehicle") and r["viable"]]
    elif pf == "split_partner":
        filtered = [r for r in filtered if r["status_category"] == "split_partner" and r["viable"]]
    elif pf == "high_need":
        filtered = [r for r in filtered if (r.get("need_score") or 0) >= 0.70 and r["viable"]]
    elif pf == "ruled_out":
        filtered = [r for r in filtered if not r["viable"] or r["status_category"] == "ruled_out"]

    if q.strip():
        ql = q.strip().lower()
        filtered = [
            r
            for r in filtered
            if ql in r["name"].lower()
            or ql in r["address"].lower()
            or ql in (r.get("zip_code") or "").lower()
            or ql in (r.get("cold_storage") or "").lower()
        ]

    return {
        "metro": os.environ.get("FOOD_RESCUE_METRO", "Atlanta"),
        "track": track.upper(),
        "storage_filter": storage_filter.lower(),
        "postings": postings,
        "selected_posting": selected_posting,
        "active_needs_cold": active_needs_cold,
        "min_posting_hours": min_posting_hours,
        "agent_clock": agent_match.get("clock") if agent_match else None,
        "agent_equity_audit": agent_match.get("equity_audit_summary") if agent_match else None,
        "recipients": filtered,
        "all_recipients": recipients,
        "counts": {
            "postings_count": len(postings),
            "recipients_shown": len(filtered),
            "recipients_total": len(recipients),
        },
    }
