"""Google ADK Agent definition for the Resilient Food Equity & Surplus Broker.

Owned by Person B (Agent Lane).
Wires together:
  - SYSTEM_INSTRUCTION from `agent.prompts`
  - Custom Python tools from `agent.tools` (Person A) with per-function safe fallback
  - Managed MCP toolsets from `agent.mcp_config` (Person A) with safe fallback
"""

from __future__ import annotations

import importlib
import os
from typing import Any

from dotenv import load_dotenv
from google.adk.agents import Agent

from .prompts import SYSTEM_INSTRUCTION

load_dotenv()


# ---------------------------------------------------------------------------
# 1. Fallback mock implementations matching Person A's exact tool signatures
#    and `sql/02_match_candidates.sql` output schema.
# ---------------------------------------------------------------------------
def _mock_check_shelf_life(
    food_item: str,
    storage_state: str = "refrigerated",
    donor_deadline_hours: float = 0.0,
) -> dict[str, Any]:
    """Look up USDA FSIS FoodKeeper shelf-life guidance in `a4i_food.shelf_life`
    across product_name, product_subtitle, and keywords, and compute effective_hours_remaining.

    Args:
        food_item: Name or description of the food item (e.g., 'spinach', 'milk', 'bread').
        storage_state: Storage condition ('refrigerated' or 'pantry').
        donor_deadline_hours: Donor's stated pickup deadline in hours (0 if not specified).

    Returns:
        Dictionary with matched USDA FoodKeeper product, shelf_life_hours, note, and effective clock.
    """
    q = food_item.lower()
    if "spinach" in q or "greens" in q or "lettuce" in q:
        matched_name = "Lettuce"
        subtitle = "spinach, leaf greens"
        usda_hours: float | None = 72.0
        note = (
            "ok (Matched via subtitle 'spinach, leaf greens' under product_name 'Lettuce' — "
            "no product in USDA FoodKeeper is named 'Spinach' directly)"
        )
    elif "milk" in q or "dairy" in q or "yogurt" in q:
        matched_name = "Milk"
        subtitle = "plain or flavored"
        usda_hours = None
        note = "see_package ('package use-by date' sentinel in FoodKeeper; falls back to donor deadline)"
    elif "sandwich" in q or "deli" in q or "salad" in q or "prepared" in q:
        matched_name = "Leftovers"
        subtitle = "cooked dishes, prepared salads/sandwiches"
        usda_hours = 72.0
        note = "ok (USDA home-storage guidance is 3-4 days refrigerated; donor deadline governs)"
    elif "bread" in q or "pastry" in q or "pastries" in q or "loaves" in q:
        matched_name = "Bread"
        subtitle = "commercial loaves, bakery"
        usda_hours = 48.0 if storage_state == "pantry" else 168.0
        note = "ok"
    else:
        matched_name = "General Perishable Produce"
        subtitle = ""
        usda_hours = 72.0
        note = "ok"

    if donor_deadline_hours > 0 and usda_hours is not None:
        effective = min(float(donor_deadline_hours), float(usda_hours))
    elif donor_deadline_hours > 0:
        effective = float(donor_deadline_hours)
    else:
        effective = float(usda_hours or 24.0)

    return {
        "query_item": food_item,
        "matched_product_name": matched_name,
        "matched_product_subtitle": subtitle,
        "storage_state": storage_state,
        "usda_shelf_life_hours": usda_hours,
        "usda_note": note,
        "donor_deadline_hours": donor_deadline_hours if donor_deadline_hours > 0 else None,
        "effective_hours_remaining": effective,
        "caveat": (
            "USDA FSIS FoodKeeper (CC0) is consumer home-storage guidance for freshness and quality, "
            "not a commercial cold-chain model. Effective clock is MIN(donor_deadline_hours, usda_shelf_life_hours)."
        ),
    }


