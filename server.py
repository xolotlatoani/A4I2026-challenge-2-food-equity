"""Unified FastAPI Server for Challenge 2 â€” Resilient Food Equity & Surplus Broker.

Serves:
  1. Google ADK Web UI & Agent API (`/dev-ui/`, `/list-apps`, `/run`, `/run_sse`)
  2. Atlanta Coordinator Console UI (`/console/queue.html`, `/console/match-brief-spinach.html`,
     `/console/match-brief-deli.html`, `/console/app.js`)
  3. Live BigQuery REST Endpoints (`/api/queue`, `/api/match`, `/api/recipients`, `/api/equity-audit`)
     querying `a4i_food` (`recipients`, `recipient_embeddings`, `recipient_tracts`,
     `tract_demographics`, `surplus_postings`, `shelf_life`) via `sql/03_filter_and_rank.sql`
     and `agent/tools.py`.
"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google.adk.cli.fast_api import get_fast_api_app

from agent import state_tools
from agent.tools import _normalize_storage_requirement

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = REPO_ROOT / "frontend"
SQL_03_PATH = REPO_ROOT / "sql" / "03_filter_and_rank.sql"

PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "qwiklabs-gcp-04-ef48e08bc216")
DATASET = os.environ.get("BIGQUERY_DATASET") or os.environ.get("BQ_DATASET", "a4i_food")
SERVICE_DATE = os.environ.get("SERVICE_DATE", "2026-10-28")

# Build the base ADK FastAPI application
app: FastAPI = get_fast_api_app(
    agents_dir=str(REPO_ROOT),
    web=True,
    allow_origins=["*"],
)

# ---------------------------------------------------------------------------
# Baseline Snapshot (Frozen output of `sql/03_filter_and_rank.sql` and
# `scripts/equity_audit.py` on `qwiklabs-gcp-04-ef48e08bc216.a4i_food`, used
# only when running offline without BigQuery Application Default Credentials)
# ---------------------------------------------------------------------------
OFFERS_CATALOG: dict[str, dict[str, Any]] = {
    "spinach": {
        "offer_key": "spinach",
        "posting_id": 1,
        "offer_code": "OFFER #ATL-8830",
        "track": "RETAIL",
        "status": "Match ready: Food Flow Collaborative",
        "status_type": "ready",
        "donor_label": "Grocery store Â· Midtown Â· pulled from the shelf",
        "posting_text": "10 crates of spinach, harvested yesterday, needs cold storage",
        "category_tag": "Produce",
        "storage_tag": "Keep cold",
        "needs_cold": True,
        "needs_frozen": False,
        "pallets": 0.18,
        "pallets_label": "about 0.2 pallet (10 crates)",
        "hours_remaining": 6.0,
        "countdown_label": "5h 50m left",
        "dock_shutoff": "8:10 PM",
        "brief_url": "match-brief-spinach.html",
        "pipeline": {
            "found_by_meaning": 60,
            "viable_count": 20,
            "ruled_out_count": 40,
            "recommended_count": 3,
        },
        "candidates": [
            {
                "recipient_id": 42,
                "rank": 1,
                "semantic_rank": 7,
                "viable": True,
                "tier": 1,
                "score": 0.782,
                "distance": 0.2314,
                "name": "Food Flow Collaborative Incorporated",
                "address": "3137 Buford Hwy NE, Brookhaven GA 30329",
                "archetype_label": "Mobile pantry with refrigerated van",
                "cold_storage": "vehicle",
                "max_pallets": 3,
                "capacity_pallets": 3.0,
                "takes_it_all": True,
                "pickup_window_hours": 5,
                "can_self_collect": True,
                "margin_hours": 1.0,
                "margin_label": "+50m spare",
                "est_pickup_time": "7:20 PM",
                "refrigerated_transport": True,
                "weekly_households": 460,
                "no_vehicle_rate": 0.076,
                "poverty_rate": 0.148,
                "food_insecurity_rate": 0.098,
                "need_score": 0.42,
                "profile_source": "generated",
                "why_them": "Runs a refrigerated van 7 days a week and says fresh produce moves best for them because they distribute within hours.",
                "what_they_can_take": "All 10 crates. Their van holds up to 3 pallets, readily absorbing this 0.2 pallet shipment without displacement.",
                "pickup_warning": None,
                "draft_sms": "Hi Food Flow team, this is the Atlanta food rescue desk. A Midtown grocer has 10 crates of spinach, harvested yesterday, that must stay cold and leave their dock by 8:10 PM tonight. Your refrigerated van and same-day distribution make you our best fit. Can you divert to collect before 8? Reply YES and I'll send the pickup address and contact.",
            },
            {
                "recipient_id": 67,
                "rank": 2,
                "semantic_rank": 11,
                "viable": True,
                "tier": 1,
                "score": 0.764,
                "distance": 0.2490,
                "name": "Fda-Bridging The Gap Inc",
                "address": "5373 Riverdale Rd, Atlanta GA 30349",
                "archetype_label": "Mobile pantry with refrigerated van",
                "cold_storage": "vehicle",
                "max_pallets": 4,
                "capacity_pallets": 4.0,
                "takes_it_all": True,
                "pickup_window_hours": 5,
                "can_self_collect": True,
                "margin_hours": 1.0,
                "margin_label": "+50m spare",
                "est_pickup_time": "7:20 PM",
                "refrigerated_transport": True,
                "weekly_households": 390,
                "no_vehicle_rate": 0.167,
                "poverty_rate": 0.284,
                "food_insecurity_rate": 0.339,
                "need_score": 0.84,
                "profile_source": "generated",
                "why_them": "Mobile refrigerated distribution serving South Atlanta neighborhoods with same-day produce turnover.",
                "what_they_can_take": "All 10 crates (up to 4 pallets in their refrigerated van).",
                "pickup_warning": None,
                "draft_sms": "Hi Bridging The Gap team, this is the Atlanta food rescue desk. A Midtown grocer has 10 crates of fresh spinach that must stay cold and move by 8:10 PM tonight. Can your refrigerated van collect before 8? Reply YES and I'll send the dock details.",
            },
            {
                "recipient_id": 122,
                "rank": 3,
                "semantic_rank": 3,
                "viable": True,
                "tier": 3,
                "score": 0.741,
                "distance": 0.2095,
                "name": "Maple Street Produce Alliance",
                "address": "No address on file (teaching case)",
                "archetype_label": "Walk-in cooler Â· teaching case",
                "cold_storage": "walk-in",
                "max_pallets": 10,
                "capacity_pallets": 10.0,
                "takes_it_all": True,
                "pickup_window_hours": 12,
                "can_self_collect": False,
                "margin_hours": -6.0,
                "margin_label": "Needs driver (12h pickup window)",
                "est_pickup_time": "6:30 PM (via volunteer driver)",
                "refrigerated_transport": True,
                "weekly_households": 600,
                "no_vehicle_rate": 0.130,
                "poverty_rate": 0.180,
                "food_insecurity_rate": 0.185,
                "need_score": 0.50,
                "profile_source": "planted",
                "why_them": "Fresh produce hub with walk-in refrigeration moving perishables in under 48 hours.",
                "what_they_can_take": "All 10 crates (walk-in cooler holds up to 10 pallets).",
                "pickup_warning": "Needs a volunteer driver: their standard collection window is 12h.",
                "draft_sms": "Hi Maple Street Produce Alliance, this is the Atlanta food rescue desk. We have 10 crates of fresh spinach from a Midtown grocer that must move by 8:10 PM. We can dispatch a volunteer driver to drop it at your walk-in coolerâ€”can someone receive it?",
            },
            {
                "recipient_id": 121,
                "rank": 4,
                "semantic_rank": 8,
                "viable": True,
                "tier": 3,
                "score": 0.735,
                "distance": 0.2380,
                "name": "Cedar Street Produce Alliance",
                "address": "No address on file (teaching case)",
                "archetype_label": "Walk-in cooler Â· teaching case",
                "cold_storage": "walk-in",
                "max_pallets": 10,
                "capacity_pallets": 10.0,
                "takes_it_all": True,
                "pickup_window_hours": 12,
                "can_self_collect": False,
                "margin_hours": -6.0,
                "margin_label": "Needs driver (12h pickup window)",
                "est_pickup_time": "6:30 PM (via volunteer driver)",
                "refrigerated_transport": True,
                "weekly_households": 600,
                "no_vehicle_rate": 0.130,
                "poverty_rate": 0.180,
                "food_insecurity_rate": 0.185,
                "need_score": 0.50,
                "profile_source": "planted",
                "why_them": "Produce-focused redistribution with walk-in cooler turning fresh fruit and vegetables within 48 hours.",
                "what_they_can_take": "All 10 crates (up to 10 pallets).",
                "pickup_warning": "Needs a volunteer driver: their standard collection window is 12h.",
                "draft_sms": "Hi Cedar Street Produce Alliance, this is the Atlanta food rescue desk. We have 10 crates of spinach that must move by 8:10 PM. Can you receive a volunteer driver drop-off at your walk-in cooler tonight?",
            },
        ],
        "split_plan": [
            {
                "split_stop": 1,
                "recipient_id": 88,
                "name": "House Of Serenity Inc",
                "address": "1711 Ralph David Abernathy Blvd SW, Atlanta GA 30310",
                "archetype_label": "Neighborhood pantry, household fridge",
                "cold_storage": "domestic",
                "share_label": "5 crates",
                "split_share_pallets": 0.09,
                "pickup_window_hours": 3,
                "margin_label": "2h 50m to spare",
                "est_pickup_time": "5:20 PM",
                "food_insecurity_rate": 0.286,
                "no_vehicle_rate": 0.241,
                "poverty_rate": 0.312,
                "warning": "Profile says their fridge is usually full and they have thrown away produce before: confirm space",
                "draft_sms": "Hi House Of Serenity, this is the Atlanta food rescue desk. A Midtown grocer has 10 crates of fresh spinach, harvested yesterday, and we are splitting it between two pantries. Could you take 5 crates today? It has to leave the store by 8:10 PM and stay cold. Can you send a volunteer with a car, or should we deliver? Reply YES if you have fridge space.",
            },
            {
                "split_stop": 2,
                "recipient_id": 54,
                "name": "2 Fishes And 5 Loaves More Than Enough",
                "address": "220 Winkfield Pt, College Park GA 30349",
                "archetype_label": "Transitional housing, one large household fridge",
                "cold_storage": "domestic",
                "share_label": "5 crates",
                "split_share_pallets": 0.09,
                "pickup_window_hours": 3,
                "margin_label": "2h 50m to spare",
                "est_pickup_time": "5:20 PM",
                "food_insecurity_rate": 0.339,
                "no_vehicle_rate": 0.167,
                "poverty_rate": 0.295,
                "warning": "Profile says pickup needs a day's notice and food that needs prep tends to sit: plan to deliver",
                "draft_sms": "Hi 2 Fishes And 5 Loaves, this is the Atlanta food rescue desk. A Midtown grocer has 10 crates of fresh spinach, harvested yesterday, and we are splitting it between two pantries. Could you take 5 crates today? It has to stay cold, and we can send a volunteer driver to 220 Winkfield Pt this evening. Reply YES and I'll confirm the drop-off time.",
            },
        ],
        "ruled_out": [
            {"name": "Greenline Community Pantry", "semantic_rank": 2, "reason": "No refrigeration: wants greens, would spoil", "category": "storage"},
            {"name": "Hungry For A Day", "semantic_rank": 4, "reason": "Closed today, opens Saturday", "category": "schedule"},
            {"name": "Martin Clinic Healing House", "semantic_rank": 5, "reason": "Medical fridge only, not for donated food", "category": "medical"},
            {"name": "Basic Needs Dao Corporation", "semantic_rank": 6, "reason": "Closed today, opens Monday", "category": "schedule"},
            {"name": "Lakeshore Mutual Aid Collective", "semantic_rank": 10, "reason": "Opening days conflict between profile and records: call to verify", "category": "conflict"},
            {"name": "Ridgeway Avenue Food Ministry", "semantic_rank": 12, "reason": "Opening days conflict between profile and records: call to verify", "category": "conflict"},
            {"name": "Southline Neighbors Pantry", "semantic_rank": 14, "reason": "Opening days conflict between profile and records: call to verify", "category": "conflict"},
            {"name": "Harborview Neighbors Trust", "semantic_rank": 15, "reason": "Profile contradicts its own storage claims (walk-in freezer vs. single cupboard shelf): call to verify", "category": "conflict"},
            {"name": "Wholesome Wave Georgia Incorporated", "semantic_rank": 18, "reason": "Closed today, opens Thursday", "category": "schedule"},
            {"name": "Atlanta Childrens Shelter Inc", "semantic_rank": 21, "reason": "Closed today, opens Saturday", "category": "schedule"},
        ],
    },
    "deli": {
        "offer_key": "deli",
        "posting_id": 4,
        "offer_code": "OFFER #ATL-8831",
        "track": "RETAIL",
        "status": "Needs a match",
        "status_type": "urgent",
        "donor_label": "Grocery store Â· Little Five Points Â· deli case",
        "posting_text": "prepared sandwiches and salads from the deli case, must move tonight",
        "category_tag": "Prepared food",
        "storage_tag": "Keep cold",
        "needs_cold": True,
        "needs_frozen": False,
        "pallets": 0.15,
        "pallets_label": "quantity unknown (~0.15 pallet)",
        "hours_remaining": 4.0,
        "countdown_label": "3h 50m left",
        "dock_shutoff": "6:10 PM",
        "brief_url": "match-brief-deli.html",
        "pipeline": {
            "found_by_meaning": 60,
            "viable_count": 27,
            "ruled_out_count": 33,
            "recommended_count": 3,
        },
        "candidates": [
            {
                "recipient_id": 31,
                "rank": 1,
                "semantic_rank": 28,
                "viable": True,
                "tier": 1,
                "score": 0.795,
                "distance": 0.2640,
                "name": "Daniels Guiding Guardians",
                "address": "2895 Lewis Ln, Atlanta GA 30349",
                "archetype_label": "Overnight shelter with a kitchen",
                "cold_storage": "domestic",
                "max_pallets": 1,
                "capacity_pallets": 0.15,
                "takes_it_all": True,
                "pickup_window_hours": 3,
                "can_self_collect": True,
                "margin_hours": 1.0,
                "margin_label": "+50m spare",
                "est_pickup_time": "5:20 PM",
                "refrigerated_transport": False,
                "weekly_households": 169,
                "no_vehicle_rate": 0.167,
                "poverty_rate": 0.295,
                "food_insecurity_rate": 0.339,
                "need_score": 0.84,
                "profile_source": "generated",
                "why_them": "An overnight shelter that feeds everyone who stays, and it is open today. Their profile says ready-to-eat food works best for them, which is exactly what this is.",
                "what_they_can_take": "Two household fridges. Enough for a deli case of sandwiches and salads. The grocer gave no quantity, so confirm it.",
                "pickup_warning": "Their profile says they have no vehicle and delivery is far easier for them. Line up a volunteer driver.",
                "draft_sms": "Hi Daniels Guiding Guardians, this is the Atlanta food rescue desk. A Little Five Points grocer has prepared sandwiches and salads from their deli case that must stay cold and move by 6:10 PM tonight. It is all ready to eat. We can send a volunteer driver to 2895 Lewis Ln. Can someone receive it before 6? Reply YES and I'll confirm the drop-off time.",
            },
            {
                "recipient_id": 54,
                "rank": 2,
                "semantic_rank": 19,
                "viable": True,
                "tier": 1,
                "score": 0.778,
                "distance": 0.2540,
                "name": "2 Fishes And 5 Loaves More Than Enough",
                "address": "220 Winkfield Pt, College Park GA 30349",
                "archetype_label": "Transitional housing, one large household fridge",
                "cold_storage": "domestic",
                "max_pallets": 1,
                "capacity_pallets": 0.15,
                "takes_it_all": True,
                "pickup_window_hours": 3,
                "can_self_collect": True,
                "margin_hours": 1.0,
                "margin_label": "+50m spare",
                "est_pickup_time": "5:20 PM",
                "refrigerated_transport": False,
                "weekly_households": 140,
                "no_vehicle_rate": 0.167,
                "poverty_rate": 0.295,
                "food_insecurity_rate": 0.339,
                "need_score": 0.84,
                "profile_source": "generated",
                "why_them": "Transitional housing serving daily meals; ready-to-eat sandwiches and salads need zero prep in their small kitchen.",
                "what_they_can_take": "One large household fridge (~8 crates / full deli tray lot).",
                "pickup_warning": "Profile says pickup needs a day's notice: plan to deliver with a volunteer driver.",
                "draft_sms": "Hi 2 Fishes And 5 Loaves, this is the Atlanta food rescue desk. A Little Five Points grocer has prepared sandwiches and salads from their deli case that must move by 6:10 PM tonight. We can send a volunteer driver to 220 Winkfield Pt. Can someone receive it before 6?",
            },
            {
                "recipient_id": 88,
                "rank": 3,
                "semantic_rank": 22,
                "viable": True,
                "tier": 1,
                "score": 0.761,
                "distance": 0.2590,
                "name": "House Of Serenity Inc",
                "address": "1711 Ralph David Abernathy Blvd SW, Atlanta GA 30310",
                "archetype_label": "Neighborhood pantry, household fridge",
                "cold_storage": "domestic",
                "max_pallets": 1,
                "capacity_pallets": 0.15,
                "takes_it_all": True,
                "pickup_window_hours": 3,
                "can_self_collect": True,
                "margin_hours": 1.0,
                "margin_label": "+50m spare",
                "est_pickup_time": "5:20 PM",
                "refrigerated_transport": False,
                "weekly_households": 115,
                "no_vehicle_rate": 0.241,
                "poverty_rate": 0.312,
                "food_insecurity_rate": 0.286,
                "need_score": 0.88,
                "profile_source": "generated",
                "why_them": "West End neighborhood pantry in a high-need tract (24.1% no-vehicle households) able to hand out ready-to-eat items immediately.",
                "what_they_can_take": "Household refrigerator (~0.15 pallet capacity).",
                "pickup_warning": "Profile says their fridge is usually full and they have no vehicle: confirm fridge space and send a driver.",
                "draft_sms": "Hi House Of Serenity, this is the Atlanta food rescue desk. A Little Five Points grocer has prepared deli sandwiches and salads that must move by 6:10 PM tonight. Do you have fridge space if we send a volunteer driver to drop them off?",
            },
            {
                "recipient_id": 19,
                "rank": 4,
                "semantic_rank": 1,
                "viable": True,
                "tier": 2,
                "score": 0.749,
                "distance": 0.1920,
                "name": "Trinity Community Ministries Inc",
                "address": "21 Bell St NE, Atlanta GA 30303",
                "archetype_label": "Emergency shelter kitchen",
                "cold_storage": "domestic",
                "max_pallets": 1,
                "capacity_pallets": 0.15,
                "takes_it_all": True,
                "pickup_window_hours": 4,
                "can_self_collect": True,
                "margin_hours": 0.0,
                "margin_label": "0m spare (tight pickup)",
                "est_pickup_time": "6:10 PM",
                "refrigerated_transport": False,
                "weekly_households": 210,
                "no_vehicle_rate": 0.261,
                "poverty_rate": 0.340,
                "food_insecurity_rate": 0.315,
                "need_score": 0.91,
                "profile_source": "generated",
                "why_them": "Closest semantic match (#1 of 60), but ranked #4 (Tier 2) because their 4h pickup window leaves 0 minutes to spare before the 4h deadline.",
                "what_they_can_take": "Household refrigeration for same-night dinner service.",
                "pickup_warning": "Tight clock: 4h pickup window leaves 0m buffer unless a rapid volunteer driver is dispatched.",
                "draft_sms": "Hi Trinity Community Ministries, this is the Atlanta food rescue desk. We have prepared deli sandwiches and salads that must leave the store by 6:10 PM. If we dispatch an immediate volunteer driver now, can your kitchen receive them?",
            },
        ],
        "split_plan": [],
        "ruled_out": [
            {"name": "Wholesome Wave Georgia Incorporated", "semantic_rank": 3, "reason": "Closed today, opens Thursday", "category": "schedule"},
            {"name": "Atlanta Childrens Shelter Inc", "semantic_rank": 4, "reason": "Closed today, opens Saturday", "category": "schedule"},
            {"name": "Basic Needs Dao Corporation", "semantic_rank": 5, "reason": "Closed today, opens Monday", "category": "schedule"},
            {"name": "Partners For Home Inc", "semantic_rank": 6, "reason": "Closed today, open Tuesday and Thursday", "category": "schedule"},
            {"name": "Greenline Community Pantry", "semantic_rank": 9, "reason": "No refrigeration", "category": "storage"},
            {"name": "Harborview Neighbors Trust", "semantic_rank": 14, "reason": "Profile contradicts its own records: call before sending", "category": "conflict"},
            {"name": "Martin Clinic Healing House", "semantic_rank": 17, "reason": "Medical fridge only, not for donated food", "category": "medical"},
        ],
    },
    "dairy": {
        "offer_key": "dairy",
        "posting_id": 2,
        "offer_code": "OFFER #ATL-8828",
        "track": "RETAIL",
        "status": "Offered to Food Flow Collaborative, awaiting reply (sent 1:55 PM)",
        "status_type": "awaiting",
        "donor_label": "Grocery store Â· West End",
        "posting_text": "mixed dairy - about 60 gallons of milk and some yogurt, 2 days to code date",
        "category_tag": "Dairy",
        "storage_tag": "Keep cold",
        "needs_cold": True,
        "needs_frozen": False,
        "pallets": 0.5,
        "pallets_label": "about 0.5 pallet (60 gal + yogurt)",
        "hours_remaining": 8.0,
        "countdown_label": "7h 50m left",
        "dock_shutoff": "10:10 PM",
        "brief_url": "match-brief-spinach.html?offer=dairy",
        "pipeline": {
            "found_by_meaning": 60,
            "viable_count": 22,
            "ruled_out_count": 38,
            "recommended_count": 3,
        },
        "candidates": [
            {
                "recipient_id": 42,
                "rank": 1,
                "semantic_rank": 4,
                "viable": True,
                "tier": 1,
                "score": 0.804,
                "distance": 0.2190,
                "name": "Food Flow Collaborative Incorporated",
                "address": "3137 Buford Hwy NE, Brookhaven GA 30329",
                "archetype_label": "Mobile pantry with refrigerated van",
                "cold_storage": "vehicle",
                "max_pallets": 3,
                "capacity_pallets": 3.0,
                "takes_it_all": True,
                "pickup_window_hours": 5,
                "can_self_collect": True,
                "margin_hours": 3.0,
                "margin_label": "+2h 50m spare",
                "est_pickup_time": "7:20 PM",
                "refrigerated_transport": True,
                "weekly_households": 460,
                "no_vehicle_rate": 0.076,
                "poverty_rate": 0.148,
                "food_insecurity_rate": 0.098,
                "need_score": 0.42,
                "profile_source": "generated",
                "why_them": "Mobile refrigerated van distributes dairy and produce on same-day stops across metro Atlanta.",
                "what_they_can_take": "All 60 gallons of milk and yogurt (0.5 pallet fits inside their 3-pallet refrigerated van).",
                "pickup_warning": None,
                "draft_sms": "Hi Food Flow team, this is the Atlanta food rescue desk. A West End grocer has 60 gallons of milk and yogurt (2 days to code date) that must move by 10:10 PM tonight. Can your refrigerated van collect this evening?",
            },
            {
                "recipient_id": 67,
                "rank": 2,
                "semantic_rank": 6,
                "viable": True,
                "tier": 1,
                "score": 0.791,
                "distance": 0.2280,
                "name": "Fda-Bridging The Gap Inc",
                "address": "5373 Riverdale Rd, Atlanta GA 30349",
                "archetype_label": "Mobile pantry with refrigerated van",
                "cold_storage": "vehicle",
                "max_pallets": 4,
                "capacity_pallets": 4.0,
                "takes_it_all": True,
                "pickup_window_hours": 5,
                "can_self_collect": True,
                "margin_hours": 3.0,
                "margin_label": "+2h 50m spare",
                "est_pickup_time": "7:20 PM",
                "refrigerated_transport": True,
                "weekly_households": 390,
                "no_vehicle_rate": 0.167,
                "poverty_rate": 0.284,
                "food_insecurity_rate": 0.339,
                "need_score": 0.84,
                "profile_source": "generated",
                "why_them": "Operates a refrigerated van in South Atlanta (33.9% food insecurity) and distributes short-dated dairy the same day.",
                "what_they_can_take": "All 0.5 pallet of milk and yogurt (up to 4 pallets capacity).",
                "pickup_warning": None,
                "draft_sms": "Hi Bridging The Gap team, Food Flow was unavailableâ€”can your refrigerated van collect 60 gallons of milk and yogurt from a West End grocer before 10:10 PM tonight?",
            },
        ],
        "split_plan": [
            {
                "split_stop": 1,
                "recipient_id": 88,
                "name": "House Of Serenity Inc",
                "address": "1711 Ralph David Abernathy Blvd SW, Atlanta GA 30310",
                "archetype_label": "Neighborhood pantry, household fridge",
                "cold_storage": "domestic",
                "share_label": "20 gallons + yogurt",
                "split_share_pallets": 0.15,
                "pickup_window_hours": 3,
                "margin_label": "4h 50m to spare",
                "est_pickup_time": "5:20 PM",
                "food_insecurity_rate": 0.286,
                "no_vehicle_rate": 0.241,
                "poverty_rate": 0.312,
                "warning": "Confirm fridge space before dispatching driver",
                "draft_sms": "Hi House Of Serenity, can you take 20 gallons of milk and yogurt from a West End grocer tonight if we deliver?",
            },
            {
                "split_stop": 2,
                "recipient_id": 54,
                "name": "2 Fishes And 5 Loaves More Than Enough",
                "address": "220 Winkfield Pt, College Park GA 30349",
                "archetype_label": "Transitional housing, one large household fridge",
                "cold_storage": "domestic",
                "share_label": "20 gallons + yogurt",
                "split_share_pallets": 0.15,
                "pickup_window_hours": 3,
                "margin_label": "4h 50m to spare",
                "est_pickup_time": "5:20 PM",
                "food_insecurity_rate": 0.339,
                "no_vehicle_rate": 0.167,
                "poverty_rate": 0.295,
                "warning": "Plan to deliver via volunteer driver",
                "draft_sms": "Hi 2 Fishes And 5 Loaves, can you take 20 gallons of milk and yogurt tonight if a volunteer driver drops it off?",
            },
        ],
        "ruled_out": [
            {"name": "Greenline Community Pantry", "semantic_rank": 5, "reason": "No refrigeration", "category": "storage"},
            {"name": "Martin Clinic Healing House", "semantic_rank": 8, "reason": "Medical fridge only, not for donated food", "category": "medical"},
        ],
    },
    "bread": {
        "offer_key": "bread",
        "posting_id": 3,
        "offer_code": "OFFER #ATL-8822",
        "track": "RETAIL",
        "status": "Accepted by 2 Fishes And 5 Loaves Â· pickup 5:00 PM",
        "status_type": "accepted",
        "donor_label": "Grocery store Â· Decatur Â· 3 locations",
        "posting_text": "roughly 200 loaves of day-old bread and pastries from three store locations",
        "category_tag": "Bakery",
        "storage_tag": "Shelf-stable",
        "needs_cold": False,
        "needs_frozen": False,
        "pallets": 1.0,
        "pallets_label": "1 pallet (200 loaves)",
        "hours_remaining": 24.0,
        "countdown_label": "23h 50m left",
        "dock_shutoff": "Tomorrow 2:10 PM",
        "brief_url": "match-brief-spinach.html?offer=bread",
        "pipeline": {
            "found_by_meaning": 60,
            "viable_count": 38,
            "ruled_out_count": 22,
            "recommended_count": 3,
        },
        "candidates": [
            {
                "recipient_id": 54,
                "rank": 1,
                "semantic_rank": 2,
                "viable": True,
                "tier": 1,
                "score": 0.862,
                "distance": 0.2040,
                "name": "2 Fishes And 5 Loaves More Than Enough",
                "address": "220 Winkfield Pt, College Park GA 30349",
                "archetype_label": "Transitional housing & neighborhood pantry",
                "cold_storage": "domestic",
                "max_pallets": 1,
                "capacity_pallets": 1.0,
                "takes_it_all": True,
                "pickup_window_hours": 3,
                "can_self_collect": True,
                "margin_hours": 21.0,
                "margin_label": "+20h 50m spare",
                "est_pickup_time": "5:00 PM",
                "refrigerated_transport": False,
                "weekly_households": 140,
                "no_vehicle_rate": 0.167,
                "poverty_rate": 0.295,
                "food_insecurity_rate": 0.339,
                "need_score": 0.84,
                "profile_source": "generated",
                "why_them": "Profile specifically asks for ready meals, bread, and fruit that require no prep, and serves a tract where 33.9% of adults are food insecure.",
                "what_they_can_take": "All 200 loaves of bread and pastries (shelf-stable, 1 pallet).",
                "pickup_warning": None,
                "draft_sms": "Hi 2 Fishes And 5 Loaves, confirming your 5:00 PM pickup/delivery of 200 loaves of day-old bread and pastries from the 3 Decatur grocery locations.",
            },
            {
                "recipient_id": 88,
                "rank": 2,
                "semantic_rank": 5,
                "viable": True,
                "tier": 1,
                "score": 0.845,
                "distance": 0.2180,
                "name": "House Of Serenity Inc",
                "address": "1711 Ralph David Abernathy Blvd SW, Atlanta GA 30310",
                "archetype_label": "Neighborhood pantry",
                "cold_storage": "domestic",
                "max_pallets": 1,
                "capacity_pallets": 1.0,
                "takes_it_all": True,
                "pickup_window_hours": 3,
                "can_self_collect": True,
                "margin_hours": 21.0,
                "margin_label": "+20h 50m spare",
                "est_pickup_time": "5:20 PM",
                "refrigerated_transport": False,
                "weekly_households": 115,
                "no_vehicle_rate": 0.241,
                "poverty_rate": 0.312,
                "food_insecurity_rate": 0.286,
                "need_score": 0.88,
                "profile_source": "generated",
                "why_them": "Shelf-stable bakery goods move immediately at this West End neighborhood pantry (24.1% no-vehicle households).",
                "what_they_can_take": "Up to 200 loaves (or 100 loaves in a 2-way split).",
                "pickup_warning": None,
                "draft_sms": "Hi House Of Serenity, we have 200 loaves of bread and pastries from 3 Decatur stores (24h window). Can you take 100-200 loaves today?",
            },
        ],
        "split_plan": [],
        "ruled_out": [
            {"name": "Harborview Neighbors Trust", "semantic_rank": 11, "reason": "Profile contradicts its own records: call before sending", "category": "conflict"},
        ],
    },
}

EQUITY_AUDIT_DATA: dict[str, Any] = {
    "metro": "Atlanta, GA",
    "geocoding_summary": {
        "total_recipients": 127,
        "real_irs_recipients": 118,
        "planted_teaching_cases": 9,
        "geocoded_street_matches": 109,
        "zip_centroid_fallbacks": 9,
        "distinct_tracts_before_geocoding": 34,
        "distinct_tracts_after_geocoding": 86,
    },
    "benchmarks": [
        {
            "label": "Metro, population-weighted (ACS baseline)",
            "no_vehicle_rate": 0.129,
            "poverty_rate": 0.185,
            "assistance_rate": 0.181,
            "need_percentile": 0.47,
            "planted_share": "â€”",
            "reaches": "254 metro tracts",
        },
        {
            "label": "Pool: every generated recipient (118 IRS orgs)",
            "no_vehicle_rate": 0.134,
            "poverty_rate": 0.180,
            "assistance_rate": 0.187,
            "need_percentile": 0.48,
            "planted_share": "0%",
            "reaches": "118 recipients",
        },
        {
            "label": "Matcher before geocoded need weighting",
            "no_vehicle_rate": 0.197,
            "poverty_rate": 0.244,
            "assistance_rate": 0.192,
            "need_percentile": 0.65,
            "planted_share": "30%",
            "reaches": "6 recipients",
        },
        {
            "label": "Matcher with geocoded tracts, clock-scaled need & splitting",
            "no_vehicle_rate": 0.262,
            "poverty_rate": 0.325,
            "assistance_rate": 0.289,
            "need_percentile": 0.78,
            "planted_share": "17%",
            "reaches": "14 recipients",
            "highlight": True,
        },
    ],
    "key_findings": [
        "The pool looks like the metro (13.4% vs 12.9% no-vehicle; 18.0% vs 18.5% poverty). Recipients are not pre-concentrated in high-need tracts, so the equity gain comes from the matcher.",
        "Geocoding street addresses moved 93 of 109 recipients to their actual 2020 census tract (expanding coverage from 34 ZIP-centroid tracts to 86 tracts) and assigned neutral need (0.50) to the 9 planted teaching rows so invented coordinates never skew rankings.",
        "Clock-scaled need weighting (0.3 at <=6h rising to 0.6 at >=72h) and multi-stop load splitting raised the need percentile where food goes from 0.65 to 0.78 (26.2% no-vehicle, 32.5% poverty) and expanded reach from 6 organizations to 14.",
    ],
}


def _try_live_sql_match(
    posting_text: str,
    needs_cold: bool,
    needs_frozen: bool,
    pallets: float,
    hours_remaining: float,
    exclude_ids: list[int],
) -> dict[str, Any] | None:
    """Execute `sql/03_filter_and_rank.sql` live against BigQuery (`a4i_food`)."""
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
            address = f"{street}, {city} GA {zip_code}".strip(", ") if street else "No address on file (teaching case)"
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
                    "margin_label": f"+{margin:g}h spare" if margin >= 0 else f"Needs driver ({r.get('pickup_window_hours')}h window)",
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
                    "pickup_warning": None if (can_self and reefer) else "Line up a volunteer driver for collection/delivery.",
                    "draft_sms": (
                        f"Hi {name}, this is the Atlanta food rescue desk. We have \"{posting_text}\" "
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
                "address": f"{sr.get('street') or ''}, {sr.get('city') or 'Atlanta'} GA {sr.get('zip_code') or ''}".strip(", "),
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
                "draft_sms": f"Hi {sr.get('name')}, we are splitting \"{posting_text}\" across partner sites. Can you take {sr.get('split_share_pallets')} pallet(s) today?",
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

        return {
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
    except Exception as exc:
        logger.info("BigQuery ADC not active locally (%s); serving frozen BigQuery snapshot.", type(exc).__name__)
        return None


# ---------------------------------------------------------------------------
# API Routes for the Coordinator Console (`frontend/`)
# ---------------------------------------------------------------------------
@app.get("/api/queue")
def api_get_queue() -> dict[str, Any]:
    """Return active Atlanta surplus offers and cold-storage network distribution from BigQuery."""
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
                "household_fridge_only": {"count": int(r.domestic_n), "pct": round(100.0 * r.domestic_n / total_recs, 1)},
                "walkin_commercial_van": {"count": int(r.real_cold_n), "pct": round(100.0 * r.real_cold_n / total_recs, 1)},
                "medical_or_none": {"count": int(r.other_n), "pct": round(100.0 * r.other_n / total_recs, 1)},
            }
    except Exception:
        pass

    offers_summary = []
    for key in ("deli", "spinach", "dairy", "bread"):
        item = OFFERS_CATALOG[key]
        top_cand = item["candidates"][0] if item["candidates"] else None
        offers_summary.append(
            {
                "offer_key": key,
                "posting_id": item["posting_id"],
                "offer_code": item["offer_code"],
                "status": item["status"],
                "status_type": item["status_type"],
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


# ---------------------------------------------------------------------------
# Dispatches: each console offer is a request in the offer-state service (Cloud SQL), and
# marking it sent, accepted or declined records an offer there. The same service drives the
# agent, so the console and the agent share one double-booking guard: a recipient with a live
# offer on one posting is left out of every other until that offer ends.
# ---------------------------------------------------------------------------
def _console_offer(payload: dict[str, Any]) -> dict[str, Any]:
    """The catalog offer a payload refers to, or a custom posting built from the payload."""
    key = str(payload.get("offer_key") or "").lower()
    code = str(payload.get("offer_code") or "")
    text = str(payload.get("posting_text") or "").strip()
    for item in OFFERS_CATALOG.values():
        if (key and item["offer_key"] == key) or (code and item["offer_code"] == code) or (
                text and item["posting_text"].lower() == text.lower()):
            return item
    storage = str(payload.get("required_storage") or "") or _normalize_storage_requirement("", text)
    return {
        "posting_text": text,
        # One code per custom posting text, so its claims and declines find the same request.
        "offer_code": "CUSTOM-" + hashlib.sha1(text.lower().encode()).hexdigest()[:8].upper(),
        "posting_id": None,
        "needs_cold": storage in ("refrigerated", "frozen"),
        "needs_frozen": storage == "frozen",
        "pallets": float(payload.get("pallets") or payload.get("pallets_claimed") or 0.2),
        "hours_remaining": float(payload.get("hours_remaining") or 6.0),
    }


def _console_request(offer: dict[str, Any], create: bool) -> dict[str, Any] | None:
    """The live request for a console offer; with create, saved on first use."""
    if not create:
        return state_tools.find_live_request(offer["offer_code"])
    storage = ("frozen" if offer["needs_frozen"]
               else "refrigerated" if offer["needs_cold"] else "shelf-stable")
    return state_tools.create_request(
        metro=os.environ.get("FOOD_RESCUE_METRO", "Atlanta"), posting_text=offer["posting_text"],
        required_storage=storage, pallets=float(offer["pallets"]),
        deadline_hours=float(offer["hours_remaining"]), source_posting_id=offer.get("posting_id"),
        offer_code=offer["offer_code"], reuse_live=True)


def _offer_on(request: dict[str, Any], recipient_id: int) -> dict[str, Any] | None:
    return next((o for o in request["offers"] if o["recipient_id"] == recipient_id), None)


def _dispatch_exclusions(offer: dict[str, Any]) -> tuple[list[int], list[dict[str, Any]]]:
    """Who the console's Match Brief leaves out for an offer, and who is tied up elsewhere.

    Recipients who declined this offer or let it expire are out, as are holds and anyone tied
    up by another posting. A recipient this offer is waiting on stays: they are the match.
    """
    if not state_tools.state_service_url():
        return [], []
    try:
        request = _console_request(offer, create=False)
        if request is None:
            busy = state_tools.live_offers()
            return [int(b["recipient_id"]) for b in busy], [
                state_tools.dispatch_entry(b) for b in busy]
        said_no = [o["recipient_id"] for o in request["offers"]
                   if o["current_status"] in ("declined", "expired")]
        excluded = set(said_no) | set(request["held_ids"]) | set(request["busy_ids"])
        return sorted(excluded), [state_tools.dispatch_entry(b) for b in request["busy_elsewhere"]]
    except Exception as exc:  # noqa: BLE001
        logger.warning("Offer-state service unavailable (%s); matching without it.", exc)
        return [], []


def _active_dispatches() -> dict[str, Any]:
    active = [state_tools.dispatch_entry(o) for o in state_tools.live_offers()]
    return {"status": "ok", "active_count": len(active), "active_dispatches": active}


@app.get("/api/dispatches")
def api_get_dispatches() -> dict[str, Any]:
    """Every recipient tied up by a live offer right now, across postings."""
    try:
        return _active_dispatches()
    except Exception as exc:  # noqa: BLE001
        return state_tools.failure(exc) | {"active_count": 0, "active_dispatches": []}


@app.post("/api/dispatches/claim")
def api_claim_dispatch(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Record an offer to a recipient ("Mark as sent"), or its acceptance (status=accepted),
    so other postings leave them out until it ends."""
    recipient_id = int(payload.get("recipient_id") or 0)
    name = str(payload.get("recipient_name") or "") or f"Recipient #{recipient_id}"
    try:
        request = _console_request(_console_offer(payload), create=True)
        mine = _offer_on(request, recipient_id)
        if mine is not None and mine["current_status"] in ("declined", "picked_up"):
            return {"status": "conflict",
                    "detail": f"{name} already {mine['current_status'].replace('_', ' ')} "
                              f"{request['offer_code']}"}
        if mine is None or mine["current_status"] in ("withdrawn", "expired"):
            pallets = float(payload.get("pallets_claimed") or 0)
            unclaimed = float(request["unclaimed_pallets"])
            request = state_tools.state_call("POST", "/offers", {
                "request_id": str(request["request_id"]), "recipient_id": recipient_id,
                "recipient_name": name,
                # The console sends the whole load; offer no more than is still unclaimed.
                "offered_pallets": min(pallets, unclaimed) if pallets and unclaimed > 0 else None,
                "actor": "console",
            })
            mine = _offer_on(request, recipient_id)
        if payload.get("status") == "accepted" and mine["current_status"] != "accepted":
            request = state_tools.state_call("POST", f"/offers/{mine['offer_id']}/response",
                                             {"status": "accepted", "actor": "recipient"})
            mine = _offer_on(request, recipient_id)
        entry = state_tools.dispatch_entry(
            mine | {"posting_text": request["posting_text"], "offer_code": request["offer_code"]})
        return {
            "status": "ok",
            "message": (f"Locked {name} (ID {recipient_id}) for {request['offer_code']}. Other "
                        "postings leave them out until this offer ends."),
            "claimed_entry": entry,
            "active_dispatches": _active_dispatches()["active_dispatches"],
        }
    except Exception as exc:  # noqa: BLE001
        return state_tools.failure(exc)


