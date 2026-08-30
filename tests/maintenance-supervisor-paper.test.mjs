import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  classifySupervisorHealth,
  runMaintenanceSupervisorPaper,
  supervisorInvocationKey,
  validateSupervisorPreflight,
} from '../lib/maintenance-supervisor-paper.mjs';
import { buildPrivateMaintenancePreflight } from '../lib/maintenance-private-api.mjs';
import {
  closeSupervisorDatabase,
  supervisorPaperConfig,
  supervisorPaperDatabaseConfig,
  supervisorPaperExitCode,
  runSupervisorWithDeadline,
} from '../scripts/run-maintenance-supervisor-paper.mjs';

const NOW = new Date('2026-08-30T12:34:56.000Z');
const HANDLE = {
  run_id: '7',
  owner: 'maintenance-supervisor-paper',
  fence: '3',
  context_hash: 'a'.repeat(64),
};

function healthySweep(observationOverrides = {}) {
  const observations = [
    { capability: 'web_database', health: 'healthy', code: null, stable_dimensions: {}, safe_context: {} },
    {
      capability: 'daily_import', health: 'healthy', code: null, stable_dimensions: {},
      safe_context: {
        data_status: 'healthy', latest_import_id: '12', last_success_id: '12',
        last_success_finished_at: '2026-08-30T11:00:00.000Z', last_success_age_hours: 1.5,
      },
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
  for (const [capability, override] of Object.entries(observationOverrides)) {
    const index = observations.findIndex((item) => item.capability === capability);
    observations[index] = { ...observations[index], ...override };
  }
  return {
    version: 'radar_maintenance_health_sweep_v1',
    observed_at: NOW.toISOString(),
    ok: true,
    code: null,
    observations,
  };
}

function issue(code, fingerprintCharacter = 'b') {
  const policies = {
    daily_import_stale: ['daily_import', 'P1', 'data_pipeline', 'run_import_preflight'],
    daily_import_failed: ['daily_import', 'P0', 'data_pipeline', 'inspect_latest_import'],
    invalid_data_coverage: ['data_coverage', 'P0', 'data_pipeline', 'inspect_import_coverage'],
    events_for_non_success_import: ['radar_diff', 'P0', 'radar_diff', 'inspect_event_integrity'],
  };
  const [capability, severity, owner, nextAction] = policies[code];
  return {
    fingerprint: fingerprintCharacter.repeat(64),
    capability,
    code,
    severity,
    owner,
    next_action_code: nextAction,
    occurrence_count: 1,
  };
}

function preflight({ sweep = healthySweep(), leaseState = 'idle', openIssues = [] } = {}) {
  return buildPrivateMaintenancePreflight({
    sweep,
    leaseState,
    actionsDisabled: true,
    openIssues,
  });
}

function receiptFor(value, status = 'succeeded', code = 'health_sweep_succeeded') {
  return {
    version: 'radar_accountability_v1',
    status,
    code,
    ...(status === 'succeeded' ? { observations: value.observations } : {}),
    remaining: value.open_issues.map(({ occurrence_count: _ignored, ...item }) => item),
  };
}

function terminalFor(value, status = 'succeeded', code = 'health_sweep_succeeded') {
  return { status, run_id: '7', code, receipt: receiptFor(value, status, code) };
}

function reader(initial, postflight = initial, calls = []) {
  let count = 0;
  return async () => {
    calls.push(count === 0 ? 'preflight' : 'postflight');
    const body = count === 0 ? initial : postflight;
    count += 1;
    return { statusCode: body.ok ? 200 : 503, body };
  };
}

function acquired(contextHash) {
  return {
    status: 'acquired',
    actions_disabled: true,
    handle: { ...HANDLE, context_hash: contextHash },
  };
}

test('strict v1 preflight accepts exactly four safe capabilities and rejects stale or duplicate input', () => {
  const valid = preflight();
  assert.equal(validateSupervisorPreflight(valid, NOW).context_hash, valid.context_hash);

  const stale = preflight({
    sweep: { ...healthySweep(), observed_at: '2026-08-30T12:19:55.999Z' },
  });
  assert.throws(() => validateSupervisorPreflight(stale, NOW), /preflight_stale/);

  const smallClockSkew = preflight({
    sweep: { ...healthySweep(), observed_at: '2026-08-30T12:35:25.999Z' },
  });
  assert.equal(validateSupervisorPreflight(smallClockSkew, NOW).observed_at, smallClockSkew.observed_at);
  const excessiveClockSkew = preflight({
    sweep: { ...healthySweep(), observed_at: '2026-08-30T12:35:26.001Z' },
  });
  assert.throws(() => validateSupervisorPreflight(excessiveClockSkew, NOW), /preflight_stale/);

  const duplicate = structuredClone(valid);
  duplicate.observations[3] = duplicate.observations[2];
  assert.throws(() => validateSupervisorPreflight(duplicate, NOW), /preflight_invalid/);

  const unexpectedContext = structuredClone(valid);
  unexpectedContext.observations[0].safe_context = { email: 'person@example.com' };
  assert.throws(() => validateSupervisorPreflight(unexpectedContext, NOW), /preflight_invalid/);
});

test('UTC-hour invocation key is stable across context changes and allows only attempts a0 and a1', () => {
  const first = preflight();
  const same = supervisorInvocationKey(first, NOW);
  assert.equal(same, supervisorInvocationKey(first, new Date('2026-08-30T12:59:59.999Z')));
  assert.equal(same, 'radar-supervisor:20260830T12:a0');
  assert.equal(supervisorInvocationKey(first, NOW, 1), 'radar-supervisor:20260830T12:a1');
  assert.throws(() => supervisorInvocationKey(first, NOW, 2), /supervisor_attempt_invalid/);

  const changed = preflight({
    sweep: healthySweep({
      daily_import: {
        safe_context: {
          data_status: 'updating', latest_import_id: '13', last_success_id: '12',
          last_success_finished_at: '2026-08-30T11:00:00.000Z', last_success_age_hours: 1.5,
        },
      },
    }),
  });
  assert.equal(same, supervisorInvocationKey(changed, NOW));
  assert.notEqual(same, supervisorInvocationKey(first, new Date('2026-08-30T13:00:00.000Z')));
});

test('health classification covers live import, stale import, failed import and unknown radar diff', () => {
  const updating = preflight({
    sweep: healthySweep({
      daily_import: {
        safe_context: {
          data_status: 'updating', latest_import_id: '13', last_success_id: '12',
          last_success_finished_at: '2026-08-30T11:00:00.000Z', last_success_age_hours: 1.5,
        },
      },
    }),
  });
  assert.equal(classifySupervisorHealth(validateSupervisorPreflight(updating, NOW)), 'healthy');

  const staleSweep = healthySweep({
    daily_import: {
      health: 'unhealthy', code: 'daily_import_stale',
      safe_context: { data_status: 'stale', last_success_age_hours: 49 },
    },
  });
  const stale = preflight({ sweep: staleSweep, openIssues: [issue('daily_import_stale')] });
  assert.equal(classifySupervisorHealth(validateSupervisorPreflight(stale, NOW)), 'stale');

  const failedSweep = healthySweep({
    daily_import: {
      health: 'unhealthy', code: 'daily_import_failed',
      safe_context: { data_status: 'failed', latest_import_id: '13', last_success_id: '12' },
    },
  });
  const failed = preflight({ sweep: failedSweep, openIssues: [issue('daily_import_failed')] });
  assert.equal(classifySupervisorHealth(validateSupervisorPreflight(failed, NOW)), 'failed');

  const unknown = preflight({
    sweep: healthySweep({ radar_diff: { health: 'unknown', code: null, safe_context: {} } }),
  });
  assert.equal(classifySupervisorHealth(validateSupervisorPreflight(unknown, NOW)), 'unknown');

  const invalidDiff = preflight({
    sweep: healthySweep({
      radar_diff: {
        health: 'unhealthy', code: 'events_for_non_success_import',
        safe_context: { non_success_event_total: 1 },
      },
    }),
    openIssues: [issue('events_for_non_success_import')],
  });
  assert.equal(classifySupervisorHealth(validateSupervisorPreflight(invalidDiff, NOW)), 'failed');
});

test('paper supervisor follows preflight, acquire, heartbeat, sweep, complete and verified postflight', async () => {
  const initial = preflight();
  const postflight = preflight();
  const calls = [];
  const output = await runMaintenanceSupervisorPaper({}, { now: () => NOW }, {
    readPrivateMaintenancePreflight: reader(initial, postflight, calls),
    acquire: async (_database, key, hash, executor) => {
      calls.push(['acquire', key, hash, executor]);
      return acquired(hash);
    },
    heartbeat: async (_database, handle) => {
      calls.push(['heartbeat', handle]);
      return { status: 'running', actions_disabled: true, handle };
    },
    runMaintenanceHealthSweep: async () => {
      calls.push('sweep');
      return healthySweep();
    },
    completeHealthSweep: async (_database, handle, observations) => {
      calls.push(['complete', handle, observations]);
      return terminalFor(postflight);
    },
    failRun: async () => { throw new Error('unexpected fail'); },
  });
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'preflight', 'acquire', 'heartbeat', 'sweep', 'complete', 'postflight',
  ]);
  assert.equal(output.execution, 'succeeded');
  assert.equal(output.health, 'healthy');
  assert.equal(output.ok, true);
  assert.equal(output.postflight_verified, true);
  assert.equal(output.effects_performed, false);
  assert.equal('handle' in output, false);
});