def _mock_match_surplus_posting(
    posting_text: str,
    required_storage: str = "refrigerated",
    pallets_needed: int = 1,
    donor_deadline_hours: float = 6.0,
    food_item: str = "",
    top_k: int = 10,
) -> dict[str, Any]:
    """Run BigQuery VECTOR_SEARCH on `a4i_food.recipient_embeddings` (using
    `sql/02_match_candidates.sql`), apply hard operational constraint filters
    (cold storage, max pallets, pickup window vs. USDA shelf life, contradiction check),
    and rank viable recipients with census tract equity tie-breaking.

    Args:
        posting_text: Raw free-text surplus posting from the grocer or coordinator.
        required_storage: One of 'refrigerated', 'frozen', or 'pantry'.
        pallets_needed: Estimated pallet count (use 1 for crate/case lots <= 1 pallet).
        donor_deadline_hours: Hours until the donor dock closes or food must move.
        food_item: Core product name for USDA FoodKeeper lookup (e.g. 'spinach', 'milk').
        top_k: Number of semantic candidates to retrieve from VECTOR_SEARCH.

    Returns:
        Dictionary with clock analysis, viable_matches (ranked), and eliminated_candidates.
    """
    metro = os.environ.get("FOOD_RESCUE_METRO", "Atlanta")
    shelf_info = check_shelf_life(
        food_item=food_item or posting_text,
        storage_state=required_storage,
        donor_deadline_hours=donor_deadline_hours,
    )
    effective_hours = shelf_info["effective_hours_remaining"]

    return {
        "status": "ok",
        "mode": "mock_fallback_until_tools_py_merged",
        "metro": metro,
        "query": {
            "posting_text": posting_text,
            "required_storage": required_storage,
            "pallets_needed": pallets_needed,
            "donor_deadline_hours": donor_deadline_hours,
            "effective_hours_remaining": effective_hours,
            "top_k": top_k,
        },
        "clock": shelf_info,
        "metro_equity_baseline": {
            "poverty_rate": 0.142,
            "no_vehicle_rate": 0.130,
            "assistance_rate": 0.118,
        },
        "viable_matches": [
            {
                "rank": 1,
                "recipient_id": 104,
                "name": "West End Mobile Fresh Market",
                "street": "640 Evans St SW",
                "city": metro,
                "state": "GA",
                "zip_code": "30310",
                "archetype": "mobile_pantry",
                "archetype_label": "Mobile pantry, refrigerated van",
                "profile_source": "generated",
                "distance": 0.2412,
                "vector_distance": 0.2412,
                "cold_storage": "vehicle",
                "frozen_storage": False,
                "loading_dock": False,
                "refrigerated_transport": True,
                "max_pallets": 4,
                "pickup_window_hours": 3,
                "safety_margin_hours": round(effective_hours - 3, 1),
                "weekly_households": 520,
                "populations_served": "Families with children",
                "reported_income": 410000.0,
                "service_days": "Monday, Tuesday, Wednesday, Thursday, Friday",
                "latitude": 33.7365,
                "longitude": -84.4172,
                "profile_text": (
                    "Mobile distribution running 6 stops a week from a refrigerated van. "
                    "Chilled capacity travels with us; we hold nothing at base. "
                    "We are already on the road and can add a pickup to the route. "
                    "Fresh produce and dairy. We distribute within hours, so perishable is fine. "
                    "Open Monday, Tuesday, Wednesday, Thursday, Friday."
                ),
                "tract_demographics": {
                    "geo_id": "13121006500",
                    "poverty_rate": 0.284,
                    "no_vehicle_rate": 0.261,
                    "assistance_rate": 0.245,
                    "median_income": 34200.0,
                },
                "why_selected": (
                    "High semantic similarity on fast-moving perishable greens/dairy, "
                    "has active refrigerated van transport (can self-collect in 3h with a "
                    f"{round(effective_hours - 3, 1)}h margin), and serves a census tract "
                    "with 26.1% no-vehicle households (2x the Atlanta metro average of 13.0%)."
                ),
            },
            {
                "rank": 2,
                "recipient_id": 120,
                "name": "Cedar Street Produce Alliance",
                "street": "310 Whitehall St SW",
                "city": metro,
                "state": "GA",
                "zip_code": "30303",
                "archetype": "planted",
                "archetype_label": "Planted teaching case",
                "profile_source": "planted",
                "distance": 0.2580,
                "vector_distance": 0.2580,
                "cold_storage": "walk-in",
                "frozen_storage": False,
                "loading_dock": True,
                "refrigerated_transport": True,
                "max_pallets": 10,
                "pickup_window_hours": 4,
                "safety_margin_hours": round(effective_hours - 4, 1),
                "weekly_households": 600,
                "populations_served": "General public",
                "reported_income": 0.0,
                "service_days": "Monday, Wednesday, Friday",
                "latitude": 33.7470,
                "longitude": -84.4035,
                "profile_text": (
                    "Produce-focused redistribution with a walk-in cooler and a refrigerated van. "
                    "We turn fresh fruit and vegetables within 48 hours and serve about 600 households a week."
                ),
                "tract_demographics": {
                    "geo_id": "13121003500",
                    "poverty_rate": 0.238,
                    "no_vehicle_rate": 0.219,
                    "assistance_rate": 0.194,
                    "median_income": 41500.0,
                },
                "why_selected": (
                    "Tied operationally with Maple Street Produce Alliance (walk-in cooler, "
                    "reefer van, 10 pallets, 600 weekly households); ranked #2 ahead of Maple Street "
                    "due to higher census-tract no-vehicle rate (21.9% vs. 16.4%)."
                ),
            },
            {
                "rank": 3,
                "recipient_id": 121,
                "name": "Maple Street Produce Alliance",
                "street": "485 Edgewood Ave SE",
                "city": metro,
                "state": "GA",
                "zip_code": "30312",
                "archetype": "planted",
                "archetype_label": "Planted teaching case",
                "profile_source": "planted",
                "distance": 0.2615,
                "vector_distance": 0.2615,
                "cold_storage": "walk-in",
                "frozen_storage": False,
                "loading_dock": True,
                "refrigerated_transport": True,
                "max_pallets": 10,
                "pickup_window_hours": 4,
                "safety_margin_hours": round(effective_hours - 4, 1),
                "weekly_households": 600,
                "populations_served": "General public",
                "reported_income": 0.0,
                "service_days": "Monday, Wednesday, Friday",
                "latitude": 33.7542,
                "longitude": -84.3715,
                "profile_text": (
                    "Fresh produce hub with walk-in refrigeration and our own reefer truck. "
                    "Roughly 600 households weekly, and perishables move through us in under two days."
                ),
                "tract_demographics": {
                    "geo_id": "13121002900",
                    "poverty_rate": 0.192,
                    "no_vehicle_rate": 0.164,
                    "assistance_rate": 0.151,
                    "median_income": 49800.0,
                },
                "why_selected": (
                    "Strong backup with walk-in cooler and own reefer truck; placed #3 behind "
                    "Cedar Street Produce Alliance on census-tract equity tie-breaker."
                ),
            },
        ],
        "eliminated_candidates": [
            {
                "recipient_id": 119,
                "name": "Greenline Community Pantry",
                "distance": 0.1984,
                "vector_distance": 0.1984,
                "cold_storage": "none",
                "max_pallets": 1,
                "pickup_window_hours": 12,
                "profile_text": (
                    "Our families ask for fresh greens and salad vegetables more than anything else. "
                    "We have no refrigeration of any kind - dry storage only - so we can only take "
                    "produce that will be handed out the same morning it arrives."
                ),
                "elimination_reason": (
                    "NEAR-MISS DECOY: Ranked #2 in raw VECTOR_SEARCH because profile asks for 'fresh greens "
                    "and salad vegetables', but `cold_storage = 'none'` (dry storage only) and "
                    "`pickup_window_hours = 12h` exceeds the donor deadline."
                ),
            },
            {
                "recipient_id": 120,
                "name": "Harborview Neighbors Trust",
                "distance": 0.2690,
                "vector_distance": 0.2690,
                "cold_storage": "walk-in",
                "max_pallets": 6,
                "pickup_window_hours": 12,
                "profile_text": (
                    "We operate a large walk-in freezer and can accept full pallets of frozen protein. "
                    "Storage is a single shelf in a shared cupboard and we have no freezer at present."
                ),
                "elimination_reason": (
                    "PROFILE CONTRADICTION: Profile claims a large walk-in freezer in sentence one "
                    "but states 'Storage is a single shelf in a shared cupboard and we have no freezer "
                    "at present' in sentence two. Flagged as unverified/unsafe capacity."
                ),
            },
            {
                "recipient_id": 14,
                "name": "Metro Regional Food Distribution Hub",
                "distance": 0.2745,
                "vector_distance": 0.2745,
                "cold_storage": "walk-in",
                "max_pallets": 20,
                "pickup_window_hours": 18,
                "profile_text": (
                    "Central warehouse and redistribution point for 18 member agencies. "
                    "Full pallets and truckloads. Small mixed lots cost us more to handle than they are worth."
                ),
                "elimination_reason": (
                    f"CLOCK & LOT-SIZE MISMATCH: `pickup_window_hours = 18h` exceeds the {effective_hours}h "
                    "deadline, and regional warehouse profile explicitly declines small retail lots."
                ),
            },
        ],
    }


