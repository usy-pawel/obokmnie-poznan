SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE case_events
  ADD COLUMN IF NOT EXISTS match_parcel_ids text[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_events_match_parcels_bounded'
      AND conrelid = 'case_events'::regclass
  ) THEN
    ALTER TABLE case_events
      ADD CONSTRAINT case_events_match_parcels_bounded
      CHECK (
        match_parcel_ids IS NULL OR (
          cardinality(match_parcel_ids) <= 1000
          AND array_position(match_parcel_ids, NULL) IS NULL
        )
      ) NOT VALID;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS radar_profiles (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_active_on date NOT NULL DEFAULT current_date,
  inactive_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  rate_window_started_at timestamptz NOT NULL DEFAULT date_trunc('hour', clock_timestamp()),
  monitor_create_count integer NOT NULL DEFAULT 0 CHECK (monitor_create_count >= 0),
  mutation_count integer NOT NULL DEFAULT 0 CHECK (mutation_count >= 0),
  feed_read_count integer NOT NULL DEFAULT 0 CHECK (feed_read_count >= 0),
  CHECK (inactive_expires_at > created_at),
  CHECK (absolute_expires_at > created_at),
  CHECK (absolute_expires_at <= created_at + interval '365 days 1 minute'),
  CHECK (inactive_expires_at <= absolute_expires_at)
);

