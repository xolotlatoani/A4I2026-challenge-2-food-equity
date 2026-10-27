"""Person A — BigQuery Vector Search, Shelf-Life, Equity Audit, and Load-Splitting Tools.

Implements the tool functions consumed by Person B's ADK agent (`agent/agent.py`):
1. `match_surplus_posting` — Semantic search via BigQuery `VECTOR_SEARCH` + `AI.EMBED`
   with post-search operational filtering, planted decoy elimination, contradiction
   detection, and census-tract equity tie-breaking.
2. `check_shelf_life` — USDA FSIS FoodKeeper shelf-life lookup across `product_name`,
   `product_subtitle`, and `keywords`, resolving sentinel notes and effective clock.
3. `get_recipient_tract_equity` — Geospatial join (`ST_DISTANCE`) between a recipient
   organization and `a4i_food.tract_demographics`, benchmarked against Atlanta metro averages.
4. `split_large_load` — Multi-recipient load-splitting planner when a surplus donation
   exceeds any single recipient's pallet capacity.
5. `record_grocer_request` — Saves a new posting in the offer-state service
   (`agent/state_tools.py`), so `match_surplus_posting(request_id=...)` remembers who was
   asked, what they said, and how much clock is left. The other offer tools ride along in
   `TOOLS`.
6. `recommend_open_postings` — Reads every open posting from the offer-state service (Cloud
   SQL) and runs the matcher on each. `import_surplus_postings` (not a tool; see
   scripts/import_postings.py) copies BigQuery's seed postings there first.
"""

from __future__ import annotations

import os
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from google.cloud import bigquery

# One pallet reader for the agent, the offer-state service and the import (plain Python; the
# repo root is on the path wherever the agent runs).
from state_service.pallets import estimate_pallets

from . import state_tools

# ---------------------------------------------------------------------------
# Configuration (Environment-driven with safe defaults for our GCP project)
# ---------------------------------------------------------------------------
PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "qwiklabs-gcp-04-ef48e08bc216")
DATASET = os.environ.get("BIGQUERY_DATASET") or os.environ.get("BQ_DATASET", "a4i_food")
LOCATION = os.environ.get("BIGQUERY_LOCATION") or os.environ.get("BQ_LOCATION", "US")
EMBED_ENDPOINT = os.environ.get("EMBED_ENDPOINT", "gemini-embedding-2")
BQ_CONNECTION_ID = os.environ.get("BIGQUERY_CONNECTION_ID", "").strip()

_bq_client: bigquery.Client | None = None


def _get_bq_client() -> bigquery.Client:
    """Return a cached BigQuery client configured for the project and dataset location."""
    global _bq_client
    if _bq_client is None:
        project = os.environ.get("GOOGLE_CLOUD_PROJECT", PROJECT_ID)
        location = os.environ.get("BIGQUERY_LOCATION") or os.environ.get("BQ_LOCATION", LOCATION)
        _bq_client = bigquery.Client(project=project, location=location)
    return _bq_client


def _table_ref(table_name: str) -> str:
    """Return the fully-qualified backtick-quoted BigQuery table reference."""
    project = os.environ.get("GOOGLE_CLOUD_PROJECT", PROJECT_ID)
    dataset = os.environ.get("BIGQUERY_DATASET") or os.environ.get("BQ_DATASET", DATASET)
    return f"`{project}.{dataset}.{table_name}`"


def _ai_embed_sql(expr: str) -> str:
    """Build the `AI.EMBED(...)` SQL expression, optionally including `connection_id`."""
    endpoint = os.environ.get("EMBED_ENDPOINT", EMBED_ENDPOINT)
    conn = os.environ.get("BIGQUERY_CONNECTION_ID", BQ_CONNECTION_ID).strip()
    if conn:
        return f"AI.EMBED({expr}, endpoint => '{endpoint}', connection_id => '{conn}')"
    return f"AI.EMBED({expr}, endpoint => '{endpoint}')"


# ---------------------------------------------------------------------------
# The data lane's queries (`sql/`), shared with the Toolbox tools and the equity audit
# ---------------------------------------------------------------------------
SQL_DIR = Path(__file__).resolve().parent.parent / "sql"

# What each tier of sql/03_filter_and_rank.sql means, for the Match Brief.
_TIER_MEANING = {
    1: "takes the whole load and collects with 30+ minutes to spare",
    2: "takes the whole load but collects with under 30 minutes to spare",
    3: "takes the whole load but needs a volunteer driver",
    4: "takes part of the load and collects it: a split-load stop",
    5: "takes part of the load and needs a volunteer driver",
}


def _run_sql_file(filename: str, params: list[Any]) -> list[dict[str, Any]]:
    """Run one of the parameterized queries in `sql/` against our project and dataset."""
    dataset = os.environ.get("BIGQUERY_DATASET", DATASET)
    sql = (SQL_DIR / filename).read_text().replace("`a4i_food.", f"`{dataset}.")
    job_config = bigquery.QueryJobConfig(query_parameters=params)
    return [dict(r) for r in _get_bq_client().query(sql, job_config=job_config).result()]


def _recipient_facts(recipient_ids: list[int]) -> dict[int, dict[str, Any]]:
    """Rows of the `recipient_facts` view (sql/05_recipient_facts.sql), keyed by recipient_id."""
    if not recipient_ids:
        return {}
    sql = f"SELECT * FROM {_table_ref('recipient_facts')} WHERE recipient_id IN UNNEST(@ids)"
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("ids", "INT64", [int(i) for i in recipient_ids]),
    ])
    return {int(r["recipient_id"]): dict(r)
            for r in _get_bq_client().query(sql, job_config=job_config).result()}


def _tract_equity(facts: dict[str, Any]) -> dict[str, Any]:
    """One recipient's tract and need from a `recipient_facts` row.

    The tract is the one its street address geocodes to. Rates are None when there is no
    address on file (the planted teaching rows): their coordinates are made up, so they have no
    tract, and the matcher scores their need as neutral rather than inventing one.
    """
    def num(key: str, digits: int = 4) -> float | None:
        value = facts.get(key)
        return None if value is None else round(float(value), digits)

    pov, no_veh, asst = num("poverty_rate"), num("no_vehicle_rate"), num("assistance_rate")
    m_pov, m_veh, m_asst = (num("metro_poverty_rate"), num("metro_no_vehicle_rate"),
                            num("metro_assistance_rate"))
    known = pov is not None and no_veh is not None
    return {
        "tract_geo_id": facts.get("tract_geo_id"),
        "tract_source": facts.get("tract_source"),
        "poverty_rate": pov,
        "no_vehicle_rate": no_veh,
        "assistance_rate": asst,
        "tract_median_income": num("tract_median_income", 0),
        "need_percentile": num("need_score", 3),
        "equity_need_index": round(0.50 * pov + 0.30 * no_veh + 0.20 * (asst or 0.0), 4) if known else None,
        "metro_poverty_rate": m_pov,
        "metro_no_vehicle_rate": m_veh,
        "metro_assistance_rate": m_asst,
        "metro_equity_need_index": (round(0.50 * m_pov + 0.30 * m_veh + 0.20 * m_asst, 4)
                                    if None not in (m_pov, m_veh, m_asst) else None),
        "above_metro_need_average": bool(facts.get("above_metro_need")) if known else None,
    }


def _need_text(equity: dict[str, Any]) -> str:
    """A tract's need in one phrase, for explanations."""
    if equity.get("poverty_rate") is None:
        return "need unknown (no street address on file, so scored as neutral)"
    return (f"need percentile {equity['need_percentile']:.2f} in Tract {equity['tract_geo_id']} "
            f"(poverty {equity['poverty_rate']:.1%}, no-vehicle {equity['no_vehicle_rate']:.1%})")


