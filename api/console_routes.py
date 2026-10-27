"""Live BigQuery & snapshot REST routes (`/api/queue`, `/api/match`, `/api/recipients`, `/api/equity-audit`)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Query

from api.catalog import DATASET, EQUITY_AUDIT_DATA, OFFERS_CATALOG, PROJECT_ID, SERVICE_DATE, SQL_03_PATH
from api.dispatch_routes import console_offer, dispatch_exclusions, live_status

logger = logging.getLogger(__name__)

console_router = APIRouter()

_INTAKE_DIST: tuple[int, dict[str, Any]] | None = None
_BQ_MATCH_CACHE: dict[tuple[Any, ...], dict[str, Any]] = {}


def _try_live_sql_match(
    posting_text: str,
    needs_cold: bool,
    needs_frozen: bool,
    pallets: float,
    hours_remaining: float,
    exclude_ids: list[int],
) -> dict[str, Any] | None:
    """Execute `sql/03_filter_and_rank.sql` live against BigQuery (`a4i_food`), with in-memory caching."""
    cache_key = (
        posting_text.strip(),
        bool(needs_cold),
        bool(needs_frozen),
        round(float(pallets), 3),
        round(float(hours_remaining), 2),
        tuple(sorted(exclude_ids)),
    )
    if cache_key in _BQ_MATCH_CACHE:
        return _BQ_MATCH_CACHE[cache_key]

    try:
        from google.cloud import bigquery

        client = bigquery.Client(project=PROJECT_ID)
        sql = SQL_03_PATH.read_text(encoding="utf-8")
        cfg = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("posting_text", "STRING", posting_text),
                bigquery.ScalarQueryParameter("needs_cold", "BOOL", needs_cold),
                bigquery.ScalarQueryParameter("needs_frozen", "BOOL", needs_frozen),
                bigquery.ScalarQueryParameter("pallets", "FLOAT64", float(pallets)),
                bigquery.ScalarQueryParameter("hours_remaining", "FLOAT64", float(hours_remaining)),
                bigquery.ScalarQueryParameter("service_date", "DATE", SERVICE_DATE),
                bigquery.ArrayQueryParameter("exclude_ids", "INT64", exclude_ids),
            ]
        )
        rows = [dict(r) for r in client.query(sql, job_config=cfg).result()]
        if not rows:
            return None

        viable_rows = [r for r in rows if r.get("viable")]
        ruled_out_rows = [r for r in rows if not r.get("viable")]

        candidates = []
        for idx, r in enumerate(viable_rows[:10], start=1):
            margin = float(r.get("margin_hours") or 0.0)
            can_self = bool(r.get("can_self_collect"))
            reefer = bool(r.get("refrigerated_transport"))
            name = r.get("name") or ""
            street = r.get("street") or ""
            city = r.get("city") or "Atlanta"
            zip_code = r.get("zip_code") or ""
            address = (
                f"{street}, {city} GA {zip_code}".strip(", ")
                if street
                else "No address on file (teaching case)"
            )
            no_veh = float(r.get("no_vehicle_rate") or 0.13)
            pov = float(r.get("poverty_rate") or 0.18)
            candidates.append(
                {
                    "recipient_id": int(r["recipient_id"]),
                    "rank": idx,
                    "semantic_rank": int(r.get("semantic_rank") or idx),
                    "viable": True,
                    "tier": int(r.get("tier") or 1),
                    "score": float(r.get("score") or 0.0),
                    "distance": float(r.get("distance") or 0.0),
                    "name": name,
                    "address": address,
                    "archetype_label": r.get("archetype_label") or "Recipient organization",
                    "cold_storage": r.get("cold_storage") or "none",
                    "max_pallets": int(r.get("max_pallets") or 1),
                    "capacity_pallets": float(r.get("capacity_pallets") or 0.25),
                    "takes_it_all": bool(r.get("takes_it_all")),
                    "pickup_window_hours": int(r.get("pickup_window_hours") or 4),
                    "can_self_collect": can_self,
                    "margin_hours": margin,
                    "margin_label": f"+{margin:g}h spare"
                    if margin >= 0
                    else f"Needs driver ({r.get('pickup_window_hours')}h window)",
                    "est_pickup_time": "Within window",
                    "refrigerated_transport": reefer,
                    "weekly_households": int(r.get("weekly_households") or 200),
                    "no_vehicle_rate": no_veh,
                    "poverty_rate": pov,
                    "food_insecurity_rate": round(min(0.45, pov * 1.12), 3),
                    "need_score": float(r.get("need_score") or 0.5),
                    "profile_source": r.get("profile_source") or "generated",
                    "why_them": r.get("profile_text") or "",
                    "what_they_can_take": f"Up to {r.get('capacity_pallets')} pallet(s) ({r.get('cold_storage')} storage).",
                    "pickup_warning": None
                    if (can_self and reefer)
                    else "Line up a volunteer driver for collection/delivery.",
                    "draft_sms": (
                        f'Hi {name}, this is the Atlanta food rescue desk. We have "{posting_text}" '
                        f"({hours_remaining:g}h window). Your {r.get('cold_storage')} storage and service profile "
                        f"make you our #1 match. Reply YES to confirm intake."
                    ),
                }
            )

        split_rows = sorted(
            [r for r in rows if r.get("split_stop") is not None],
            key=lambda x: int(x["split_stop"]),
        )
        split_plan = [
            {
                "split_stop": int(sr["split_stop"]),
                "recipient_id": int(sr["recipient_id"]),
                "name": sr.get("name"),
                "address": f"{sr.get('street') or ''}, {sr.get('city') or 'Atlanta'} GA {sr.get('zip_code') or ''}".strip(
                    ", "
                ),
                "archetype_label": sr.get("archetype_label"),
                "cold_storage": sr.get("cold_storage"),
                "share_label": f"{sr.get('split_share_pallets')} pallet(s)",
                "split_share_pallets": float(sr.get("split_share_pallets") or 0.0),
                "pickup_window_hours": int(sr.get("pickup_window_hours") or 3),
                "margin_label": f"{float(sr.get('margin_hours') or 0.0):g}h to spare",
                "est_pickup_time": "Within window",
                "food_insecurity_rate": round(min(0.45, float(sr.get("poverty_rate") or 0.25) * 1.12), 3),
                "no_vehicle_rate": float(sr.get("no_vehicle_rate") or 0.15),
                "poverty_rate": float(sr.get("poverty_rate") or 0.25),
                "warning": None,
                "draft_sms": f'Hi {sr.get("name")}, we are splitting "{posting_text}" across partner sites. Can you take {sr.get("split_share_pallets")} pallet(s) today?',
            }
            for sr in split_rows
        ]

        ruled_out = [
            {
                "name": rr.get("name"),
                "semantic_rank": int(rr.get("semantic_rank") or 99),
                "reason": "; ".join(rr.get("ruled_out_because") or ["Filtered out"]),
                "category": "filter",
            }
            for rr in sorted(ruled_out_rows, key=lambda x: int(x.get("semantic_rank") or 99))
        ]

        result = {
            "source": "live_bigquery_sql_03",
            "pipeline": {
                "found_by_meaning": len(rows),
                "viable_count": len(viable_rows),
                "ruled_out_count": len(ruled_out_rows),
                "recommended_count": min(3, len(viable_rows)),
            },
            "candidates": candidates,
            "split_plan": split_plan,
            "ruled_out": ruled_out,
        }
        _BQ_MATCH_CACHE[cache_key] = result
        return result
    except Exception as exc:
        logger.info(
            "BigQuery ADC not active locally (%s); serving frozen BigQuery snapshot.",
            type(exc).__name__,
        )
        return None


def _intake_distribution() -> tuple[int, dict[str, Any]]:
    """How many recipients have real cold storage, from BigQuery once per process."""
    global _INTAKE_DIST
    if _INTAKE_DIST is not None:
        return _INTAKE_DIST
    intake_dist = {
        "household_fridge_only": {"count": 87, "pct": 68.5},
        "walkin_commercial_van": {"count": 25, "pct": 19.7},
        "medical_or_none": {"count": 15, "pct": 11.8},
    }
    total_recs = 127
    try:
        from google.cloud import bigquery

        client = bigquery.Client(project=PROJECT_ID)
        dist_sql = f"""
        SELECT
          COUNT(*) AS total,
          COUNTIF(cold_storage = 'domestic') AS domestic_n,
          COUNTIF(cold_storage IN ('walk-in', 'commercial', 'vehicle')) AS real_cold_n,
          COUNTIF(cold_storage IN ('medical', 'none')) AS other_n
        FROM `{PROJECT_ID}.{DATASET}.recipients`
        """
        r = next(iter(client.query(dist_sql).result()))
        if r.total:
            total_recs = int(r.total)
            intake_dist = {
                "household_fridge_only": {
                    "count": int(r.domestic_n),
                    "pct": round(100.0 * r.domestic_n / total_recs, 1),
                },
                "walkin_commercial_van": {
                    "count": int(r.real_cold_n),
                    "pct": round(100.0 * r.real_cold_n / total_recs, 1),
                },
                "medical_or_none": {
                    "count": int(r.other_n),
                    "pct": round(100.0 * r.other_n / total_recs, 1),
                },
            }
            _INTAKE_DIST = (total_recs, intake_dist)
    except Exception:
        pass
    return total_recs, intake_dist


@console_router.get("/api/queue")
def api_get_queue() -> dict[str, Any]:
    """Return active Atlanta surplus offers and cold-storage network distribution."""
    total_recs, intake_dist = _intake_distribution()
    offers_summary = []
    for key in ("deli", "spinach", "dairy", "bread"):
        item = OFFERS_CATALOG[key]
        top_cand = item["candidates"][0] if item["candidates"] else None
        live = live_status(item)
        offers_summary.append(
            {
                "offer_key": key,
                "posting_id": item["posting_id"],
                "offer_code": item["offer_code"],
                "status": live["status"] if live else item["status"],
                "status_type": live["status_type"] if live else item["status_type"],
                "live": live,
                "donor_label": item["donor_label"],
                "posting_text": item["posting_text"],
                "category_tag": item["category_tag"],
                "storage_tag": item["storage_tag"],
                "pallets_label": item["pallets_label"],
                "hours_remaining": item["hours_remaining"],
                "countdown_label": item["countdown_label"],
                "dock_shutoff": item["dock_shutoff"],
                "brief_url": item["brief_url"],
                "top_match_name": top_cand["name"] if top_cand else None,
            }
        )
    return {
        "metro": "Atlanta, GA",
        "track": "Retail & Grocer Rescue",
        "total_recipients": total_recs,
        "intake_distribution": intake_dist,
        "offers": offers_summary,
    }


@console_router.get("/api/match")
def api_get_match(
    offer: str = Query("spinach", description="Offer key: spinach, deli, dairy, bread"),
    exclude_ids: str = Query("", description="Comma-separated recipient_ids to exclude"),
) -> dict[str, Any]:
    """Return Match Brief data for a specific offer, dynamically filtering excluded recipients."""
    explicit_excluded = [int(x.strip()) for x in exclude_ids.split(",") if x.strip().isdigit()]
    base = OFFERS_CATALOG.get(offer.lower(), OFFERS_CATALOG["spinach"])

    saved_excluded, claimed_elsewhere = dispatch_exclusions(base)
    excluded = sorted(set(explicit_excluded) | set(saved_excluded))

    live = _try_live_sql_match(
        posting_text=base["posting_text"],
        needs_cold=base["needs_cold"],
        needs_frozen=base["needs_frozen"],
        pallets=base["pallets"],
        hours_remaining=base["hours_remaining"],
        exclude_ids=excluded,
    )

    if live is not None and live["candidates"]:
        candidates = live["candidates"]
        pipeline = live["pipeline"]
        split_plan = live["split_plan"] or base["split_plan"]
        ruled_out = list(live["ruled_out"] or base["ruled_out"])
        data_source = "live_bigquery"
    else:
        candidates = [dict(c) for c in base["candidates"] if c["recipient_id"] not in excluded]
        for idx, c in enumerate(candidates, start=1):
            c["rank"] = idx
        pipeline = dict(base["pipeline"])
        pipeline["viable_count"] = max(1, pipeline["viable_count"] - len(excluded))
        split_plan = [s for s in base["split_plan"] if s["recipient_id"] not in excluded]
        ruled_out = list(base["ruled_out"])
        data_source = "bigquery_snapshot"

    for claim in claimed_elsewhere:
        ruled_out.insert(
            0,
            {
                "name": claim["recipient_name"],
                "semantic_rank": 1,
                "reason": f"Already matched to {claim.get('offer_code') or 'another active offer'} (prevented double-match)",
                "category": "double_match_prevented",
            },
        )

    live_state = live_status(base)
    return {
        "data_source": data_source,
        "offer_key": base["offer_key"],
        "posting_id": base["posting_id"],
        "offer_code": base["offer_code"],
        "status": live_state["status"] if live_state else base["status"],
        "status_type": live_state["status_type"] if live_state else base["status_type"],
        "live": live_state,
        "donor_label": base["donor_label"],
        "posting_text": base["posting_text"],
        "category_tag": base["category_tag"],
        "storage_tag": base["storage_tag"],
        "pallets": base["pallets"],
        "pallets_label": base["pallets_label"],
        "hours_remaining": base["hours_remaining"],
        "countdown_label": base["countdown_label"],
        "dock_shutoff": base["dock_shutoff"],
        "excluded_recipient_ids": excluded,
        "already_matched_excluded": claimed_elsewhere,
        "pipeline": pipeline,
        "primary_match": candidates[0] if candidates else None,
        "next_options": candidates[1:3] if len(candidates) > 1 else [],
        "all_viable_candidates": candidates,
        "split_plan": split_plan,
        "ruled_out": ruled_out,
    }


@console_router.post("/api/match")
def api_post_custom_match(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Run a custom surplus posting through `sql/03_filter_and_rank.sql`."""
    posting_text = str(
        payload.get("posting_text") or "10 crates of spinach, harvested yesterday, needs cold storage"
    )
    storage = str(payload.get("required_storage") or "refrigerated").lower()
    pallets = float(payload.get("pallets") or 0.2)
    hours = float(payload.get("hours_remaining") or 6.0)
    excluded = [int(x) for x in (payload.get("exclude_ids") or []) if str(x).isdigit()]
    posting = console_offer(payload)
    saved_excluded, claimed_elsewhere = dispatch_exclusions(posting)
    excluded = sorted(set(excluded) | set(saved_excluded))
    live_state = live_status(posting)

    needs_cold = storage in ("refrigerated", "cold", "frozen")
    needs_frozen = storage == "frozen"

    live = _try_live_sql_match(
        posting_text=posting_text,
        needs_cold=needs_cold,
        needs_frozen=needs_frozen,
        pallets=pallets,
        hours_remaining=hours,
        exclude_ids=excluded,
    )
    if live is not None and live["candidates"]:
        return {
            "data_source": "live_bigquery",
            "posting_text": posting_text,
            "required_storage": storage,
            "hours_remaining": hours,
            "pallets": pallets,
            "pipeline": live["pipeline"],
            "primary_match": live["candidates"][0],
            "next_options": live["candidates"][1:3],
            "all_viable_candidates": live["candidates"],
            "split_plan": live["split_plan"],
            "ruled_out": live["ruled_out"],
            "excluded_recipient_ids": excluded,
            "already_matched_excluded": claimed_elsewhere,
            "live": live_state,
        }

    pt_low = posting_text.lower()
    if any(w in pt_low for w in ("sandwich", "deli", "salad", "prepared", "meal")):
        fallback_key = "deli"
    elif any(w in pt_low for w in ("milk", "dairy", "yogurt", "cheese")):
        fallback_key = "dairy"
    elif any(w in pt_low for w in ("bread", "loaf", "loaves", "pastry", "pastries", "bakery")):
        fallback_key = "bread"
    else:
        fallback_key = "spinach"

    res = api_get_match(offer=fallback_key, exclude_ids=",".join(str(i) for i in excluded))
    res["posting_text"] = posting_text
    res["hours_remaining"] = hours
    for key in ("offer_key", "posting_id", "offer_code", "status", "status_type"):
        res.pop(key, None)
    res["live"] = live_state
    return res