test('busy and existing terminal runs perform no heartbeat, sweep, completion or failure', async () => {
  const initial = preflight();
  for (const claim of [
    { status: 'busy', code: 'lease_busy' },
    terminalFor(initial),
  ]) {
    let downstream = 0;
    const output = await runMaintenanceSupervisorPaper({}, { now: () => NOW }, {
      readPrivateMaintenancePreflight: reader(initial),
      acquire: async () => claim,
      heartbeat: async () => { downstream += 1; },
      runMaintenanceHealthSweep: async () => { downstream += 1; },
      completeHealthSweep: async () => { downstream += 1; },
      failRun: async () => { downstream += 1; },
    });
    assert.equal(downstream, 0);
    assert.equal(output.effects_performed, false);
    if (claim.status === 'busy') {
      assert.equal(output.execution, 'busy');
      assert.equal(output.postflight_verified, false);
    } else {
      assert.equal(output.execution, 'succeeded');
      assert.equal(output.postflight_verified, true);
    }
  }
});

test('one recovery after a lost completion response reuses the terminal receipt without a duplicate sweep', async () => {
  const initial = preflight();
  const calls = [];
  let acquireCount = 0;
  let sweeps = 0;
  const output = await runMaintenanceSupervisorPaper({}, { now: () => NOW }, {
    readPrivateMaintenancePreflight: reader(initial, initial, calls),
    acquire: async () => {
      acquireCount += 1;
      calls.push(`acquire-${acquireCount}`);
      return acquireCount === 1 ? acquired(initial.context_hash) : terminalFor(initial);
    },
    heartbeat: async (_database, handle) => ({ status: 'running', actions_disabled: true, handle }),
    runMaintenanceHealthSweep: async () => { sweeps += 1; return healthySweep(); },
    completeHealthSweep: async () => { throw new Error('lost response with secret detail'); },
    failRun: async () => { throw new Error('unexpected fail'); },
  });
  assert.equal(acquireCount, 2);
  assert.equal(sweeps, 1);
  assert.equal(output.ok, true);
  assert.doesNotMatch(JSON.stringify(output), /secret|lost response/);
});