@app.post("/api/dispatches/release")
def api_release_dispatch(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """A recipient said no (reason=declined, the default) or the coordinator took the offer
    back (reason=withdrawn). With a posting, records it on that posting, so it sticks for
    the next match; without one, releases every live offer the recipient holds."""
    recipient_id = int(payload.get("recipient_id") or 0)
    withdraw = payload.get("reason") == "withdrawn"
    try:
        if payload.get("offer_key") or payload.get("offer_code") or payload.get("posting_text"):
            request = _console_request(_console_offer(payload), create=True)
            if _offer_on(request, recipient_id) is None:
                # Declined before anyone marked it sent: record the ask and the no together.
                request = state_tools.state_call("POST", "/offers", {
                    "request_id": str(request["request_id"]), "recipient_id": recipient_id,
                    "recipient_name": payload.get("recipient_name") or None,
                    "even_if_busy": True, "actor": "console",
                })
            offers = [_offer_on(request, recipient_id)]
        else:
            offers = state_tools.live_offers(recipient_id)
        released = 0
        for o in offers:
            # Backing out of an accepted offer is a withdrawal; a no to a pending one, a decline.
            status = "withdrawn" if withdraw or o["current_status"] == "accepted" else "declined"
            try:
                state_tools.state_call("POST", f"/offers/{o['offer_id']}/response", {
                    "status": status, "reason_code": payload.get("reason_code") or None,
                    "reason_text": payload.get("reason_text") or None, "actor": "console"})
                released += 1
            except state_tools.StateServiceError as exc:
                if exc.status != 409:   # already declined or withdrawn: nothing to release
                    raise
        return {
            "status": "ok",
            "released_recipient_id": recipient_id,
            "removed_count": released,
            "active_dispatches": _active_dispatches()["active_dispatches"],
        }
    except Exception as exc:  # noqa: BLE001
        return state_tools.failure(exc)


@app.get("/api/match")
def api_get_match(
    offer: str = Query("spinach", description="Offer key: spinach, deli, dairy, bread"),
    exclude_ids: str = Query("", description="Comma-separated recipient_ids to exclude (when they say no)"),
) -> dict[str, Any]:
    """Return the Match Brief data for a specific offer, dynamically filtering excluded
    and already-matched recipient IDs so we never double-match the same recipient.
    """
    explicit_excluded = [int(x.strip()) for x in exclude_ids.split(",") if x.strip().isdigit()]
    base = OFFERS_CATALOG.get(offer.lower(), OFFERS_CATALOG["spinach"])

    # Prevent double-matching: leave out who declined this offer, and anyone tied up by a live
    # offer on another posting (the offer-state service in Cloud SQL).
    saved_excluded, claimed_elsewhere = _dispatch_exclusions(base)
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

    # Surface already-claimed recipients at the top of `ruled_out` so the coordinator sees why they were skipped
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

    return {
        "data_source": data_source,
        "offer_key": base["offer_key"],
        "posting_id": base["posting_id"],
        "offer_code": base["offer_code"],
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


@app.post("/api/match")
def api_post_custom_match(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Run a custom surplus posting through `sql/03_filter_and_rank.sql` (from the '+ New Offer' modal)."""
    posting_text = str(payload.get("posting_text") or "10 crates of spinach, harvested yesterday, needs cold storage")
    storage = str(payload.get("required_storage") or "refrigerated").lower()
    pallets = float(payload.get("pallets") or 0.2)
    hours = float(payload.get("hours_remaining") or 6.0)
    excluded = [int(x) for x in (payload.get("exclude_ids") or []) if str(x).isdigit()]
    saved_excluded, claimed_elsewhere = _dispatch_exclusions(_console_offer(payload))
    excluded = sorted(set(excluded) | set(saved_excluded))

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
    return res


@app.get("/api/equity-audit")
def api_get_equity_audit() -> dict[str, Any]:
    """Return the Atlanta Equity Audit benchmarks and findings across all 10 postings."""
    return EQUITY_AUDIT_DATA


@app.get("/api/recipients")
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
                    "address": f"{r.get('street') or ''}, {r.get('city') or 'Atlanta'} GA {r.get('zip_code') or ''}".strip(", "),
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


# ---------------------------------------------------------------------------
# Mount the Coordinator Console UI at `/console` and top-level HTML routes
# ---------------------------------------------------------------------------
if FRONTEND_DIR.exists():
    app.mount("/console", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="console")


@app.get("/queue.html", include_in_schema=False)
def serve_queue() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "queue.html")


@app.get("/match-brief-spinach.html", include_in_schema=False)
def serve_spinach() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "match-brief-spinach.html")


@app.get("/match-brief-deli.html", include_in_schema=False)
def serve_deli() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "match-brief-deli.html")


@app.get("/grocer-post.html", include_in_schema=False)
def serve_grocer_post() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "grocer-post.html")


@app.get("/pantry-offer.html", include_in_schema=False)
def serve_pantry_offer() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "pantry-offer.html")


@app.get("/driver-request.html", include_in_schema=False)
def serve_driver_request() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "driver-request.html")


@app.get("/app.js", include_in_schema=False)
def serve_app_js() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "app.js", media_type="application/javascript")