@console_router.get("/api/equity-audit")
def api_get_equity_audit() -> dict[str, Any]:
    """Return the Atlanta Equity Audit benchmarks and findings across all 10 postings."""
    return EQUITY_AUDIT_DATA


@console_router.get("/api/recipients")
def api_get_recipients() -> dict[str, Any]:
    """Query `a4i_food.recipients` + `a4i_food.recipient_tracts` in BigQuery (with fallback)."""
    try:
        from google.cloud import bigquery

        client = bigquery.Client(project=PROJECT_ID)
        sql = f"""
        SELECT
          r.recipient_id,
          r.name,
          r.street,
          r.city,
          r.zip_code,
          r.archetype_label,
          r.cold_storage,
          r.max_pallets,
          r.pickup_window_hours,
          r.weekly_households,
          r.profile_source,
          rt.tract_source,
          ROUND(rt.no_vehicle_rate, 3) AS no_vehicle_rate,
          ROUND(rt.poverty_rate, 3) AS poverty_rate,
          ROUND(rt.need_score, 2) AS need_score
        FROM `{PROJECT_ID}.{DATASET}.recipients` r
        LEFT JOIN `{PROJECT_ID}.{DATASET}.recipient_tracts` rt USING (recipient_id)
        ORDER BY COALESCE(rt.need_score, 0) DESC, r.recipient_id
        LIMIT 50
        """
        rows = [dict(r) for r in client.query(sql).result()]
        if rows:
            recs = [
                {
                    "recipient_id": int(r["recipient_id"]),
                    "name": r["name"],
                    "address": f"{r.get('street') or ''}, {r.get('city') or 'Atlanta'} GA {r.get('zip_code') or ''}".strip(
                        ", "
                    ),
                    "archetype_label": r.get("archetype_label"),
                    "cold_storage": r.get("cold_storage"),
                    "max_pallets": int(r.get("max_pallets") or 0),
                    "pickup_window_hours": int(r.get("pickup_window_hours") or 0),
                    "weekly_households": int(r.get("weekly_households") or 0),
                    "no_vehicle_rate": float(r.get("no_vehicle_rate") or 0.0),
                    "poverty_rate": float(r.get("poverty_rate") or 0.0),
                    "need_score": float(r.get("need_score") or 0.5),
                    "profile_source": r.get("profile_source"),
                    "status": f"Geocoded ({r.get('tract_source') or 'tract'})",
                }
                for r in rows
            ]
            return {
                "metro": "Atlanta, GA",
                "total_corpus_count": 127,
                "real_irs_count": 118,
                "planted_count": 9,
                "recipients": recs,
                "planted_decoys_and_conflicts": OFFERS_CATALOG["spinach"]["ruled_out"],
            }
    except Exception:
        pass

    all_seen: dict[int, dict[str, Any]] = {}
    for offer in OFFERS_CATALOG.values():
        for c in offer["candidates"]:
            all_seen[c["recipient_id"]] = {
                "recipient_id": c["recipient_id"],
                "name": c["name"],
                "address": c["address"],
                "archetype_label": c["archetype_label"],
                "cold_storage": c["cold_storage"],
                "max_pallets": c["max_pallets"],
                "pickup_window_hours": c["pickup_window_hours"],
                "weekly_households": c["weekly_households"],
                "no_vehicle_rate": c["no_vehicle_rate"],
                "poverty_rate": c["poverty_rate"],
                "need_score": c["need_score"],
                "profile_source": c["profile_source"],
                "status": "Viable Partner",
            }
        for s in offer["split_plan"]:
            if s["recipient_id"] not in all_seen:
                all_seen[s["recipient_id"]] = {
                    "recipient_id": s["recipient_id"],
                    "name": s["name"],
                    "address": s["address"],
                    "archetype_label": s["archetype_label"],
                    "cold_storage": s["cold_storage"],
                    "max_pallets": 1,
                    "pickup_window_hours": s["pickup_window_hours"],
                    "weekly_households": 150,
                    "no_vehicle_rate": s["no_vehicle_rate"],
                    "poverty_rate": s["poverty_rate"],
                    "need_score": 0.85,
                    "profile_source": "generated",
                    "status": "Split-Load Partner",
                }
    return {
        "metro": "Atlanta, GA",
        "total_corpus_count": 127,
        "real_irs_count": 118,
        "planted_count": 9,
        "recipients": list(all_seen.values()),
        "planted_decoys_and_conflicts": OFFERS_CATALOG["spinach"]["ruled_out"],
    }