def _mock_get_recipient_tract_equity(recipient_name_or_id: str) -> dict[str, Any]:
    """Look up a recipient's nearest census tract demographics from `a4i_food.tract_demographics`
    and compare against the metro-wide average.

    Args:
        recipient_name_or_id: Recipient organization name or numeric recipient_id.

    Returns:
        Dictionary with recipient details, census tract rates, and metro comparison.
    """
    metro = os.environ.get("FOOD_RESCUE_METRO", "Atlanta")
    return {
        "recipient_query": recipient_name_or_id,
        "metro": metro,
        "tract_geoid": "13121006500",
        "poverty_rate": 0.284,
        "no_vehicle_rate": 0.261,
        "assistance_rate": 0.245,
        "median_income": 34200.0,
        "metro_averages": {
            "poverty_rate": 0.142,
            "no_vehicle_rate": 0.130,
            "assistance_rate": 0.118,
        },
        "equity_summary": (
            f"This organization sits in a high-need {metro} census tract: "
            "28.4% poverty rate (2.0x metro avg) and 26.1% households with no vehicle "
            "(2.0x metro avg). Note: `assistance_rate` (24.5%) measures households receiving "
            "public assistance OR SNAP/food stamps in ACS."
        ),
    }


def _mock_split_large_load(
    posting_text: str,
    required_storage: str,
    total_pallets: int,
    donor_deadline_hours: float,
) -> dict[str, Any]:
    """Propose a multi-recipient load split when a surplus posting exceeds any single
    organization's pallet capacity or benefits from multi-stop distribution.

    Args:
        posting_text: Raw surplus posting text.
        required_storage: 'refrigerated', 'frozen', or 'pantry'.
        total_pallets: Total pallets to split across recipients.
        donor_deadline_hours: Hours remaining to complete pickups.

    Returns:
        Dictionary with proposed split allocations across top viable recipients.
    """
    p1 = min(total_pallets, 4)
    p2 = max(0, min(total_pallets - p1, 6))
    p3 = max(0, total_pallets - p1 - p2)
    allocations = [
        {
            "stop": 1,
            "name": "West End Mobile Fresh Market",
            "allocated_pallets": p1,
            "max_pallets": 4,
            "cold_storage": "vehicle",
            "refrigerated_transport": True,
            "pickup_window_hours": 3,
            "tract_no_vehicle_rate": 0.261,
        },
        {
            "stop": 2,
            "name": "Cedar Street Produce Alliance",
            "allocated_pallets": p2,
            "max_pallets": 10,
            "cold_storage": "walk-in",
            "refrigerated_transport": True,
            "pickup_window_hours": 4,
            "tract_no_vehicle_rate": 0.219,
        },
    ]
    if p3 > 0:
        allocations.append(
            {
                "stop": 3,
                "name": "Maple Street Produce Alliance",
                "allocated_pallets": p3,
                "max_pallets": 10,
                "cold_storage": "walk-in",
                "refrigerated_transport": True,
                "pickup_window_hours": 4,
                "tract_no_vehicle_rate": 0.164,
            }
        )
    return {
        "posting_text": posting_text,
        "total_pallets": total_pallets,
        "required_storage": required_storage,
        "donor_deadline_hours": donor_deadline_hours,
        "allocations": allocations,
        "unallocated_pallets": max(0, total_pallets - (p1 + p2 + p3)),
    }


