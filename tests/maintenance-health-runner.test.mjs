import assert from 'node:assert/strict';
import test from 'node:test';
import {
  healthRunnerConfig,
  healthRunnerDatabaseConfig,
  runHealthSweepCli,
} from '../scripts/run-maintenance-health-sweep.mjs';

const HASH = 'a'.repeat(64);
const HANDLE = { run_id: '7', owner: 'runner-a', fence: '3', context_hash: HASH };
const OBSERVATIONS = [
  { capability: 'web_database', health: 'healthy', code: null, stable_dimensions: {}, safe_context: {} },
  { capability: 'daily_import', health: 'healthy', code: null, stable_dimensions: {}, safe_context: {} },
  { capability: 'data_coverage', health: 'healthy', code: null, stable_dimensions: {}, safe_context: {} },
  { capability: 'radar_diff', health: 'healthy', code: null, stable_dimensions: {}, safe_context: {} },
];

function config() {
  return {
    preflightVersion: 'radar_maintenance_api_v1',
    invocationKey: 'health-2026-08-30',
    contextHash: HASH,
    executor: 'runner-a',
  };
}

test('runner requires a stable idempotency key and frozen context hash', () => {
  assert.throws(() => healthRunnerConfig({
    MAINTENANCE_PREFLIGHT_VERSION: 'radar_maintenance_api_v1',
    MAINTENANCE_CONTEXT_HASH: HASH,
  }), /maintenance_invocation_key_required/);
  assert.throws(() => healthRunnerConfig({
    MAINTENANCE_PREFLIGHT_VERSION: 'radar_maintenance_api_v1',
    MAINTENANCE_INVOCATION_KEY: 'health-2026-08-30',
  }), /maintenance_context_hash_required/);
  assert.throws(() => healthRunnerConfig({
    MAINTENANCE_PREFLIGHT_VERSION: 'radar_maintenance_paper_v1',
    MAINTENANCE_INVOCATION_KEY: 'health-2026-08-30',
    MAINTENANCE_CONTEXT_HASH: HASH,
  }), /maintenance_preflight_version_invalid/);
  assert.deepEqual(healthRunnerConfig({
    MAINTENANCE_PREFLIGHT_VERSION: 'radar_maintenance_api_v1',
    MAINTENANCE_INVOCATION_KEY: 'health-2026-08-30',
    MAINTENANCE_CONTEXT_HASH: HASH,
    MAINTENANCE_EXECUTOR: 'runner-a',
  }), config());
});

test('runner database config requires Railway private networking or explicit local tests', () => {
  assert.throws(
    () => healthRunnerDatabaseConfig({ DATABASE_URL: 'postgres://user:password@db.example.com/radar' }),
    /private_database_host_required/,
  );
  assert.throws(
    () => healthRunnerDatabaseConfig({ PGHOST: '127.0.0.1', PGSSLMODE: 'disable' }),
    /private_database_host_required/,
  );
  const verified = healthRunnerDatabaseConfig({
    DATABASE_URL: 'postgres://user:password@postgres.railway.internal/radar?sslmode=verify-full',
  });
  assert.deepEqual(verified.ssl, { rejectUnauthorized: true });
  assert.doesNotMatch(verified.connectionString, /sslmode/);
  assert.equal(verified.statement_timeout, 15_000);
  assert.equal(verified.query_timeout, 20_000);
  assert.match(verified.options, /statement_timeout=15000/);
  const local = healthRunnerDatabaseConfig({
    PGHOST: '127.0.0.1',
    PGSSLMODE: 'disable',
    ALLOW_LOCAL_MAINTENANCE_RUNNER: '1',
  });
  assert.equal(local.ssl, false);
  assert.equal(local.statement_timeout < local.query_timeout, true);
});

