# scripts/

## `load.sh`

A headless fallback that reaches the same end state as `notebooks/c2_01_load_explore.ipynb`,
rebuilding all four BigQuery tables from a pre-staged snapshot in Cloud Storage.

```bash
bash scripts/load.sh                # defaults to atlanta
bash scripts/load.sh philadelphia
bash scripts/load.sh --list         # show available metros
```

Invoke it with `bash`, not `./scripts/load.sh`—that way it works regardless of whether the
file arrived with its executable bit set, which depends on how your repo was created.

Safe to run repeatedly. Every table load uses `--replace`, so the script is idempotent and
interrupting it breaks nothing.

**Use the notebook if you can.** This script gets you the tables without the teaching, and one
piece of that teaching—which half of the recipient data is real and which half is generated—is
something judges look for directly.

## `geocode_recipients.py`

Finds the census tract each recipient's street address actually sits in. The notebook places
organizations at their ZIP centroid, and 118 of them share 35 centroids, so neighbors across a ZIP
inherit one tract's need. This sends the addresses to the Census Bureau's batch geocoder (public
domain, no key), loads `a4i_food.recipient_geocodes`, and builds `a4i_food.recipient_tracts` with
`sql/04_build_recipient_tracts.sql`.

```bash
python3 scripts/geocode_recipients.py
```

Run it once after loading the data. `sql/03_filter_and_rank.sql` and `equity_audit.py` read
`recipient_tracts`. Safe to re-run.

2026-10-27 results:

- **Coverage:** 109 of 118 addresses matched (73 exact, 36 approximate). The other 9 fall back to
  the ZIP centroid. The 9 planted rows have no address, so they get no tract and neutral need.
- **Tracts:** geocoding put 93 of the 109 in a different tract from the ZIP method, and the
  organizations now sit in 86 distinct tracts instead of 34.
- **Need:** scores moved 0.19 on average, and by a quarter of the scale or more for 36 recipients.

**A gap in `tract_demographics` worth knowing:** it holds 165 of the 254 tracts in the Atlanta
box. The notebook joins 2010 tract geometry to ACS 2016–2020, which is on 2020 tracts, so every
tract redrawn in 2020 drops out. Half the geocoded addresses sit in one of those, which is why
`recipient_tracts` takes its rates straight from ACS instead. Need percentiles are still measured
against the 165, so they stay comparable with everything else.

## `equity_audit.py`

Did the food go where the need is, or where the loading docks are? Runs a matcher across all ten
postings and compares the tracts of the recipients it chose with the metro, and with every
recipient it could have chosen. Each recipient is judged by its geocoded tract, whatever tract the
matcher itself used.

```bash
python3 scripts/equity_audit.py                  # both matchers
python3 scripts/equity_audit.py --matcher agent  # agent/tools.py only
python3 scripts/equity_audit.py --matcher sql    # sql/03_filter_and_rank.sql only
python3 scripts/equity_audit.py --matcher sql --sql old.sql   # a variant, for before and after
```

Needs `google-cloud-bigquery` and application default credentials, both already in Cloud Shell,
and `recipient_tracts` from `geocode_recipients.py`. It takes a few minutes. The clock is fixed to
Thursday 2026-10-29, 2:10pm, so runs can be compared. Pallet sizes are estimates, because
`surplus_postings` has no quantity column.

"Where the food goes" sends each load to rank 1 when rank 1 can hold all of it, and otherwise
follows the query's split plan, weighting every stop by its pallets. Pallets the split plan
can't place are reported. Planted rows are left out of the averages, and their share is reported
instead.

2026-10-27, geocoded tracts:

| Where the food goes | No vehicle | Poverty | Need percentile | Food to planted rows | Pallets placed (of 50.7) | Reaches |
|---|---:|---:|---:|---:|---:|---:|
| Metro, population-weighted | 12.9% | 18.5% | 0.47 | | | |
| Pool: every generated recipient | 13.4% | 18.0% | 0.48 | | | |
| SQL matcher, fixed 0.3 need weight, ZIP-centroid tracts | 19.8% | 24.5% | 0.65 | 27% | 41.7 | 7 recipients |
| SQL matcher, clock-scaled weight, geocoded tracts | 26.4% | 31.8% | 0.77 | 20% | 23.7 | 9 recipients |
| Agent matcher (`agent/tools.py`) | 19.0% | 29.4% | 0.72 | 50% | 20.7 | 4 recipients |

- **The pool looks like the metro.** Recipients aren't concentrated in needy tracts, so any skew is
  the matcher's doing.
- **Clock-scaled need and geocoded tracts moved the SQL matcher from 0.65 to 0.77,** and cut the
  share of food going to planted rows.
- **The split plan now places much less of the 30-pallet squash: 3 pallets, not 21.** The plan
  takes the three best-scored stops. With need counting 60% on a 120-hour clock, those are three
  high-need pantries holding a pallet each. Before, two of its three stops were planted rows that
  each hold 10 pallets and scored on a made-up location's need. Need and a three-stop cap pull
  against each other on farm-sized loads; every other posting is placed in full either way.
- **The agent's matcher sends half the food to planted teaching rows,** mostly Maple Street Produce
  Alliance. Those rows have no address and made-up coordinates in the middle of the metro, a
  high-need tract, so the matcher rewards an invented location. It also finds no recipient for the
  30-pallet squash; that's left to `split_large_load`.
