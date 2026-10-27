-- One row per recipient: the census tract it sits in, that tract's ACS figures, and its need.
-- scripts/geocode_recipients.py loads a4i_food.recipient_geocodes and then runs this file.
--
-- tract_source says where the tract came from:
--   geocoded      the street address, matched by the Census Bureau geocoder to a 2020 tract
--   zip_centroid  the address did not match, so the nearest tract_demographics tract to the
--                 organization's ZIP centroid - the notebook's method
--   none          no street address: the planted teaching rows. Their coordinates are made up,
--                 so they get no tract, and the matcher treats their need as neutral
--
-- Geocoded rates come straight from ACS 2016-2020, which is published on 2020 tracts, not from
-- tract_demographics. That table holds only 165 of the 254 tracts in the Atlanta box: the
-- notebook joins 2010 tract geometry to 2020 ACS, so every tract redrawn in 2020 drops out,
-- and about half the geocoded addresses sit in one of them.
--
-- need_score is on sql/03_filter_and_rank.sql's scale: the average of the tract's percentile
-- among tract_demographics tracts on no-vehicle rate and on poverty rate.

CREATE OR REPLACE TABLE `a4i_food.recipient_tracts` AS
WITH
acs AS (
  -- Same formulas as the notebook's Section 9 pull.
  SELECT
    LPAD(geo_id, 11, '0') AS geo_id,
    SAFE_CAST(total_pop AS FLOAT64) AS total_pop,
    SAFE_CAST(median_income AS FLOAT64) AS median_income,
    SAFE_DIVIDE(SAFE_CAST(poverty AS FLOAT64),
                SAFE_CAST(pop_determined_poverty_status AS FLOAT64)) AS poverty_rate,
    SAFE_DIVIDE(SAFE_CAST(no_cars AS FLOAT64), SAFE_CAST(households AS FLOAT64)) AS no_vehicle_rate,
    SAFE_DIVIDE(SAFE_CAST(households_public_asst_or_food_stamps AS FLOAT64),
                SAFE_CAST(households AS FLOAT64)) AS assistance_rate
  FROM `bigquery-public-data.census_bureau_acs.censustract_2020_5yr`
),

metro AS (
  SELECT * FROM `a4i_food.tract_demographics`
  WHERE no_vehicle_rate IS NOT NULL AND poverty_rate IS NOT NULL
),

geocoded AS (
  SELECT
    g.recipient_id, 'geocoded' AS tract_source, g.match_type, g.latitude, g.longitude,
    a.geo_id AS tract_geo_id, a.total_pop, a.median_income,
    a.poverty_rate, a.no_vehicle_rate, a.assistance_rate
  FROM `a4i_food.recipient_geocodes` g
  JOIN acs a ON a.geo_id = g.tract_geo_id
  WHERE g.match_status = 'Match'
),

fallback AS (
  SELECT
    r.recipient_id, r.latitude, r.longitude,
    ARRAY_AGG(STRUCT(m.geo_id, m.total_pop, m.median_income,
                     m.poverty_rate, m.no_vehicle_rate, m.assistance_rate)
              ORDER BY ST_DISTANCE(ST_GEOGPOINT(r.longitude, r.latitude),
                                   ST_GEOGPOINT(m.tract_lon, m.tract_lat))
              LIMIT 1)[OFFSET(0)] AS t
  FROM `a4i_food.recipients` r CROSS JOIN metro m
  WHERE r.street != ''
    AND r.recipient_id NOT IN (SELECT recipient_id FROM geocoded)
  GROUP BY r.recipient_id, r.latitude, r.longitude
),

located AS (
  SELECT * FROM geocoded
  UNION ALL
  SELECT recipient_id, 'zip_centroid', NULL, latitude, longitude, t.geo_id, t.total_pop,
         t.median_income, t.poverty_rate, t.no_vehicle_rate, t.assistance_rate
  FROM fallback
  UNION ALL
  SELECT recipient_id, 'none', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM `a4i_food.recipients`
  WHERE street = ''
),

-- PERCENT_RANK as it would be if this tract were one of the metro's: the share of the other
-- tracts below it. Capped at 1 for a tract above every metro tract.
need AS (
  SELECT
    l.recipient_id,
    ROUND(LEAST(1, (COUNTIF(m.no_vehicle_rate < l.no_vehicle_rate)
                    + COUNTIF(m.poverty_rate < l.poverty_rate)) / 2 / (COUNT(*) - 1)), 3)
      AS need_score
  FROM located l CROSS JOIN metro m
  WHERE l.no_vehicle_rate IS NOT NULL AND l.poverty_rate IS NOT NULL
  GROUP BY l.recipient_id
)

SELECT l.*, n.need_score
FROM located l
LEFT JOIN need n USING (recipient_id);