test('runner follows acquire then direct health then complete and performs no effects', async () => {
  const calls = [];
  const operations = {
    acquire: async (_database, invocationKey, contextHash, executor) => {
      calls.push(['acquire', invocationKey, contextHash, executor]);
      return { status: 'acquired', actions_disabled: true, handle: HANDLE };
    },
    runMaintenanceHealthSweep: async () => {
      calls.push(['sweep']);
      return { ok: true, observations: OBSERVATIONS };
    },
    completeHealthSweep: async (_database, handle, observations) => {
      calls.push(['complete', handle, observations]);
      return {
        status: 'succeeded', run_id: '7', code: 'health_sweep_succeeded',
        receipt: { version: 'radar_accountability_v1', remaining: [] },
      };
    },
    failRun: async () => { throw new Error('unexpected fail'); },
  };
  const result = await runHealthSweepCli({}, config(), operations);
  assert.deepEqual(calls.map((call) => call[0]), ['acquire', 'sweep', 'complete']);
  assert.equal(calls[0][1], config().invocationKey);
  assert.deepEqual(calls[2][1], HANDLE);
  assert.equal(result.ok, true);
  assert.equal(result.execution_ok, true);
  assert.equal(result.health_ok, true);
  assert.equal(result.priority, 'healthy');
  assert.equal(result.effects_performed, false);
  assert.equal('handle' in result, false);
});

test('runner fails closed before the sweep when the canonical kill switch is not enabled', async () => {
  const calls = [];
  const result = await runHealthSweepCli({}, config(), {
    acquire: async () => ({ status: 'acquired', actions_disabled: false, handle: HANDLE }),
    runMaintenanceHealthSweep: async () => { calls.push('sweep'); },
    completeHealthSweep: async () => { calls.push('complete'); },
    failRun: async (_database, handle, code) => {
      calls.push(['fail', handle, code]);
      return {
        status: 'failed', run_id: '7', code,
        receipt: { version: 'radar_accountability_v1', status: 'failed', code, remaining: [] },
      };
    },
  });
  assert.deepEqual(calls, [['fail', HANDLE, 'control_plane_failed']]);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'control_plane_failed');
  assert.equal(result.effects_performed, false);
});

test('runner terminalizes a failed direct database sweep with a typed safe code', async () => {
  const calls = [];
  const result = await runHealthSweepCli({}, config(), {
    acquire: async () => ({ status: 'acquired', actions_disabled: true, handle: HANDLE }),
    runMaintenanceHealthSweep: async () => {
      calls.push('sweep');
      return { ok: false, code: 'database_unavailable', observations: null };
    },
    completeHealthSweep: async () => { throw new Error('unexpected complete'); },
    failRun: async (_database, handle, code) => {
      calls.push(['fail', handle, code]);
      return {
        status: 'failed', run_id: '7', code,
        receipt: { version: 'radar_accountability_v1', status: 'failed', code, remaining: [] },
      };
    },
  });
  assert.deepEqual(calls, ['sweep', ['fail', HANDLE, 'database_unavailable']]);
  assert.equal(result.status, 'failed');
  assert.equal(result.ok, false);
  assert.equal(result.receipt.code, 'database_unavailable');
  assert.equal(result.effects_performed, false);
});

