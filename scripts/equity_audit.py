#!/usr/bin/env python3
"""Equity audit: did the food go where the need is, or where the loading docks are?

Runs a matcher across all ten surplus postings and compares the census tracts of the recipients
it chose with two baselines (README, "What auditing the outcome actually means"):

  * the metro       - every tract in tract_demographics, weighted by population
  * the pool        - every recipient the matcher could have chosen

The second baseline matters. If recipients already sit in needier tracts than the metro, a
matcher beats the metro by doing nothing. Beating the pool is the real test.

Three views of what a matcher chose:

  * first picks          - rank 1 for each posting
  * top 3 picks          - the short list a coordinator works down
  * where the food goes  - each posting's load, divided between recipients by the pallets they
                           get: all of it to rank 1 when rank 1 can hold it, otherwise the
                           query's split plan. Pallets nobody can hold are reported as unplaced

    python3 scripts/equity_audit.py                  # both matchers
    python3 scripts/equity_audit.py --matcher sql    # sql/03_filter_and_rank.sql only
    python3 scripts/equity_audit.py --matcher agent  # agent/tools.py match_surplus_posting only
    python3 scripts/equity_audit.py --matcher sql --sql old_version.sql   # compare a variant

Needs google-cloud-bigquery, application default credentials (Cloud Shell has both), and
a4i_food.recipient_tracts (run scripts/geocode_recipients.py first). Every recipient is judged
by the tract its street address geocodes to, whatever tract the matcher itself used.

Planted rows are left out of every average: they have no address and their coordinates are
made up, so there is no tract to judge them by. Their share is reported instead.
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

# Every recipient's geocoded tract and need, plus every metro tract for the baseline.
BASELINE_SQL = f"""
WITH tracts AS (
  SELECT
    geo_id, total_pop, poverty_rate, no_vehicle_rate, assistance_rate,
    ROUND((PERCENT_RANK() OVER (ORDER BY no_vehicle_rate)
           + PERCENT_RANK() OVER (ORDER BY poverty_rate)) / 2, 3) AS need_score
  FROM `{PROJECT}.{DATASET}.tract_demographics`
  WHERE no_vehicle_rate IS NOT NULL AND poverty_rate IS NOT NULL
)
SELECT
  'recipient' AS kind, r.recipient_id, r.name, r.profile_source, rt.tract_source,
  rt.tract_geo_id AS geo_id, rt.poverty_rate, rt.no_vehicle_rate, rt.assistance_rate,
  rt.need_score, NULL AS weight
FROM `{PROJECT}.{DATASET}.recipients` r
JOIN `{PROJECT}.{DATASET}.recipient_tracts` rt USING (recipient_id)
UNION ALL
SELECT 'tract', NULL, NULL, NULL, NULL, geo_id, poverty_rate, no_vehicle_rate, assistance_rate,
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


def sql_choice(client, sql, posting):
    """(ranked ids, [(id, share of the load)]) from a version of 03_filter_and_rank.sql."""
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
    rows = sorted(client.query(sql, job_config=cfg).result(), key=lambda r: r["rank"])
    viable = [r for r in rows if r["viable"]]
    if not viable:
        return [], []
    # Rank 1 takes the load when it can hold all of it. Otherwise the split plan is the plan,
    # and its shares can add up to less than the load. Versions without one send it to rank 1.
    split = sorted((r for r in rows if r.get("split_stop")), key=lambda r: r["split_stop"])
    if viable[0]["takes_it_all"] or not split:
        delivered = [(viable[0]["recipient_id"], 1.0)]
    else:
        delivered = [(r["recipient_id"], r["split_share_pallets"] / PALLETS[pid]) for r in split]
    return [r["recipient_id"] for r in viable][:TOP_N], delivered


def agent_choice(match, posting):
    """(ranked ids, [(id, share)]) from agent/tools.py.

    Rank 1 takes the load when it can hold all of it; otherwise the tool's split plan, when it
    returns one. Versions without either send everything to rank 1.
    """
    pid = posting["posting_id"]
    result = match(
        posting_text=posting["posting_text"],
        required_storage="shelf-stable" if posting["storage_state"] == "pantry" else posting["storage_state"],
        pallets_needed=max(1, math.ceil(PALLETS[pid])),
        donor_deadline_hours=float(posting["hours_available"]),
        food_item=posting["foodkeeper_product"] or "",
    )
    ids = [m["recipient_id"] for m in result["ranked_matches"]]
    if not ids:
        return [], []
    takes_all = result["ranked_matches"][0]["operational_capabilities"].get("takes_whole_load", True)
    split = result.get("split_plan") or []
    if takes_all or not split:
        return ids[:TOP_N], [(ids[0], 1.0)]
    load = float(result["pallets_needed"])
    return ids[:TOP_N], [(s["recipient_id"], s["pallets"] / load) for s in split]