test('one recovery may repeat only the idempotent read-only sweep when the run is still active', async () => {
  const initial = preflight();
  let acquireCount = 0;
  let heartbeatCount = 0;
  let sweepCount = 0;
  let completionCount = 0;
  const output = await runMaintenanceSupervisorPaper({}, { now: () => NOW }, {
    readPrivateMaintenancePreflight: reader(initial),
    acquire: async () => {
      acquireCount += 1;
      return acquired(initial.context_hash);
    },
    heartbeat: async (_database, handle) => {
      heartbeatCount += 1;
      return { status: 'running', actions_disabled: true, handle };
    },
    runMaintenanceHealthSweep: async () => { sweepCount += 1; return healthySweep(); },
    completeHealthSweep: async () => {
      completionCount += 1;
      if (completionCount === 1) throw new Error('completion transport failed');
      return terminalFor(initial);
    },
    failRun: async () => { throw new Error('unexpected fail'); },
  });
  assert.deepEqual({ acquireCount, heartbeatCount, sweepCount, completionCount }, {
    acquireCount: 2, heartbeatCount: 2, sweepCount: 2, completionCount: 2,
  });
  assert.equal(output.ok, true);
  assert.equal(output.effects_performed, false);
});

test('a failed sweep is terminalized with a typed code and verified without raw errors', async () => {
  const initial = preflight();
  let failure;
  const output = await runMaintenanceSupervisorPaper({}, { now: () => NOW }, {
    readPrivateMaintenancePreflight: reader(initial),
    acquire: async () => acquired(initial.context_hash),
    heartbeat: async (_database, handle) => ({ status: 'running', actions_disabled: true, handle }),
    runMaintenanceHealthSweep: async () => { throw new Error('postgres://secret@private/db'); },
    completeHealthSweep: async () => { throw new Error('unexpected complete'); },
    failRun: async (_database, _handle, code) => {
      failure = code;
      return terminalFor(initial, 'failed', code);
    },
  });
  assert.equal(failure, 'health_sweep_failed');
  assert.equal(output.execution, 'failed');
  assert.equal(output.health, 'failed');
  assert.equal(output.postflight_verified, true);
  assert.doesNotMatch(JSON.stringify(output), /postgres|secret|private/);
});