test('runner terminalizes an unexpected sweep failure', async () => {
  const failures = [];
  const result = await runHealthSweepCli({}, config(), {
    acquire: async () => ({ status: 'acquired', actions_disabled: true, handle: HANDLE }),
    runMaintenanceHealthSweep: async () => { throw new Error('secret sweep detail'); },
    completeHealthSweep: async () => { throw new Error('unexpected complete'); },
    failRun: async (_database, handle, code) => {
      failures.push([handle, code]);
      return {
        status: 'failed', run_id: '7', code,
        receipt: { version: 'radar_accountability_v1', status: 'failed', code, remaining: [] },
      };
    },
  });
  assert.deepEqual(failures, [[HANDLE, 'health_sweep_failed']]);
  assert.equal(result.code, 'health_sweep_failed');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('lost completion response is recovered by retry without failRun or a second sweep', async () => {
  let terminal = null;
  let sweeps = 0;
  let failures = 0;
  const receipt = { version: 'radar_accountability_v1', code: 'health_sweep_succeeded', remaining: [] };
  const operations = {
    acquire: async () => terminal || ({ status: 'acquired', actions_disabled: true, handle: HANDLE }),
    runMaintenanceHealthSweep: async () => {
      sweeps += 1;
      return { ok: true, observations: OBSERVATIONS };
    },
    completeHealthSweep: async () => {
      terminal = { status: 'succeeded', run_id: '7', code: 'health_sweep_succeeded', receipt };
      throw new Error('lost commit response');
    },
    failRun: async () => {
      failures += 1;
      throw new Error('unexpected fail');
    },
  };
  await assert.rejects(runHealthSweepCli({}, config(), operations), /lost commit response/);
  const recovered = await runHealthSweepCli({}, config(), operations);
  assert.equal(sweeps, 1);
  assert.equal(failures, 0);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.receipt, receipt);
});

test('idempotent terminal acquire returns the existing receipt without repeating health or completion', async () => {
  let downstreamCalls = 0;
  const receipt = { version: 'radar_accountability_v1', code: 'health_sweep_succeeded', remaining: [] };
  const result = await runHealthSweepCli({}, config(), {
    acquire: async () => ({
      status: 'succeeded', run_id: '7', code: 'health_sweep_succeeded', receipt,
    }),
    runMaintenanceHealthSweep: async () => { downstreamCalls += 1; },
    completeHealthSweep: async () => { downstreamCalls += 1; },
    failRun: async () => { downstreamCalls += 1; },
  });
  assert.equal(downstreamCalls, 0);
  assert.deepEqual(result.receipt, receipt);
  assert.equal(result.ok, true);
  assert.equal(result.effects_performed, false);
});

test('successful accountability execution with remaining P0 is unhealthy', async () => {
  const result = await runHealthSweepCli({}, config(), {
    acquire: async () => ({
      status: 'succeeded',
      run_id: '7',
      code: 'health_sweep_succeeded',
      receipt: {
        version: 'radar_accountability_v1',
        code: 'health_sweep_succeeded',
        remaining: [{ code: 'invalid_data_coverage', severity: 'P0' }],
      },
    }),
  });
  assert.equal(result.execution_ok, true);
  assert.equal(result.health_ok, false);
  assert.equal(result.priority, 'P0');
  assert.equal(result.ok, false);
});

test('failed and timed-out terminal receipts preserve existing P0 priority', async () => {
  for (const status of ['failed', 'timed_out']) {
    const result = await runHealthSweepCli({}, config(), {
      acquire: async () => ({
        status,
        run_id: '7',
        code: status === 'failed' ? 'database_unavailable' : 'lease_expired',
        receipt: {
          version: 'radar_accountability_v1',
          status,
          remaining: [{ code: 'invalid_data_coverage', severity: 'P0' }],
        },
      }),
    });
    assert.equal(result.execution_ok, false);
    assert.equal(result.health_ok, null);
    assert.equal(result.priority, 'P0');
    assert.equal(result.ok, false);
  }
});

test('busy runner neither exposes a handle nor performs health or effects', async () => {
  let downstreamCalls = 0;
  const result = await runHealthSweepCli({}, config(), {
    acquire: async () => ({ status: 'busy', code: 'lease_busy' }),
    runMaintenanceHealthSweep: async () => { downstreamCalls += 1; },
    completeHealthSweep: async () => { downstreamCalls += 1; },
    failRun: async () => { downstreamCalls += 1; },
  });
  assert.equal(downstreamCalls, 0);
  assert.deepEqual(result, {
    ok: false,
    execution_ok: false,
    health_ok: null,
    priority: null,
    status: 'busy',
    code: 'lease_busy',
    run_id: null,
    receipt: null,
    effects_performed: false,
  });
});
