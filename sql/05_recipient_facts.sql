-- One row per recipient with everything a question about a single organization needs: what it
-- can store and when it is open, the tract its street address sits in, and how that tract
-- compares with the metro. Per-organization tools ("whose neighborhood does this help?", "why
-- not them?") read this view instead of joining the tables themselves.
--
-- Built on a4i_food.recipient_tracts; scripts/geocode_recipients.py builds both. A view, so it
-- follows recipients and recipient_tracts whenever either is rebuilt.
--
-- Metro baselines are population-weighted across tract_demographics, like the README's figures.
-- Planted rows have no address: their tract columns are NULL and tract_source is 'none'.

CREATE OR REPLACE VIEW `a4i_food.recipient_facts` AS
WITH metro AS (
  SELECT
    SUM(no_vehicle_rate * total_pop) / SUM(total_pop) AS metro_no_vehicle_rate,
    SUM(poverty_rate * total_pop) / SUM(total_pop) AS metro_poverty_rate,
    SUM(assistance_rate * total_pop) / SUM(total_pop) AS metro_assistance_rate,
    COUNT(*) AS metro_tracts
  FROM `a4i_food.tract_demographics`
  WHERE no_vehicle_rate IS NOT NULL AND poverty_rate IS NOT NULL
)
SELECT
  r.*,
  rt.tract_source,
  rt.match_type AS geocode_match,
  rt.latitude AS address_latitude,
  rt.longitude AS address_longitude,
  rt.tract_geo_id,
  rt.total_pop AS tract_population,
  rt.median_income AS tract_median_income,
  rt.poverty_rate,
  rt.no_vehicle_rate,
  rt.assistance_rate,
  rt.need_score,
  m.metro_no_vehicle_rate,
  m.metro_poverty_rate,
  m.metro_assistance_rate,
  m.metro_tracts,
  rt.no_vehicle_rate > m.metro_no_vehicle_rate
    OR rt.poverty_rate > m.metro_poverty_rate AS above_metro_need
FROM `a4i_food.recipients` r
LEFT JOIN `a4i_food.recipient_tracts` rt USING (recipient_id)
CROSS JOIN metro m;
