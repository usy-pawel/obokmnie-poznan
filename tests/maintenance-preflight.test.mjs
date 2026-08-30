import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMaintenancePreflight,
  collectMaintenancePreflight,
  DATA_STATUS_UNAVAILABLE,
  DATABASE_UNAVAILABLE,
  maintenanceReceipt,
  MAX_PREFLIGHT_BYTES,
  PREFLIGHT_VERSION,
  RECEIPT_VERSION,
} from '../lib/maintenance-preflight.mjs';

const NOW = new Date('2026-08-30T12:00:00.000Z');

function dataStatus(status = 'healthy') {
  return {
    status,
    latest: {
      id: '42',
      status: status === 'updating' ? 'running' : 'success',
      started_at: '2026-08-30T09:00:00.000Z',
      finished_at: status === 'updating' ? null : '2026-08-30T10:00:00.000Z',
      period_start: '2025-08-30',
      period_end: '2026-08-30',
      metrics: { published_cases: 123, unsafe_note: 'person@example.com' },
      error: 'postgres://user:password@host/database',
    },
    last_success: {
      id: '42',
      status: 'success',
      started_at: '2026-08-30T09:00:00.000Z',
      finished_at: '2026-08-30T10:00:00.000Z',
      period_start: '2025-08-30',
      period_end: '2026-08-30',
      metrics: { published_cases: 123 },
    },
  };
}

test('preflight has a stable versioned, bounded and redacted paper-mode contract', () => {
  const input = {
    health: { ok: true, database: true, configured: true },
    dataStatus: dataStatus(),
    now: NOW,
  };
  const preflight = buildMaintenancePreflight(input);
  const repeatedObservation = buildMaintenancePreflight(input);

  assert.equal(preflight.version, PREFLIGHT_VERSION);
  assert.equal(preflight.ok, true);
  assert.equal(preflight.code, null);
  assert.deepEqual(preflight.autonomy, { mode: 'paper', mutations_allowed: false });
  assert.equal(preflight.context_hash, repeatedObservation.context_hash);
  assert.ok(Buffer.byteLength(JSON.stringify(preflight), 'utf8') <= MAX_PREFLIGHT_BYTES);
  assert.equal(preflight.daily_import.latest.metrics.published_cases, 123);
  assert.equal('unsafe_note' in preflight.daily_import.latest.metrics, false);
  assert.doesNotMatch(JSON.stringify(preflight), /person@example\.com|password|postgres:/);
  assert.throws(
    () => buildMaintenancePreflight({ ...input, maxBytes: 1 }),
    (error) => error.code === 'preflight_payload_too_large',
  );
});

test('preflight emits database_unavailable when public database readiness fails', () => {
  const preflight = buildMaintenancePreflight({
    health: { ok: false, database: false, configured: true, code: DATABASE_UNAVAILABLE },
    dataStatus: { status: 'failed', code: DATABASE_UNAVAILABLE },
    now: NOW,
  });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.code, DATABASE_UNAVAILABLE);
  assert.deepEqual(preflight.missing_capabilities, ['web_database', 'daily_import']);
  assert.deepEqual(preflight.selected_issue, {
    severity: 'P1',
    code: DATABASE_UNAVAILABLE,
    owner: 'engineer',
  });
});

test('collector reads only public health endpoints and returns a local receipt payload', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url.pathname);
    const body = url.pathname === '/health'
      ? { ok: true, database: true, configured: true }
      : dataStatus('updating');
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const preflight = await collectMaintenancePreflight({
    baseUrl: 'http://localhost:3000/private/path',
    fetchImpl,
    now: NOW,
    allowLocalhost: true,
  });
  const receipt = maintenanceReceipt(preflight, NOW);

  assert.deepEqual(requested.sort(), ['/api/data-status', '/health']);
  assert.equal(preflight.daily_import.status, 'updating');
  assert.equal(receipt.version, RECEIPT_VERSION);
  assert.equal(receipt.preflight.context_hash, preflight.context_hash);
  assert.doesNotMatch(JSON.stringify(receipt), /localhost|private\/path/);
});

