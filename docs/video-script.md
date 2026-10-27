# Pitch video script — Atlanta Food Rescue Broker (3:00)

Track: **Retail & Grocer Rescue**, Atlanta. Live app: https://food-rescue-agent-2u2wh53apa-uc.a.run.app

Structure: 0:20 intro (deck slides 1–2) · 2:20 live demo · 0:20 outro (deck slides 3–4).
Words per segment are sized for a calm pace (~150 words/minute). Read it aloud once with a timer.

---

## 0:00 – 0:20 · Intro (deck slides 1–2)

**Slide 1 — "10 crates of spinach."**
> "We're team ATL-12, Retail and Grocer Rescue, in Atlanta. A Midtown grocer has ten crates of spinach that must stay cold and leave the dock by 8:10 tonight."

**Slide 2 — "87 of 127."**
> "87 of Atlanta's 127 food recipients have only a household fridge. So a coordinator phones pantries one by one while the food spoils. Our agent answers who can take it, in seconds."

---

## 0:20 – 2:40 · Live demo

Open these tabs before recording (base URL above):
`/grocer-post.html` · `/map.html` · `/queue.html` · `/match-brief-spinach.html?offer=spinach` · `/pantry-offer.html` · BigQuery job history · Cloud Run services list.

### 0:20 – 0:32 · Capability 1: the grocer posts in plain words — `/grocer-post.html`
Type "10 crates of spinach, needs cold storage", pick **Keep cold**, set must-leave-by 8:10 PM, post.
> "The store posts in its own words, with a real deadline. No forms to learn."

### 0:32 – 0:52 · Capability 2: see who can take it, on the map — `/map.html`
Pick the spinach posting. Click the pills **Walk-in Cooler or Van**, then **Ruled Out**, then **High-Need Tracts**.
> "Here's every Atlanta recipient that could take this spinach, on the map. Cold storage narrows it fast. Ruled-out sites stay visible, so a coordinator sees why, and the high-need tracts show where the food would do the most good."

### 0:52 – 1:17 · Capability 3 + Decisions 1–2: search by meaning, decide by reality — spinach Match Brief
Open the spinach brief from the queue. Point at **60 → 20 → 3**, the **Ruled out** list, then the clock bar.
> "BigQuery vector search finds 60 recipients whose profiles *mean* the right thing. Our first decision: vector search is a candidate generator, not the answer. Greenline Community Pantry is the second-closest match by meaning, but it has no refrigerator, so the agent rules it out and says why. Every brief shows the margin: collect by 7:20, fifty minutes spare. Ties break on census-tract need, never on demographics."

### 1:17 – 1:37 · Capability 4: ask the agent — "Ask Broker Agent" drawer
Open the drawer and tap the suggested question **"why is Food Flow Collaborative recommended while Greenline … was ruled out?"**
> "The coordinator can just ask. This is our ADK agent on Gemini, live on Cloud Run, calling its own tools and answering in plain language."

### 1:37 – 1:57 · Capability 5 + Decision 3: "they said no" — `/pantry-offer.html`
Tap **Decline → No fridge space**, then on the brief click **They said no → next option**.
> "Coordinators live in the world where the first call says no. A decline is saved in our Cloud SQL offer service, so the rematch skips that pantry, and a pantry with a live offer can't be double-booked on another one."

### 1:57 – 2:10 · Split the load toward need — spinach brief, "Or split it"
> "When no household fridge can take it all, it proposes five crates each to two pantries in neighborhoods where 29 and 34 percent of adults are food insecure."

### 2:10 – 2:20 · Proof it's real — BigQuery job history
Show the `VECTOR_SEARCH` job the agent just ran.
> "And here's the actual VECTOR_SEARCH job in BigQuery."

### 2:20 – 2:40 · Architecture tour — Cloud Run services list (or deck slide 3)
> "Two Cloud Run services: the agent with the console, map and phone pages, and the offer-state service on Cloud SQL. Data lives in BigQuery, reached through ten custom tools and Google's managed BigQuery MCP server."

---

## 2:40 – 3:00 · Outro (deck slides 3–4)

**Slide 3 — architecture + what it can't do**
> "What it can't do yet: pantry storage profiles are generated, because no pantry publishes them. Shelf life is home-storage guidance, drive times are estimates, and the driver backend isn't built."

**Slide 4 — "2×"**
> "Our equity audit found the food reaches neighborhoods with twice Atlanta's no-car rate. Next: let pantries confirm their own profiles. Thank you."

---

## Before you record

- **Redeploy `main` first, once, by one person.** The live revision (food-rescue-agent-00007) still serves the old `app.js`: the new console modules (`/console-js/*`) return 404, so the new Ask Broker Agent drawer and the live `/api/queue` cards are not what's deployed. The map is already live. After `bash deploy.sh` from current `main`, check that `/console-js/main.js` returns 200.
- **Check the map before you script it:** confirm the spinach posting shows Greenline (or another named site) under **Ruled Out**. Planted teaching rows have made-up coordinates, so if Greenline is missing, narrate the ruled-out pins generically.
- **Rerun `python3 scripts/equity_audit.py`** and confirm the "2×" (26.4% vs 12.9% no-car) still holds.
- **Agent answers vary run to run.** Do one practice question before recording so the session is warm, and keep the drawer answer on screen for a few seconds.
- The driver page has no backend yet. Leave it out, or show it only as "a volunteer accepts".
- Keep a screenshot of each screen in case the live app misbehaves.
