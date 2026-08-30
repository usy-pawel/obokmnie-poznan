import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_STAGE_PACK_VERSION } from '../lib/maintenance-agent-pack.mjs';
import { buildPrivateMaintenancePreflight } from '../lib/maintenance-private-api.mjs';
import {
  runMaintenanceSupervisorTick,
  readSupervisorSlot,
  supervisorSlotTime,
  supervisorSweepDue,
} from '../lib/maintenance-supervisor-tick.mjs';

const NOW = new Date('2026-08-30T06:15:00.000Z');
const COMMIT = '1'.repeat(40);

function watchdogIdle() {
  return { status: 'idle', code: null, observed_at: NOW.toISOString() };
}

function stalePreflight() {
  const issue = {
    fingerprint: 'b'.repeat(64),
    capability: 'daily_import',
    code: 'daily_import_stale',
    severity: 'P1',
    owner: 'data_pipeline',
    next_action_code: 'run_import_preflight',
    occurrence_count: 2,
  };
  return buildPrivateMaintenancePreflight({
    sweep: {
      ok: true,
      observed_at: NOW.toISOString(),
      observations: [
        { capability: 'web_database', health: 'healthy', code: null, stable_dimensions: {}, safe_context: {} },
        {
          capability: 'daily_import', health: 'unhealthy', code: 'daily_import_stale',
          stable_dimensions: {}, safe_context: { data_status: 'stale', last_success_age_hours: 49 },
        },
        {
          capability: 'data_coverage', health: 'healthy', code: null,
          stable_dimensions: {}, safe_context: { voivodeships: 16, published_cases: 100 },
        },
        {
          capability: 'radar_diff', health: 'healthy', code: null,
          stable_dimensions: {}, safe_context: { non_success_event_total: 0 },
        },
      ],
    },
    leaseState: 'idle',
    actionsDisabled: true,
    openIssues: [issue],
  });
}

function healthySweepResult(overrides = {}) {
  return {
    version: 'radar_maintenance_supervisor_paper_v1',
    ok: true,
    execution: 'succeeded',
    health: 'healthy',
    status: 'succeeded',
    code: 'health_sweep_succeeded',
    effects_performed: false,
    ...overrides,
  };
}

test('daily due window uses UTC and force mode is explicit', () => {
  assert.equal(supervisorSweepDue(NOW, 6), true);
  assert.equal(supervisorSweepDue(NOW, 7), false);
  assert.equal(supervisorSweepDue(new Date('2026-08-30T07:15:00.000Z'), 6), true);
  assert.equal(supervisorSweepDue(NOW, 7, true), true);
  assert.equal(supervisorSweepDue('invalid', 6), false);
  assert.equal(supervisorSweepDue(NOW, 24), false);
});

test('catch-up keeps the logical slot at the configured UTC hour', () => {
  assert.equal(
    supervisorSlotTime(new Date('2026-08-30T11:45:00.000Z'), 6).toISOString(),
    '2026-08-30T06:00:00.000Z',
  );
});

test('slot lookup is bounded to the configured UTC day and hour', async () => {
  const calls = [];
  const empty = await readSupervisorSlot({
    query: async (sql, parameters) => {
      calls.push([sql, parameters]);
      return { rows: [] };
    },
  }, NOW, 6);
  assert.deepEqual(empty, { state: 'empty', attempts: 0, status: null });
  assert.match(calls[0][0], /LIMIT 3/);
  assert.deepEqual(calls[0][1], ['radar-supervisor:20260830T06:%']);
});

test('not-due tick runs only the watchdog and exits as a successful no-op', async () => {
  const calls = [];
  const result = await runMaintenanceSupervisorTick({}, {
    now: () => NOW,
    dueHourUtc: 7,
    forceSweep: false,
  }, {
    watchdog: async () => { calls.push('watchdog'); return watchdogIdle(); },
    runMaintenanceSupervisorPaper: async () => { calls.push('sweep'); },
  });
  assert.deepEqual(calls, ['watchdog']);
  assert.equal(result.ok, true);
  assert.equal(result.execution, 'idle');
  assert.equal(result.code, 'not_due');
  assert.equal(result.effects_performed, false);
});

test('due tick runs watchdog before one paper sweep', async () => {
  const calls = [];
  const result = await runMaintenanceSupervisorTick({}, {
    now: () => NOW,
    dueHourUtc: 6,
    executor: 'paper-supervisor',
  }, {
    watchdog: async () => { calls.push('watchdog'); return watchdogIdle(); },
    readSupervisorSlot: async () => { calls.push('slot'); return { state: 'empty', attempts: 0, status: null }; },
    runMaintenanceSupervisorPaper: async (_database, config) => {
      calls.push('sweep');
      assert.equal(config.slot.toISOString(), '2026-08-30T06:00:00.000Z');
      return healthySweepResult();
    },
  });
  assert.deepEqual(calls, ['watchdog', 'slot', 'sweep']);
  assert.equal(result.ok, true);
  assert.equal(result.watchdog.status, 'idle');
  assert.equal(result.agent_stage_pack, null);
});

test('an existing daily slot prevents repeated sweeps after context changes', async () => {
  const calls = [];
  const result = await runMaintenanceSupervisorTick({}, {
    now: () => NOW,
    dueHourUtc: 6,
  }, {
    watchdog: async () => { calls.push('watchdog'); return watchdogIdle(); },
    readSupervisorSlot: async () => {
      calls.push('slot');
      return { state: 'existing', attempts: 1, status: 'succeeded' };
    },
    runMaintenanceSupervisorPaper: async () => { calls.push('sweep'); },
  });
  assert.deepEqual(calls, ['watchdog', 'slot']);
  assert.equal(result.execution, 'idle');
  assert.equal(result.code, 'already_run');
  assert.equal(result.effects_performed, false);
});

