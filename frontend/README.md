# frontend/

Three static screens for the coordinator console, designed in Google Stitch (project
"Surplus Broker · Atlanta (A4I 2026)") and exported as HTML.

- `queue.html`: today's offers, each with a countdown clock. "Find recipients" on the deli offer
  and "Review match brief" on the spinach offer open their briefs.
- `map.html` (`map.js`): dedicated Google Maps & interactive dispatch map screen (`Live Map` in the
  sidebar, or `Inspect route` on a match brief) showing where the groceries with extra food are and
  where recipient organizations are across Metro Atlanta, with filters for grocer offer, cold
  storage, match status/viability, census tract need, and zone, plus 1-click Google Maps route
  directions and an embedded Google Maps view.
- `match-brief-deli.html`: the deli offer, the textbook retail case. A shelter with two household
  fridges, and the catch its profile adds: no vehicle, so line up a volunteer driver.
- `match-brief-spinach.html`: the spinach offer. Shows the planted pantry that wants greens and has
  no refrigeration being ruled out, second by meaning, and the split plan: five crates each to two
  household-fridge pantries in higher-need neighborhoods, set against one van pickup.

Each brief has the recommended recipient, the clock, who it helps, the drafted message, the next
two options, and who was ruled out and why.

Three phone screens follow the deli offer past the coordinator, one per person who touches it:

- `grocer-post.html`: the store posts surplus in its own words, then tracks it: posted, matched,
  driver on the way, picked up.
- `pantry-offer.html`: Daniels Guiding Guardians accepts or declines, with a one-tap reason that
  goes back to the coordinator.
- `driver-request.html`: a volunteer driver accepts the pickup and drop-off, then marks it picked
  up and delivered.

All three are views of the same offer record, so an answer on one moves the others. The store has
no street address because we do not have a real one, and the driver is fictional, named by first
name only.

## The grocer page is live, and so is its backend

`grocer-post.html` runs on `grocer.js`: the storage choice, a real must-leave-by time, checks
before posting, and today's posts with a tracker that refreshes every 10 seconds. `server.py`
serves its three routes over the offer-state service (`state_service/`), so a post is saved in
Cloud SQL, where the agent's `recommend_open_postings` and the desk pick it up:

- `POST /api/offers` saves a post and returns it as an offer with `status: "posted"`.
- `GET /api/offers?store=<store_id>` lists today's posts, newest first, as `{ offers: [...] }`.
- `GET /api/offers/<offer_id>` returns one offer, so the tracker can move.

The exact fields are in the comment at the top of `grocer.js`. The tracker reads `status`
(`posted`, `matched`, `driver_assigned`, `picked_up` or `expired`) and the time and name that go
with each step.

`matched` means a pantry accepted; `picked_up` means every accepted share was collected. There are
no drivers yet, so `driver_assigned` never comes. Without an offer-state service (no
`STATE_SERVICE_URL`), or whenever the page is opened from disk, it says it is in demo mode and
keeps posts in that browser only. Nothing pretends to reach the coordinator.

## The pantry page is live too

The desk texts each pantry a link, `pantry-offer.html?offer=<offer_id>&recipient=<recipient_id>`.
With no query string it is the deli offer for Daniels Guiding Guardians, recipient 14: `deli` is
looked up as the catalog's deli posting. `server.py` serves its two routes over the offer-state
service, where the offer is the one the desk or the agent recorded (`record_offer`):

- `GET /api/offers/<offer_id>/invites/<recipient_id>` returns what that pantry is being offered and
  why, plus `respond_by`, which drives the answer-by countdown.
- `POST /api/offers/<offer_id>/invites/<recipient_id>/response` takes
  `{ decision: "accept" | "decline", reason }`. The reason is `no_capacity_today`, `closed`,
  `wrong_food` or `other`, and is required when declining.

The fields are in the comment at the top of `pantry.js`; `why_you` and `tags` stay empty for now.
A link to an offer that was never made to that pantry answers 404, and then Accept and Decline go
to the dispatch board `server.py` serves (`/api/dispatches/claim` and `/release`), as `app.js`
did, with the decline reason kept on the device. A link for any offer the
page cannot load shows no buttons, so nobody can answer the deli example on behalf of another offer.

