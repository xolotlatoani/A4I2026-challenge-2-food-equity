-- Filter and rank: the half of the matcher that comes after 02's vector search.
--
-- This runs the same search as 02_match_candidates.sql, then decides who can actually take
-- the food, and says why when the answer is no. Every candidate comes back, viable or not,
-- so the agent can answer "why not them?" as well as "who?".
--
-- Parameters:
--   @posting_text     STRING        what we embed: the raw posting, or an enriched version of it
--   @needs_cold       BOOL          must stay refrigerated
--   @needs_frozen     BOOL          must stay frozen
--   @pallets          FLOAT64       size of the offer in pallet-equivalents (10 produce crates ~ 0.18)
--   @hours_remaining  FLOAT64       the clock: the donor's deadline, capped by shelf life
--   @service_date     DATE          the day the posting arrives; NULL means today in Atlanta
--   @exclude_ids      ARRAY<INT64>  recipients who already said no
--
-- The query side embeds with gemini-embedding-2 because that is the model that built
-- recipient_embeddings. Checked 2026-10-27: re-embedding a stored profile with it gives cosine
-- distance 0.0, while gemini-embedding-001 gives 0.97 at the same 3,072 dimensions. The wrong
-- model here would not raise an error. It would just return nonsense.
--
-- Judgment calls, written down so they can be argued with:
--   * Cold capacity. A walk-in or a refrigerated van holds max_pallets; a commercial kitchen
--     fridge at least half a pallet; a household fridge about 0.15 pallet (~8 produce crates).
--     Medical fridges are for medication, not donated food.
--   * Shelf-stable capacity is max_pallets, but never below 0.25: a pantry that cannot take a
--     pallet can still take what volunteers carry through the door.
--   * A profile whose text contradicts its own storage flags or opening days is held for a
--     phone call, never auto-recommended. (Five of the planted profiles say "Open Tuesday,
--     Thursday" while service_days says Monday, Wednesday, Friday.)
--   * Not open in time is a hard no. Every day the clock reaches counts: today always, and day
--     N after it if at least 24 x N hours remain. So a 72-hour posting on a Thursday reaches a
--     Saturday-only pantry, and a 6-hour one does not reach anyone who opens tomorrow.
--   * Collecting too late is not a no. It means the coordinator sends a volunteer driver, so it
--     ranks below a recipient who can collect themselves.
--   * Among the viable, score = (1 - w) x semantic fit + w x neighborhood need, where need is
--     the average percentile on no-vehicle and poverty rates of the tract the recipient's street
--     address geocodes to. Needs a4i_food.recipient_tracts: run scripts/geocode_recipients.py
--     once after loading the data. w follows the clock: 0.3
--     at 6 hours or less, rising linearly to 0.6 at 72 hours or more. Food about to spoil goes
--     where it is surest to be wanted; food with days left has time to reach the neediest.
--   * A load over one pallet is split. In rank order, each viable recipient that can hold at
--     least a pallet takes what it can until the load runs out, so with need in the score, the
--     neediest fill first. Taking all of it stops mattering for these loads; collecting it
--     yourself still does. A load of a pallet or less goes whole to rank 1.

CREATE TEMP FUNCTION open_on(days STRING, d DATE) AS (
  CASE
    WHEN STARTS_WITH(days, 'First ')
      THEN REGEXP_EXTRACT(days, r'^First (\w+)') = FORMAT_DATE('%A', d)
           AND EXTRACT(DAY FROM d) <= 7
    WHEN STARTS_WITH(days, 'Second and fourth ')
      THEN REGEXP_EXTRACT(days, r'^Second and fourth (\w+)') = FORMAT_DATE('%A', d)
           AND DIV(EXTRACT(DAY FROM d) - 1, 7) IN (1, 3)
    ELSE STRPOS(days, FORMAT_DATE('%A', d)) > 0
  END
);

WITH
clock AS (
  SELECT
    service_date,
    DATE_ADD(service_date, INTERVAL CAST(FLOOR(@hours_remaining / 24) AS INT64) DAY) AS last_day,
    0.3 + 0.3 * LEAST(1, GREATEST(0, (@hours_remaining - 6) / 66)) AS need_weight
  FROM UNNEST([COALESCE(@service_date, CURRENT_DATE('America/New_York'))]) AS service_date
),

candidates AS (
  SELECT base.* EXCEPT (embedding), distance
  FROM VECTOR_SEARCH(
    TABLE `a4i_food.recipient_embeddings`, 'embedding',
    (SELECT AI.EMBED(@posting_text, endpoint => 'gemini-embedding-2').result AS embedding),
    top_k => 60,
    distance_type => 'COSINE',
    options => '{"use_brute_force": true}')
),

checked AS (
  SELECT
    c.*,
    -- Each recipient's tract comes from its geocoded street address (recipient_tracts, built by
    -- scripts/geocode_recipients.py). No address means no tract and neutral need, 0.5: the
    -- planted rows' coordinates are made up, and an invented location should not earn need.
    STRUCT(rt.tract_geo_id AS geo_id, rt.poverty_rate, rt.no_vehicle_rate, rt.median_income,
           COALESCE(rt.need_score, 0.5) AS need_score) AS tract,
    rt.tract_source,
    CASE
      WHEN NOT @needs_cold THEN GREATEST(c.max_pallets, 0.25)
      WHEN c.cold_storage IN ('walk-in', 'vehicle') THEN c.max_pallets
      WHEN c.cold_storage = 'commercial' THEN GREATEST(c.max_pallets, 0.5)
      WHEN c.cold_storage = 'domestic' THEN 0.15
      ELSE 0
    END AS capacity_pallets,
    k.need_weight,
    open_on(c.service_days, k.service_date) AS open_today,
    (SELECT MIN(d)
     FROM UNNEST(GENERATE_DATE_ARRAY(k.service_date, k.last_day)) AS d
     WHERE open_on(c.service_days, d)) AS first_open_date,
    -- Text that contradicts the flags. Catches the planted "walk-in freezer ... single shelf"
    -- profile without tripping on the many honest "no freezer" pantries.
    (c.frozen_storage AND REGEXP_CONTAINS(LOWER(c.profile_text), r'no freezer'))
      OR (c.cold_storage IN ('walk-in', 'commercial', 'vehicle')
          AND REGEXP_CONTAINS(LOWER(c.profile_text), r'no (refrigerat|fridge|cold)'))
      OR (c.max_pallets >= 2
          AND REGEXP_CONTAINS(LOWER(c.profile_text), r'single shelf|shared cupboard'))
      AS contradicts_itself,
    -- Generated profiles end with "Open <service_days>." verbatim, so any difference is real.
    REGEXP_EXTRACT(c.profile_text, r'Open ([^.]+)\.') AS text_days
  FROM candidates c
  LEFT JOIN `a4i_food.recipient_tracts` rt USING (recipient_id)
  CROSS JOIN clock k
  WHERE c.recipient_id NOT IN UNNEST(@exclude_ids)
),

