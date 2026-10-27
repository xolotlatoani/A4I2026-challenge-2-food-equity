#!/usr/bin/env python3
"""Copy BigQuery's seed surplus postings into the offer-state service (Cloud SQL).

After this, the agent's `recommend_open_postings` and the coordinator console work the
postings from Cloud SQL. BigQuery keeps `a4i_food.surplus_postings`. Safe to re-run: postings
that are still live are left alone, and ones whose clock ran out come back with a fresh clock.

    STATE_SERVICE_URL=https://food-rescue-state-....run.app python3 scripts/import_postings.py
    STATE_SERVICE_URL=... python3 scripts/import_postings.py --track RETAIL
    STATE_SERVICE_URL=... python3 scripts/import_postings.py --reset    # empty it first

--reset does what the demo's Reset button does: it deletes every request, offer, match run
and hold, in every metro, then imports.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from agent import state_tools  # noqa: E402
from agent.tools import import_surplus_postings  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--track", default="all",
                        help="all (the default: every posting the console shows), RETAIL, FARM, "
                             "or ESSENTIALS")
    parser.add_argument("--reset", action="store_true",
                        help="empty the offer-state service first, as the demo's Reset button does")
    args = parser.parse_args()
    if not state_tools.state_service_url():
        sys.exit("Set STATE_SERVICE_URL first.")

    result = import_surplus_postings(args.track, reset=args.reset)
    if result["cleared"] is not None:
        print("Deleted " + ", ".join(f"{n} {t}" for t, n in result["cleared"].items()))
    print(f"{result['metro']}: {result['imported']} imported, "
          f"{result['already_live']} already live\n")
    for p in result["postings"]:
        print(f"  #{p['posting_id']:<2} {p['track']:<10} "
              f"{'live' if p['already_live'] else 'new ':<4}  "
              f"{p['hours_remaining']:>6.1f}h  {p['pallets']:>5g} pal  {p['posting_text'][:60]}")


if __name__ == "__main__":
    main()