CREATE TABLE IF NOT EXISTS radar_watches (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES radar_profiles(id) ON DELETE CASCADE,
  client_key uuid NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  kind text NOT NULL CHECK (kind IN ('parcel', 'parcel_set', 'radius')),
  anchor geometry(Point, 4326),
  radius_m smallint,
  starts_after_import_id bigint NOT NULL DEFAULT 0 CHECK (starts_after_import_id >= 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (profile_id, client_key),
  CHECK (
    (kind IN ('parcel', 'parcel_set') AND anchor IS NULL AND radius_m IS NULL)
    OR
    (kind = 'radius' AND anchor IS NOT NULL AND radius_m IN (500, 1000, 3000)
      AND ST_IsValid(anchor)
      AND ST_Covers(ST_MakeEnvelope(13.5, 48.5, 24.8, 55.5, 4326), anchor))
  )
);

CREATE TABLE IF NOT EXISTS radar_watch_parcels (
  watch_id uuid NOT NULL REFERENCES radar_watches(id) ON DELETE CASCADE,
  parcel_id text NOT NULL REFERENCES parcels(parcel_id) ON DELETE RESTRICT,
  PRIMARY KEY (watch_id, parcel_id)
);

CREATE TABLE IF NOT EXISTS radar_matches (
  id bigserial PRIMARY KEY,
  watch_id uuid NOT NULL REFERENCES radar_watches(id) ON DELETE CASCADE,
  event_id bigint NOT NULL REFERENCES case_events(id) ON DELETE CASCADE,
  match_kind text NOT NULL CHECK (match_kind IN ('parcel', 'radius')),
  matched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (watch_id, event_id)
);

CREATE TABLE IF NOT EXISTS radar_import_projections (
  import_id bigint PRIMARY KEY REFERENCES imports(id) ON DELETE RESTRICT,
  projection_kind text NOT NULL CHECK (projection_kind IN ('baseline', 'projected')),
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  event_count integer,
  match_count integer,
  CHECK (
    (projection_kind = 'baseline' AND event_count IS NULL AND match_count IS NULL)
    OR
    (projection_kind = 'projected' AND event_count >= 0 AND match_count >= 0)
  )
);

CREATE TABLE IF NOT EXISTS radar_rate_windows (
  scope text PRIMARY KEY CHECK (scope IN ('profile_create', 'monitor_create')),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS radar_profiles_inactive_expiry_idx
  ON radar_profiles (inactive_expires_at);
CREATE INDEX IF NOT EXISTS radar_profiles_absolute_expiry_idx
  ON radar_profiles (absolute_expires_at);
CREATE INDEX IF NOT EXISTS radar_watches_profile_idx
  ON radar_watches (profile_id, created_at, id);
CREATE INDEX IF NOT EXISTS radar_watches_anchor_geog_gix
  ON radar_watches USING gist ((anchor::geography))
  WHERE kind = 'radius';
CREATE INDEX IF NOT EXISTS radar_watch_parcels_parcel_idx
  ON radar_watch_parcels (parcel_id, watch_id);
CREATE INDEX IF NOT EXISTS radar_matches_event_idx
  ON radar_matches (event_id);
CREATE INDEX IF NOT EXISTS radar_matches_watch_cursor_idx
  ON radar_matches (watch_id, id);
CREATE INDEX IF NOT EXISTS radar_matches_retention_idx
  ON radar_matches (matched_at, id);

CREATE OR REPLACE FUNCTION record_case_event() RETURNS trigger AS $$
DECLARE
  active_import_id bigint := nullif(current_setting('obokmnie.import_id', true), '')::bigint;
  event_kind text;
  fields text[];
  match_ids text[];
BEGIN
  IF active_import_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.source_fingerprint IS NULL THEN RETURN NEW; END IF;
    event_kind := 'new';
    fields := ARRAY['case'];
  ELSIF OLD.source_active AND NOT NEW.source_active THEN
    event_kind := 'removed';
    fields := ARRAY['source_active'];
  ELSIF NOT OLD.source_active AND NEW.source_active THEN
    event_kind := 'changed';
    fields := ARRAY['source_active'];
  ELSIF OLD.source_fingerprint IS NULL OR OLD.source_fingerprint = NEW.source_fingerprint THEN
    RETURN NEW;
  ELSE
    event_kind := 'changed';
    fields := array_remove(ARRAY[
      CASE WHEN OLD.received_date IS DISTINCT FROM NEW.received_date THEN 'received_date' END,
      CASE WHEN OLD.decision_date IS DISTINCT FROM NEW.decision_date THEN 'decision_date' END,
      CASE WHEN OLD.status IS DISTINCT FROM NEW.status THEN 'status' END,
      CASE WHEN OLD.office IS DISTINCT FROM NEW.office THEN 'office' END,
      CASE WHEN OLD.voivodeship IS DISTINCT FROM NEW.voivodeship THEN 'voivodeship' END,
      CASE WHEN OLD.city IS DISTINCT FROM NEW.city THEN 'city' END,
      CASE WHEN OLD.address IS DISTINCT FROM NEW.address THEN 'address' END,
      CASE WHEN OLD.case_kind IS DISTINCT FROM NEW.case_kind THEN 'case_kind' END,
      CASE WHEN OLD.description IS DISTINCT FROM NEW.description THEN 'description' END,
      CASE WHEN OLD.parcel_ids IS DISTINCT FROM NEW.parcel_ids THEN 'parcel_ids' END
    ], NULL);
  END IF;

  SELECT coalesce(array_agg(DISTINCT parcel_id ORDER BY parcel_id), '{}'::text[])
  INTO match_ids
  FROM unnest(
    CASE WHEN TG_OP = 'INSERT'
      THEN coalesce(NEW.parcel_ids, '{}'::text[])
      ELSE coalesce(OLD.parcel_ids, '{}'::text[]) || coalesce(NEW.parcel_ids, '{}'::text[])
    END
  ) AS parcel_id
  WHERE parcel_id IS NOT NULL AND parcel_id <> '';

  IF cardinality(match_ids) > 1000 THEN
    RAISE EXCEPTION 'case_event_match_parcels_too_many';
  END IF;

  INSERT INTO case_events(case_id, import_id, event_type, changed_fields, snapshot, match_parcel_ids)
  VALUES (
    NEW.id,
    active_import_id,
    event_kind,
    fields,
    jsonb_build_object(
      'case_key', NEW.case_key,
      'external_id', NEW.external_id,
      'source_type', NEW.source_type,
      'received_date', NEW.received_date,
      'decision_date', NEW.decision_date,
      'status', NEW.status,
      'city', NEW.city,
      'address', NEW.address,
      'description', NEW.description,
      'parcel_ids', NEW.parcel_ids
    ),
    match_ids
  )
  ON CONFLICT (case_id, import_id, event_type) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_import_terminal_status() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('success', 'failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'terminal_import_status_is_immutable';
  END IF;
  IF OLD.status = 'running' AND NEW.status NOT IN ('running', 'success', 'failed') THEN
    RAISE EXCEPTION 'invalid_import_status_transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS imports_protect_terminal_status ON imports;
CREATE TRIGGER imports_protect_terminal_status
BEFORE UPDATE OF status ON imports
FOR EACH ROW EXECUTE FUNCTION protect_import_terminal_status();

CREATE OR REPLACE FUNCTION radar_project_import(target_import_id bigint)
RETURNS TABLE(event_count integer, match_count integer)
LANGUAGE plpgsql
AS $$
DECLARE
  imported_events integer;
  inserted_exact integer := 0;
  inserted_radius integer := 0;
  existing_projection radar_import_projections%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('radar_watch_projection'));

  SELECT * INTO existing_projection
  FROM radar_import_projections
  WHERE import_id = target_import_id;
  IF FOUND THEN
    RETURN QUERY SELECT
      coalesce(existing_projection.event_count, 0),
      coalesce(existing_projection.match_count, 0);
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM imports
    WHERE id = target_import_id AND status = 'success' AND finished_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'radar_projection_requires_successful_import';
  END IF;

  IF EXISTS (
    SELECT 1 FROM case_events
    WHERE import_id = target_import_id AND match_parcel_ids IS NULL
  ) THEN
    RAISE EXCEPTION 'radar_event_match_keys_missing';
  END IF;

  SELECT count(*)::integer INTO imported_events
  FROM case_events WHERE import_id = target_import_id;

  INSERT INTO radar_matches(watch_id, event_id, match_kind)
  SELECT DISTINCT watch.id, event.id, 'parcel'
  FROM case_events event
  CROSS JOIN imports imported
  JOIN radar_watch_parcels membership
    ON membership.parcel_id = ANY(event.match_parcel_ids)
  JOIN radar_watches watch ON watch.id = membership.watch_id
    AND watch.kind IN ('parcel', 'parcel_set')
  JOIN radar_profiles profile ON profile.id = watch.profile_id
  WHERE imported.id = target_import_id
    AND imported.status = 'success'
    AND imported.finished_at IS NOT NULL
    AND event.import_id = imported.id
    AND watch.state = 'active'
    AND watch.starts_after_import_id < imported.id
    AND profile.inactive_expires_at > imported.finished_at
    AND profile.absolute_expires_at > imported.finished_at
  ON CONFLICT (watch_id, event_id) DO NOTHING;
  GET DIAGNOSTICS inserted_exact = ROW_COUNT;

  WITH event_geometry AS (
    SELECT DISTINCT event.id AS event_id, parcel.geom
    FROM case_events event
    CROSS JOIN LATERAL unnest(event.match_parcel_ids) AS match_parcel_id
    JOIN parcels parcel ON parcel.parcel_id = match_parcel_id
    WHERE event.import_id = target_import_id
      AND parcel.geom IS NOT NULL
      AND NOT ST_IsEmpty(parcel.geom)
      AND ST_IsValid(parcel.geom)
  )
  INSERT INTO radar_matches(watch_id, event_id, match_kind)
  SELECT DISTINCT watch.id, event_geometry.event_id, 'radius'
  FROM event_geometry
  CROSS JOIN imports imported
  JOIN radar_watches watch ON watch.kind = 'radius'
    AND ST_DWithin(watch.anchor::geography, event_geometry.geom::geography, 3000)
    AND ST_DWithin(watch.anchor::geography, event_geometry.geom::geography, watch.radius_m)
  JOIN radar_profiles profile ON profile.id = watch.profile_id
  WHERE imported.id = target_import_id
    AND imported.status = 'success'
    AND imported.finished_at IS NOT NULL
    AND watch.state = 'active'
    AND watch.starts_after_import_id < imported.id
    AND profile.inactive_expires_at > imported.finished_at
    AND profile.absolute_expires_at > imported.finished_at
  ON CONFLICT (watch_id, event_id) DO NOTHING;
  GET DIAGNOSTICS inserted_radius = ROW_COUNT;

  INSERT INTO radar_import_projections(
    import_id, projection_kind, event_count, match_count
  ) VALUES (
    target_import_id, 'projected', imported_events, inserted_exact + inserted_radius
  );

  RETURN QUERY SELECT imported_events, inserted_exact + inserted_radius;
END;
$$;

CREATE OR REPLACE FUNCTION radar_event_match_keys(
  target_case_id bigint,
  target_import_id bigint,
  target_event_id bigint,
  target_snapshot jsonb,
  stored_keys text[]
) RETURNS text[]
LANGUAGE sql
STABLE
AS $function$
  SELECT CASE WHEN stored_keys IS NOT NULL THEN stored_keys
    ELSE ARRAY(
      SELECT DISTINCT parcel_id
      FROM (
        SELECT jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(target_snapshot->'parcel_ids') = 'array'
            THEN target_snapshot->'parcel_ids' ELSE '[]'::jsonb END
        ) AS parcel_id
        UNION ALL
        SELECT jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(previous_event.snapshot->'parcel_ids') = 'array'
            THEN previous_event.snapshot->'parcel_ids' ELSE '[]'::jsonb END
        ) AS parcel_id
        FROM (
          SELECT previous.snapshot
          FROM case_events previous
          JOIN imports previous_import ON previous_import.id = previous.import_id
            AND previous_import.status = 'success'
            AND previous_import.finished_at IS NOT NULL
          WHERE previous.case_id = target_case_id
            AND (previous.import_id, previous.id) < (target_import_id, target_event_id)
          ORDER BY previous.import_id DESC, previous.id DESC
          LIMIT 1
        ) previous_event
      ) expanded
      WHERE parcel_id IS NOT NULL AND parcel_id <> ''
    )
  END
