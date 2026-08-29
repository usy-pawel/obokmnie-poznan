CREATE OR REPLACE FUNCTION voivodeship_teryt_code(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE lower(value)
    WHEN 'dolnośląskie' THEN '02'
    WHEN 'kujawsko-pomorskie' THEN '04'
    WHEN 'lubelskie' THEN '06'
    WHEN 'lubuskie' THEN '08'
    WHEN 'łódzkie' THEN '10'
    WHEN 'małopolskie' THEN '12'
    WHEN 'mazowieckie' THEN '14'
    WHEN 'opolskie' THEN '16'
    WHEN 'podkarpackie' THEN '18'
    WHEN 'podlaskie' THEN '20'
    WHEN 'pomorskie' THEN '22'
    WHEN 'śląskie' THEN '24'
    WHEN 'świętokrzyskie' THEN '26'
    WHEN 'warmińsko-mazurskie' THEN '28'
    WHEN 'wielkopolskie' THEN '30'
    WHEN 'zachodniopomorskie' THEN '32'
  END
$$;

UPDATE parcels
SET geom = ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3)),
    updated_at = now()
WHERE geom IS NOT NULL AND NOT ST_IsValid(geom);

ALTER TABLE parcels
  ADD CONSTRAINT parcels_geom_valid
  CHECK (geom IS NULL OR ST_IsValid(geom)) NOT VALID;
ALTER TABLE parcels VALIDATE CONSTRAINT parcels_geom_valid;

DELETE FROM case_parcels cp
USING cases c
WHERE cp.case_id = c.id
  AND voivodeship_teryt_code(c.voivodeship) IS NOT NULL
  AND left(cp.parcel_id, 2) <> voivodeship_teryt_code(c.voivodeship);

UPDATE cases SET location = NULL, published = false WHERE published OR location IS NOT NULL;

UPDATE cases c
SET location = linked.location,
    published = true
FROM (
  SELECT cp.case_id, ST_PointOnSurface(ST_Collect(p.geom)) AS location
  FROM case_parcels cp
  JOIN parcels p ON p.parcel_id = cp.parcel_id
  JOIN cases source_case ON source_case.id = cp.case_id
  WHERE p.geom IS NOT NULL
    AND NOT ST_IsEmpty(p.geom)
    AND ST_IsValid(p.geom)
    AND left(cp.parcel_id, 2) = voivodeship_teryt_code(source_case.voivodeship)
    AND ST_Within(ST_Centroid(p.geom), ST_MakeEnvelope(14.0, 48.8, 24.3, 55.3, 4326))
  GROUP BY cp.case_id
) linked
WHERE c.id = linked.case_id;

ANALYZE cases;
ANALYZE parcels;
