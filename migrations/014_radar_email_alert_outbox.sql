SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE radar_email_alerts (
  id bigserial PRIMARY KEY,
  profile_id uuid REFERENCES radar_profiles(id) ON DELETE SET NULL,
  event_id bigint NOT NULL REFERENCES case_events(id) ON DELETE CASCADE,
  content_version text NOT NULL DEFAULT 'radar_alert_v1'
    CHECK (content_version = 'radar_alert_v1'),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'sending', 'sent', 'failed')),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  worker_key uuid,
  last_error_code text CHECK (
    last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80
  ),
  provider_message_id text CHECK (
    provider_message_id IS NULL OR provider_message_id ~ '^[A-Za-z0-9_-]{1,100}$'
  ),
  provider_message_uuid text CHECK (
    provider_message_uuid IS NULL OR provider_message_uuid ~ '^[A-Za-z0-9_-]{1,100}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '30 days'),
  UNIQUE (profile_id, event_id, content_version),
  CHECK (expires_at > created_at),
  CHECK (
    (state = 'sending' AND claimed_at IS NOT NULL AND worker_key IS NOT NULL
      AND sent_at IS NULL AND provider_message_id IS NULL AND provider_message_uuid IS NULL)
    OR
    (state = 'sent' AND claimed_at IS NULL AND worker_key IS NULL
      AND sent_at IS NOT NULL AND provider_message_id IS NOT NULL
      AND provider_message_uuid IS NOT NULL)
    OR
    (state IN ('queued', 'failed') AND claimed_at IS NULL AND worker_key IS NULL
      AND sent_at IS NULL AND provider_message_id IS NULL AND provider_message_uuid IS NULL)
  )
);

CREATE INDEX radar_email_alerts_queue_idx
  ON radar_email_alerts(next_attempt_at, id) WHERE state = 'queued';
CREATE INDEX radar_email_alerts_stale_claim_idx
  ON radar_email_alerts(claimed_at, id) WHERE state = 'sending';
CREATE INDEX radar_email_alerts_expiry_idx ON radar_email_alerts(expires_at, id);

CREATE OR REPLACE FUNCTION radar_enqueue_projected_import_alerts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.projection_kind <> 'projected' OR coalesce(NEW.match_count, 0) = 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO radar_email_alerts(profile_id, event_id, content_version)
  SELECT DISTINCT subscription.profile_id, event.id, 'radar_alert_v1'
  FROM radar_matches match
  JOIN radar_watches watch ON watch.id = match.watch_id AND watch.state = 'active'
  JOIN case_events event ON event.id = match.event_id AND event.import_id = NEW.import_id
  JOIN imports imported ON imported.id = event.import_id
    AND imported.status = 'success' AND imported.finished_at IS NOT NULL
  JOIN radar_email_subscriptions subscription ON subscription.profile_id = watch.profile_id
    AND subscription.state = 'active'
  JOIN radar_profiles profile ON profile.id = subscription.profile_id
    AND profile.inactive_expires_at > imported.finished_at
    AND profile.absolute_expires_at > imported.finished_at
  ON CONFLICT (profile_id, event_id, content_version) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_import_projection_enqueue_email_alerts
AFTER INSERT ON radar_import_projections
FOR EACH ROW EXECUTE FUNCTION radar_enqueue_projected_import_alerts();

CREATE OR REPLACE FUNCTION radar_cancel_unsent_email_alerts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_profile_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.profile_id ELSE NEW.profile_id END;
BEGIN
  UPDATE radar_email_alerts SET
    state='failed',claimed_at=NULL,worker_key=NULL,
    last_error_code='subscription_inactive',updated_at=clock_timestamp()
  WHERE profile_id=target_profile_id AND state IN ('queued', 'sending');
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radar_email_subscription_cancel_alerts_on_delete
AFTER DELETE ON radar_email_subscriptions
FOR EACH ROW EXECUTE FUNCTION radar_cancel_unsent_email_alerts();

CREATE TRIGGER radar_email_subscription_cancel_alerts_on_change
AFTER UPDATE OF state, email_fingerprint ON radar_email_subscriptions
FOR EACH ROW
WHEN (OLD.state = 'active' AND (
  NEW.state <> 'active' OR OLD.email_fingerprint IS DISTINCT FROM NEW.email_fingerprint
))
EXECUTE FUNCTION radar_cancel_unsent_email_alerts();

CREATE OR REPLACE FUNCTION radar_purge_email_alerts(batch_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_alerts integer;
BEGIN
  IF batch_limit < 1 OR batch_limit > 1000 THEN
    RAISE EXCEPTION 'radar_purge_batch_out_of_range';
  END IF;

  WITH doomed AS (
    SELECT id
    FROM radar_email_alerts
    WHERE expires_at <= clock_timestamp()
    ORDER BY expires_at, id
    LIMIT batch_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM radar_email_alerts alert
  USING doomed
  WHERE alert.id = doomed.id;
  GET DIAGNOSTICS deleted_alerts = ROW_COUNT;
  RETURN deleted_alerts;
END;
$$;
