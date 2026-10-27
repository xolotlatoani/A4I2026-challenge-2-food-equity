-- "Whose neighborhood does this help?" One recipient's tract against the metro, read from
-- a4i_food.recipient_facts (sql/05_recipient_facts.sql).
--
-- Parameters:
--   @recipient  STRING  a recipient_id, an exact name, or part of a name
--
-- Returns up to five matches: an exact id first, then an exact name, then partial names.
-- need_score is the tract's average percentile on no-vehicle and poverty rates among the
-- metro's tracts, the same scale sql/03_filter_and_rank.sql ranks on. It is NULL for planted
-- rows, which have no address and so no tract.

SELECT
  recipient_id,
  name,
  street,
  city,
  state,
  zip_code,
  archetype_label,
  profile_source,
  cold_storage,
  max_pallets,
  weekly_households,
  tract_source,
  geocode_match,
  tract_geo_id,
  tract_population,
  tract_median_income,
  ROUND(poverty_rate, 4) AS poverty_rate,
  ROUND(no_vehicle_rate, 4) AS no_vehicle_rate,
  ROUND(assistance_rate, 4) AS assistance_rate,
  need_score,
  ROUND(metro_poverty_rate, 4) AS metro_poverty_rate,
  ROUND(metro_no_vehicle_rate, 4) AS metro_no_vehicle_rate,
  ROUND(metro_assistance_rate, 4) AS metro_assistance_rate,
  metro_tracts,
  above_metro_need
FROM `a4i_food.recipient_facts`
WHERE CAST(recipient_id AS STRING) = TRIM(@recipient)
   OR LOWER(name) LIKE CONCAT('%', LOWER(TRIM(@recipient)), '%')
ORDER BY
  CAST(recipient_id AS STRING) = TRIM(@recipient) DESC,
  LOWER(name) = LOWER(TRIM(@recipient)) DESC,
  recipient_id
LIMIT 5;
