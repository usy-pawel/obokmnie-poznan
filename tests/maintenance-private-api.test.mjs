import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildPrivateMaintenancePreflight,
  createPrivateMaintenancePreflightHandler,
  maintenanceApiAuthorized,
  readPrivateMaintenancePreflight,
} from '../lib/maintenance-private-api.mjs';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const TOKEN = 'maintenance-token-for-tests-32-bytes';

function healthySweep(overrides = {}) {
  const observations = [
    { capability: 'web_database', health: 'healthy', code: null, stable_dimensions: {}, safe_context: {} },
    {
      capability: 'daily_import', health: 'healthy', code: null, stable_dimensions: {},
      safe_context: { data_status: 'healthy', latest_import_id: '12', last_success_id: '12' },
    },
    {
      capability: 'data_coverage', health: 'healthy', code: null, stable_dimensions: {},
      safe_context: { last_success_id: '12', voivodeships: 16, published_cases: 100 },
    },
    {
      capability: 'radar_diff', health: 'healthy', code: null, stable_dimensions: {},
      safe_context: { non_success_event_total: 0 },
    },
  ];
  return {
    version: 'radar_maintenance_health_sweep_v1',
    observed_at: NOW.toISOString(),
    ok: true,
    code: null,
    observations,
    ...overrides,
  };
}

function healthySweepRow() {
  return {
    observed_at: NOW,
    latest_id: '12',
    latest_status: 'success',
    latest_started_at: '2026-08-30T10:00:00.000Z',
    latest_finished_at: '2026-08-30T11:00:00.000Z',
    last_success_id: '12',
    last_success_status: 'success',
    last_success_started_at: '2026-08-30T10:00:00.000Z',
    last_success_finished_at: '2026-08-30T11:00:00.000Z',
    voivodeships: '16',
    published_cases: '100',
    non_success_event_total: '0',
  };
}

function openIssue(code, severity, capability, owner, nextAction, fingerprintCharacter) {
  return {
    fingerprint: fingerprintCharacter.repeat(64),
    capability,
    code,
    severity,
    owner,
    next_action_code: nextAction,
    occurrence_count: 2,
    safe_context: { email: 'person@example.com' },
  };
}

function responseRecorder() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function transactionPool(query, commands = []) {
  return {
    connect: async () => ({
      query: async (sql, params) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        commands.push(normalized);
        if (normalized.startsWith('BEGIN')
            || normalized.startsWith('SET LOCAL')
            || normalized === 'COMMIT'
            || normalized === 'ROLLBACK') return { rows: [], rowCount: 0 };
        return query(sql, params);
      },
      release() { commands.push('RELEASE'); },
    }),
  };
}

test('private endpoint hides missing configuration, missing bearer and invalid bearer identically', async () => {
  let databaseCalls = 0;
  const database = { query: async () => { databaseCalls += 1; throw new Error('must not query'); } };
  const cases = [
    { token: undefined, authorization: undefined },
    { token: TOKEN, authorization: undefined },
    { token: TOKEN, authorization: 'Bearer wrong-token' },
    { token: TOKEN, authorization: 'Basic wrong-token' },
  ];
  for (const item of cases) {
    const response = responseRecorder();
    const handler = createPrivateMaintenancePreflightHandler({
      database,
      tokenProvider: () => item.token,
      now: () => NOW,
    });
    await handler({ headers: { authorization: item.authorization } }, response);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { error: 'not_found' });
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(databaseCalls, 0);
});

