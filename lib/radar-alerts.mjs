import { randomUUID } from 'node:crypto';
import { radarPublicOrigin } from './radar-email.mjs';

export const RADAR_ALERT_CONTENT_VERSION = 'radar_alert_v1';

const EVENT_LABELS = Object.freeze({
  new: 'Nowa sprawa',
  changed: 'Zmiana w sprawie',
  removed: 'Sprawa usunięta ze źródła',
});
const FIELD_LABELS = Object.freeze({
  received_date: 'data wpływu',
  decision_date: 'data decyzji',
  status: 'status',
  office: 'urząd',
  voivodeship: 'województwo',
  city: 'miejscowość',
  address: 'adres',
  case_kind: 'rodzaj sprawy',
  description: 'opis',
  parcel_ids: 'działki',
  source_active: 'obecność w źródle',
  case: 'nowa sprawa',
});
const MAX_ATTEMPTS = 3;
const RETRY_SECONDS = Object.freeze([60, 300, 900]);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function boundedText(value, maximum) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function safeErrorCode(error) {
  const candidate = typeof error?.code === 'string' ? error.code : 'provider_unavailable';
  return /^[a-z][a-z0-9_]{0,79}$/u.test(candidate) ? candidate : 'provider_unavailable';
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function alertMessage(alert, environment = process.env) {
  const alertId = String(alert?.alertId || '');
  const eventId = String(alert?.eventId || '');
  const email = boundedText(alert?.email, 254).toLowerCase();
  const eventType = String(alert?.eventType || '');
  const contentVersion = String(alert?.contentVersion || '');
  const snapshot = alert?.snapshot && typeof alert.snapshot === 'object' && !Array.isArray(alert.snapshot)
    ? alert.snapshot : {};
  const caseKey = boundedText(snapshot.case_key, 200);
  if (!/^\d{1,19}$/u.test(alertId) || !/^\d{1,19}$/u.test(eventId)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
      || !Object.hasOwn(EVENT_LABELS, eventType)
      || contentVersion !== RADAR_ALERT_CONTENT_VERSION
      || !caseKey || /[\u0000-\u001f]/u.test(caseKey)) {
    throw new Error('radar_alert_message_invalid');
  }

  const origin = radarPublicOrigin(environment);
  const caseUrl = `${origin}/sprawa/${encodeURIComponent(caseKey)}`;
  const manageUrl = `${origin}/?radar=1`;
  const location = boundedText(snapshot.address, 160)
    || boundedText(snapshot.city, 120)
    || 'obserwowanej lokalizacji';
  const changed = Array.isArray(alert.changedFields)
    ? [...new Set(alert.changedFields
      .filter((field) => typeof field === 'string')
      .map((field) => FIELD_LABELS[field] || '')
      .filter(Boolean))].slice(0, 10)
    : [];
  const eventLabel = EVENT_LABELS[eventType];
  const changeLine = changed.length ? `Zmieniły się: ${changed.join(', ')}.` : '';
  const subject = `${eventLabel}: ${location}`.slice(0, 160);
  const text = [
    `${eventLabel} w ${location}.`,
    changeLine,
    '',
    `Zobacz sprawę: ${caseUrl}`,
    `Zarządzaj monitoringiem: ${manageUrl}`,
    '',
    'RadarZmian.pl powiadamia wyłącznie o miejscach, które obserwujesz.',
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
  const html = [
    `<p><strong>${escapeHtml(eventLabel)}</strong> w ${escapeHtml(location)}.</p>`,
    changeLine ? `<p>${escapeHtml(changeLine)}</p>` : '',
    `<p><a href="${escapeHtml(caseUrl)}">Zobacz sprawę</a></p>`,
    `<p><a href="${escapeHtml(manageUrl)}">Zarządzaj monitoringiem</a></p>`,
    '<p>RadarZmian.pl powiadamia wyłącznie o miejscach, które obserwujesz.</p>',
  ].filter(Boolean).join('');

  return Object.freeze({
    to: email,
    subject,
    text,
    html,
    customId: `alert:${alertId}:${contentVersion}`,
    campaignId: `rza_${contentVersion}_${eventId}`,
  });
}

async function claimAlerts(database, workerId, batchSize, claimTimeoutMinutes) {
  const result = await database.query(`
    WITH candidates AS (
      SELECT alert.id
      FROM radar_email_alerts alert
      JOIN radar_email_subscriptions subscription
        ON subscription.profile_id=alert.profile_id AND subscription.state='active'
      JOIN radar_profiles profile ON profile.id=alert.profile_id
        AND profile.inactive_expires_at>clock_timestamp()
        AND profile.absolute_expires_at>clock_timestamp()
      WHERE alert.expires_at>clock_timestamp()
        AND (
          (alert.state='queued' AND alert.next_attempt_at<=clock_timestamp())
          OR
          (alert.state='sending'
            AND alert.claimed_at<=clock_timestamp()-($3::integer * interval '1 minute'))
        )
      ORDER BY alert.next_attempt_at,alert.id
      LIMIT $2
      FOR UPDATE OF alert,subscription SKIP LOCKED
    ), claimed AS (
      UPDATE radar_email_alerts alert SET
        state='sending',attempt_count=alert.attempt_count+1,
        claimed_at=clock_timestamp(),worker_key=$1,last_error_code=NULL,
        updated_at=clock_timestamp()
      FROM candidates
      WHERE alert.id=candidates.id
      RETURNING alert.id,alert.profile_id,alert.event_id,alert.content_version,
                alert.attempt_count
    )
    SELECT claimed.id::text AS alert_id,claimed.event_id::text AS event_id,
           claimed.content_version,claimed.attempt_count,subscription.email,
           event.event_type,event.changed_fields,event.snapshot
    FROM claimed
    JOIN radar_email_subscriptions subscription
      ON subscription.profile_id=claimed.profile_id AND subscription.state='active'
    JOIN case_events event ON event.id=claimed.event_id
    ORDER BY claimed.id
  `, [workerId, batchSize, claimTimeoutMinutes]);
  return result.rows;
}

async function markSent(database, alertId, workerId, receipt) {
  const result = await database.query(`
    UPDATE radar_email_alerts SET
      state='sent',claimed_at=NULL,worker_key=NULL,last_error_code=NULL,
      provider_message_id=$3,provider_message_uuid=$4,
      sent_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=$1 AND state='sending' AND worker_key=$2
  `, [alertId, workerId, receipt.messageId, receipt.messageUuid]);
  return result.rowCount === 1;
}

async function markFailed(database, row, workerId, error) {
  const retry = error?.retryable === true && row.attempt_count < MAX_ATTEMPTS;
  const delay = RETRY_SECONDS[Math.min(row.attempt_count - 1, RETRY_SECONDS.length - 1)];
  const result = await database.query(`
    UPDATE radar_email_alerts SET
      state=$3,claimed_at=NULL,worker_key=NULL,last_error_code=$4,
      next_attempt_at=CASE WHEN $3='queued'
        THEN clock_timestamp()+($5::double precision * interval '1 second')
        ELSE next_attempt_at END,
      updated_at=clock_timestamp()
    WHERE id=$1 AND state='sending' AND worker_key=$2
  `, [row.alert_id, workerId, retry ? 'queued' : 'failed', safeErrorCode(error), delay]);
  return result.rowCount === 1 ? (retry ? 'retried' : 'failed') : 'lost';
}

export async function dispatchRadarAlerts({
  database,
  mailSender,
  environment = process.env,
  batchSize = 25,
  claimTimeoutMinutes = 15,
  workerId = randomUUID(),
} = {}) {
  if (!database || typeof database.query !== 'function') throw new Error('radar_alert_database_invalid');
  if (typeof mailSender !== 'function') {
    return Object.freeze({ enabled: false, claimed: 0, sent: 0, retried: 0, failed: 0 });
  }
  const boundedBatch = positiveInteger(batchSize, 25, 1, 100);
  const boundedClaimTimeout = positiveInteger(claimTimeoutMinutes, 15, 1, 60);
  if (!/^[0-9a-f-]{36}$/u.test(workerId)) throw new Error('radar_alert_worker_invalid');

  const claimed = await claimAlerts(database, workerId, boundedBatch, boundedClaimTimeout);
  let sent = 0;
  let retried = 0;
  let failed = 0;
  for (const row of claimed) {
    try {
      const receipt = await mailSender(alertMessage({
        alertId: row.alert_id,
        eventId: row.event_id,
        email: row.email,
        eventType: row.event_type,
        changedFields: row.changed_fields,
        snapshot: row.snapshot,
        contentVersion: row.content_version,
      }, environment));
      if (await markSent(database, row.alert_id, workerId, receipt)) sent += 1;
    } catch (error) {
      const outcome = await markFailed(database, row, workerId, error);
      if (outcome === 'retried') retried += 1;
      if (outcome === 'failed') failed += 1;
    }
  }
  return Object.freeze({ enabled: true, claimed: claimed.length, sent, retried, failed });
}

export function startRadarAlertDispatcher({
  database,
  mailSender,
  environment = process.env,
  onError = () => {},
} = {}) {
  if (!database || typeof mailSender !== 'function') return () => {};
  const intervalMs = positiveInteger(
    environment.RADAR_EMAIL_DISPATCH_INTERVAL_MS, 30_000, 5_000, 300_000,
  );
  let stopped = false;
  let timer;
  const schedule = (delay) => {
    timer = setTimeout(async () => {
      try {
        await dispatchRadarAlerts({ database, mailSender, environment });
      } catch {
        onError({ code: 'radar_alert_dispatch_failed' });
      } finally {
        if (!stopped) schedule(intervalMs);
      }
    }, delay);
    timer.unref?.();
  };
  schedule(1_000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