# Ensure ADK exposes the exact contract tool names (`func.__name__`) to Gemini
# even when running in standalone mock mode before Person A merges `agent/tools.py`.
_mock_match_surplus_posting.__name__ = "match_surplus_posting"
_mock_check_shelf_life.__name__ = "check_shelf_life"
_mock_get_recipient_tract_equity.__name__ = "get_recipient_tract_equity"
_mock_split_large_load.__name__ = "split_large_load"


# ---------------------------------------------------------------------------
# 2. Dynamically bind Person A's `agent/tools.py` per-function so even if
#    Person A implements a subset of functions or adds extra tools, nothing breaks.
# ---------------------------------------------------------------------------
_tools_mod = None
try:
    _tools_mod = importlib.import_module(".tools", __package__)
except ImportError:
    _tools_mod = None

USING_MOCK_TOOLS = _tools_mod is None

match_surplus_posting = getattr(_tools_mod, "match_surplus_posting", _mock_match_surplus_posting)
check_shelf_life = getattr(_tools_mod, "check_shelf_life", _mock_check_shelf_life)
get_recipient_tract_equity = getattr(
    _tools_mod, "get_recipient_tract_equity", _mock_get_recipient_tract_equity
)
split_large_load = getattr(_tools_mod, "split_large_load", _mock_split_large_load)


