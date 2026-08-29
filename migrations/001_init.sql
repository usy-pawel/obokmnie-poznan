CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS imports (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  source_date date,
  period_start date,
  period_end date,
  status text NOT NULL DEFAULT 'running',
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);

CREATE TABLE IF NOT EXISTS cases (
  id bigserial PRIMARY KEY,
  case_key text NOT NULL UNIQUE,
  source_type text NOT NULL CHECK (source_type IN ('wniosek_decyzja', 'zgloszenie')),
  external_id text NOT NULL,
  received_date date NOT NULL,
  decision_date date,
  status text NOT NULL,
  office text NOT NULL DEFAULT '',
  voivodeship text NOT NULL,
  city text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  case_kind text NOT NULL DEFAULT '',
  description text NOT NULL,
  parcel_ids text[] NOT NULL DEFAULT '{}',
  location geometry(Point, 4326),
  published boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(external_id, '') || ' ' || coalesce(city, '') || ' ' ||
      coalesce(address, '') || ' ' || coalesce(description, '') || ' ' ||
      coalesce(office, '') || ' ' || coalesce(voivodeship, '')
    )
  ) STORED
);

CREATE TABLE IF NOT EXISTS parcels (
  parcel_id text PRIMARY KEY,
  returned_id text,
  geom geometry(MultiPolygon, 4326),
  datasource text,
  error text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_parcels (
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  parcel_id text NOT NULL REFERENCES parcels(parcel_id) ON DELETE CASCADE,
  PRIMARY KEY (case_id, parcel_id)
);

CREATE INDEX IF NOT EXISTS cases_location_gix ON cases USING gist (location) WHERE published;
CREATE INDEX IF NOT EXISTS cases_received_date_idx ON cases (received_date DESC);
CREATE INDEX IF NOT EXISTS cases_source_type_idx ON cases (source_type) WHERE published;
CREATE INDEX IF NOT EXISTS cases_voivodeship_idx ON cases (voivodeship) WHERE published;
CREATE INDEX IF NOT EXISTS cases_search_gin ON cases USING gin (search_vector);
CREATE INDEX IF NOT EXISTS parcels_geom_gix ON parcels USING gist (geom) WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS case_parcels_parcel_idx ON case_parcels (parcel_id);

