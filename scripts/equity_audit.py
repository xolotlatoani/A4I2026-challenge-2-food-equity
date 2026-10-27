#!/usr/bin/env python3
"""Equity audit: did the food go where the need is, or where the loading docks are?

Runs a matcher across all ten surplus postings, takes the recipients it put first, and compares
their census tracts with two baselines (README, "What auditing the outcome actually means"):

  * the metro       - every tract, weighted by population
  * the pool        - every recipient the matcher could have chosen

The second baseline matters. If recipients already sit in needier tracts than the metro, a
matcher beats the metro by doing nothing. Beating the pool is the real test.

    python3 scripts/equity_audit.py                  # both matchers
    python3 scripts/equity_audit.py --matcher sql    # sql/03_filter_and_rank.sql only
    python3 scripts/equity_audit.py --matcher agent  # agent/tools.py match_surplus_posting only

Needs google-cloud-bigquery and application default credentials (Cloud Shell has both).

Planted rows are left out of every average: the notebook places them at made-up coordinates in
the middle of the metro, so the tract they land in says nothing. Picks that were planted rows
are counted and reported instead.
"""

from __future__ import annotations

import argparse
import importlib.util
import math
import os
import statistics
from collections import Counter
from pathlib import Path

from google.cloud import bigquery

REPO = Path(__file__).resolve().parent.parent
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "qwiklabs-gcp-04-ef48e08bc216")
DATASET = os.environ.get("BIGQUERY_DATASET", "a4i_food")

# The audit's clock: Thursday 2:10pm, the README's scenario. Fixed so runs are comparable.
SERVICE_DATE = "2026-10-29"

# Load size in pallets. surplus_postings has no quantity column, so these are estimates,
# on the scale sql/03_filter_and_rank.sql uses (10 produce crates ~ 0.18 pallet).
PALLETS = {1: 0.18, 2: 0.5, 3: 1, 4: 0.25, 5: 5, 6: 12, 7: 30, 8: 0.5, 9: 1, 10: 0.25}

TOP_N = 3     # a coordinator works down a short list, so audit the first three, not just one

# Every recipient's tract, need percentile, and the two baselines, in one pass. "Their tract"
# is the nearest tract center, the same rule both matchers use.
BASELINE_SQL = f"""
WITH tracts AS (
  SELECT
    geo_id, tract_lat, tract_lon, total_pop, poverty_rate, no_vehicle_rate, assistance_rate,
    ROUND((PERCENT_RANK() OVER (ORDER BY no_vehicle_rate)
           + PERCENT_RANK() OVER (ORDER BY poverty_rate)) / 2, 3) AS need_score
  FROM `{PROJECT}.{DATASET}.tract_demographics`
  WHERE no_vehicle_rate IS NOT NULL AND poverty_rate IS NOT NULL
),
recipient_tract AS (
  SELECT
    r.recipient_id, r.name, r.profile_source,
    ARRAY_AGG(STRUCT(t.geo_id, t.poverty_rate, t.no_vehicle_rate, t.assistance_rate, t.need_score)
              ORDER BY ST_DISTANCE(ST_GEOGPOINT(r.longitude, r.latitude),
                                   ST_GEOGPOINT(t.tract_lon, t.tract_lat))
              LIMIT 1)[OFFSET(0)] AS tract
  FROM `{PROJECT}.{DATASET}.recipients` r CROSS JOIN tracts t
  GROUP BY r.recipient_id, r.name, r.profile_source
)
SELECT
  'recipient' AS kind, recipient_id, name, profile_source, tract.geo_id,
  tract.poverty_rate, tract.no_vehicle_rate, tract.assistance_rate, tract.need_score,
  NULL AS weight
FROM recipient_tract
UNION ALL
SELECT 'tract', NULL, NULL, NULL, geo_id, poverty_rate, no_vehicle_rate, assistance_rate,
       need_score, total_pop
FROM tracts
"""

# (column, header, format) for the summary table, in print order.
METRICS = (
    ("no_vehicle_rate", "no-vehicle", ".1%"),
    ("poverty_rate", "poverty", ".1%"),
    ("assistance_rate", "assist", ".1%"),
    ("need_score", "need pct", ".2f"),
)


