-- Constraint filter: semantic candidates in, viable recipients out, plus the reason every
-- other candidate was eliminated. Wraps the search from 02_match_candidates.sql; this is the
-- query the agent's matching tool should call. Rules and assumptions are in sql/README.md.
--
-- Parameters:
--   @posting_text        STRING     the offer as typed - this is what gets embedded
--   @storage_state       STRING     'pantry' | 'refrigerated' | 'frozen'
--   @hours_remaining     FLOAT64    from surplus_postings, or min(donor window, shelf life)
--   @pallets_needed      FLOAT64    size of the load; fractions are fine (10 crates ~ 0.5)
--   @posted_at           TIMESTAMP  when the clock started; NULL means now
--   @top_k               INT64      candidates to pull before filtering (40 of 127 works)
--   @include_eliminated  BOOL       TRUE also returns eliminated rows, with eliminated_by set
--
-- Rows come back viable first, then by cosine distance (lower is closer). Ordering among
-- viable rows is semantic only - ranking is a separate decision.

WITH candidates AS (
  SELECT
    base.recipient_id, base.name, base.street, base.city, base.zip_code,
    base.archetype_label, base.profile_source, base.cold_storage, base.frozen_storage,
    base.loading_dock, base.refrigerated_transport, base.max_pallets,
    base.pickup_window_hours, base.service_days, base.weekly_households,
    base.populations_served, base.latitude, base.longitude, base.profile_text,
    distance
  FROM VECTOR_SEARCH(
    TABLE `a4i_food.recipient_embeddings`, 'embedding',
    (SELECT AI.EMBED(@posting_text, endpoint => 'gemini-embedding-2').result AS embedding),
    top_k => @top_k,
    distance_type => 'COSINE',
    options => '{"use_brute_force": true}')
),

clock AS (
  SELECT
    COALESCE(@posted_at, CURRENT_TIMESTAMP()) AS posted_at,
    TIMESTAMP_ADD(COALESCE(@posted_at, CURRENT_TIMESTAMP()),
                  INTERVAL CAST(ROUND(@hours_remaining * 60) AS INT64) MINUTE) AS deadline
),

checks AS (
  SELECT
    c.*,
    k.deadline,
    TIMESTAMP_ADD(k.posted_at, INTERVAL c.pickup_window_hours HOUR) AS earliest_pickup,
    -- The profile's own words deny a capability its storage columns claim.
    (c.frozen_storage AND REGEXP_CONTAINS(LOWER(c.profile_text), r'\bno freezer\b'))
      OR (c.cold_storage != 'none' AND REGEXP_CONTAINS(LOWER(c.profile_text),
            r'\bno (refrigeration|fridge|cold storage|cooler|cold chain)\b'))
      AS storage_conflict,
    -- Every generated profile says "Open <service_days>". Saying anything else is a conflict.
    REGEXP_CONTAINS(c.profile_text, r'\bOpen ')
      AND STRPOS(c.profile_text, CONCAT('Open ', c.service_days)) = 0
      AS schedule_conflict
  FROM candidates c CROSS JOIN clock k
),

scored AS (
  SELECT
    ch.*,
    -- A profile that contradicts its own storage record can't be trusted for any load,
    -- dry goods included: its pallet count is suspect too.
    NOT ch.storage_conflict AND CASE @storage_state
      WHEN 'frozen'       THEN ch.frozen_storage
      WHEN 'refrigerated' THEN ch.cold_storage != 'none'
      ELSE TRUE
    END AS storage_ok,
    ch.max_pallets >= LEAST(@pallets_needed, 1) AS pallets_ok,
    ch.max_pallets >= @pallets_needed AS takes_full_load,
    ch.pickup_window_hours <= @hours_remaining AS pickup_ok,
    -- First date between their earliest pickup and the deadline that is a service day.
    -- "Second and fourth Wednesday of the month" is matched on which week of the month d is.
    (SELECT MIN(d)
     FROM UNNEST(GENERATE_DATE_ARRAY(DATE(ch.earliest_pickup, 'America/New_York'),
                                     DATE(ch.deadline, 'America/New_York'))) AS d
     WHERE STRPOS(ch.service_days, FORMAT_DATE('%A', d)) > 0
       AND (STRPOS(ch.service_days, 'of the month') = 0
            OR STRPOS(LOWER(ch.service_days),
                      ['first', 'second', 'third', 'fourth', 'fifth']
                        [OFFSET(DIV(EXTRACT(DAY FROM d) - 1, 7))]) > 0)
    ) AS pickup_date
  FROM checks ch
),

verdict AS (
  SELECT
    s.*,
    s.storage_ok AND s.pallets_ok AND s.pickup_ok AND s.pickup_date IS NOT NULL AS viable,
    ARRAY(
      SELECT reason FROM UNNEST([
        IF(s.storage_ok, NULL,
           IF(s.storage_conflict, 'storage: profile text contradicts its storage record',
              FORMAT('storage: needs %s, has cold_storage=%s frozen_storage=%t',
                     @storage_state, s.cold_storage, s.frozen_storage))),
        IF(s.pallets_ok, NULL,
           FORMAT('pallets: takes %d, load is %.1f', s.max_pallets, @pallets_needed)),
        IF(s.pickup_ok, NULL,
           FORMAT('pickup: needs %dh notice, food has %.0fh',
                  s.pickup_window_hours, @hours_remaining)),
        IF(NOT s.pickup_ok OR s.pickup_date IS NOT NULL, NULL,
           FORMAT('service days: %s, none before the deadline', s.service_days))
      ]) AS reason
      WHERE reason IS NOT NULL
    ) AS eliminated_by
  FROM scored s
)

SELECT
  recipient_id, name, street, city, zip_code, archetype_label, profile_source,
  viable,
  eliminated_by,
  takes_full_load,
  LEAST(max_pallets, @pallets_needed) AS pallets_they_can_take,
  pickup_date,
  @storage_state != 'pantry' AND NOT refrigerated_transport AS needs_cold_transport,
  storage_conflict,
  schedule_conflict,
  cold_storage, frozen_storage, loading_dock, refrigerated_transport, max_pallets,
  pickup_window_hours, service_days, weekly_households, populations_served,
  latitude, longitude, profile_text,
  ROUND(distance, 4) AS distance
FROM verdict
WHERE viable OR COALESCE(@include_eliminated, FALSE)
ORDER BY viable DESC, distance;
