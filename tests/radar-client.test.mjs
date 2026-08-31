import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RadarApiError,
  cookieValue,
  createRadarClient,
  csrfFromCookies,
  emailSubscriptionBody,
  isRetryableRadarError,
  marketingPreferenceBody,
  monitorCreateBody,
  monitorIncludesParcel,
  monitorLabel,
  monitorTargetKey,
  radarErrorMessage,
  removeMonitorBackup,
  reusablePendingCreate,
} from '../public/radar-client.js';

function jsonResponse(status, body = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? {} : { 'Content-Type': 'application/json' },
  });
}

test('cookie helpers select the host cookie and never expose the profile secret', () => {
  const cookies = 'theme=light; __Host-radar_profile=secret; __Host-radar_csrf=csrf%2Dtoken';
  assert.equal(cookieValue(cookies, '__Host-radar_profile'), 'secret');
  assert.equal(csrfFromCookies(cookies), 'csrf-token');
  assert.equal(csrfFromCookies('radar_csrf=local-token'), 'local-token');
});

test('profile probe distinguishes disabled API from an unauthenticated profile', async () => {
  const disabled = createRadarClient({ fetchFn: async () => jsonResponse(404, { error: 'not_found' }) });
  assert.deepEqual(await disabled.probeProfile(), {
    available: false, authenticated: false, profile: null,
  });

  const available = createRadarClient({
    fetchFn: async () => jsonResponse(401, { error: 'profile_unavailable' }),
  });
  assert.deepEqual(await available.probeProfile(), {
    available: true, authenticated: false, profile: null,
  });
});

test('mutations send exact JSON, same-origin credentials and CSRF', async () => {
  const calls = [];
  const client = createRadarClient({
    cookieHeader: () => '__Host-radar_csrf=csrf-token; __Host-radar_profile=not-readable-by-js-in-browser',
    fetchFn: async (path, options) => {
      calls.push({ path, options });
      return jsonResponse(201, {
        version: 'radar_monitor_v1', monitor_id: 'monitor-id', status: 'active',
        target: { kind: 'parcel', parcel_id: 'A' },
      });
    },
  });
  const body = monitorCreateBody({ kind: 'parcel', parcel_id: 'A' }, {
    idempotencyKey: 'c7ee54c1-7610-4b3a-bb18-e0f60948a183',
  });
  await client.createMonitor(body);
  assert.equal(calls[0].path, '/api/radar/monitors');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers['X-Radar-CSRF'], 'csrf-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), body);
  assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)).sort(), [
    'idempotency_key', 'source', 'target', 'version',
  ]);
});

test('email subscription keeps service and optional marketing consent separate', async () => {
  assert.deepEqual(emailSubscriptionBody('user@example.com'), {
    version: 'radar_email_request_v1',
    email: 'user@example.com',
    service_consent: true,
    service_consent_version: 'radar_alerts_service_pl_v1',
    marketing_consent: false,
    marketing_consent_version: 'radar_marketing_pl_v1',
  });
  assert.equal(emailSubscriptionBody('user@example.com', { marketingConsent: true }).marketing_consent, true);
  assert.deepEqual(marketingPreferenceBody(false), {
    version: 'radar_email_request_v1', marketing_consent: false,
    marketing_consent_version: 'radar_marketing_pl_v1',
  });
});

test('email API methods use the existing session and confirmation is token-only', async () => {
  const calls = [];
  const client = createRadarClient({
    cookieHeader: () => 'radar_csrf=csrf-token',
    fetchFn: async (path, options) => {
      calls.push({ path, options });
      return jsonResponse(200, { version: 'radar_email_status_v1', state: 'active' });
    },
  });
  await client.requestEmail(emailSubscriptionBody('user@example.com'));
  await client.updateMarketingConsent(marketingPreferenceBody(false));
  await client.confirmEmail('x'.repeat(43));
  await client.deleteEmail();
  assert.deepEqual(calls.map(({ path }) => path), [
    '/api/radar/email', '/api/radar/email/marketing', '/api/radar/email/confirm', '/api/radar/email',
  ]);
  assert.equal(calls[0].options.headers['X-Radar-CSRF'], 'csrf-token');
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[1].options.headers['X-Radar-CSRF'], 'csrf-token');
  assert.equal(calls[2].options.headers['X-Radar-CSRF'], undefined);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    version: 'radar_email_confirm_v1', token: 'x'.repeat(43),
  });
  assert.equal(calls[3].options.method, 'DELETE');
});

