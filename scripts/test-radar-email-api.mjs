import assert from 'node:assert/strict';
import express from 'express';
import net from 'node:net';
import pg from 'pg';
import { createRadarSubscriptionsRouter } from '../lib/radar-subscriptions.mjs';
import {
  RADAR_EMAIL_CONFIRM_VERSION,
  RADAR_EMAIL_REQUEST_VERSION,
  RADAR_MARKETING_CONSENT_VERSION,
  RADAR_SERVICE_CONSENT_VERSION,
} from '../lib/radar-email.mjs';

if (process.env.RADAR_TEST_DATABASE !== '1' || !process.env.DATABASE_URL) {
  throw new Error('test-radar-email-api wymaga izolowanej bazy');
}
const testUrl = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(testUrl.hostname)
    || !/^\/radar_test_[a-z0-9_]+$/.test(testUrl.pathname)) {
  throw new Error('Test e-mail wymaga bazy radar_test_* dostępnej przez loopback');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function cookiesFrom(response) {
  const result = new Map();
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(';');
    const separator = pair.indexOf('=');
    result.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return result;
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 });
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const environment = {
  RADAR_ALLOWED_ORIGINS: origin,
  RADAR_SECURE_COOKIES: 'false',
  RADAR_EMAIL_HASH_KEY: Buffer.alloc(32, 11).toString('base64url'),
  RADAR_PUBLIC_ORIGIN: origin,
};
const captured = [];
const mailSender = async (message) => {
  if (message.to.startsWith('fail@')) throw new Error('provider details must stay private');
  captured.push(message);
  return { messageId: `id-${captured.length}`, messageUuid: `uuid-${captured.length}` };
};
const app = express();
app.use('/api/radar', createRadarSubscriptionsRouter({ database: pool, environment, mailSender }));
app.use((_error, _request, response, _next) => response.status(500).json({ error: 'internal_error' }));
const server = await new Promise((resolve, reject) => {
  const listening = app.listen(port, '127.0.0.1', () => resolve(listening));
  listening.once('error', reject);
});