test('kill switch changed after acquire terminalizes the run before the sweep', async () => {
  const initial = preflight();
  let sweeps = 0;
  let failureCode = null;
  const output = await runMaintenanceSupervisorPaper({}, { now: () => NOW }, {
    readPrivateMaintenancePreflight: reader(initial),
    acquire: async () => acquired(initial.context_hash),
    heartbeat: async (_database, handle) => ({
      status: 'running', actions_disabled: false, handle,
    }),
    runMaintenanceHealthSweep: async () => { sweeps += 1; },
    completeHealthSweep: async () => { throw new Error('unexpected complete'); },
    failRun: async (_database, _handle, code) => {
      failureCode = code;
      return terminalFor(initial, 'failed', code);
    },
  });
  assert.equal(sweeps, 0);
  assert.equal(failureCode, 'control_plane_failed');
  assert.equal(output.execution, 'failed');
  assert.equal(output.effects_performed, false);
});

test('lost acquire response is retried exactly once with identical idempotency material', async () => {
  const initial = preflight();
  const calls = [];
  let acquireCount = 0;
  const output = await runMaintenanceSupervisorPaper({}, { now: () => NOW }, {
    readPrivateMaintenancePreflight: reader(initial, initial, calls),
    acquire: async (_database, key, hash, executor) => {
      acquireCount += 1;
      calls.push(['acquire', key, hash, executor]);
      if (acquireCount === 1) throw new Error('lost commit response');
      return acquired(hash);
    },
    heartbeat: async (_database, handle) => ({
      status: 'running', actions_disabled: true, handle,
    }),
    runMaintenanceHealthSweep: async () => healthySweep(),
    completeHealthSweep: async () => terminalFor(initial),
    failRun: async () => { throw new Error('unexpected fail'); },
  });
  assert.equal(acquireCount, 2);
  const acquireCalls = calls.filter((call) => Array.isArray(call) && call[0] === 'acquire');
  assert.equal(acquireCalls.length, 2);
  assert.deepEqual(acquireCalls[1], acquireCalls[0]);
  assert.equal(output.ok, true);
  assert.doesNotMatch(JSON.stringify(output), /lost commit/);
});

test('postflight must be fresh, idle and consistent with the terminal receipt', async () => {
  const initial = preflight();
  const activePostflight = preflight({ leaseState: 'active' });
  const output = await runMaintenanceSupervisorPaper({}, { now: () => NOW }, {
    readPrivateMaintenancePreflight: reader(initial, activePostflight),
    acquire: async () => terminalFor(initial),
  });
  assert.equal(output.execution, 'failed');
  assert.equal(output.health, 'failed');
  assert.equal(output.code, 'postflight_inconsistent');
  assert.equal(output.postflight_verified, false);
});