test('local migration request includes its observed timestamp and stable key', () => {
  assert.deepEqual(monitorCreateBody({ kind: 'parcel', parcel_id: 'A' }, {
    idempotencyKey: 'c7ee54c1-7610-4b3a-bb18-e0f60948a183',
    source: 'local_storage_v1',
    observedSince: '2026-08-30T12:00:00.000Z',
  }), {
    version: 'radar_monitor_create_v1',
    idempotency_key: 'c7ee54c1-7610-4b3a-bb18-e0f60948a183',
    source: 'local_storage_v1',
    observed_since: '2026-08-30T12:00:00.000Z',
    target: { kind: 'parcel', parcel_id: 'A' },
  });
});

test('missing CSRF fails closed before a mutation reaches the network', async () => {
  let called = false;
  const client = createRadarClient({
    cookieHeader: () => '',
    fetchFn: async () => { called = true; return jsonResponse(204); },
  });
  await assert.rejects(() => client.deleteMonitor('monitor-id'), (error) => (
    error instanceof RadarApiError && error.status === 403 && error.code === 'csrf_invalid'
  ));
  assert.equal(called, false);
});

test('monitor presentation supports parcel, set and radius without private labels', () => {
  const parcel = { kind: 'parcel', parcel_id: 'A.12/3' };
  const set = { kind: 'parcel_set', parcel_ids: ['B', 'A'] };
  const radius = { kind: 'radius', lat: 52.4, lng: 16.9, radius_m: 1000 };
  assert.equal(monitorLabel(parcel), 'Działka A.12/3');
  assert.equal(monitorLabel(set), '2 działki');
  assert.equal(monitorLabel(radius), 'Obszar 1 km');
  assert.equal(monitorTargetKey(set), 'parcel_set:A|B');
  assert.equal(monitorIncludesParcel({ target: set }, 'B'), true);
  assert.equal(monitorIncludesParcel({ target: radius }, 'B'), false);
});

test('server error codes map to bounded Polish messages', () => {
  assert.match(radarErrorMessage(new RadarApiError(422, 'monitor_limit_reached')), /limit/);
  assert.match(radarErrorMessage(new RadarApiError(403, 'csrf_invalid')), /Odśwież/);
  assert.match(radarErrorMessage(new RadarApiError(400, 'confirmation_invalid')), /wygasł/);
  assert.doesNotMatch(radarErrorMessage(new Error('secret database detail')), /secret|database/);
  assert.equal(isRetryableRadarError(new TypeError('network')), true);
  assert.equal(isRetryableRadarError(new RadarApiError(503, 'database_unavailable')), true);
  assert.equal(isRetryableRadarError(new RadarApiError(422, 'parcel_not_found')), false);
  assert.equal(isRetryableRadarError(new RadarApiError(429, 'rate_limited')), false);
});

test('pending create reuses its key after response loss and deletion removes the fallback', () => {
  const target = { kind: 'parcel', parcel_id: 'A' };
  const first = reusablePendingCreate([], target, 'first-key');
  const replay = reusablePendingCreate([first], target, 'different-key');
  assert.equal(replay.idempotency_key, 'first-key');
  assert.deepEqual(removeMonitorBackup([
    { parcelId: 'A', serverMonitorId: 'removed' },
    { parcelId: 'B', serverMonitorId: 'kept' },
  ], 'removed'), [{ parcelId: 'B', serverMonitorId: 'kept' }]);
});
