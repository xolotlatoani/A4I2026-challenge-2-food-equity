# AGENTS.md

## Project & Track Context
- **Challenge 2 — Resilient Food Equity & Surplus Broker** (Agents for Impact 2026).
- **Active Track & Metro**: **Retail & Grocer Rescue** (`RETAIL`) in **Atlanta** (`FOOD_RESCUE_METRO=Atlanta`), though code must remain metro-agnostic via environment variables.
- **BigQuery Dataset**: `a4i_food` (location `US`) containing `recipients`, `recipient_embeddings`, `surplus_postings`, `shelf_life`, `tract_demographics`, `recipient_geocodes`, `recipient_tracts`, and the `recipient_facts` view.

## Commands
- **Run ADK Web UI**:
  ```bash
  adk web .
  ```
- **Verify agent loading & tool wiring**:
  ```bash
  python -c "from google.adk.cli.utils.agent_loader import AgentLoader; a = AgentLoader('.').load_agent('agent'); print(a.name, len(a.tools))"
  ```
- **Load BigQuery data**:
  ```bash
  bash scripts/load.sh atlanta
  ```
  Always invoke with `bash scripts/load.sh`, never `./scripts/load.sh`. Do not run `notebooks/c2_90_publish_snapshot.ipynb` (maintainer-only; fails with bucket permission error).
- **Geocode recipients** (once after loading; builds `recipient_tracts` and the `recipient_facts` view that `match_surplus_posting` and `get_recipient_tract_equity` read):
  ```bash
  python3 scripts/geocode_recipients.py
  ```
- **Deploy to Cloud Run**:
  ```bash
  bash deploy.sh
  ```
  Uses `gcloud run deploy --source . --min-instances=1` (Cloud Build reads `Dockerfile` remotely).

## Architecture & Lane Ownership
- `agent/__init__.py`, `agent/agent.py`, `agent/prompts.py`, `Dockerfile`, `deploy.sh`: ADK agent (`root_agent` named `food_rescue_broker`, model `gemini-3.8-flash`) and system instructions (Agent Lane — Person B).
- `agent/tools.py`, `agent/mcp_config.py`, `agent/tools.yaml`, `scripts/test_person_a_tools.py`: Custom BigQuery `VECTOR_SEARCH` + constraint filter tools (`match_surplus_posting`, `check_shelf_life`, `get_recipient_tract_equity`, `split_large_load`, `ensure_embeddings_table`) and `get_mcp_toolsets()` (Agent Lane — Person A).
- `sql/01_build_recipient_embeddings.sql`, `sql/02_match_candidates.sql`, `sql/03_filter_and_rank.sql`: Materializes `a4i_food.recipient_embeddings` (127 Atlanta rows), runs parameterized `VECTOR_SEARCH` (`@posting_text`, `@top_k`), and defines the SQL filter/rank pipeline (tiers 1-5, `<30m` margin penalties, and `split_stop`/`split_share_pallets`). `match_surplus_posting` runs `03` directly, so the agent, the Toolbox and `scripts/equity_audit.py` rank with one query.
- `sql/04_build_recipient_tracts.sql`, `sql/05_recipient_facts.sql`, `sql/06_recipient_equity.sql`, `scripts/geocode_recipients.py`: each recipient's geocoded census tract and need, the `recipient_facts` view, and the "whose neighborhood does this help?" lookup that `get_recipient_tract_equity` and the Toolbox's `query_recipient_tract_demographics` both run (Data Lane).
- `frontend/`: Static coordinator console screens designed in Google Stitch (`queue.html`, `match-brief-spinach.html`, `match-brief-deli.html`) representing real Atlanta dispatch outputs.

## Critical BigQuery & Domain Gotchas
1. **Embedding Model Lock-In**: Corpus and query sides must both use `endpoint => 'gemini-embedding-2'` (3072 dims). Never use `gemini-embedding-001` in bulk (1 row/request limit).
2. **`AI.EMBED` Return Type**: Returns `STRUCT<result ARRAY<FLOAT64>, status STRING>`. Always extract `.result` and filter `WHERE embedded.status = ''`.
3. **Brute-Force Vector Search Only**: Do not rely on `CREATE VECTOR INDEX` (<10 MB tables never populate the index). Always pass `distance_type => 'COSINE', options => '{"use_brute_force": true}'` to `VECTOR_SEARCH`.
4. **Vector Search Is a Candidate Generator, Not the Answer**:
   - **Near-miss decoy**: `Greenline Community Pantry` (`profile_source = 'planted'`) ranks #2 semantically on spinach (`distance ~0.198`) because its profile asks for fresh greens, but it has `cold_storage = 'none'`. Post-search filtering on `cold_storage`, `max_pallets`, and `pickup_window_hours <= effective_hours_remaining` is mandatory.
   - **Contradiction case**: `Harborview Neighbors Trust` claims a walk-in freezer in sentence one and a single cupboard shelf with no freezer in sentence two. Flag/exclude it.
   - **Tied candidates**: `Cedar Street Produce Alliance` and `Maple Street Produce Alliance` have identical operational specs; break ties explicitly using census tract need (`no_vehicle_rate`, `poverty_rate`, `assistance_rate`).
5. **USDA FoodKeeper (`a4i_food.shelf_life`) Quirks**:
   - No product is named `"Spinach"`—spinach is stored under `product_name = 'Lettuce'` with `product_subtitle = 'spinach, leaf greens'`. Always search across `product_name`, `product_subtitle`, and `keywords`.
   - Duration columns contain non-numeric sentinels (`indefinitely`, `not recommended`, `package use-by date` -> `see_package`, `when ripe`). Never cast unparsed durations to `0` (which falsely marks food as expired); fall back to `donor_deadline_hours` when shelf life is null.
6. **ACS Census Join Quirks**:
   - Always join ACS tract IDs with `LPAD(a.geo_id, 11, '0') = g.geo_id` (ACS strips leading zeros on state FIPS < 10).
   - `internal_point_lat` and `internal_point_lon` in `us_census_tracts_national` are `STRING`—always `SAFE_CAST(... AS FLOAT64)`.