$function$;

CREATE OR REPLACE FUNCTION radar_backfill_watch(target_watch_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_exact integer := 0;
  inserted_radius integer := 0;
  selected_watch radar_watches%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('radar_watch_projection'));

  SELECT * INTO selected_watch
  FROM radar_watches
  WHERE id = target_watch_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'radar_watch_not_found';
  END IF;

  IF selected_watch.kind IN ('parcel', 'parcel_set') THEN
    WITH event_keys AS (
      SELECT event.id AS event_id,
             radar_event_match_keys(
               event.case_id,event.import_id,event.id,event.snapshot,event.match_parcel_ids
             ) AS parcel_ids
      FROM case_events event
      JOIN imports imported ON imported.id = event.import_id
        AND imported.status = 'success' AND imported.finished_at IS NOT NULL
      WHERE event.import_id > selected_watch.starts_after_import_id
    )
    INSERT INTO radar_matches(watch_id, event_id, match_kind)
    SELECT DISTINCT selected_watch.id, event_keys.event_id, 'parcel'
    FROM event_keys
    JOIN radar_watch_parcels membership
      ON membership.watch_id = selected_watch.id
      AND membership.parcel_id = ANY(event_keys.parcel_ids)
    ON CONFLICT (watch_id, event_id) DO NOTHING;
    GET DIAGNOSTICS inserted_exact = ROW_COUNT;
  ELSE
    WITH event_keys AS (
      SELECT event.id AS event_id,
             radar_event_match_keys(
               event.case_id,event.import_id,event.id,event.snapshot,event.match_parcel_ids
             ) AS parcel_ids
      FROM case_events event
      JOIN imports imported ON imported.id = event.import_id
        AND imported.status = 'success' AND imported.finished_at IS NOT NULL
      WHERE event.import_id > selected_watch.starts_after_import_id
    ), event_geometry AS (
      SELECT DISTINCT event_keys.event_id, parcel.geom
      FROM event_keys
      CROSS JOIN LATERAL unnest(event_keys.parcel_ids) AS match_parcel_id
      JOIN parcels parcel ON parcel.parcel_id = match_parcel_id
      WHERE parcel.geom IS NOT NULL
        AND NOT ST_IsEmpty(parcel.geom)
        AND ST_IsValid(parcel.geom)
    )
    INSERT INTO radar_matches(watch_id, event_id, match_kind)
    SELECT DISTINCT selected_watch.id, event_geometry.event_id, 'radius'
    FROM event_geometry
    WHERE ST_DWithin(selected_watch.anchor::geography, event_geometry.geom::geography, 3000)
      AND ST_DWithin(
        selected_watch.anchor::geography,
        event_geometry.geom::geography,
        selected_watch.radius_m
      )
    ON CONFLICT (watch_id, event_id) DO NOTHING;
    GET DIAGNOSTICS inserted_radius = ROW_COUNT;
  END IF;

  RETURN inserted_exact + inserted_radius;
