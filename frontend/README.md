# frontend/

Three static screens for the coordinator console, designed in Google Stitch (project
"Surplus Broker · Atlanta (A4I 2026)") and exported as HTML.

- `queue.html`: today's offers, each with a countdown clock. "Find recipients" on the deli offer
  and "Review match brief" on the spinach offer open their briefs.
- `match-brief-deli.html`: the deli offer, the textbook retail case. A shelter with two household
  fridges, and the catch its profile adds: no vehicle, so line up a volunteer driver.
- `match-brief-spinach.html`: the spinach offer. Shows the planted pantry that wants greens and has
  no refrigeration being ruled out, second by meaning, and the split plan: five crates each to two
  household-fridge pantries in higher-need neighborhoods, set against one van pickup.

Each brief has the recommended recipient, the clock, who it helps, the drafted message, the next
two options, and who was ruled out and why.

Open either file in a browser. They load Tailwind and fonts from CDNs, so they need a connection.

**The matches on screen are real output, frozen.** They are what `sql/03_filter_and_rank.sql`
returns for the deli and spinach postings at 2:20 PM on Wednesday 2026-10-28, with CDC PLACES 2025
food-insecurity estimates for the recipients' tracts. The queue statuses, send and pickup times,
and the store neighborhoods in the donor labels are illustrative. Nothing is wired to the agent yet: swap the hard-coded values for its
response once its endpoint is live.

**Stitch invents things, and we removed them.** Its first drafts added a "98.4% match confidence",
a donor distance, a phone number, a food-safety regulation that does not exist, a vehicle-tracking
panel and a dispatch rule. None of that is in our data. If you regenerate a screen, check it for the
same thing before anyone sees it.
