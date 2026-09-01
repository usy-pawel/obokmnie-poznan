import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { dispatchRadarAlerts } from '../lib/radar-alerts.mjs';

if (process.env.RADAR_TEST_DATABASE !== '1' || !process.env.DATABASE_URL) {
  throw new Error('test-radar-alerts wymaga izolowanej bazy');
}
const testUrl = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(testUrl.hostname)
    || !/^\/radar_test_[a-z0-9_]+$/.test(testUrl.pathname)) {
  throw new Error('Test alertów wymaga bazy radar_test_* dostępnej przez loopback');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 });
const profileId = randomUUID();
const workerA = randomUUID();
const workerB = randomUUID();
const environment = { RADAR_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' };
const emailFingerprint = randomBytes(32);

try {
  await pool.query('DELETE FROM radar_email_alerts');
  const selectedEvent = await pool.query(`
    SELECT event.id FROM case_events event
    JOIN imports imported ON imported.id=event.import_id AND imported.status='success'
    ORDER BY event.id LIMIT 2
  `);
  assert.equal(selectedEvent.rowCount, 2);
  await pool.query(`
    INSERT INTO radar_profiles(id,token_hash,csrf_hash,inactive_expires_at,absolute_expires_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '90 days',clock_timestamp()+interval '365 days')
  `, [profileId, randomBytes(32), randomBytes(32)]);
  await pool.query(`
    INSERT INTO radar_email_subscriptions(
      profile_id,email,email_fingerprint,state,
      service_consent_version,service_consent_text,service_consented_at,
      marketing_consent,marketing_consent_version,marketing_consent_text,
      confirmed_at
    ) VALUES(
      $1,'alert-test@example.com',$2,'active',
      'radar_service_alerts_pl_v1','Zgoda testowa.',clock_timestamp(),
      false,'radar_marketing_pl_v1','Zgoda marketingowa testowa.',
      clock_timestamp()
    )
  `, [profileId, emailFingerprint]);
  await pool.query(`
    INSERT INTO radar_email_alerts(profile_id,event_id)
    VALUES($1,$2)
  `, [profileId, selectedEvent.rows[0].id]);

  const messages = [];
  let attempt = 0;
  const sender = async (message) => {
    messages.push(message);
    attempt += 1;
    if (attempt === 1) {
      const error = new Error('provider detail must not be stored');
      error.code = 'mailjet_unavailable';
      error.retryable = true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { messageId: `message-${attempt}`, messageUuid: `uuid-${attempt}` };
  };

  const first = await dispatchRadarAlerts({ database: pool, mailSender: sender, environment, workerId: workerA });
  assert.deepEqual(first, { enabled: true, claimed: 1, sent: 0, retried: 1, failed: 0 });
  const queued = await pool.query(`
    SELECT state,attempt_count,last_error_code FROM radar_email_alerts WHERE profile_id=$1
  `, [profileId]);
  assert.deepEqual(queued.rows[0], {
    state: 'queued', attempt_count: 1, last_error_code: 'mailjet_unavailable',
  });
  assert.equal(JSON.stringify(queued.rows).includes('provider detail'), false);
  await pool.query(`
    UPDATE radar_email_alerts SET next_attempt_at=clock_timestamp() WHERE profile_id=$1
  `, [profileId]);

  const [parallelA, parallelB] = await Promise.all([
    dispatchRadarAlerts({ database: pool, mailSender: sender, environment, workerId: workerA }),
    dispatchRadarAlerts({ database: pool, mailSender: sender, environment, workerId: workerB }),
  ]);
  assert.equal(parallelA.sent + parallelB.sent, 1);
  assert.equal(parallelA.claimed + parallelB.claimed, 1);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].campaignId, messages[1].campaignId);

  const sent = await pool.query(`
    SELECT state,attempt_count,provider_message_id,provider_message_uuid,
           sent_at IS NOT NULL AS has_sent_at
    FROM radar_email_alerts WHERE profile_id=$1
  `, [profileId]);
  assert.deepEqual(sent.rows[0], {
    state: 'sent', attempt_count: 2, provider_message_id: 'message-2',
    provider_message_uuid: 'uuid-2', has_sent_at: true,
  });
  const replay = await dispatchRadarAlerts({ database: pool, mailSender: sender, environment, workerId: workerA });
  assert.equal(replay.claimed, 0);
  assert.equal(messages.length, 2);

  await pool.query(`
    INSERT INTO radar_email_alerts(profile_id,event_id) VALUES($1,$2)
  `, [profileId, selectedEvent.rows[1].id]);
  await pool.query('DELETE FROM radar_email_subscriptions WHERE profile_id=$1', [profileId]);
  const afterUnsubscribe = await pool.query(`
    SELECT state,last_error_code FROM radar_email_alerts
    WHERE profile_id=$1 ORDER BY event_id
  `, [profileId]);
  assert.deepEqual(afterUnsubscribe.rows, [
    { state: 'sent', last_error_code: null },
    { state: 'failed', last_error_code: 'subscription_inactive' },
  ]);
  await pool.query('DELETE FROM radar_email_suppressions WHERE email_fingerprint=$1', [emailFingerprint]);

  await pool.query(`
    UPDATE radar_email_alerts SET
      created_at=clock_timestamp()-interval '31 days',
      expires_at=clock_timestamp()-interval '1 second'
    WHERE profile_id=$1
  `, [profileId]);
  assert.equal((await pool.query('SELECT radar_purge_email_alerts(100) AS count')).rows[0].count, 2);

  console.log(JSON.stringify({
    ok: true, retry: true, parallel_claim: true, replay_safe: true, campaign_stable: true,
    unsubscribe_cancels_unsent: true, receipt_retained: true,
  }));
} finally {
  await pool.end();
}