END;
$$;

CREATE OR REPLACE FUNCTION radar_recover_missing_projections(batch_limit integer DEFAULT 25)
RETURNS TABLE(import_id bigint, event_count integer, match_count integer)
LANGUAGE plpgsql
AS $$
DECLARE
  missing_import_id bigint;
BEGIN
  IF batch_limit < 1 OR batch_limit > 100 THEN
    RAISE EXCEPTION 'radar_recovery_batch_out_of_range';
  END IF;

  FOR missing_import_id IN
    SELECT imported.id
    FROM imports imported
    LEFT JOIN radar_import_projections projection ON projection.import_id = imported.id
    WHERE imported.status = 'success'
      AND imported.finished_at IS NOT NULL
      AND projection.import_id IS NULL
    ORDER BY imported.id
    LIMIT batch_limit
  LOOP
    RETURN QUERY
      SELECT missing_import_id, projected.event_count, projected.match_count
      FROM radar_project_import(missing_import_id) projected;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION radar_charge_global_rate(target_scope text, maximum_attempts integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  charged integer;
BEGIN
  IF target_scope NOT IN ('profile_create', 'monitor_create')
     OR maximum_attempts < 1 OR maximum_attempts > 1000000 THEN
    RAISE EXCEPTION 'radar_rate_limit_invalid';
  END IF;

  INSERT INTO radar_rate_windows(scope, window_started_at, attempts)
  VALUES(target_scope, date_trunc('hour', clock_timestamp()), 1)
  ON CONFLICT(scope) DO UPDATE SET
    window_started_at = CASE
      WHEN radar_rate_windows.window_started_at < date_trunc('hour', clock_timestamp())
        THEN date_trunc('hour', clock_timestamp())
      ELSE radar_rate_windows.window_started_at
    END,
    attempts = CASE
      WHEN radar_rate_windows.window_started_at < date_trunc('hour', clock_timestamp()) THEN 1
      ELSE radar_rate_windows.attempts + 1
    END
  RETURNING attempts INTO charged;

  IF charged > maximum_attempts THEN
    RAISE EXCEPTION 'radar_global_rate_limited';
  END IF;
  RETURN charged;
END;
$$;

CREATE OR REPLACE FUNCTION radar_purge_expired_profiles(batch_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_profiles integer;
BEGIN
  IF batch_limit < 1 OR batch_limit > 1000 THEN
    RAISE EXCEPTION 'radar_purge_batch_out_of_range';
  END IF;

  WITH doomed AS (
    SELECT id
    FROM radar_profiles
    WHERE inactive_expires_at <= clock_timestamp()
       OR absolute_expires_at <= clock_timestamp()
    ORDER BY least(inactive_expires_at, absolute_expires_at), id
    LIMIT batch_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM radar_profiles profile
  USING doomed
  WHERE profile.id = doomed.id;
  GET DIAGNOSTICS deleted_profiles = ROW_COUNT;
  RETURN deleted_profiles;
END;
$$;

INSERT INTO radar_import_projections(import_id, projection_kind, event_count, match_count)
SELECT id, 'baseline', NULL, NULL
FROM imports
WHERE status = 'success'
ON CONFLICT (import_id) DO NOTHING;