judged AS (
  SELECT
    *,
    ARRAY_CONCAT(
      IF(@needs_cold AND cold_storage = 'none',
         ['no refrigeration'], ARRAY<STRING>[]),
      IF(@needs_cold AND cold_storage = 'medical',
         ['medical fridge only, not for donated food'], ARRAY<STRING>[]),
      IF(@needs_frozen AND NOT frozen_storage,
         ['no freezer'], ARRAY<STRING>[]),
      IF(contradicts_itself,
         ['profile contradicts its own storage claims: call to verify'], ARRAY<STRING>[]),
      IF(text_days != service_days,
         [FORMAT('opening days conflict: profile says %s, records say %s: call to verify',
                 text_days, service_days)], ARRAY<STRING>[]),
      IF(IFNULL(text_days = service_days, TRUE) AND first_open_date IS NULL,
         [FORMAT('not open in time (open %s)', service_days)], ARRAY<STRING>[])
    ) AS ruled_out_because,
    pickup_window_hours <= @hours_remaining AS can_self_collect,
    ROUND(@hours_remaining - pickup_window_hours, 1) AS margin_hours,
    capacity_pallets >= @pallets AS takes_it_all
  FROM checked
),

scored AS (
  SELECT
    *,
    ARRAY_LENGTH(ruled_out_because) = 0 AS viable,
    CASE
      WHEN @pallets > 1 THEN IF(can_self_collect, 1, 2)   -- split load: shares, not all of it
      WHEN takes_it_all AND can_self_collect THEN 1
      WHEN takes_it_all THEN 2          -- needs a volunteer driver
      WHEN can_self_collect THEN 3      -- can take part of it: a split candidate
      ELSE 4
    END AS tier,
    ROUND((1 - need_weight) * SAFE_DIVIDE(MAX(distance) OVER () - distance,
                                          MAX(distance) OVER () - MIN(distance) OVER ())
          + need_weight * tract.need_score, 3) AS score
  FROM judged
),

ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (ORDER BY viable DESC, tier, score DESC) AS rank,
    @pallets > 1 AND viable AND capacity_pallets >= 1 AS gets_share
  FROM scored
),

-- Each share is what the recipient can hold, or whatever is left after everyone ranked above it.
allocated AS (
  SELECT
    *,
    IF(gets_share,
       NULLIF(ROUND(LEAST(capacity_pallets, GREATEST(0, @pallets - IFNULL(
         SUM(IF(gets_share, capacity_pallets, 0))
           OVER (ORDER BY rank ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0))), 2), 0),
       NULL) AS allocated_pallets
  FROM ranked
)

SELECT
  rank,
  RANK() OVER (ORDER BY distance) AS semantic_rank,
  viable, tier, score, ROUND(need_weight, 2) AS need_weight, ROUND(distance, 4) AS distance,
  allocated_pallets,
  IF(allocated_pallets > 0,
     ROW_NUMBER() OVER (PARTITION BY allocated_pallets > 0 ORDER BY rank), NULL) AS split_stop,
  IF(@pallets > 1,
     ROUND(GREATEST(0, @pallets - IFNULL(SUM(allocated_pallets) OVER (), 0)), 2),
     NULL) AS unplaced_pallets,
  recipient_id, name, street, city, zip_code, archetype_label,
  cold_storage, frozen_storage, max_pallets, capacity_pallets, takes_it_all,
  pickup_window_hours, can_self_collect, margin_hours, refrigerated_transport, loading_dock,
  service_days, open_today, first_open_date, weekly_households, reported_income, populations_served,
  tract.geo_id AS tract_geo_id, tract_source, tract.poverty_rate, tract.no_vehicle_rate,
  tract.need_score,
  ruled_out_because, profile_source, profile_text
FROM allocated
ORDER BY rank