`app.js` used to answer this page with recipient 31, which is Food Flow Collaborative, not Daniels
Guiding Guardians. `pantry.js` uses 14.

## So is the driver page

The desk texts each driver a link, `driver-request.html?offer=<offer_id>&driver=<driver_id>`. With
no query string it is Sam's deli run. `driver.js` expects three routes:

- `GET /api/offers/<offer_id>/drivers/<driver_id>` returns the run: pickup point and time, drop-off,
  what to bring, and `status` (`requested`, `accepted`, `picked_up`, `delivered`, `declined`,
  `cancelled` or `expired`).
- `POST .../drivers/<driver_id>/response` takes `{ decision: "accept" | "decline" }`.
- `POST .../drivers/<driver_id>/progress` takes `{ step: "picked_up" | "delivered" }`.

The fields are in the comment at the top of `driver.js`. Picked up unlocks only after accepting, and
Delivered only after Picked up. When live, the page counts down to the pickup time and checks every
15 seconds in case the desk cancels. `server.py` has no driver routes yet, so until it does the page
says it is in demo mode and keeps progress on the phone. `app.js` used to show "Coordinator & grocer
notified" here without sending anything.

`app.js` no longer loads on the grocer, pantry or driver pages; it still runs the coordinator's.

## The coordinator console is live

`queue.html` and the two briefs run on `app.js`, over the same `server.py` routes as the agent:

- `GET /api/queue` fills the queue. With an offer-state service, each offer's status is where it
  stands there (`live`): awaiting a reply, accepted, or donated once every accepted share is
  picked up. An offer nobody was sent is ready or urgent, whatever the catalog says.
- `GET /api/match?offer=<key>` fills a brief: the ranking from `sql/03_filter_and_rank.sql` (live
  BigQuery, or its frozen snapshot), the split, who was ruled out and why. "+ New Offer" sends its
  posting to `POST /api/match`.
- Mark as sent, the split plan, Mark accepted and Mark donated call `POST /api/dispatches/claim`
  (`status` `accepted` or `picked_up`). "They said no" calls `/api/dispatches/release` with
  `declined`, so that recipient is left out of this offer from then on. "Switch to this match"
  takes back an offer still waiting, with `withdrawn`.
- Equity Audit, Recipients and Active Routes read `/api/equity-audit`, `/api/recipients` and
  `/api/dispatches`. The agent drawer talks to the agent `server.py` serves (`/run`).

The console re-reads the queue every 15 seconds, so a pantry answering on its own page moves it,
and a "no" brings up the next match. While a brief waits on a reply it links each pantry's page.
Opened from disk, or with `server.py` unreachable, it says so and runs on a demo catalog in that
browser only. Without an offer-state service, the buttons work but say nothing is saved.

## How these pages are deployed

One app today. `server.py` serves the agent, the `/api` routes and every page from one Cloud Run
service, so each person just gets a different link to the same place.

The grocer, pantry and driver pages can move to their own app without code changes: host them
anywhere and add `<meta name="broker-api-base" content="https://<the API service>">` to each page.
The API already accepts calls from other origins. That split is worth making before real use,
because the service needs no login: anyone holding a pantry's link can also open the coordinator
console and the agent chat at `/dev-ui`.

Open either file in a browser. They load Tailwind and fonts from CDNs, so they need a connection.

**The matches on screen are real output, frozen.** They are what `sql/03_filter_and_rank.sql`
returns for the deli and spinach postings at 2:20 PM on Wednesday 2026-10-28, with CDC PLACES 2025
food-insecurity estimates for the recipients' tracts. The queue statuses, send and pickup times,
and the store neighborhoods in the donor labels are illustrative. That is what each page shows
until `app.js` replaces it with the routes' answers.

**Stitch invents things, and we removed them.** Its first drafts added a "98.4% match confidence",
a donor distance, a phone number, a food-safety regulation that does not exist, a vehicle-tracking
panel and a dispatch rule. None of that is in our data. If you regenerate a screen, check it for the
same thing before anyone sees it.
