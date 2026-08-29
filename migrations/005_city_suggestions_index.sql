CREATE INDEX IF NOT EXISTS cases_city_lower_prefix_published_idx
ON cases (lower(city) text_pattern_ops)
WHERE published;