test('bearer comparison uses a fixed-size timing-safe digest', async () => {
  assert.equal(maintenanceApiAuthorized(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(maintenanceApiAuthorized('Bearer short', 'also-short'), false);
  assert.equal(maintenanceApiAuthorized('Bearer short', TOKEN), false);
  assert.equal(maintenanceApiAuthorized(`Bearer ${TOKEN}x`, TOKEN), false);
  const source = await readFile(new URL('../lib/maintenance-private-api.mjs', import.meta.url), 'utf8');
  assert.match(source, /timingSafeEqual\(expectedDigest, suppliedDigest\)/);
});

test('authorized preflight is bounded, no-store and redacts lease identity, PII and secrets', async () => {
  const issues = [
    openIssue('daily_import_stale', 'P1', 'daily_import', 'data_pipeline', 'run_import_preflight', 'b'),
    openIssue('invalid_data_coverage', 'P0', 'data_coverage', 'data_pipeline', 'inspect_import_coverage', 'a'),
  ];
  const commands = [];
  const database = transactionPool(async (sql) => {
      if (String(sql).includes('lease_snapshot')) {
        return { rows: [{
          lease_state: 'active',
          actions_disabled: true,
          open_issues: issues,
          owner: 'private-worker-identity',
          fence: '99',
          context_hash: 'secret-context',
        }] };
      }
      return { rows: [healthySweepRow()] };
    }, commands);
  const response = responseRecorder();
  const handler = createPrivateMaintenancePreflightHandler({
    database,
    tokenProvider: () => TOKEN,
    now: () => NOW,
  });
  await handler({ headers: { authorization: `Bearer ${TOKEN}` } }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.version, 'radar_maintenance_api_v1');
  assert.equal(response.body.observations.length, 4);
  assert.equal(response.body.priority, 'P0');
  assert.equal(response.body.selected.code, 'invalid_data_coverage');
  assert.deepEqual(response.body.control_plane, {
    lease: { state: 'active' },
    kill_switch: { actions_disabled: true },
  });
  assert.match(response.body.context_hash, /^[0-9a-f]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(response.body), 'utf8') <= 32 * 1024);
  assert.deepEqual(response.body.open_issues[0], {
    fingerprint: 'a'.repeat(64),
    capability: 'data_coverage',
    code: 'invalid_data_coverage',
    severity: 'P0',
    owner: 'data_pipeline',
    next_action_code: 'inspect_import_coverage',
    occurrence_count: 2,
  });
  assert.doesNotMatch(
    JSON.stringify(response.body),
    /person@example\.com|private-worker-identity|secret-context|maintenance-token-for-tests|"fence"/,
  );
  assert.deepEqual(commands.slice(0, 3), [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    "SET LOCAL lock_timeout='3s'",
    "SET LOCAL statement_timeout='10s'",
  ]);
  assert.match(commands[3], /WITH observed AS/);
  assert.match(commands[4], /WITH lease_snapshot AS/);
  assert.deepEqual(commands.slice(-2), ['COMMIT', 'RELEASE']);
});

test('priority is deterministic P0 then P1 then plan and context hash ignores observation time', () => {
  const p0Sweep = healthySweep();
  p0Sweep.observations[2] = {
    capability: 'data_coverage', health: 'unhealthy', code: 'invalid_data_coverage',
    stable_dimensions: {}, safe_context: { voivodeships: 15, published_cases: 100 },
  };
  const p0 = buildPrivateMaintenancePreflight({ sweep: p0Sweep });
  assert.equal(p0.priority, 'P0');
  assert.equal(p0.selected.code, 'invalid_data_coverage');

  const p1Sweep = healthySweep();
  p1Sweep.observations[1] = {
    capability: 'daily_import', health: 'unhealthy', code: 'daily_import_stale',
    stable_dimensions: {}, safe_context: { data_status: 'stale' },
  };
  assert.equal(buildPrivateMaintenancePreflight({ sweep: p1Sweep }).priority, 'P1');

  const plan = buildPrivateMaintenancePreflight({ sweep: healthySweep() });
  const laterPlan = buildPrivateMaintenancePreflight({
    sweep: healthySweep({ observed_at: '2026-08-30T13:00:00.000Z' }),
  });
  assert.equal(plan.priority, 'plan');
  assert.equal(plan.selected.code, 'health_sweep_planned');
  assert.equal(plan.context_hash, laterPlan.context_hash);
});

test('payload limit fails closed and database unavailability remains a four-capability safe preflight', async () => {
  assert.throws(
    () => buildPrivateMaintenancePreflight({ sweep: healthySweep(), maxBytes: 100 }),
    (error) => error.code === 'preflight_payload_too_large',
  );
  const commands = [];
  const unavailable = await readPrivateMaintenancePreflight(transactionPool(
    async () => { throw new Error('postgres://user:password@private-host/database'); },
    commands,
  ), NOW);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.code, 'database_unavailable');
  assert.equal(unavailable.body.observations.length, 4);
  assert.equal(unavailable.body.priority, 'P1');
  assert.doesNotMatch(JSON.stringify(unavailable.body), /password|private-host|postgres:/);
  assert.deepEqual(commands.slice(-2), ['ROLLBACK', 'RELEASE']);
});
