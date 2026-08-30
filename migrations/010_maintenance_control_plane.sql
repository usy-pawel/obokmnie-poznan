CREATE TABLE IF NOT EXISTS maintenance_runs (
  id bigserial PRIMARY KEY,
  scope text NOT NULL DEFAULT 'radar_operations' CHECK (scope='radar_operations'),
  invocation_key text NOT NULL CHECK (
    char_length(invocation_key) BETWEEN 1 AND 128
    AND invocation_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  contract_version text NOT NULL CHECK (contract_version='radar_maintenance_control_v1'),
  context_hash text NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  executor text NOT NULL CHECK (
    char_length(executor) BETWEEN 1 AND 64
    AND executor ~ '^[A-Za-z0-9._:-]+$'
  ),
  fence bigint NOT NULL CHECK (fence > 0),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','succeeded','failed','timed_out','blocked')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  result_code text CHECK (result_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  receipt jsonb,
  UNIQUE (scope, invocation_key),
  UNIQUE (scope, fence),
  CHECK (deadline_at > started_at AND deadline_at <= started_at + interval '50 minutes'),
  CHECK (
    (status='running' AND finished_at IS NULL AND result_code IS NULL AND receipt IS NULL)
    OR (status<>'running' AND finished_at IS NOT NULL
      AND result_code IS NOT NULL AND receipt IS NOT NULL)
  ),
  CHECK (receipt IS NULL OR (
    (jsonb_typeof(receipt)='object') IS TRUE
    AND octet_length(receipt::text) <= 32768
  ))
);

CREATE TABLE IF NOT EXISTS maintenance_leases (
  scope text PRIMARY KEY CHECK (scope='radar_operations'),
  run_id bigint UNIQUE REFERENCES maintenance_runs(id),
  owner text CHECK (
    owner IS NULL OR (
      char_length(owner) BETWEEN 1 AND 64
      AND owner ~ '^[A-Za-z0-9._:-]+$'
    )
  ),
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  context_hash text CHECK (context_hash IS NULL OR context_hash ~ '^[0-9a-f]{64}$'),
  acquired_at timestamptz,
  heartbeat_at timestamptz,
  expires_at timestamptz,
  actions_disabled boolean NOT NULL DEFAULT true,
  CHECK (
    (run_id IS NULL AND owner IS NULL AND context_hash IS NULL
      AND acquired_at IS NULL AND heartbeat_at IS NULL AND expires_at IS NULL)
    OR
    (run_id IS NOT NULL AND owner IS NOT NULL AND context_hash IS NOT NULL
      AND acquired_at IS NOT NULL AND heartbeat_at IS NOT NULL AND expires_at IS NOT NULL)
  )
);

INSERT INTO maintenance_leases(scope, actions_disabled)
VALUES('radar_operations', true)
ON CONFLICT(scope) DO NOTHING;

CREATE TABLE IF NOT EXISTS maintenance_issues (
  id bigserial PRIMARY KEY,
  scope text NOT NULL DEFAULT 'radar_operations' CHECK (scope='radar_operations'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  capability text NOT NULL
    CHECK (capability IN ('web_database','daily_import','data_coverage','radar_diff')),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  severity text NOT NULL CHECK (severity IN ('P0','P1')),
  owner text NOT NULL CHECK (owner IN ('data_pipeline','radar_diff')),
  next_action_code text NOT NULL CHECK (next_action_code IN (
    'inspect_latest_import','run_import_preflight',
    'inspect_import_coverage','inspect_event_integrity'
  )),
  stable_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    (jsonb_typeof(stable_dimensions)='object') IS TRUE
    AND octet_length(stable_dimensions::text) <= 2048
  ),
  safe_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    (jsonb_typeof(safe_context)='object') IS TRUE
    AND octet_length(safe_context::text) <= 8192
  ),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  last_occurrence_run_id bigint NOT NULL REFERENCES maintenance_runs(id),
  last_observed_run_id bigint NOT NULL REFERENCES maintenance_runs(id),
  UNIQUE (scope, fingerprint),
  CHECK (
    (code='daily_import_failed' AND severity='P0'
      AND owner='data_pipeline' AND next_action_code='inspect_latest_import')
    OR (code='daily_import_stale' AND severity='P1'
      AND owner='data_pipeline' AND next_action_code='run_import_preflight')
    OR (code='invalid_data_coverage' AND severity='P0'
      AND owner='data_pipeline' AND next_action_code='inspect_import_coverage')
    OR (code='events_for_non_success_import' AND severity='P0'
      AND owner='radar_diff' AND next_action_code='inspect_event_integrity')
  ),
  CHECK (
    (status='open' AND resolved_at IS NULL)
    OR (status='resolved' AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS maintenance_runs_status_idx
  ON maintenance_runs(scope, status, started_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_issues_open_idx
  ON maintenance_issues(scope, capability, status) WHERE status='open';

CREATE OR REPLACE FUNCTION protect_maintenance_runs_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'maintenance_runs_history_is_append_only';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.scope IS DISTINCT FROM OLD.scope
      OR NEW.invocation_key IS DISTINCT FROM OLD.invocation_key
      OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
      OR NEW.context_hash IS DISTINCT FROM OLD.context_hash
      OR NEW.executor IS DISTINCT FROM OLD.executor
      OR NEW.fence IS DISTINCT FROM OLD.fence
      OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at THEN
    RAISE EXCEPTION 'maintenance_run_identity_is_immutable';
  END IF;

  IF OLD.status <> 'running' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal_maintenance_run_is_immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER maintenance_runs_protect_rows
BEFORE UPDATE OR DELETE ON maintenance_runs
FOR EACH ROW EXECUTE FUNCTION protect_maintenance_runs_history();

CREATE TRIGGER maintenance_runs_protect_truncate
BEFORE TRUNCATE ON maintenance_runs
FOR EACH STATEMENT EXECUTE FUNCTION protect_maintenance_runs_history();
