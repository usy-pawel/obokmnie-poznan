CREATE INDEX IF NOT EXISTS cases_city_lower_published_idx
ON cases (lower(city))
WHERE published;
