CREATE TABLE radar_email_subscriptions (
  profile_id uuid PRIMARY KEY REFERENCES radar_profiles(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  email_fingerprint bytea NOT NULL UNIQUE CHECK (octet_length(email_fingerprint)=32),
  state text NOT NULL CHECK (state IN ('pending', 'active')),
  confirmation_token_hash bytea UNIQUE CHECK (confirmation_token_hash IS NULL OR octet_length(confirmation_token_hash)=32),
  confirmation_expires_at timestamptz,
  unconfirmed_delete_at timestamptz,
  resend_available_at timestamptz,
  service_consent_version text NOT NULL CHECK (length(service_consent_version) BETWEEN 1 AND 80),
  service_consent_text text NOT NULL CHECK (length(service_consent_text) BETWEEN 1 AND 500),
  service_consented_at timestamptz NOT NULL,
  marketing_consent boolean NOT NULL DEFAULT false,
  marketing_consent_version text NOT NULL CHECK (length(marketing_consent_version) BETWEEN 1 AND 80),
  marketing_consent_text text NOT NULL CHECK (length(marketing_consent_text) BETWEEN 1 AND 500),
  marketing_consented_at timestamptz,
  delivery_mode text NOT NULL DEFAULT 'immediate' CHECK (delivery_mode='immediate'),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (state='pending' AND confirmation_token_hash IS NOT NULL AND confirmation_expires_at IS NOT NULL
      AND unconfirmed_delete_at IS NOT NULL AND confirmed_at IS NULL)
    OR
    (state='active' AND confirmation_token_hash IS NULL AND confirmation_expires_at IS NULL
      AND unconfirmed_delete_at IS NULL AND confirmed_at IS NOT NULL)
  ),
  CHECK ((marketing_consent AND marketing_consented_at IS NOT NULL)
    OR (NOT marketing_consent AND marketing_consented_at IS NULL))
);

CREATE TABLE radar_email_suppressions (
  email_fingerprint bytea PRIMARY KEY CHECK (octet_length(email_fingerprint)=32),
  suppressed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at>suppressed_at)
);

CREATE TABLE radar_email_deliveries (
  id uuid PRIMARY KEY,
  profile_id uuid REFERENCES radar_profiles(id) ON DELETE SET NULL,
  custom_id text NOT NULL UNIQUE CHECK (length(custom_id) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind='confirmation'),
  provider_message_id text NOT NULL CHECK (provider_message_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  provider_message_uuid text NOT NULL CHECK (provider_message_uuid ~ '^[A-Za-z0-9_-]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '30 days'),
  CHECK (expires_at>created_at)
);

CREATE INDEX radar_email_subscriptions_pending_expiry_idx
  ON radar_email_subscriptions(unconfirmed_delete_at) WHERE state='pending';
CREATE INDEX radar_email_deliveries_expiry_idx ON radar_email_deliveries(expires_at);
CREATE INDEX radar_email_suppressions_expiry_idx ON radar_email_suppressions(expires_at);

CREATE OR REPLACE FUNCTION radar_suppress_removed_email()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO radar_email_suppressions(email_fingerprint,suppressed_at,expires_at)
  VALUES(OLD.email_fingerprint,clock_timestamp(),clock_timestamp()+interval '30 days')
  ON CONFLICT(email_fingerprint) DO UPDATE SET
    suppressed_at=excluded.suppressed_at,expires_at=excluded.expires_at;
  RETURN OLD;
END;
$$;

CREATE TRIGGER radar_email_subscription_suppress_delete
AFTER DELETE ON radar_email_subscriptions FOR EACH ROW EXECUTE FUNCTION radar_suppress_removed_email();
CREATE TRIGGER radar_email_subscription_suppress_change
AFTER UPDATE OF email_fingerprint ON radar_email_subscriptions
FOR EACH ROW WHEN (OLD.email_fingerprint IS DISTINCT FROM NEW.email_fingerprint)
EXECUTE FUNCTION radar_suppress_removed_email();

ALTER TABLE radar_rate_windows DROP CONSTRAINT radar_rate_windows_scope_check;
ALTER TABLE radar_rate_windows ADD CONSTRAINT radar_rate_windows_scope_check
  CHECK (scope IN ('profile_create', 'monitor_create', 'email_confirmation'));

CREATE OR REPLACE FUNCTION radar_charge_global_rate(target_scope text, maximum_attempts integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE charged integer;
BEGIN
  IF target_scope NOT IN ('profile_create', 'monitor_create', 'email_confirmation')
     OR maximum_attempts < 1 OR maximum_attempts > 1000000 THEN
    RAISE EXCEPTION 'radar_rate_limit_invalid';
  END IF;
  INSERT INTO radar_rate_windows(scope,window_started_at,attempts)
  VALUES(target_scope,date_trunc('hour',clock_timestamp()),1)
  ON CONFLICT(scope) DO UPDATE SET
    window_started_at=CASE
      WHEN radar_rate_windows.window_started_at<date_trunc('hour',clock_timestamp())
        THEN date_trunc('hour',clock_timestamp()) ELSE radar_rate_windows.window_started_at END,
    attempts=CASE
      WHEN radar_rate_windows.window_started_at<date_trunc('hour',clock_timestamp()) THEN 1
      ELSE radar_rate_windows.attempts+1 END
  RETURNING attempts INTO charged;
  IF charged>maximum_attempts THEN RAISE EXCEPTION 'radar_global_rate_limited'; END IF;
  RETURN charged;
END;
$$;

CREATE OR REPLACE FUNCTION radar_purge_email_data(batch_limit integer DEFAULT 1000)
RETURNS TABLE(pending_subscriptions integer, deliveries integer, suppressions integer)
LANGUAGE plpgsql AS $$
BEGIN
  IF batch_limit < 1 OR batch_limit > 1000 THEN RAISE EXCEPTION 'radar_purge_batch_out_of_range'; END IF;
  WITH doomed AS (
    SELECT profile_id FROM radar_email_subscriptions
    WHERE state='pending' AND unconfirmed_delete_at<=clock_timestamp()
    ORDER BY unconfirmed_delete_at,profile_id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM radar_email_subscriptions subscription USING doomed
    WHERE subscription.profile_id=doomed.profile_id RETURNING 1
  ) SELECT count(*)::integer INTO pending_subscriptions FROM removed;
  WITH doomed AS (
    SELECT id FROM radar_email_deliveries WHERE expires_at<=clock_timestamp()
    ORDER BY expires_at,id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM radar_email_deliveries delivery USING doomed
    WHERE delivery.id=doomed.id RETURNING 1
  ) SELECT count(*)::integer INTO deliveries FROM removed;
  WITH doomed AS (
    SELECT email_fingerprint FROM radar_email_suppressions WHERE expires_at<=clock_timestamp()
    ORDER BY expires_at,email_fingerprint LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM radar_email_suppressions suppression USING doomed
    WHERE suppression.email_fingerprint=doomed.email_fingerprint RETURNING 1
  ) SELECT count(*)::integer INTO suppressions FROM removed;
  RETURN NEXT;
END;
$$;