def load_agent_matcher():
    """Import agent/tools.py by path, so the ADK package init is not needed."""
    spec = importlib.util.spec_from_file_location("agent_tools", REPO / "agent" / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.match_surplus_posting


def sql_picks(client, posting):
    """Recipient ids sql/03_filter_and_rank.sql puts first, viable only, in rank order."""
    pid = posting["posting_id"]
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("posting_text", "STRING", posting["posting_text"]),
        bigquery.ScalarQueryParameter("needs_cold", "BOOL", posting["storage_state"] == "refrigerated"),
        bigquery.ScalarQueryParameter("needs_frozen", "BOOL", posting["storage_state"] == "frozen"),
        bigquery.ScalarQueryParameter("pallets", "FLOAT64", PALLETS[pid]),
        bigquery.ScalarQueryParameter("hours_remaining", "FLOAT64", posting["hours_remaining"]),
        bigquery.ScalarQueryParameter("service_date", "DATE", SERVICE_DATE),
        bigquery.ArrayQueryParameter("exclude_ids", "INT64", []),
    ])
    sql = (REPO / "sql" / "03_filter_and_rank.sql").read_text()
    rows = client.query(sql, job_config=cfg).result()
    return [r["recipient_id"] for r in sorted(rows, key=lambda r: r["rank"]) if r["viable"]][:TOP_N]


def agent_picks(match, posting):
    """Recipient ids agent/tools.py match_surplus_posting ranks first."""
    pid = posting["posting_id"]
    result = match(
        posting_text=posting["posting_text"],
        required_storage="shelf-stable" if posting["storage_state"] == "pantry" else posting["storage_state"],
        pallets_needed=max(1, math.ceil(PALLETS[pid])),
        donor_deadline_hours=float(posting["hours_available"]),
        food_item=posting["foodkeeper_product"] or "",
    )
    return [m["recipient_id"] for m in result["ranked_matches"]][:TOP_N]


def mean(rows, key, weight=None):
    rows = [r for r in rows if r[key] is not None]
    if not rows:
        return float("nan")
    if weight:
        total = sum(r[weight] for r in rows)
        return sum(r[key] * r[weight] for r in rows) / total
    return statistics.mean(r[key] for r in rows)


def audit(name, picks_by_posting, recipients, postings, baselines):
    print(f"\n{'=' * 92}\n{name}\n{'=' * 92}")
    print(f"{'#':<3}{'posting':<34}{'first pick':<32}{'no-veh':>8}{'poverty':>9}{'need':>6}")
    first, top_n, planted = [], [], 0
    for p in postings:
        ids = picks_by_posting[p["posting_id"]]
        if not ids:
            print(f"{p['posting_id']:<3}{p['posting_text'][:32]:<34}(no viable recipient)")
            continue
        for rank, rid in enumerate(ids):
            r = recipients[rid]
            if r["profile_source"] == "planted":
                planted += 1
                continue
            top_n.append(r)
            if rank == 0:
                first.append(r)
        r = recipients[ids[0]]
        tag = " (planted)" if r["profile_source"] == "planted" else ""
        print(f"{p['posting_id']:<3}{p['posting_text'][:32]:<34}{(r['name'][:20] + tag):<32}"
              f"{r['no_vehicle_rate']:>8.1%}{r['poverty_rate']:>9.1%}{r['need_score']:>6.2f}")

    print(f"\n{'':<34}" + "".join(f"{header:>11}" for _, header, _ in METRICS))
    for label, rows, weight in (
        ("Metro, population-weighted", baselines["metro"], "weight"),
        ("Pool: every generated recipient", baselines["pool"], None),
        ("First picks", first, None),
        (f"Top {TOP_N} picks", top_n, None),
    ):
        print(f"{label:<34}" + "".join(
            f"{mean(rows, key, weight):>11{fmt}}" for key, _, fmt in METRICS))
    picks = [rid for ids in picks_by_posting.values() for rid in ids]
    counts = Counter(recipients[rid]["name"] for rid in picks)
    print(f"\n{len(set(picks))} distinct recipients across {len(picks)} top-{TOP_N} slots; "
          f"{planted} slots went to planted rows (left out of the averages).")
    print("Most chosen: " + ", ".join(f"{n} x{c}" for n, c in counts.most_common(3)))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--matcher", choices=("both", "sql", "agent"), default="both")
    args = parser.parse_args()

    client = bigquery.Client(project=PROJECT)
    rows = [dict(r) for r in client.query(BASELINE_SQL).result()]
    recipients = {r["recipient_id"]: r for r in rows if r["kind"] == "recipient"}
    baselines = {
        "metro": [r for r in rows if r["kind"] == "tract"],
        "pool": [r for r in recipients.values() if r["profile_source"] == "generated"],
    }
    postings = [dict(r) for r in client.query(
        f"SELECT * FROM `{PROJECT}.{DATASET}.surplus_postings` ORDER BY posting_id").result()]

    if args.matcher in ("both", "sql"):
        picks = {p["posting_id"]: sql_picks(client, p) for p in postings}
        audit("sql/03_filter_and_rank.sql", picks, recipients, postings, baselines)
    if args.matcher in ("both", "agent"):
        match = load_agent_matcher()
        picks = {p["posting_id"]: agent_picks(match, p) for p in postings}
        audit("agent/tools.py match_surplus_posting (what the demo agent calls)",
              picks, recipients, postings, baselines)


if __name__ == "__main__":
    main()
