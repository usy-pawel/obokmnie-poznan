import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMaintenanceHealthSweep,
  runMaintenanceHealthSweep,
} from '../lib/maintenance-health-sweep.mjs';

const OBSERVED_AT = '2026-08-30T12:00:00.000Z';

function healthyRow(overrides = {}) {
  return {
    observed_at: OBSERVED_AT,
    latest_id: '12',
    latest_status: 'success',
    latest_started_at: '2026-08-30T09:00:00.000Z',
    latest_finished_at: '2026-08-30T11:00:00.000Z',
    last_success_id: '12',
    last_success_status: 'success',
    last_success_started_at: '2026-08-30T09:00:00.000Z',
    last_success_finished_at: '2026-08-30T11:00:00.000Z',
    voivodeships: '16',
    published_cases: '2581496',
    non_success_event_total: '0',
    ...overrides,
  };
}

function byCapability(result, capability) {
  return result.observations.find((item) => item.capability === capability);
}

test('health sweep uses one aggregate read-only query and emits four deterministic capabilities', async () => {
  const queries = [];
  const database = {
    query: async (sql) => {
      queries.push(sql);
      return { rows: [healthyRow({ snapshot: { email: 'person@example.com' } })] };
    },
  };
  const result = await runMaintenanceHealthSweep(database, new Date(OBSERVED_AT));

  assert.equal(queries.length, 1);
  assert.match(queries[0], /^\s*WITH observed/);
  assert.doesNotMatch(queries[0], /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
  assert.match(queries[0], /imports\.status<>'success'/);
  assert.doesNotMatch(queries[0], /expected.*event|event.*expected/i);
  assert.deepEqual(result.observations.map((item) => item.capability), [
    'web_database', 'daily_import', 'data_coverage', 'radar_diff',
  ]);
  assert.ok(result.observations.every((item) => item.health === 'healthy'));
  assert.doesNotMatch(JSON.stringify(result), /person@example\.com|snapshot/);
});

test('daily_import follows existing service-health freshness and running semantics', () => {
  const updating = buildMaintenanceHealthSweep(healthyRow({
    latest_id: '13',
    latest_status: 'running',
    latest_started_at: '2026-08-30T11:00:00.000Z',
    latest_finished_at: null,
  }));
  assert.equal(byCapability(updating, 'daily_import').health, 'healthy');
  assert.equal(byCapability(updating, 'daily_import').safe_context.data_status, 'updating');

  const stale = buildMaintenanceHealthSweep(healthyRow({
    latest_id: '13',
    latest_status: 'running',
    latest_started_at: '2026-08-30T11:00:00.000Z',
    latest_finished_at: null,
    last_success_finished_at: '2026-08-28T11:59:59.000Z',
  }));
  assert.deepEqual(
    { health: byCapability(stale, 'daily_import').health, code: byCapability(stale, 'daily_import').code },
    { health: 'unhealthy', code: 'daily_import_stale' },
  );

  const failed = buildMaintenanceHealthSweep(healthyRow({
    latest_status: 'failed',
  }));
  assert.equal(byCapability(failed, 'daily_import').code, 'daily_import_failed');
});

test('data_coverage requires exactly 16 voivodeships and a positive published aggregate', () => {
  for (const overrides of [
    { voivodeships: '15' },
    { voivodeships: '17' },
    { voivodeships: null },
    { published_cases: '0' },
    { published_cases: null },
  ]) {
    const coverage = byCapability(buildMaintenanceHealthSweep(healthyRow(overrides)), 'data_coverage');
    assert.equal(coverage.health, 'unhealthy');
    assert.equal(coverage.code, 'invalid_data_coverage');
  }
});

test('radar_diff checks only the prohibition on events from non-success imports', () => {
  const unhealthy = byCapability(buildMaintenanceHealthSweep(healthyRow({
    non_success_event_total: '3',
  })), 'radar_diff');
  assert.equal(unhealthy.health, 'unhealthy');
  assert.equal(unhealthy.code, 'events_for_non_success_import');
  assert.deepEqual(unhealthy.safe_context, { non_success_event_total: 3 });

  const unknown = byCapability(buildMaintenanceHealthSweep(healthyRow({
    non_success_event_total: null,
  })), 'radar_diff');
  assert.equal(unknown.health, 'unknown');
  assert.equal(unknown.code, null);
});

test('database unavailability stays external and never fabricates observations or a receipt', async () => {
  const result = await runMaintenanceHealthSweep({
    query: async () => { throw new Error('postgres://user:password@private-host/database'); },
  }, new Date(OBSERVED_AT));
  assert.deepEqual(result, {
    version: 'radar_maintenance_health_sweep_v1',
    observed_at: OBSERVED_AT,
    ok: false,
    code: 'database_unavailable',
    observations: null,
  });
  assert.equal('receipt' in result, false);
  assert.doesNotMatch(JSON.stringify(result), /password|private-host|postgres:/);
});