async function api(path, { method = 'GET', cookies, csrf, body } = {}) {
  const headers = { Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  if (cookies) headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  if (csrf) headers['X-Radar-CSRF'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${origin}/api/radar${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: response.status === 204 ? null : await response.json() };
}

function emailBody(email, marketing = false) {
  return {
    version: RADAR_EMAIL_REQUEST_VERSION,
    email,
    service_consent: true,
    service_consent_version: RADAR_SERVICE_CONSENT_VERSION,
    marketing_consent: marketing,
    marketing_consent_version: RADAR_MARKETING_CONSENT_VERSION,
  };
}

function marketingBody(marketing) {
  return {
    version: RADAR_EMAIL_REQUEST_VERSION,
    marketing_consent: marketing,
    marketing_consent_version: RADAR_MARKETING_CONSENT_VERSION,
  };
}

async function profile() {
  const created = await api('/profile', { method: 'POST', body: {} });
  assert.equal(created.response.status, 201);
  const cookies = cookiesFrom(created.response);
  return { cookies, csrf: cookies.get('radar_csrf') };
}

try {
  await pool.query("DELETE FROM radar_rate_windows WHERE scope='email_confirmation'");
  const first = await profile();
  assert.deepEqual((await api('/email', { cookies: first.cookies })).payload, {
    version: 'radar_email_status_v1', state: 'none', confirmation_available: true,
  });

  const invalidConsent = await api('/email', {
    method: 'POST', cookies: first.cookies, csrf: first.csrf,
    body: { ...emailBody('owner@example.com'), service_consent: false },
  });
  assert.equal(invalidConsent.response.status, 400);

  const requested = await api('/email', {
    method: 'POST', cookies: first.cookies, csrf: first.csrf, body: emailBody('Owner@Example.com'),
  });
  assert.equal(requested.response.status, 202);
  assert.equal(captured.length, 1);
  const stored = await pool.query(`
    SELECT state,email,octet_length(email_fingerprint)::integer AS fingerprint_bytes,
           octet_length(confirmation_token_hash)::integer AS token_bytes,
           extract(epoch FROM confirmation_expires_at-requested_at)::integer AS token_lifetime_seconds,
           extract(epoch FROM unconfirmed_delete_at-requested_at)::integer AS pending_lifetime_seconds,
           marketing_consent
    FROM radar_email_subscriptions WHERE email='owner@example.com'
  `);
  assert.equal(stored.rows[0].state, 'pending');
  assert.equal(stored.rows[0].fingerprint_bytes, 32);
  assert.equal(stored.rows[0].token_bytes, 32);
  assert.equal(stored.rows[0].token_lifetime_seconds, 86_400);
  assert.equal(stored.rows[0].pending_lifetime_seconds, 604_800);
  assert.equal(stored.rows[0].marketing_consent, false);

  const pendingStatus = await api('/email', { cookies: first.cookies });
  assert.equal(pendingStatus.payload.state, 'pending');
  assert.equal(pendingStatus.payload.masked_email, 'o***@example.com');
  assert.equal(JSON.stringify(pendingStatus.payload).includes('owner@example.com'), false);

  const throttledResend = await api('/email', {
    method: 'POST', cookies: first.cookies, csrf: first.csrf, body: emailBody('owner@example.com'),
  });
  assert.equal(throttledResend.response.status, 202);
  assert.equal(captured.length, 1);

  const token = captured[0].text.match(/#token=([A-Za-z0-9_-]{43})/u)?.[1];
  assert.ok(token);
  assert.equal(JSON.stringify(stored.rows).includes(token), false);
  const wrong = await api('/email/confirm', {
    method: 'POST', body: { version: RADAR_EMAIL_CONFIRM_VERSION, token: 'x'.repeat(43) },
  });
  assert.equal(wrong.response.status, 400);
  const confirmed = await api('/email/confirm', {
    method: 'POST', body: { version: RADAR_EMAIL_CONFIRM_VERSION, token },
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.payload.state, 'active');
  assert.equal((await api('/email/confirm', {
    method: 'POST', body: { version: RADAR_EMAIL_CONFIRM_VERSION, token },
  })).response.status, 400);
  assert.equal((await api('/email', { cookies: first.cookies })).payload.state, 'active');

  const marketingEnabled = await api('/email/marketing', {
    method: 'PUT', cookies: first.cookies, csrf: first.csrf, body: marketingBody(true),
  });
  assert.equal(marketingEnabled.response.status, 200);
  assert.equal(marketingEnabled.payload.marketing_consent, true);
  const marketingWithdrawn = await api('/email/marketing', {
    method: 'PUT', cookies: first.cookies, csrf: first.csrf, body: marketingBody(false),
  });
  assert.equal(marketingWithdrawn.response.status, 200);
  assert.equal(marketingWithdrawn.payload.marketing_consent, false);

  const changed = await api('/email', {
    method: 'POST', cookies: first.cookies, csrf: first.csrf, body: emailBody('new@example.com', true),
  });
  assert.equal(changed.response.status, 202);
  assert.equal(captured.length, 2);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM radar_email_suppressions')).rows[0].count, 1);

  const second = await profile();
  const duplicate = await api('/email', {
    method: 'POST', cookies: second.cookies, csrf: second.csrf, body: emailBody('new@example.com'),
  });
  assert.equal(duplicate.response.status, 202);
  assert.equal(captured.length, 2);

  await pool.query(`
    UPDATE radar_email_subscriptions SET confirmation_expires_at=clock_timestamp()-interval '1 second'
    WHERE email='new@example.com'
  `);
  const changedToken = captured[1].text.match(/#token=([A-Za-z0-9_-]{43})/u)?.[1];
  assert.equal((await api('/email/confirm', {
    method: 'POST', body: { version: RADAR_EMAIL_CONFIRM_VERSION, token: changedToken },
  })).response.status, 400);

  const third = await profile();
  const failedDelivery = await api('/email', {
    method: 'POST', cookies: third.cookies, csrf: third.csrf, body: emailBody('fail@example.com'),
  });
  assert.equal(failedDelivery.response.status, 202);
  const failedState = await pool.query(`
    SELECT resend_available_at<=clock_timestamp() AS retry_available
    FROM radar_email_subscriptions WHERE email='fail@example.com'
  `);
  assert.equal(failedState.rows[0].retry_available, true);

  const expiredProfile = await profile();
  await api('/email', {
    method: 'POST', cookies: expiredProfile.cookies, csrf: expiredProfile.csrf,
    body: emailBody('expired-profile@example.com'),
  });
  const expiredProfileToken = captured[2].text.match(/#token=([A-Za-z0-9_-]{43})/u)?.[1];
  await pool.query(`
    UPDATE radar_profiles SET
      created_at=clock_timestamp()-interval '2 days',
      inactive_expires_at=clock_timestamp()-interval '1 day',
      absolute_expires_at=clock_timestamp()+interval '300 days'
    WHERE id=(SELECT profile_id FROM radar_email_subscriptions WHERE email='expired-profile@example.com')
  `);
  assert.equal((await api('/email/confirm', {
    method: 'POST', body: { version: RADAR_EMAIL_CONFIRM_VERSION, token: expiredProfileToken },
  })).response.status, 400);

  const removed = await api('/email', {
    method: 'DELETE', cookies: first.cookies, csrf: first.csrf, body: {},
  });
  assert.equal(removed.response.status, 204);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM radar_email_subscriptions WHERE email='new@example.com'")).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM radar_email_deliveries')).rows[0].count, 3);
  const columns = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='radar_email_deliveries' ORDER BY column_name
  `);
  assert.equal(columns.rows.some(({ column_name }) => ['email', 'body', 'subject'].includes(column_name)), false);

  console.log(JSON.stringify({
    ok: true, double_opt_in: true, expiry: true, replay_blocked: true,
    email_change: true, consent_separated: true, provider_isolated: true,
  }));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
