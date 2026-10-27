# Offer-state service

The matcher in BigQuery knows recipients; this service remembers what happened to each grocer
request: who it was offered to, what they said, and how much of the load and the clock is left.
`match_surplus_posting(request_id=...)` asks it before every match, so a recipient who said no
is never offered the same food again, in this conversation or the next.

It is also the double-booking guard: a recipient with a live offer on one request (waiting on a
reply, or accepted and not yet picked up) is left out of every other request until that offer
ends, so two grocers never book the same van or fridge at once.

It is a small FastAPI app on Cloud Run over Cloud SQL for PostgreSQL. The agent calls it through
`agent/state_tools.py`. So does the coordinator console: `server.py`'s `/api/dispatches/*` and
`/api/match` save each console offer as a request (one per offer code) and record "Mark as sent",
"They said no" and the pantry's Accept/Decline as offers and replies here.

## Tables (`schema.sql`)

| Table | One row per |
|---|---|
| `grocer_requests` | posting as it came in, with a fixed `deadline_at` (donor deadline or FoodKeeper, whichever is sooner) and the console's `offer_code` |
| `offers` | request × recipient: the latest status, the share offered, the reply-by time |
| `offer_events` | status change, in order, with who made it |
| `match_runs` | time the matcher ran for a request: what it excluded and what it ranked |
| `recipient_holds` | stretch of time a recipient takes no offers, optionally for one kind of storage |

Three views do the arithmetic, so nothing runs on a timer: `offer_status` reads an unanswered
offer past its reply-by as `expired`; `live_offers` lists the offers tying a recipient up right
now; and `request_status` gives each request's hours left, unclaimed pallets, and the recipients
to leave out: already asked, on hold, or busy on another request (`busy_ids`).

## Endpoints

| | |
|---|---|
| `POST /requests` | save a posting; with `offer_code` and `reuse_live`, return the live one with that code instead |
| `GET /requests?status=open&metro=Atlanta&offer_code=...` | the queue, soonest deadline first, with offers |
| `GET /requests/{id}` | one request, its offers, `busy_elsewhere`, and `exclude_ids` for the matcher |
| `POST /requests/{id}/match-runs` | save what a match ranked |
| `POST /offers` | offer a recipient (part of) a request; 409 if already asked, busy on another request (unless `even_if_busy`), or nothing is left |
| `GET /offers/live?recipient_id=` | every offer tying a recipient up right now, across requests |
| `POST /offers/{id}/response` | `accepted`, `declined`, `withdrawn`, `picked_up`; 409 when it doesn't fit |
| `POST /holds`, `GET /holds` | pause a recipient across requests |

## Deploy

```bash
pip install -r state_service/requirements.txt   # the schema step runs locally
bash state_service/setup_cloudsql.sh            # instance, database, service account, tables
bash state_service/deploy.sh                    # private Cloud Run service; prints its URL
bash deploy.sh                                  # redeploys the agent, which finds the service by name
```

The service signs in to Cloud SQL as its own service account (IAM database login, no password).
It is private: only the agent's service account and whoever ran `deploy.sh` can call it.

## Run and test locally

```bash
DATABASE_URL=postgresql+pg8000://postgres@localhost:5432/food_rescue python state_service/apply_schema.py
DATABASE_URL=postgresql+pg8000://postgres@localhost:5432/food_rescue \
  uvicorn main:app --port 8080 --app-dir state_service
STATE_SERVICE_URL=http://localhost:8080 python3 scripts/test_state_service.py
```

`scripts/test_state_service.py` also runs against the deployed URL; its rows go under metro
`StateServiceTest`, out of any real queue.