# ---------------------------------------------------------------------------
# 3. Dynamically bind Person A's `agent/mcp_config.py` (`get_mcp_toolsets`)
# ---------------------------------------------------------------------------
_mcp_mod = None
try:
    _mcp_mod = importlib.import_module(".mcp_config", __package__)
except ImportError:
    _mcp_mod = None


def _default_get_mcp_toolsets() -> list[Any]:
    """Fallback when `agent/mcp_config.py` is not yet merged."""
    return []


get_mcp_toolsets = getattr(
    _mcp_mod,
    "get_mcp_toolsets",
    getattr(_mcp_mod, "get_mcp_tools", _default_get_mcp_toolsets),
)


def _build_tools() -> list[Any]:
    """Assemble custom Python tools + any extra Person A tools + managed MCP toolsets."""
    tools: list[Any] = [
        match_surplus_posting,
        check_shelf_life,
        get_recipient_tract_equity,
        split_large_load,
    ]

    # If Person A exports additional custom tools in `TOOLS` or `CUSTOM_TOOLS`, include them
    if _tools_mod is not None:
        for attr_name in ("TOOLS", "CUSTOM_TOOLS"):
            extra = getattr(_tools_mod, attr_name, None)
            if isinstance(extra, (list, tuple)):
                for item in extra:
                    if item not in tools:
                        tools.append(item)

    # Attach Google-managed MCP server toolsets (BigQuery MCP / MCP Toolbox)
    try:
        mcp_tools = get_mcp_toolsets()
        if mcp_tools:
            if isinstance(mcp_tools, (list, tuple)):
                tools.extend(mcp_tools)
            else:
                tools.append(mcp_tools)
    except Exception as exc:  # noqa: BLE001
        print(f"[food_rescue_broker] Warning: MCP toolset initialization skipped: {exc}")

    return tools


MODEL_NAME = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
if MODEL_NAME.startswith("gemini-3") and os.environ.get("GOOGLE_CLOUD_LOCATION") in (None, "", "us-central1"):
    os.environ["GOOGLE_CLOUD_LOCATION"] = "global"

root_agent = Agent(
    name="food_rescue_broker",
    model=MODEL_NAME,
    description=(
        "Resilient Food Equity & Surplus Broker for Retail & Grocer Rescue. "
        "Matches perishable grocery surplus to viable neighborhood recipients using "
        "BigQuery VECTOR_SEARCH, USDA FoodKeeper shelf-life constraints, and ACS census equity data."
    ),
    instruction=SYSTEM_INSTRUCTION,
    tools=_build_tools(),
)