def _elimination_category(reasons: list[str], cand: dict[str, Any]) -> str:
    """Map sql/03_filter_and_rank.sql's ruled_out_because to this tool's categories."""
    text = " ".join(reasons)
    if "no refrigeration" in text:
        is_decoy = "fresh greens" in str(cand.get("profile_text") or "").lower()
        return "near_miss_decoy_no_cold_storage" if is_decoy else "storage_incompatible"
    if "no freezer" in text or "medical fridge" in text:
        return "storage_incompatible"
    if "opening days conflict" in text:
        return "opening_days_conflict"
    if "not open in time" in text:
        return "not_open_in_time"
    return "operational_constraint"


# ---------------------------------------------------------------------------
# Helper: Ensure `recipient_embeddings` exists in BigQuery
# ---------------------------------------------------------------------------
def ensure_embeddings_table() -> dict[str, Any]:
    """Materialize `a4i_food.recipient_embeddings` using `AI.EMBED` if not already present.

    Follows the 4 rules from Section 14 of `c2_01_load_explore.ipynb`:
    1. Extracts `.result AS embedding` from the `STRUCT<result ARRAY<FLOAT64>, status STRING>`.
    2. Filters `WHERE embedded.status = ''` so failed embeddings never pollute rankings.
    3. Keeps table in `US` location for brute-force `VECTOR_SEARCH`.
    """
    client = _get_bq_client()
    emb_table = _table_ref("recipient_embeddings")
    rec_table = _table_ref("recipients")
    embed_call = _ai_embed_sql("r.profile_text")

    sql = f"""
    CREATE OR REPLACE TABLE {emb_table} AS
    SELECT
      * EXCEPT (embedded),
      embedded.result AS embedding
    FROM (
      SELECT r.*, {embed_call} AS embedded
      FROM {rec_table} r
    )
    WHERE embedded.status = ''
    """
    job = client.query(sql)
    job.result()

    count_row = next(iter(client.query(f"SELECT COUNT(*) AS n FROM {emb_table}").result()))
    return {
        "status": "ok",
        "table": emb_table.strip("`"),
        "rows_embedded": int(count_row.n),
        "embed_endpoint": os.environ.get("EMBED_ENDPOINT", EMBED_ENDPOINT),
    }


# ---------------------------------------------------------------------------
# Helper: Contradiction & Operational Constraint Checkers
# ---------------------------------------------------------------------------
def _detect_profile_contradictions(row: dict[str, Any]) -> list[str]:
    """Detect contradictions between structured columns and free-text `profile_text`,
    or internal contradictions within `profile_text` (e.g., Harborview Neighbors Trust).
    """
    contradictions: list[str] = []
    text = str(row.get("profile_text") or "")
    text_lower = text.lower()
    cold = str(row.get("cold_storage") or "none").lower()
    frozen = bool(row.get("frozen_storage"))
    max_pallets = int(row.get("max_pallets") or 0)

    # 1. Claims walk-in/freezer/pallets, but also states single shelf in a shared cupboard / no freezer
    if ("single shelf in a shared cupboard" in text_lower or "shared cupboard" in text_lower) and (
        cold in ("walk-in", "commercial", "medical", "vehicle") or max_pallets >= 2
    ):
        contradictions.append(
            f"Structured record and opening sentence claim cold_storage='{cold}' and "
            f"max_pallets={max_pallets}, but profile_text contradicts this: "
            "'Storage is a single shelf in a shared cupboard and we have no freezer at present.'"
        )

    if "we have no freezer" in text_lower and (frozen or "walk-in freezer" in text_lower):
        msg = (
            "Profile claims frozen_storage=True / 'walk-in freezer' in one sentence, "
            "but states 'we have no freezer at present' in another."
        )
        if msg not in contradictions:
            contradictions.append(msg)

    # 2. Structured cold_storage is 'none' but profile text claims walk-in/commercial refrigeration
    if cold == "none" and re.search(
        r"\b(walk-in cooler|walk-in cold|reach-in cooler|reefer|chilled holding|cold chain capacity)\b",
        text_lower,
    ):
        if "no " not in text_lower and "without " not in text_lower and "not " not in text_lower:
            contradictions.append(
                "Structured cold_storage='none', but profile_text describes active commercial refrigeration."
            )

    # 3. Structured cold_storage is 'walk-in' but profile text says household/domestic fridge only
    if cold == "walk-in" and re.search(
        r"\b(one household refrigerator|one domestic refrigerator|household refrigeration only|single fridge behind the counter)\b",
        text_lower,
    ):
        contradictions.append(
            "Structured cold_storage='walk-in', but profile_text describes only a single household refrigerator."
        )

    return contradictions


# "no refrigeration needed", "does not need cold storage": the posting rules cold storage out.
_NO_COLD = re.compile(r"\b(?:no|not|without|never)\s+(?:need(?:s|ed)?\s+)?(?:any\s+)?(?:refrigerat|cold|chill)")


def _normalize_storage_requirement(required_storage: str, posting_text: str = "") -> str:
    """Normalize storage requirement into 'refrigerated', 'frozen', or 'shelf-stable'."""
    s = (required_storage or "").strip().lower()
    pt = (posting_text or "").strip().lower()
    rules_out_cold = bool(_NO_COLD.search(pt))

    if any(k in s for k in ("frozen", "freezer", "ice")):
        return "frozen"
    if any(k in s for k in ("refrigerat", "cold", "chill", "cooler", "produce", "dairy", "perishable", "deli")):
        return "refrigerated"
    if any(k in s for k in ("pantry", "shelf", "ambient", "dry", "room")):
        # Double-check posting text in case caller left default or passed pantry for cold item
        if not rules_out_cold and any(k in pt for k in ("cold storage", "cold chain", "refrigerat", "needs cold")):
            return "refrigerated"
        return "shelf-stable"

    # Fallback inference from posting_text
    if any(k in pt for k in ("frozen", "freezer")):
        return "frozen"
    if not rules_out_cold and any(k in pt for k in ("cold", "refrigerat", "spinach", "milk", "yogurt", "dairy", "deli", "sandwiches", "salads", "blueberries")):
        return "refrigerated"
    return "shelf-stable"


def _infer_food_item(posting_text: str, food_item: str = "") -> str:
    """Infer a concise FoodKeeper lookup term from `food_item` or `posting_text`."""
    if food_item and food_item.strip():
        return food_item.strip()

    pt = (posting_text or "").lower()
    known_mappings = [
        ("spinach", "spinach"),
        ("lettuce", "lettuce"),
        ("salad", "leftovers"),
        ("sandwich", "leftovers"),
        ("deli", "leftovers"),
        ("milk", "milk"),
        ("yogurt", "yogurt"),
        ("dairy", "milk"),
        ("bread", "bread"),
        ("pastr", "bread"),
        ("potato", "potatoes"),
        ("blueberr", "blueberries"),
        ("berr", "berries"),
        ("winter squash", "spaghetti squash"),
        ("squash", "squash"),
        ("sealed infant formula", "liquid concentrate or ready-to-feed formula"),
        ("nutritional supplement", "formula"),
        ("formula", "formula"),
        ("diaper", "diapers"),
        ("chicken", "chicken"),
        ("beef", "beef"),
        ("pork", "pork"),
        ("apple", "apples"),
        ("tomato", "tomatoes"),
        ("egg", "eggs"),
    ]
    for keyword, mapped in known_mappings:
        if keyword in pt:
            return mapped

    # Fallback: strip numbers/units and return first meaningful words
    cleaned = re.sub(r"\b(\d+|crates|crate|pallets|pallet|cases|case|gallons|loaves|tons|bins|of|about|roughly)\b", " ", pt)
    words = [w for w in re.findall(r"[a-z]+", cleaned) if len(w) > 2]
    return " ".join(words[:3]) if words else posting_text.strip()


def _given_pallets(posting_text: str, pallets_needed: float) -> float | None:
    """The caller's pallet figure, or None when there is none to trust: 0, or the posting's own
    count passed as pallets ("10 crates" -> 10), which the reader turns into pallets instead."""
    given = float(pallets_needed or 0)
    if given <= 0:
        return None
    read = estimate_pallets(posting_text)
    if read.count is not None and read.unit != "pallet" and abs(given - read.count) < 1e-9:
        return None
    return given