test('collector converts transport and payload failures into database_unavailable', async () => {
  const transportFailure = await collectMaintenancePreflight({
    baseUrl: 'https://example.invalid',
    allowedOrigins: ['https://example.invalid'],
    fetchImpl: async () => { throw new Error('token=secret'); },
    now: NOW,
  });
  assert.equal(transportFailure.code, DATABASE_UNAVAILABLE);
  assert.doesNotMatch(JSON.stringify(transportFailure), /token=secret/);

  const oversized = await collectMaintenancePreflight({
    baseUrl: 'https://example.invalid',
    allowedOrigins: ['https://example.invalid'],
    fetchImpl: async () => new Response(JSON.stringify({ padding: 'x'.repeat(1_000) })),
    now: NOW,
    maxBytes: 768,
  });
  assert.equal(oversized.code, DATABASE_UNAVAILABLE);
});

test('collector rejects untrusted origins and redirects', async () => {
  let requested = false;
  await assert.rejects(
    collectMaintenancePreflight({
      baseUrl: 'http://169.254.169.254:8080',
      fetchImpl: async () => { requested = true; },
      now: NOW,
    }),
    /base_url_not_allowed/,
  );
  assert.equal(requested, false);

  const redirects = [];
  await collectMaintenancePreflight({
    baseUrl: 'https://example.invalid',
    allowedOrigins: ['https://example.invalid'],
    fetchImpl: async (_url, options) => {
      redirects.push(options.redirect);
      throw new Error('redirect blocked');
    },
    now: NOW,
  });
  assert.deepEqual(redirects, ['error', 'error']);
});

test('collector preserves healthy database evidence when only data status fails', async () => {
  const preflight = await collectMaintenancePreflight({
    baseUrl: 'https://example.invalid',
    allowedOrigins: ['https://example.invalid'],
    fetchImpl: async (url) => {
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ ok: true, database: true, configured: true }));
      }
      throw new Error('invalid status payload');
    },
    now: NOW,
  });
  assert.equal(preflight.code, DATA_STATUS_UNAVAILABLE);
  assert.deepEqual(preflight.database, { configured: true, reachable: true });
  assert.deepEqual(preflight.missing_capabilities, ['daily_import']);
});

test('collector rejects JSON error pages and unsupported HTTP statuses', async () => {
  const preflight = await collectMaintenancePreflight({
    baseUrl: 'https://example.invalid',
    allowedOrigins: ['https://example.invalid'],
    fetchImpl: async (url) => {
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ ok: true, database: true, configured: true }));
      }
      return new Response(JSON.stringify({ error: 'bad_gateway' }), { status: 502 });
    },
    now: NOW,
  });
  assert.equal(preflight.code, DATA_STATUS_UNAVAILABLE);
  assert.deepEqual(preflight.database, { configured: true, reachable: true });
  assert.deepEqual(preflight.missing_capabilities, ['daily_import']);
});

test('collector rejects a healthy label without import evidence', async () => {
  const preflight = await collectMaintenancePreflight({
    baseUrl: 'https://example.invalid',
    allowedOrigins: ['https://example.invalid'],
    fetchImpl: async (url) => new Response(JSON.stringify(
      url.pathname === '/health'
        ? { ok: true, database: true, configured: true }
        : { status: 'healthy' },
    )),
    now: NOW,
  });
  assert.equal(preflight.code, DATA_STATUS_UNAVAILABLE);
  assert.deepEqual(preflight.missing_capabilities, ['daily_import']);
});

test('collector classifies an empty imports table as stale data', async () => {
  const preflight = await collectMaintenancePreflight({
    baseUrl: 'https://example.invalid',
    allowedOrigins: ['https://example.invalid'],
    fetchImpl: async (url) => new Response(JSON.stringify(
      url.pathname === '/health'
        ? { ok: true, database: true, configured: true }
        : { status: 'stale', latest: null, last_success: null, last_import: null },
    ), { status: url.pathname === '/health' ? 200 : 503 }),
    now: NOW,
  });
  assert.equal(preflight.code, 'daily_import_stale');
  assert.equal(preflight.daily_import.status, 'stale');
  assert.deepEqual(preflight.database, { configured: true, reachable: true });
});