def mean(rows, key, weight=None):
    rows = [r for r in rows if r[key] is not None]
    if not rows:
        return float("nan")
    if weight:
        return sum(r[key] * r[weight] for r in rows) / sum(r[weight] for r in rows)
    return statistics.mean(r[key] for r in rows)


def pct(value):
    return f"{value:.1%}" if value is not None else "-"


def audit(name, choices, recipients, postings, baselines):
    print(f"\n{'=' * 96}\n{name}\n{'=' * 96}")
    print(f"{'#':<3}{'posting':<34}{'first pick':<32}{'no-veh':>8}{'poverty':>9}{'need':>6}{'stops':>6}")
    first, top_n, delivered = [], [], []
    planted_slots, planted_food = 0, 0.0
    for p in postings:
        ranked, shares = choices[p["posting_id"]]
        if not ranked:
            print(f"{p['posting_id']:<3}{p['posting_text'][:32]:<34}(no viable recipient)")
            continue
        for rank, rid in enumerate(ranked):
            r = recipients[rid]
            if r["profile_source"] == "planted":
                planted_slots += 1
            else:
                top_n.append(r)
                if rank == 0:
                    first.append(r)
        for rid, share in shares:
            if recipients[rid]["profile_source"] == "planted":
                planted_food += share
            else:
                delivered.append({**recipients[rid], "share": share})
        r = recipients[ranked[0]]
        tag = " (planted)" if r["profile_source"] == "planted" else ""
        need = f"{r['need_score']:.2f}" if r["need_score"] is not None else "-"
        print(f"{p['posting_id']:<3}{p['posting_text'][:32]:<34}{(r['name'][:20] + tag):<32}"
              f"{pct(r['no_vehicle_rate']):>8}{pct(r['poverty_rate']):>9}{need:>6}{len(shares):>6}")

    print(f"\n{'':<34}" + "".join(f"{header:>11}" for _, header, _ in METRICS))
    for label, rows, weight in (
        ("Metro, population-weighted", baselines["metro"], "weight"),
        ("Pool: every generated recipient", baselines["pool"], None),
        ("First picks", first, None),
        (f"Top {TOP_N} picks", top_n, None),
        ("Where the food goes", delivered, "share"),
    ):
        print(f"{label:<34}" + "".join(
            f"{mean(rows, key, weight):>11{fmt}}" for key, _, fmt in METRICS))
    picks = [rid for ranked, _ in choices.values() for rid in ranked]
    counts = Counter(recipients[rid]["name"] for rid in picks)
    stops = Counter(rid for _, shares in choices.values() for rid, _ in shares)
    placed = sum(share * PALLETS[pid] for pid, (_, shares) in choices.items() for _, share in shares)
    unplaced = {pid: PALLETS[pid] * (1 - sum(s for _, s in shares))
                for pid, (_, shares) in choices.items()}
    print(f"Pallets placed: {placed:.1f} of {sum(PALLETS.values()):.1f}"
          + "".join(f"; #{pid} leaves {left:.1f} unplaced"
                    for pid, left in unplaced.items() if left > 0.01))
    print(f"\n{len(set(picks))} distinct recipients across {len(picks)} top-{TOP_N} slots; "
          f"{planted_slots} slots and {planted_food / len(postings):.0%} of the food went to "
          f"planted rows (left out of the averages).")
    print(f"Food reaches {len(stops)} distinct recipients in {sum(stops.values())} stops.")
    print("Most chosen: " + ", ".join(f"{n} x{c}" for n, c in counts.most_common(3)))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--matcher", choices=("both", "sql", "agent"), default="both")
    parser.add_argument("--sql", type=Path, default=REPO / "sql" / "03_filter_and_rank.sql",
                        help="version of the SQL matcher to audit")
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
        sql = args.sql.read_text()
        choices = {p["posting_id"]: sql_choice(client, sql, p) for p in postings}
        audit(f"SQL matcher: {args.sql.name}", choices, recipients, postings, baselines)
    if args.matcher in ("both", "agent"):
        match = load_agent_matcher()
        choices = {p["posting_id"]: agent_choice(match, p) for p in postings}
        audit("agent/tools.py match_surplus_posting (what the demo agent calls)",
              choices, recipients, postings, baselines)


if __name__ == "__main__":
    main()