def _pallet_equivalent(posting_text: str, pallets_needed: float) -> tuple[float, str | None]:
    """Pallets for capacity matching, and a note when they were read from the posting."""
    given = _given_pallets(posting_text, pallets_needed)
    if given is not None:
        return given, None
    read = estimate_pallets(posting_text)
    return read.pallets, f"Pallets {read.basis}."


# ---------------------------------------------------------------------------
# Tool 1: `check_shelf_life`
# ---------------------------------------------------------------------------
def check_shelf_life(
    food_item: str,
    storage_state: str = "refrigerated",
    donor_deadline_hours: float = 0.0,
) -> dict[str, Any]:
    """Look up USDA FSIS FoodKeeper shelf-life guidance in `a4i_food.shelf_life`.

    Searches across `product_name`, `product_subtitle` (crucial because 'Spinach' lives
    in `product_subtitle` on `product_name='Lettuce'`), and `keywords`. Computes the
    effective dispatch clock as `MIN(donor_deadline_hours, shelf_life_hours)`.

    Args:
        food_item: Name or description of the food product (e.g., "spinach", "milk", "bread").
        storage_state: Storage condition ("refrigerated", "pantry", "shelf-stable", "frozen").
        donor_deadline_hours: Hours available stated by the donor (0 if not specified).

    Returns:
        Dictionary with matched FoodKeeper row, `shelf_life_hours`, `effective_window_hours`,
        `clock_limiting_factor`, and sentinel note explanation.
    """
    client = _get_bq_client()
    shelf_table = _table_ref("shelf_life")
    surplus_table = _table_ref("surplus_postings")

    query_term = _infer_food_item(food_item, food_item).lower().strip()
    norm_storage = _normalize_storage_requirement(storage_state, food_item)
    is_sealed = "sealed" in (food_item or "").lower()

    # Non-food short-circuit (e.g., diapers/wipes)
    if any(k in query_term for k in ("diaper", "wipe", "hygiene", "toiletries")):
        eff = float(donor_deadline_hours) if donor_deadline_hours > 0 else 720.0
        return {
            "queried_item": food_item,
            "matched_product": None,
            "category": "Non-food essentials",
            "storage_state": norm_storage,
            "shelf_life_hours": None,
            "donor_deadline_hours": float(donor_deadline_hours) if donor_deadline_hours > 0 else None,
            "effective_window_hours": eff,
            "clock_limiting_factor": "donor_deadline (non-food item not tracked in USDA FoodKeeper)",
            "storage_note": "non_food_essential",
            "guidance_summary": (
                f"'{food_item}' is a non-food essential not tracked by USDA FoodKeeper. "
                f"Using donor pickup window of {eff:.1f} hours."
            ),
        }

    # Build tokens for flexible matching
    tokens = [t for t in re.findall(r"[a-z]+", query_term) if len(t) > 2]
    primary_token = tokens[0] if tokens else query_term

    sql = f"""
    WITH scored AS (
      SELECT
        product_id,
        product_name,
        product_subtitle,
        keywords,
        category,
        refrigerated_hours,
        refrigerated_note,
        pantry_hours,
        pantry_note,
        CASE
          WHEN LOWER(product_name) = @exact THEN 100
          WHEN LOWER(IFNULL(product_subtitle, '')) LIKE CONCAT('%', @exact, '%') THEN 95
          WHEN LOWER(product_name) LIKE CONCAT('%', @exact, '%') THEN 85
          WHEN LOWER(IFNULL(keywords, '')) LIKE CONCAT('%', @exact, '%') THEN 75
          WHEN LOWER(IFNULL(product_subtitle, '')) LIKE CONCAT('%', @token, '%') THEN 70
          WHEN LOWER(product_name) LIKE CONCAT('%', @token, '%') THEN 65
          WHEN LOWER(IFNULL(keywords, '')) LIKE CONCAT('%', @token, '%') THEN 55
          ELSE 0
        END AS match_score
      FROM {shelf_table}
    )
    SELECT *
    FROM scored
    WHERE match_score > 0
    ORDER BY
      match_score DESC,
      -- Prefer rows that have a numeric hour figure for the requested storage state
      CASE
        WHEN @storage = 'refrigerated' AND refrigerated_hours IS NOT NULL THEN 0
        WHEN @storage != 'refrigerated' AND pantry_hours IS NOT NULL THEN 0
        ELSE 1
      END ASC,
      product_id ASC
    LIMIT 5
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("exact", "STRING", query_term),
            bigquery.ScalarQueryParameter("token", "STRING", primary_token),
            bigquery.ScalarQueryParameter("storage", "STRING", norm_storage),
        ]
    )
    rows = [dict(r) for r in client.query(sql, job_config=job_config).result()]

    # Fallback: check if `surplus_postings` has a pre-linked `foodkeeper_product`
    if not rows:
        fallback_sql = f"""
        SELECT f.*
        FROM {surplus_table} s
        JOIN {shelf_table} f ON LOWER(f.product_name) = LOWER(s.foodkeeper_product)
        WHERE LOWER(s.posting_text) LIKE CONCAT('%', @token, '%')
        LIMIT 1
        """
        fb_config = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", primary_token)]
        )
        rows = [dict(r) for r in client.query(fallback_sql, job_config=fb_config).result()]

    if not rows:
        eff = float(donor_deadline_hours) if donor_deadline_hours > 0 else 24.0
        return {
            "queried_item": food_item,
            "matched_product": None,
            "category": "Unmatched",
            "storage_state": norm_storage,
            "shelf_life_hours": None,
            "donor_deadline_hours": float(donor_deadline_hours) if donor_deadline_hours > 0 else None,
            "effective_window_hours": eff,
            "clock_limiting_factor": "donor_deadline (no exact FoodKeeper row matched)",
            "storage_note": None,
            "guidance_summary": (
                f"No USDA FoodKeeper entry matched '{food_item}'. "
                f"Defaulting to donor window of {eff:.1f} hours."
            ),
        }

    best = rows[0]
    if norm_storage == "refrigerated":
        raw_hours = best.get("refrigerated_hours")
        note = best.get("refrigerated_note")
    else:
        raw_hours = best.get("pantry_hours")
        note = best.get("pantry_note")

    shelf_hours: float | None = float(raw_hours) if raw_hours is not None else None

    # Guardrail from Section 13: a sealed donation must NEVER inherit an after-opening 1-hour shelf life
    if is_sealed and shelf_hours is not None and shelf_hours < 24.0:
        shelf_hours = None
        note = "sealed_package_use_expiry_date"

    donor_hrs: float | None = float(donor_deadline_hours) if donor_deadline_hours and donor_deadline_hours > 0 else None

    if donor_hrs is not None and shelf_hours is not None:
        effective_hours = min(donor_hrs, shelf_hours)
        limiting = (
            "donor_deadline"
            if donor_hrs <= shelf_hours
            else "foodkeeper_shelf_life"
        )
    elif donor_hrs is not None:
        effective_hours = donor_hrs
        limiting = f"donor_deadline (FoodKeeper note: {note or 'no numeric hours for this state'})"
    elif shelf_hours is not None:
        effective_hours = shelf_hours
        limiting = "foodkeeper_shelf_life"
    else:
        effective_hours = 24.0
        limiting = f"default_24h (FoodKeeper note: {note or 'none'})"

    subtitle_str = f" ({best['product_subtitle']})" if best.get("product_subtitle") else ""
    matched_label = f"{best['product_name']}{subtitle_str}"

    return {
        "queried_item": food_item,
        "matched_product": matched_label,
        "product_id": best.get("product_id"),
        "product_name": best.get("product_name"),
        "product_subtitle": best.get("product_subtitle"),
        "category": best.get("category"),
        "storage_state": norm_storage,
        "shelf_life_hours": shelf_hours,
        "donor_deadline_hours": donor_hrs,
        "effective_window_hours": effective_hours,
        "clock_limiting_factor": limiting,
        "storage_note": note,
        "refrigerated_hours": best.get("refrigerated_hours"),
        "refrigerated_note": best.get("refrigerated_note"),
        "pantry_hours": best.get("pantry_hours"),
        "pantry_note": best.get("pantry_note"),
        "guidance_summary": (
            f"Matched '{food_item}' to USDA FoodKeeper '{matched_label}' "
            f"(category: {best.get('category')}). "
            f"FoodKeeper {norm_storage} shelf life: "
            f"{f'{shelf_hours:.0f}h' if shelf_hours is not None else f'N/A (note: {note})'}. "
            f"Donor window: {f'{donor_hrs:.0f}h' if donor_hrs is not None else 'not specified'}. "
            f"Effective dispatch clock: {effective_hours:.0f} hours ({limiting})."
        ),
    }


# ---------------------------------------------------------------------------
# Tool 2: `get_recipient_tract_equity`
# ---------------------------------------------------------------------------
def get_recipient_tract_equity(recipient_name_or_id: str) -> dict[str, Any]:
    """Fetch Census Tract ACS equity metrics for a recipient organization in Atlanta.

    Runs `sql/06_recipient_equity.sql` over the `a4i_food.recipient_facts` view: the census
    tract the recipient's street address geocodes to, its `poverty_rate`, `no_vehicle_rate`,
    `assistance_rate` and need percentile, benchmarked against population-weighted Atlanta
    metro averages (Section 11 Equity Audit). Recipients with no address on file (the planted
    teaching rows) have no tract, and the result says their need is unknown.

    Args:
        recipient_name_or_id: Recipient organization name (substring or exact) or numeric `recipient_id`.

    Returns:
        Dictionary with recipient metadata, nearest census tract `geo_id`, poverty/no-vehicle/SNAP
        rates, Atlanta metro baseline averages, and an equity audit interpretation.
    """
    rows = _run_sql_file("06_recipient_equity.sql", [
        bigquery.ScalarQueryParameter("recipient", "STRING", str(recipient_name_or_id).strip()),
    ])
    if not rows:
        return {
            "status": "not_found",
            "queried_recipient": recipient_name_or_id,
            "message": f"No recipient organization matched '{recipient_name_or_id}' in {_table_ref('recipient_facts')}.",
        }

    row = rows[0]
    equity = _tract_equity(row)
    if equity["poverty_rate"] is None:
        summary = (
            f"{row['name']} has no street address on file (a planted teaching case), so it has no "
            "census tract and its neighborhood need is unknown. The matcher treats it as neutral."
        )
    else:
        located = (
            "located from its street address" if equity["tract_source"] == "geocoded"
            else "approximate: the nearest tract to its ZIP code"
        )
        summary = (
            f"{row['name']} sits in Census Tract {equity['tract_geo_id']} ({located}). "
            f"Poverty rate: {equity['poverty_rate']:.1%} vs. Atlanta metro {equity['metro_poverty_rate']:.1%}; "
            f"households with no vehicle: {equity['no_vehicle_rate']:.1%} vs. metro {equity['metro_no_vehicle_rate']:.1%}; "
            f"households on public assistance or SNAP: {equity['assistance_rate']:.1%} vs. metro "
            f"{equity['metro_assistance_rate']:.1%}. Need percentile {equity['need_percentile']:.2f} "
            "among the metro's tracts (0.5 is the middle)."
        )

    return {
        "status": "ok",
        "recipient_id": int(row["recipient_id"]),
        "name": row["name"],
        "address": f"{row.get('street') or ''}, {row.get('city') or 'Atlanta'}, {row.get('state') or 'GA'} {row.get('zip_code') or ''}".strip(", "),
        "archetype_label": row.get("archetype_label"),
        "cold_storage": row.get("cold_storage"),
        "max_pallets": int(row.get("max_pallets") or 0),
        "weekly_households": int(row.get("weekly_households") or 0),
        "tract_geo_id": equity["tract_geo_id"],
        "tract_source": equity["tract_source"],
        "tract_population": int(row.get("tract_population") or 0),
        "tract_median_income": equity["tract_median_income"],
        "poverty_rate": equity["poverty_rate"],
        "no_vehicle_rate": equity["no_vehicle_rate"],
        "assistance_rate": equity["assistance_rate"],
        "need_percentile": equity["need_percentile"],
        "equity_need_index": equity["equity_need_index"],
        "atlanta_metro_benchmarks": {
            "metro_poverty_rate": equity["metro_poverty_rate"],
            "metro_no_vehicle_rate": equity["metro_no_vehicle_rate"],
            "metro_assistance_rate": equity["metro_assistance_rate"],
            "metro_equity_need_index": equity["metro_equity_need_index"],
            "total_metro_tracts": int(row.get("metro_tracts") or 0),
        },
        "above_metro_need_average": equity["above_metro_need_average"],
        "other_name_matches": [r["name"] for r in rows[1:]],
        "equity_summary": summary,
    }


# ---------------------------------------------------------------------------
# Tool 3: `match_surplus_posting`
# ---------------------------------------------------------------------------
def match_surplus_posting(
    posting_text: str,
    required_storage: str = "refrigerated",
    pallets_needed: float = 0.0,
    donor_deadline_hours: float = 6.0,
    food_item: str = "",
    top_k: int = 10,
    exclude_recipient_ids: list[int] | None = None,
    request_id: str = "",
) -> dict[str, Any]:
    """Match a surplus donation posting to recipient organizations using BigQuery `VECTOR_SEARCH`.

    With a `request_id` from `record_grocer_request`, the posting, storage and food item come
    from the saved request, and the match uses what the offer-state service says is left: the
    hours until the stored deadline, the pallets nobody has accepted or is still considering,
    and leaves out everyone already asked about this request or on hold. Each such match is
    saved as a match run, whose id `record_offer` takes.

    Pipeline:
    1. Resolves USDA FoodKeeper shelf life (`check_shelf_life`) to compute `effective_window_hours`
       (`MIN(donor_deadline_hours, shelf_life_hours)`).
    2. Runs the data lane's matcher, `sql/03_filter_and_rank.sql`: embeds `posting_text` with
       `AI.EMBED(..., endpoint => 'gemini-embedding-2')`, brute-force `VECTOR_SEARCH` over
       `a4i_food.recipient_embeddings`, then in the same query:
       - Eliminates semantic near-miss decoys (e.g., `Greenline Community Pantry`, which wants
         fresh greens but has `cold_storage='none'`) and anyone not open before the deadline.
       - Holds profile contradictions for a phone call (e.g., `Harborview Neighbors Trust`, which
         claims a walk-in freezer and then a single cupboard shelf with no freezer), and opening
         days that disagree between profile text and `service_days`.
       - Ranks survivors in pickup tiers (takes it all and self-collects first; volunteer driver
         and split-load stops after), then by a score of semantic fit and the need of the census
         tract each recipient's street address geocodes to. Need counts more as the clock
         lengthens: 0.3 of the score at 6 hours or less, 0.6 at 72 hours or more.
       - Proposes a split plan of up to three stops when nobody takes the whole load comfortably.
    3. Describes each recipient for the Match Brief from the `a4i_food.recipient_facts` view,
       and explains genuine operational ties (e.g., `Cedar Street Produce Alliance` vs.
       `Maple Street Produce Alliance`).

    Args:
        posting_text: Raw free-text surplus posting from a grocer, farm, or donor.
        required_storage: Required temperature regime ("refrigerated", "frozen", or "shelf-stable").
        pallets_needed: Size of the load in pallets; fractions are fine. Leave at 0 to read it
            from the posting's words (10 crates of produce is about 0.18 pallet).
        donor_deadline_hours: Hours before donor pickup window closes.
        food_item: Optional explicit food product name for USDA FoodKeeper lookup.
        top_k: Number of top viable candidates to return (default 10).
        exclude_recipient_ids: Recipients who already said no ("they said no, who's next?").
            With a `request_id` these are added to the ones the service remembers.
        request_id: The saved request to match, from `record_grocer_request`. Leave empty to
            match a posting without remembering anything.

    Returns:
        Structured dictionary with `clock`, `ranked_matches`, `eliminated_near_misses`,
        `flagged_contradictions`, `tie_break_analysis`, `split_plan`, and
        `equity_audit_summary`, and `already_matched_excluded` (recipients left out because a
        live offer on another request has them tied up); with a `request_id`, also `request`
        (its offers so far, `match_run_id`); `state_warning` if the service could not be reached.
    """
    # Step 0: A recorded request brings its own memory: the posting as it came in, the clock
    # actually left, the pallets nobody has claimed, and everyone already asked or on hold.
    request = None
    state_warning = None
    if request_id:
        try:
            request = state_tools.get_request_state(request_id)
        except Exception as exc:  # noqa: BLE001
            state_warning = state_tools.failure(exc)
        if request is not None:
            summary = state_tools.summarize_request(request)
            if request["current_status"] != "open" or float(request["hours_remaining"]) <= 0:
                return {"status": f"request_{request['current_status']}", "request": summary,
                        "message": f"This request is {request['current_status']}; there is "
                                   "nothing left to match."}
            if float(request["unclaimed_pallets"]) <= 0:
                return {"status": "fully_claimed", "request": summary,
                        "message": "Every pallet is accepted or waiting on a reply. Record a "
                                   "decline or withdraw an offer before matching again."}
            posting_text = request["posting_text"]
            required_storage = request["required_storage"]
            food_item = request["food_item"] or food_item
            pallets_needed = float(request["unclaimed_pallets"])
            donor_deadline_hours = float(request["hours_remaining"])
            exclude_recipient_ids = sorted(
                set(exclude_recipient_ids or []) | set(request["exclude_ids"]))

    norm_storage = _normalize_storage_requirement(required_storage, posting_text)
    inferred_item = _infer_food_item(posting_text, food_item)
    if request is not None:   # stored in pallets already
        effective_pallets, pallet_note = float(pallets_needed), None
    else:
        effective_pallets, pallet_note = _pallet_equivalent(posting_text, pallets_needed)

    # Step 1: Compute the clock from USDA FoodKeeper + donor deadline
    clock = check_shelf_life(
        food_item=inferred_item,
        storage_state=norm_storage,
        donor_deadline_hours=donor_deadline_hours,
    )
    effective_window_hours = float(clock.get("effective_window_hours") or donor_deadline_hours or 6.0)

    # Step 2: Search, filter and rank with the data lane's matcher, sql/03_filter_and_rank.sql:
    # VECTOR_SEARCH, then storage / opening-day / contradiction checks with a reason for every
    # elimination, pickup tiers, a score of semantic fit and the need of each recipient's
    # geocoded tract (need counts more as the clock lengthens), and a split plan. The agent, the
    # SQL tools and the equity audit all rank with this one query.
    # Also leave out recipients tied up by a live offer on another request, so two grocers
    # never book the same van or fridge at once. A saved request already counts them in its
    # exclusions; an unsaved posting asks the service for every live offer.
    if request is not None:
        busy = request.get("busy_elsewhere", [])
    elif state_tools.state_service_url():
        try:
            busy = state_tools.live_offers()
        except Exception as exc:  # noqa: BLE001
            busy, state_warning = [], state_tools.failure(exc)
    else:
        busy = []
    claimed_elsewhere = [state_tools.dispatch_entry(b) for b in busy]
    combined_exclude_ids = sorted(
        {int(i) for i in (exclude_recipient_ids or [])} | {int(b["recipient_id"]) for b in busy})

    params = [
        bigquery.ScalarQueryParameter("posting_text", "STRING", posting_text),
        bigquery.ScalarQueryParameter("needs_cold", "BOOL", norm_storage == "refrigerated"),
        bigquery.ScalarQueryParameter("needs_frozen", "BOOL", norm_storage == "frozen"),
        bigquery.ScalarQueryParameter("pallets", "FLOAT64", effective_pallets),
        bigquery.ScalarQueryParameter("hours_remaining", "FLOAT64", effective_window_hours),
        bigquery.ScalarQueryParameter("service_date", "DATE", None),   # today in Atlanta
        bigquery.ArrayQueryParameter("exclude_ids", "INT64", combined_exclude_ids),
    ]
    try:
        rows = _run_sql_file("03_filter_and_rank.sql", params)
    except Exception as exc:
        # Auto-heal if `recipient_embeddings` table was not materialized yet
        if "Not found: Table" in str(exc) and "recipient_embeddings" in str(exc):
            ensure_embeddings_table()
            rows = _run_sql_file("03_filter_and_rank.sql", params)
        else:
            raise
    facts = _recipient_facts([r["recipient_id"] for r in rows])

    ranked_matches: list[dict[str, Any]] = []
    eliminated_near_misses: list[dict[str, Any]] = []
    flagged_contradictions: list[dict[str, Any]] = []
    split_plan: list[dict[str, Any]] = []

    for row in rows:  # already in the query's rank order, viable first
        cand = {**facts.get(int(row["recipient_id"]), {}), **row}
        name = str(cand.get("name") or "")
        cold = str(cand.get("cold_storage") or "none").lower()
        frozen = bool(cand.get("frozen_storage"))
        dock = bool(cand.get("loading_dock"))
        reefer = bool(cand.get("refrigerated_transport"))
        max_pallets = int(cand.get("max_pallets") or 0)
        capacity = float(cand.get("capacity_pallets") or 0.0)
        pickup_win = int(cand.get("pickup_window_hours") or 0)
        households = int(cand.get("weekly_households") or 0)
        dist = float(cand.get("distance") or 1.0)
        sem_sim = round(max(0.0, 1.0 - (dist / 2.0)), 4)
        vector_rank = int(cand.get("semantic_rank") or 0)
        reasons = list(cand.get("ruled_out_because") or [])
        # Need comes from the facts row: the query scores an unknown tract as a neutral 0.5,
        # but the Match Brief should say it is unknown.
        tract_equity = _tract_equity(facts.get(int(row["recipient_id"]), {}))

        address_parts = [
            str(cand.get("street") or "").strip(),
            str(cand.get("city") or "Atlanta").strip(),
            f"{str(cand.get('state') or 'GA').strip()} {str(cand.get('zip_code') or '').strip()}".strip(),
        ]
        address = ", ".join(p for p in address_parts if p)

        if cand.get("split_stop"):
            split_plan.append({
                "split_stop": int(cand["split_stop"]),
                "recipient_id": int(cand["recipient_id"]),
                "name": name,
                "pallets": float(cand.get("split_share_pallets") or 0.0),
            })

        # 1. Profile contradictions (e.g. Harborview Neighbors Trust): hold for a phone call
        if any(r.startswith("profile contradicts") for r in reasons):
            contradictions = _detect_profile_contradictions(cand) or reasons
            flagged_contradictions.append({
                "recipient_id": int(cand["recipient_id"]),
                "name": name,
                "raw_vector_rank": vector_rank,
                "vector_distance": round(dist, 4),
                "structured_claims": {
                    "cold_storage": cold,
                    "frozen_storage": frozen,
                    "max_pallets": max_pallets,
                },
                "profile_text": cand.get("profile_text"),
                "contradiction_reasons": contradictions,
                "recommended_action": (
                    "Hold automatic dispatch and verify storage capacity by phone — "
                    "profile text directly contradicts structured cold-storage/pallet flags."
                ),
            })
            eliminated_near_misses.append({
                "recipient_id": int(cand["recipient_id"]),
                "name": name,
                "raw_vector_rank": vector_rank,
                "vector_distance": round(dist, 4),
                "cold_storage": cold,
                "max_pallets": max_pallets,
                "elimination_category": "profile_contradiction",
                "elimination_reason": " | ".join(contradictions),
                "profile_text": cand.get("profile_text"),
            })
            continue

        # 2. Ruled out by the query: storage, not open in time, or opening days to confirm by phone
        if not cand.get("viable"):
            days_conflict = next((r for r in reasons if r.startswith("opening days conflict")), None)
            # Record if it ranked in top 15 semantically, is a planted case, or needs a phone call
            if vector_rank <= 15 or cand.get("profile_source") == "planted" or days_conflict:
                eliminated_near_misses.append({
                    "recipient_id": int(cand["recipient_id"]),
                    "name": name,
                    "raw_vector_rank": vector_rank,
                    "vector_distance": round(dist, 4),
                    "semantic_similarity": sem_sim,
                    "cold_storage": cold,
                    "frozen_storage": frozen,
                    "max_pallets": max_pallets,
                    "elimination_category": _elimination_category(reasons, cand),
                    "elimination_reason": "; ".join(reasons),
                    "opening_days_conflict_note": days_conflict,
                    "profile_text": cand.get("profile_text"),
                })
            continue

        # 3. Viable: the query's rank and score stand; describe them for the Match Brief
        tier = int(cand.get("tier") or 5)
        can_self_collect = bool(cand.get("can_self_collect"))
        margin = float(cand.get("margin_hours") or 0.0)
        first_open = cand.get("first_open_date")

        why_fit_parts = [
            f"Semantic match (vector distance {dist:.4f}, #{vector_rank} in the search) to profile ({cand.get('archetype_label')}).",
            f"Verified '{cold}' cold storage" + (" + freezer" if frozen else "")
            + f", room for about {capacity:g} pallet(s) of this load ({_TIER_MEANING.get(tier, 'ranked')}).",
        ]
        if reefer:
            why_fit_parts.append(
                f"Operates refrigerated transport for rapid collection within the {effective_window_hours:.0f}h clock."
            )
        if tract_equity["above_metro_need_average"]:
            why_fit_parts.append(f"High-need neighborhood: {_need_text(tract_equity)}.")

        if can_self_collect and reefer:
            ask = "Can your refrigerated vehicle collect within the next few hours?"
        elif can_self_collect:
            ask = "Can you collect within the window?"
        else:
            ask = "We can send a volunteer driver. Can someone receive the delivery at your door or dock within the window?"
        outreach_msg = (
            f"URGENT SURPLUS OFFER ({effective_window_hours:.0f}h window): We have \"{posting_text}\" "
            f"({effective_pallets:g} pallet equiv., {norm_storage}). Your {cold} storage "
            f"(up to {max_pallets} pallets) and service profile ({cand.get('service_days')}) are a strong match. "
            + ask
        )

        ranked_matches.append({
            "recipient_id": int(cand["recipient_id"]),
            "name": name,
            "address": address,
            "archetype": cand.get("archetype"),
            "archetype_label": cand.get("archetype_label"),
            "profile_source": cand.get("profile_source"),
            "raw_vector_rank": vector_rank,
            "vector_distance": round(dist, 4),
            "semantic_similarity": sem_sim,
            "composite_score": float(cand.get("score") or 0.0),
            "need_weight": float(cand.get("need_weight") or 0.0),
            "tier": tier,
            "tier_meaning": _TIER_MEANING.get(tier),
            "operational_capabilities": {
                "cold_storage": cold,
                "frozen_storage": frozen,
                "loading_dock": dock,
                "refrigerated_transport": reefer,
                "max_pallets": max_pallets,
                "capacity_pallets_for_this_load": capacity,
                "takes_whole_load": bool(cand.get("takes_it_all")),
                "pallets_allocated": round(min(capacity, effective_pallets), 2),
                "pickup_window_hours": pickup_win,
                "weekly_households": households,
                "service_days": cand.get("service_days"),
                "populations_served": cand.get("populations_served"),
            },
            "clock_compatibility": {
                "effective_window_hours": effective_window_hours,
                "recipient_window_hours": pickup_win,
                "can_self_collect": can_self_collect,
                "can_collect_in_time": can_self_collect,
                "margin_hours": margin,
                "needs_volunteer_driver": not can_self_collect,
                "first_open_date": str(first_open) if first_open else None,
                "collection_mode": (
                    "Volunteer driver delivery" if not can_self_collect
                    else "Recipient refrigerated vehicle pickup" if reefer
                    else ("Dock-height delivery" if dock else "Direct door delivery")
                ),
            },
            "tract_equity": tract_equity,
            "why_matched": " ".join(why_fit_parts),
            "profile_text": cand.get("profile_text"),
            "draft_outreach_message": outreach_msg,
            "tie_breaker_reason": None,
        })

    split_plan.sort(key=lambda s: s["split_stop"])

    # Step 5: Detect genuine operational ties (e.g. Cedar Street vs Maple Street Produce Alliance,
    # or top two candidates with identical operational capabilities) and attach explicit tie-break justification.
    tie_break_analysis: dict[str, Any] | None = None
    by_spec: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for m in ranked_matches:
        ops = m["operational_capabilities"]
        spec_key = (
            ops["cold_storage"],
            ops["frozen_storage"],
            ops["loading_dock"],
            ops["refrigerated_transport"],
            ops["max_pallets"],
            ops["weekly_households"],
        )
        by_spec.setdefault(spec_key, []).append(m)

    for spec_key, tied_group in by_spec.items():
        if len(tied_group) >= 2:
            first, second = tied_group[0], tied_group[1]
            reason = (
                f"Operational Tie Detected between '{first['name']}' and '{second['name']}': "
                f"Both have identical operational specs (cold_storage='{spec_key[0]}', "
                f"loading_dock={spec_key[2]}, refrigerated_transport={spec_key[3]}, "
                f"max_pallets={spec_key[4]}, weekly_households={spec_key[5]}). "
                f"Notice their raw vector distances differ ({first['vector_distance']:.4f} vs. "
                f"{second['vector_distance']:.4f}) solely due to phrasing differences in their profiles. "
                f"Tie-break decision: Ranked '{first['name']}' ahead on score, which weighs semantic "
                f"fit against neighborhood need ({first['composite_score']:.3f} vs. "
                f"{second['composite_score']:.3f}; {_need_text(first['tract_equity'])} vs. "
                f"{_need_text(second['tract_equity'])}). "
                f"'{second['name']}' is designated as the immediate co-equal backup or split-load partner."
            )
            first["tie_breaker_reason"] = reason
            second["tie_breaker_reason"] = reason
            if tie_break_analysis is None:
                tie_break_analysis = {
                    "tied_organizations": [first["name"], second["name"]],
                    "shared_operational_specs": {
                        "cold_storage": spec_key[0],
                        "frozen_storage": spec_key[1],
                        "loading_dock": spec_key[2],
                        "refrigerated_transport": spec_key[3],
                        "max_pallets": spec_key[4],
                        "weekly_households": spec_key[5],
                    },
                    "selected_winner": first["name"],
                    "runner_up_backup": second["name"],
                    "justification": reason,
                }

    # Also ensure top 2 overall candidates have a clear comparison note if not already set
    if len(ranked_matches) >= 2 and not ranked_matches[0].get("tie_breaker_reason"):
        m1, m2 = ranked_matches[0], ranked_matches[1]
        ranked_matches[0]["tie_breaker_reason"] = (
            f"Selected #1 over #2 ('{m2['name']}'): "
            + (f"pickup tier {m1['tier']} vs {m2['tier']} ({m1['tier_meaning']} vs. {m2['tier_meaning']}); "
               if m1["tier"] != m2["tier"] else "same pickup tier, higher score; ")
            + f"score {m1['composite_score']:.3f} vs {m2['composite_score']:.3f}; "
            f"vector distance {m1['vector_distance']:.4f} vs {m2['vector_distance']:.4f}; "
            f"{_need_text(m1['tract_equity'])} vs. {_need_text(m2['tract_equity'])}."
        )

    top_matches = ranked_matches[: int(top_k or 10)]
    for idx, m in enumerate(top_matches, start=1):
        m["final_rank"] = idx

    # Step 6: Equity Audit Summary across the returned top matches (Section 11). Recipients with
    # no tract (no address on file) are left out of the averages and counted instead.
    top3 = top_matches[: min(3, len(top_matches))]
    known = [m for m in top3 if m["tract_equity"]["poverty_rate"] is not None]
    if known:
        avg_match_pov = round(sum(m["tract_equity"]["poverty_rate"] for m in known) / len(known), 4)
        avg_match_veh = round(sum(m["tract_equity"]["no_vehicle_rate"] for m in known) / len(known), 4)
        m_pov = known[0]["tract_equity"]["metro_poverty_rate"]
        m_veh = known[0]["tract_equity"]["metro_no_vehicle_rate"]
        equity_audit = {
            "top_matches_avg_poverty_rate": avg_match_pov,
            "atlanta_metro_avg_poverty_rate": m_pov,
            "top_matches_avg_no_vehicle_rate": avg_match_veh,
            "atlanta_metro_avg_no_vehicle_rate": m_veh,
            "top_matches_without_a_tract": len(top3) - len(known),
            "reaches_above_average_need": (avg_match_pov >= m_pov or avg_match_veh >= m_veh),
            "audit_narrative": (
                f"Top matched recipients sit in tracts averaging {avg_match_pov:.1%} poverty "
                f"(vs. Atlanta metro average {m_pov:.1%}) and {avg_match_veh:.1%} households without a vehicle "
                f"(vs. metro average {m_veh:.1%})."
                + (f" {len(top3) - len(known)} of the top {len(top3)} have no street address on file, "
                   "so no tract, and are left out." if len(known) < len(top3) else "")
            ),
        }
    else:
        equity_audit = None

    result = {
        "posting_text": posting_text,
        "normalized_storage_required": norm_storage,
        "pallets_needed": effective_pallets,
        "pallet_normalization_note": pallet_note,
        "clock": clock,
        "ranked_matches": top_matches,
        "eliminated_near_misses": eliminated_near_misses,
        "flagged_contradictions": flagged_contradictions,
        "tie_break_analysis": tie_break_analysis,
        "split_plan": split_plan,
        "excluded_recipient_ids": combined_exclude_ids,
        "already_matched_excluded": claimed_elsewhere,
        "equity_audit_summary": equity_audit,
    }

    # Step 7: Save what this match knew and ranked, so the offers made from it can say why.
    if request is not None:
        result["request"] = state_tools.summarize_request(request)
        snapshot = {
            "ranked": [
                {"final_rank": m["final_rank"], "recipient_id": m["recipient_id"],
                 "name": m["name"], "tier": m["tier"], "composite_score": m["composite_score"],
                 "vector_distance": m["vector_distance"], "need_weight": m["need_weight"],
                 "pallets_allocated": m["operational_capabilities"]["pallets_allocated"]}
                for m in top_matches
            ],
            "split_plan": split_plan,
            "eliminated": [
                {"recipient_id": e["recipient_id"], "name": e["name"],
                 "elimination_category": e["elimination_category"]}
                for e in eliminated_near_misses
            ],
        }
        try:
            run = state_tools.save_match_run(
                request_id, hours_remaining=effective_window_hours, pallets=effective_pallets,
                excluded_ids=combined_exclude_ids, ranked=snapshot)
            result["request"]["match_run_id"] = run["match_run_id"]
        except Exception as exc:  # noqa: BLE001
            state_warning = state_tools.failure(exc)
    if state_warning:
        result["state_warning"] = state_warning
    return result


# ---------------------------------------------------------------------------
# Tool 4: `split_large_load`
# ---------------------------------------------------------------------------
def split_large_load(
    posting_text: str,
    required_storage: str,
    total_pallets: int,
    donor_deadline_hours: float,
) -> dict[str, Any]:
    """Allocate a large multi-pallet surplus donation across multiple compatible recipients.

    Used when a single donation (e.g., 5 tons of potatoes = ~10 pallets, or half a truckload
    of blueberries = ~12 pallets, or 30 bins of winter squash) exceeds one organization's
    `max_pallets` capacity or when a coordinator wants to distribute across high-need tracts.

    Args:
        posting_text: Free-text description of the bulk surplus load.
        required_storage: Required storage condition ("refrigerated", "frozen", or "shelf-stable").
        total_pallets: Total number of pallets to allocate across recipients.
        donor_deadline_hours: Donor pickup deadline in hours.

    Returns:
        Dictionary with the multi-stop allocation plan, total pallets allocated, unallocated
        remainder (if any), per-stop outreach messages, and tract equity coverage.
    """
    target_pallets = max(1, int(total_pallets or 1))
    # Search with pallets_needed=1 so we get all storage-compatible recipients with at least 1 pallet
    base_result = match_surplus_posting(
        posting_text=posting_text,
        required_storage=required_storage,
        pallets_needed=1,
        donor_deadline_hours=donor_deadline_hours,
        top_k=25,
    )

    candidates = [
        m for m in base_result.get("ranked_matches", [])
        if int(m["operational_capabilities"].get("max_pallets") or 0) >= 1
    ]

    allocations: list[dict[str, Any]] = []
    remaining = target_pallets

    for stop_num, cand in enumerate(candidates, start=1):
        if remaining <= 0:
            break
        cap = int(cand["operational_capabilities"]["max_pallets"])
        # For refrigerated loads > 1 pallet, skip single household ('domestic') fridges if commercial cold storage exists
        if (
            base_result.get("normalized_storage_required") == "refrigerated"
            and cand["operational_capabilities"]["cold_storage"] == "domestic"
            and remaining > 1
        ):
            continue

        allocated = min(cap, remaining)
        if allocated <= 0:
            continue

        remaining -= allocated
        allocations.append({
            "stop_number": len(allocations) + 1,
            "recipient_id": cand["recipient_id"],
            "name": cand["name"],
            "address": cand["address"],
            "archetype_label": cand.get("archetype_label"),
            "pallets_allocated": allocated,
            "recipient_max_pallets": cap,
            "cold_storage": cand["operational_capabilities"]["cold_storage"],
            "loading_dock": cand["operational_capabilities"]["loading_dock"],
            "refrigerated_transport": cand["operational_capabilities"]["refrigerated_transport"],
            "weekly_households": cand["operational_capabilities"]["weekly_households"],
            "vector_distance": cand["vector_distance"],
            "tract_equity": cand["tract_equity"],
            "draft_outreach_message": (
                f"SPLIT-LOAD DISPATCH (Stop #{len(allocations) + 1} — {allocated} of {target_pallets} pallets): "
                f"We are splitting \"{posting_text}\" across partner sites within a "
                f"{base_result['clock']['effective_window_hours']:.0f}h window. "
                f"Can you accept {allocated} pallet(s) (your max capacity: {cap})?"
            ),
        })

    allocated_total = target_pallets - remaining
    total_households = sum(a["weekly_households"] for a in allocations)

    return {
        "posting_text": posting_text,
        "normalized_storage_required": base_result.get("normalized_storage_required"),
        "total_pallets_requested": target_pallets,
        "total_pallets_allocated": allocated_total,
        "unallocated_pallets": remaining,
        "fully_allocated": remaining == 0,
        "number_of_stops": len(allocations),
        "estimated_weekly_households_reached": total_households,
        "clock": base_result.get("clock"),
        "allocation_plan": allocations,
        "eliminated_near_misses": base_result.get("eliminated_near_misses", [])[:5],
        "flagged_contradictions": base_result.get("flagged_contradictions", []),
    }


# ---------------------------------------------------------------------------
# Tool 5: `record_grocer_request`
# ---------------------------------------------------------------------------
def record_grocer_request(
    posting_text: str,
    required_storage: str = "refrigerated",
    pallets_needed: float = 0.0,
    donor_deadline_hours: float = 6.0,
    food_item: str = "",
    donor_name: str = "",
) -> dict[str, Any]:
    """Save a new grocer surplus posting so offers on it, and the answers, are remembered.

    Call this once when a posting first comes in, before matching it, then pass the returned
    `request_id` to `match_surplus_posting` every time you match it. The deadline is saved
    as a time: the donor's deadline, or sooner if USDA FoodKeeper says the food spoils first,
    so a match two hours later sees two hours less clock.

    Args:
        posting_text: Raw free-text surplus posting from the grocer.
        required_storage: "refrigerated", "frozen", or "shelf-stable".
        pallets_needed: Size of the load in pallets, only if the grocer said so. Leave at 0 and
            the offer-state service reads it from the posting ("10 crates" is about 0.18) and
            says how; a crate or case count passed here is read the same way.
        donor_deadline_hours: Hours until the donor needs the food gone.
        food_item: Optional explicit food product name for the USDA FoodKeeper lookup.
        donor_name: The grocer or store, if known.

    Returns:
        The saved request (`status` 'recorded') with its `request_id`, deadline and pallets,
        or `status` 'unavailable' when the offer-state service is not set up.
    """
    if not state_tools.state_service_url():
        return state_tools.failure(state_tools.StateServiceError(0, "STATE_SERVICE_URL is not set"))
    norm_storage = _normalize_storage_requirement(required_storage, posting_text)
    inferred_item = _infer_food_item(posting_text, food_item)
    clock = check_shelf_life(food_item=inferred_item, storage_state=norm_storage,
                             donor_deadline_hours=donor_deadline_hours)
    hours = float(clock.get("effective_window_hours") or donor_deadline_hours or 6.0)
    try:
        state = state_tools.create_request(
            metro=os.environ.get("FOOD_RESCUE_METRO", "Atlanta"), posting_text=posting_text,
            required_storage=norm_storage, deadline_hours=hours,
            pallets=_given_pallets(posting_text, pallets_needed),   # None: the service reads it
            donor_name=donor_name or None, food_item=inferred_item)
    except Exception as exc:  # noqa: BLE001
        return state_tools.failure(exc)
    return {
        "status": "recorded",
        "request": state_tools.summarize_request(state),
        "clock_limiting_factor": clock.get("clock_limiting_factor"),
    }


# ---------------------------------------------------------------------------
# Seed postings: BigQuery's surplus_postings, worked from Cloud SQL
# ---------------------------------------------------------------------------
def import_surplus_postings(track: str = "RETAIL") -> dict[str, Any]:
    """Copy BigQuery's seed postings (`surplus_postings`) into the offer-state service as live
    grocer requests, so the agent and the console work them from Cloud SQL.

    BigQuery keeps its table: load.sh reloads it, and the equity audit and the shelf-life
    fallback read it. Safe to re-run: a posting with a live request in this metro is left as
    it is, so a second run only brings back postings whose clock ran out. A new request's clock
    starts now, at the posting's `hours_remaining` (the donor's hours, or fewer if FoodKeeper
    says the food spoils first). The table has no quantity column, so the service reads pallets
    from each posting's words ("10 crates", "half a truckload").

    Args:
        track: 'RETAIL', 'FARM', 'ESSENTIALS', or 'all'.
    """
    sql = (f"SELECT * FROM {_table_ref('surplus_postings')} "
           "WHERE @track = 'ALL' OR track = @track ORDER BY posting_id")
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("track", "STRING", (track or "RETAIL").upper())])
    metro = os.environ.get("FOOD_RESCUE_METRO", "Atlanta")
    postings = []
    for r in _get_bq_client().query(sql, job_config=job_config).result():
        state = state_tools.create_request(
            metro=metro, posting_text=r["posting_text"],
            required_storage=_normalize_storage_requirement(r["storage_state"], r["posting_text"]),
            deadline_hours=float(r["hours_remaining"] or r["hours_available"]),
            food_item=r["foodkeeper_product"], source_posting_id=r["posting_id"],
            reuse_live=True)
        postings.append({
            "posting_id": r["posting_id"],
            "track": r["track"],
            "request_id": state["request_id"],
            "already_live": state["reused"],
            "status": state["current_status"],
            "hours_remaining": state["hours_remaining"],
            "pallets": state["pallets"],
            "pallets_basis": state["pallets_basis"],
            "posting_text": r["posting_text"],
        })
    return {
        "status": "ok",
        "metro": metro,
        "imported": sum(not p["already_live"] for p in postings),
        "already_live": sum(p["already_live"] for p in postings),
        "postings": postings,
    }


def recommend_open_postings(max_postings: int = 5) -> dict[str, Any]:
    """Recommend recipients for every open grocer posting in the offer-state service.

    Reads the open postings from Cloud SQL, soonest deadline first, and runs
    `match_surplus_posting` on each with its saved state: the hours actually left, the pallets
    nobody has claimed, and everyone already asked, on hold, or tied up by another posting.
    Each run is saved as a match run. Use it for "what should we do with today's postings?",
    then give the full Match Brief for the posting the coordinator picks with
    `match_surplus_posting(request_id=...)`.

    Recommendations are not bookings: the same recipient can top two postings, and
    `shared_top_picks` says when. Whoever is offered first ties them up for the rest.

    Args:
        max_postings: At most this many postings, soonest deadline first (default 5).

    Returns:
        `postings`: per open posting, its clock, unclaimed pallets, offers so far, and the top
        three recommendations with the split plan; `status` 'unavailable' without the
        offer-state service.
    """
    if not state_tools.state_service_url():
        return state_tools.failure(state_tools.StateServiceError(0, "STATE_SERVICE_URL is not set"))
    metro = os.environ.get("FOOD_RESCUE_METRO", "Atlanta")
    try:
        rows = state_tools.state_call("GET", "/requests", params={"status": "open", "metro": metro})
    except Exception as exc:  # noqa: BLE001
        return state_tools.failure(exc)
    if not rows:
        return {"status": "ok", "metro": metro, "open_postings": 0, "postings": [],
                "message": "No open postings. Load the seed postings with "
                           "scripts/import_postings.py, or save a new one with "
                           "record_grocer_request."}

    def recommend(r: dict[str, Any]) -> dict[str, Any]:
        posting = {
            "request_id": r["request_id"],
            "offer_code": r["offer_code"],
            "source_posting_id": r["source_posting_id"],
            "posting_text": r["posting_text"],
            "hours_remaining": r["hours_remaining"],
            "unclaimed_pallets": r["unclaimed_pallets"],
            "pallets_basis": r["pallets_basis"],
            "offers_so_far": [{"recipient_id": o["recipient_id"], "name": o["recipient_name"],
                               "status": o["current_status"]} for o in r["offers"]],
        }
        if float(r["unclaimed_pallets"]) <= 0:
            return posting | {"recommendations": [],
                              "note": "Every pallet is accepted or waiting on a reply."}
        try:
            m = match_surplus_posting(r["posting_text"], top_k=3, request_id=str(r["request_id"]))
        except Exception as exc:  # noqa: BLE001
            return posting | {"recommendations": [], "error": str(exc)}
        return posting | {
            "match_run_id": (m.get("request") or {}).get("match_run_id"),
            "recommendations": [
                {
                    "rank": x["final_rank"],
                    "recipient_id": x["recipient_id"],
                    "name": x["name"],
                    "how": x["tier_meaning"],
                    "collection": x["clock_compatibility"]["collection_mode"],
                    "margin_hours": x["clock_compatibility"]["margin_hours"],
                    "pallets": x["operational_capabilities"]["pallets_allocated"],
                    "score": x["composite_score"],
                    "need": _need_text(x["tract_equity"]),
                }
                for x in m.get("ranked_matches", [])
            ],
            "split_plan": m.get("split_plan", []),
            "ruled_out": len(m.get("eliminated_near_misses", [])),
            "tied_up_elsewhere": [e["recipient_name"] for e in m.get("already_matched_excluded", [])],
            "state_warning": m.get("state_warning"),
        }

    shown = rows[: max(1, int(max_postings or 5))]
    with ThreadPoolExecutor(max_workers=min(4, len(shown))) as pool:   # one BigQuery job each
        postings = list(pool.map(recommend, shown))
    tops = Counter(p["recommendations"][0]["name"] for p in postings if p["recommendations"])
    return {
        "status": "ok",
        "metro": metro,
        "open_postings": len(rows),
        "postings": postings,
        "shared_top_picks": {name: n for name, n in tops.items() if n > 1},
    }


# Offer tools agent.py adds alongside the four above.
TOOLS = [record_grocer_request, recommend_open_postings, *state_tools.TOOLS]
