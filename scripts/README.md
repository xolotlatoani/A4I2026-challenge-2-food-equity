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

## `equity_audit.py`

Did the food go where the need is, or where the loading docks are? Runs a matcher across all ten
postings and compares the census tracts of the recipients it ranks first with the metro and with
every recipient it could have chosen.

```bash
python3 scripts/equity_audit.py                  # both matchers
python3 scripts/equity_audit.py --matcher agent  # agent/tools.py only
python3 scripts/equity_audit.py --matcher sql    # sql/03_filter_and_rank.sql only
```

Needs `google-cloud-bigquery` and application default credentials, both already in Cloud Shell.
It takes about two minutes. The clock is fixed to Thursday 2026-10-29, 2:10pm, so runs can be
compared, and pallet sizes are estimates because `surplus_postings` has no quantity column.

First run, 2026-10-27 (planted rows left out of the averages):

| | No vehicle | Poverty | Assistance | Need percentile |
|---|---:|---:|---:|---:|
| Metro, population-weighted | 12.9% | 18.5% | 18.1% | 0.47 |
| Pool: every generated recipient | 13.1% | 17.9% | 18.7% | 0.49 |
| SQL matcher, first picks | 14.8% | 21.3% | 14.4% | 0.59 |
| Agent matcher, first picks | 21.5% | 32.9% | 39.6% | 0.79 |

- **The pool looks like the metro.** Recipients aren't concentrated in needy tracts, so any skew is
  the matcher's doing.
- **The agent's matcher sends food to clearly needier tracts, but to few places.** Nine recipients
  fill 27 top-three slots, and 13 of those slots go to planted teaching rows. The notebook places
  those rows at made-up coordinates in the middle of the metro, which happens to be a high-need
  tract. The agent also finds no single recipient for the 30-pallet squash; that's left to
  `split_large_load`.
