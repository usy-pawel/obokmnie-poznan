CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS cases_city_trgm_idx ON cases USING gin (city gin_trgm_ops) WHERE published;
CREATE INDEX IF NOT EXISTS cases_address_trgm_idx ON cases USING gin (address gin_trgm_ops) WHERE published;
CREATE INDEX IF NOT EXISTS cases_external_id_trgm_idx ON cases USING gin (external_id gin_trgm_ops) WHERE published;
CREATE INDEX IF NOT EXISTS cases_voivodeship_trgm_idx ON cases USING gin (voivodeship gin_trgm_ops) WHERE published;