test('a loser recovers already_run when the winner terminalizes after the empty slot read', async () => {
  const calls = [];
  let slotReads = 0;
  const result = await runMaintenanceSupervisorTick({}, {
    now: () => NOW,
    dueHourUtc: 6,
  }, {
    watchdog: async () => { calls.push('watchdog'); return watchdogIdle(); },
    readSupervisorSlot: async () => {
      slotReads += 1;
      calls.push(`slot-${slotReads}`);
      return slotReads === 1
        ? { state: 'empty', attempts: 0, status: null }
        : { state: 'existing', attempts: 1, status: 'succeeded' };
    },
    runMaintenanceSupervisorPaper: async () => {
      calls.push('loser-claim');
      return healthySweepResult({
        ok: false,
        execution: 'failed',
        health: 'failed',
        status: 'failed',
        code: 'control_plane_failed',
      });
    },
  });
  assert.deepEqual(calls, ['watchdog', 'slot-1', 'loser-claim', 'slot-2']);
  assert.equal(result.ok, true);
  assert.equal(result.execution, 'idle');
  assert.equal(result.code, 'already_run');
  assert.equal(result.effects_performed, false);
});

test('one failed slot gets attempt a1 and a second failure exhausts retries', async () => {
  const attempts = [];
  const retry = await runMaintenanceSupervisorTick({}, {
    now: () => NOW,
    dueHourUtc: 6,
  }, {
    watchdog: async () => watchdogIdle(),
    readSupervisorSlot: async () => ({ state: 'existing', attempts: 1, status: 'failed' }),
    runMaintenanceSupervisorPaper: async (_database, config) => {
      attempts.push(config.attempt);
      return healthySweepResult();
    },
  });
  assert.deepEqual(attempts, [1]);
  assert.equal(retry.execution, 'succeeded');

  const exhausted = await runMaintenanceSupervisorTick({}, {
    now: () => NOW,
    dueHourUtc: 6,
  }, {
    watchdog: async () => watchdogIdle(),
    readSupervisorSlot: async () => ({ state: 'existing', attempts: 2, status: 'failed' }),
    runMaintenanceSupervisorPaper: async () => { attempts.push(2); },
  });
  assert.deepEqual(attempts, [1]);
  assert.equal(exhausted.code, 'supervisor_retry_exhausted');
  assert.equal(exhausted.execution, 'failed');
});

test('stale successful sweep emits one bounded frozen agent pack', async () => {
  const preflight = stalePreflight();
  let reads = 0;
  const result = await runMaintenanceSupervisorTick({}, {
    now: () => NOW,
    dueHourUtc: 6,
    baseCommit: COMMIT,
  }, {
    watchdog: async () => watchdogIdle(),
    readSupervisorSlot: async () => ({ state: 'empty', attempts: 0, status: null }),
    runMaintenanceSupervisorPaper: async () => healthySweepResult({ ok: false, health: 'stale' }),
    readPrivateMaintenancePreflight: async () => {
      reads += 1;
      return { statusCode: 200, body: preflight };
    },
  });
  assert.equal(reads, 1);
  assert.equal(result.agent_stage_pack.version, AGENT_STAGE_PACK_VERSION);
  assert.equal(result.agent_stage_pack.selected_task.code, 'daily_import_stale');
  assert.equal(result.agent_stage_pack.base_commit, COMMIT);
  assert.equal(result.effects_performed, false);
});

test('watchdog and agent-pack failures are redacted and fail closed', async () => {
  const watchdogFailure = await runMaintenanceSupervisorTick({}, {
    now: () => NOW, dueHourUtc: 6,
  }, {
    watchdog: async () => { throw new Error('postgres://secret@private/db'); },
  });
  assert.equal(watchdogFailure.code, 'watchdog_failed');
  assert.doesNotMatch(JSON.stringify(watchdogFailure), /postgres|secret|private/);

  const packFailure = await runMaintenanceSupervisorTick({}, {
    now: () => NOW, dueHourUtc: 6, baseCommit: null,
  }, {
    watchdog: async () => watchdogIdle(),
    readSupervisorSlot: async () => ({ state: 'empty', attempts: 0, status: null }),
    runMaintenanceSupervisorPaper: async () => healthySweepResult({ ok: false, health: 'stale' }),
    readPrivateMaintenancePreflight: async () => ({ statusCode: 200, body: stalePreflight() }),
  });
  assert.equal(packFailure.code, 'agent_stage_pack_unavailable');
  assert.equal(packFailure.execution, 'failed');
  assert.equal(packFailure.effects_performed, false);
});

test('invalid or skewed application clock fails closed against the database clock', async () => {
  const invalid = await runMaintenanceSupervisorTick({}, {
    now: () => new Date('invalid'), dueHourUtc: 6,
  }, { watchdog: async () => watchdogIdle() });
  assert.equal(invalid.code, 'supervisor_clock_invalid');
  assert.equal(invalid.execution, 'failed');

  const skewed = await runMaintenanceSupervisorTick({}, {
    now: () => new Date(NOW.getTime() + 30_001), dueHourUtc: 6,
  }, { watchdog: async () => watchdogIdle() });
  assert.equal(skewed.code, 'supervisor_clock_skew');
  assert.equal(skewed.execution, 'failed');
});