test('paper CLI requires explicit mode and reuses the private runner database boundary', () => {
  assert.throws(() => supervisorPaperConfig({}), /paper_mode_required/);
  const defaultConfig = supervisorPaperConfig({ MAINTENANCE_SUPERVISOR_MODE: 'paper' });
  assert.match(defaultConfig.executor, /^maintenance-supervisor-[0-9a-f]{16}$/);
  assert.deepEqual({ ...defaultConfig, executor: 'normalized' }, {
    executor: 'normalized', dueHourUtc: 6, forceSweep: false, baseCommit: null,
  });
  assert.deepEqual(supervisorPaperConfig({
    MAINTENANCE_SUPERVISOR_MODE: 'paper',
    MAINTENANCE_SWEEP_HOUR_UTC: '7',
    MAINTENANCE_FORCE_SWEEP: '1',
    MAINTENANCE_FORCE_CONFIRM: 'paper_manual_once',
    MAINTENANCE_EXECUTOR: 'maintenance-supervisor-paper',
    RAILWAY_GIT_COMMIT_SHA: '1'.repeat(40),
  }), {
    executor: 'maintenance-supervisor-paper',
    dueHourUtc: 7,
    forceSweep: true,
    baseCommit: '1'.repeat(40),
  });
  assert.throws(() => supervisorPaperConfig({
    MAINTENANCE_SUPERVISOR_MODE: 'paper',
    MAINTENANCE_FORCE_SWEEP: '1',
  }), /force_confirmation_required/);
  assert.throws(() => supervisorPaperConfig({
    MAINTENANCE_SUPERVISOR_MODE: 'paper',
    MAINTENANCE_FORCE_CONFIRM: 'paper_manual_once',
  }), /force_confirmation_unexpected/);
  const database = supervisorPaperDatabaseConfig({
    PGHOST: '127.0.0.1',
    PGSSLMODE: 'disable',
    ALLOW_LOCAL_MAINTENANCE_RUNNER: '1',
  });
  assert.equal(database.application_name, 'radar_maintenance_supervisor_paper');
  assert.equal(database.statement_timeout, 15_000);
  assert.equal(database.query_timeout, 20_000);
  assert.equal(supervisorPaperExitCode({ execution: 'succeeded', health: 'healthy', ok: true }), 0);
  assert.equal(supervisorPaperExitCode({ execution: 'busy', health: 'healthy', ok: false }), 0);
  assert.equal(supervisorPaperExitCode({ execution: 'idle', health: 'unknown', ok: true }), 0);
  assert.equal(supervisorPaperExitCode({ execution: 'failed', health: 'failed', ok: false }), 2);
});

test('paper CLI has a hard process deadline below the five-minute cron interval', async () => {
  const completed = await runSupervisorWithDeadline({}, {}, async () => ({ ok: true }), 50);
  assert.deepEqual(completed, { ok: true });
  await assert.rejects(
    runSupervisorWithDeadline({}, {}, async () => new Promise(() => {}), 5),
    /deadline_exceeded/,
  );
  await assert.rejects(
    runSupervisorWithDeadline({}, {}, async () => ({ ok: true }), 5 * 60 * 1000),
    /deadline_invalid/,
  );
});

test('hard deadline terminates a hung child process with only a bounded failure', () => {
  const moduleUrl = new URL('../scripts/run-maintenance-supervisor-paper.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { armSupervisorProcessDeadline, closeSupervisorDatabase, runSupervisorWithDeadline } from ${JSON.stringify(moduleUrl)};
     const hardDeadline = armSupervisorProcessDeadline(75);
     try { await runSupervisorWithDeadline({}, {}, async () => new Promise(() => {}), 10); } catch {}
     await closeSupervisorDatabase({ end: async () => new Promise(() => {}) }, hardDeadline);`,
  ], { encoding: 'utf8', timeout: 2_000 });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /maintenance_supervisor_process_deadline_exceeded/);
  assert.doesNotMatch(child.stderr, /postgres|secret|credential/);
});

test('normal database cleanup disarms the hard deadline only after the pool closes', async () => {
  const order = [];
  const deadline = setTimeout(() => order.push('deadline'), 1_000);
  await closeSupervisorDatabase({
    end: async () => { order.push('closed'); },
  }, deadline);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ['closed']);
});
