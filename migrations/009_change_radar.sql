ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS source_fingerprint text,
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS case_events (
  id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  import_id bigint NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('new', 'changed', 'removed')),
  changed_fields text[] NOT NULL DEFAULT '{}',
  snapshot jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, import_id, event_type)
);

CREATE INDEX IF NOT EXISTS case_events_import_idx ON case_events (import_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS case_events_parcels_gin ON case_events USING gin ((snapshot->'parcel_ids'));

CREATE OR REPLACE FUNCTION record_case_event() RETURNS trigger AS $$
DECLARE
  active_import_id bigint := nullif(current_setting('obokmnie.import_id', true), '')::bigint;
  event_kind text;
  fields text[];
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

  INSERT INTO case_events(case_id, import_id, event_type, changed_fields, snapshot)
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
    )
  )
  ON CONFLICT (case_id, import_id, event_type) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cases_change_radar ON cases;
CREATE TRIGGER cases_change_radar
AFTER INSERT OR UPDATE ON cases
FOR EACH ROW EXECUTE FUNCTION record_case_event();
