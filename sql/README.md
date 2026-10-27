# sql/

The data lane's matcher, in the order it runs. Atlanta, `a4i_food` dataset, `gemini-embedding-2`.

| File | What it does | Who runs it |
|---|---|---|
| `01_build_recipient_embeddings.sql` | Embeds every `profile_text` once into `recipient_embeddings` | Data lane, after any reload of `recipients` |
| `02_match_candidates.sql` | Semantic search only: posting in, nearest recipients out | Debugging; superseded by 03 for the agent |
| `03_match_filtered.sql` | Semantic search, then the constraint filter, with a reason for every elimination | **The agent's matching tool** |

From the `bq` CLI, pass a file on stdin (`bq query --nouse_legacy_sql ... < sql/03_match_filtered.sql`).
Passed as an argument, `bq` reads the leading `--` comment as a flag and fails.

## 03: parameters

| Parameter | Type | Where the agent gets it |
|---|---|---|
| `@posting_text` | STRING | The offer as typed. This is what gets embedded |
| `@storage_state` | STRING | `pantry`, `refrigerated` or `frozen`. In `surplus_postings` for the ten; inferred for new ones |
| `@hours_remaining` | FLOAT64 | In `surplus_postings`; for new postings, min(donor's window, `shelf_life`) |
| `@pallets_needed` | FLOAT64 | **Not in the data.** Estimated from the text (table below) |
| `@posted_at` | TIMESTAMP | When the clock started. NULL means now |
| `@top_k` | INT64 | How many semantic candidates to filter. See the finding below |
| `@include_eliminated` | BOOL | TRUE returns eliminated rows too, so the agent can answer "why not them?" |

Output: one row per candidate, viable first and then by cosine `distance`. `eliminated_by` lists
every rule a row failed in plain words. Other outputs:

- `pickup_date`: the first service day on which the recipient can collect
- `takes_full_load`: whether the recipient can take the whole load or only a share of it
- `needs_cold_transport`: a cold load going to a recipient with no refrigerated vehicle, so send a driver
- `storage_conflict` and `schedule_conflict`: the recipient's own text contradicts its data columns

## 03: the rules, and the assumption behind each

| Rule | Passes when | Assumption |
|---|---|---|
| Storage | `pantry` goes anywhere. `refrigerated` needs `cold_storage != 'none'`. `frozen` needs `frozen_storage` | `domestic`, `medical` and `vehicle` all count as cold. Size limits are handled by the pallet rule |
| Storage conflict | Fails for **any** load when the text denies a capability the columns claim (columns say freezer, text says "no freezer") | If an organization contradicts its own storage record, its pallet count is suspect too. Route around it and flag it for a phone call |
| Pallets | `max_pallets >= LEAST(pallets_needed, 1)` | `max_pallets = 0` means it can't receive bulk. Taking part of a load still counts, because farm loads have to be split. `takes_full_load` shows which recipients can take all of it |
| Pickup | `pickup_window_hours <= hours_remaining` | `pickup_window_hours` is the notice a recipient needs before it can collect. The generator draws it per archetype: 2–6h for neighborhood pantries, 24–96h for diaper banks |
| Service day | Some date between earliest pickup (`posted_at` + `pickup_window_hours`) and the deadline is a service day, in Atlanta time | Day-level only, because the data has no opening hours. "Second and fourth Wednesday" is matched by week of the month |
| Schedule conflict | Flag only, never eliminates | Every generated profile says "Open <service_days>". A mismatch costs a phone call, not a spoiled pallet, so it doesn't eliminate |

## Pallet estimates for the ten postings

There is no quantity column, so these are our estimates. The agent has to make the same kind of
estimate for a new posting.

| # | Posting | Pallets | Basis |
|---|---|---:|---|
| 1 | 10 crates of spinach | 0.5 | Produce crates, well under a pallet |
| 2 | ~60 gallons of milk and some yogurt | 0.5 | About 520 lb of milk |
| 3 | ~200 loaves of bread and pastries | 1 | Stacked bread trays |
| 4 | Deli sandwiches and salads | 0.25 | A few cases |
| 5 | 5 tons of potatoes | 5 | About 2,000 lb per pallet |
| 6 | Half a truckload of blueberries | 12 | A reefer trailer holds about 24 pallets |
| 7 | About 30 bins of winter squash | 30 | Bulk bins are pallet-sized |
| 8 | 48 cases of sealed formula | 0.5 | |
| 9 | Pallet of diapers and wipes | 1 | Stated |
| 10 | Clinic nutritional supplements | 0.25 | |

## What it does on the ten postings

Test settings: Thursday 2026-10-29, 2:10pm Atlanta (the README scenario), `top_k = 40`.

| # | Viable / 40 | What eliminated the rest |
|---|---:|---|
| 1 spinach, 6h, cold | 3 | Mostly pickup notice. Storage eliminated only Greenline (decoy), which has no refrigeration |
| 2 dairy, 8h, cold | 9 | Pickup notice |
| 3 bread, 24h | 17 | Service days |
| 4 deli, 4h, cold | 2 | Pickup notice |
| 5 potatoes, 5 pallets | 19 | Service days, pallets |
| 6 blueberries, 12 pallets, cold | 17 | Pickup, service days. Cedar and Maple (planted twins) tie at the top, and neither takes the full load |
| 7 squash, 30 pallets | 28 | Pallets. Nobody takes the full load, so it must be split |
| 8 formula | 26 | Diaper banks rank at the top |
| 9 diapers | 29 | Pallets |
| 10 clinic supplements, 8h, cold | 4 | Pickup notice. No clinic survives: clinics need 8–24h notice |

How the planted cases come out:

- **Greenline (decoy):** eliminated for every cold posting, and correctly viable for dry goods.
- **Harborview (contradiction):** eliminated for every posting, with a reason that names the contradiction.
- **Cedar and Maple (twins):** tie for blueberries.
- **Vocabulary-mismatch rows (123–127):** have a second, unplanned contradiction that is now flagged. Their text says "Open Tuesday, Thursday", but `service_days` says Monday, Wednesday, Friday.

## Findings worth knowing

- **`top_k` changes the answer.** For spinach, `top_k = 40` gives 3 viable recipients and `127` (the whole corpus) gives 10. The extra seven sit at distances of 0.338–0.354, just past the cutoff. Generic pantry profiles all land close together in meaning. At 127 rows brute force costs nothing, so a large `top_k` gives "they said no, who's next?" more depth.
- **The clock does most of the eliminating.** On short cold postings, pickup notice removes far more candidates than storage does.
- **Ranking among viable rows is semantic only.** Choosing between bigger, closer and higher-need is the next decision.
