import { buildMaintenanceAgentStagePack } from './maintenance-agent-pack.mjs';
import { watchdog } from './maintenance-control-plane.mjs';
import { readPrivateMaintenancePreflight } from './maintenance-private-api.mjs';
import {
  MAX_CLOCK_SKEW_MILLISECONDS,
  runMaintenanceSupervisorPaper,
  validateSupervisorPreflight,
} from './maintenance-supervisor-paper.mjs';

export const MAINTENANCE_SUPERVISOR_TICK_VERSION = 'radar_maintenance_supervisor_tick_v1';

const WATCHDOG_STATUSES = new Set(['idle', 'active', 'timed_out']);
const RUN_STATUSES = new Set(['running', 'succeeded', 'failed', 'timed_out', 'blocked']);

function safeRunId(value) {
  return typeof value === 'string' && /^\d{1,19}$/.test(value) ? value : null;
}

function safeCode(value) {
  return value === null || (typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value))
    ? value
    : 'watchdog_failed';
}

function safeWatchdog(value) {
  const observedMilliseconds = new Date(value?.observed_at).getTime();
  if (!value || !WATCHDOG_STATUSES.has(value.status) || !Number.isFinite(observedMilliseconds)) {
    return { status: 'failed', code: 'watchdog_failed', run_id: null, observed_at: null };
  }
  return {
    status: value.status,
    code: safeCode(value.code),
    run_id: safeRunId(value.run_id),
    observed_at: new Date(observedMilliseconds).toISOString(),
  };
}

function tickResult(value) {
  return {
    tick_version: MAINTENANCE_SUPERVISOR_TICK_VERSION,
    ...value,
    effects_performed: false,
  };
}

function failedTick(code, watchdogResult = null, sweep = null) {
  return tickResult({
    ok: false,
    execution: 'failed',
    health: sweep?.health || 'unknown',
    status: 'failed',
    code,
    watchdog: watchdogResult,
    sweep,
    agent_stage_pack: null,
  });
}

export function supervisorSweepDue(now, dueHourUtc, forceSweep = false) {
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime()) || !Number.isInteger(dueHourUtc)
      || dueHourUtc < 0 || dueHourUtc > 23) return false;
  return forceSweep || current.getUTCHours() >= dueHourUtc;
}

export function supervisorSlotTime(now, dueHourUtc) {
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime()) || !Number.isInteger(dueHourUtc)
      || dueHourUtc < 0 || dueHourUtc > 23) throw new Error('supervisor_slot_invalid');
  return new Date(Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
    dueHourUtc,
  ));
}

export async function readSupervisorSlot(database, now, dueHourUtc) {
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime()) || !Number.isInteger(dueHourUtc)
      || dueHourUtc < 0 || dueHourUtc > 23) throw new Error('supervisor_slot_invalid');
  const slot = supervisorSlotTime(current, dueHourUtc);
  const day = slot.toISOString().slice(0, 10).replaceAll('-', '');
  const hour = String(slot.getUTCHours()).padStart(2, '0');
  const result = await database.query(
    `SELECT status
       FROM maintenance_runs
      WHERE invocation_key LIKE $1
      ORDER BY id ASC
      LIMIT 3`,
    [`radar-supervisor:${day}T${hour}:%`],
  );
  if (!Array.isArray(result?.rows) || result.rows.length > 3) {
    throw new Error('supervisor_slot_invalid');
  }
  if (result.rows.length === 0) return { state: 'empty', attempts: 0, status: null };
  const statuses = result.rows.map((row) => row?.status);
  if (statuses.some((status) => !RUN_STATUSES.has(status))) {
    throw new Error('supervisor_slot_invalid');
  }
  return { state: 'existing', attempts: statuses.length, status: statuses.at(-1) };
}

export async function runMaintenanceSupervisorTick(database, config = {}, injected = {}) {
  const clock = typeof config.now === 'function' ? config.now : () => new Date();
  const now = clock();
  const watchdogOperation = injected.watchdog || watchdog;
  let watchdogResult;
  try {
    watchdogResult = safeWatchdog(await watchdogOperation(database));
  } catch {
    return failedTick('watchdog_failed');
  }
  if (watchdogResult.status === 'failed') return failedTick('watchdog_failed', watchdogResult);
  const nowMilliseconds = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMilliseconds)) {
    return failedTick('supervisor_clock_invalid', watchdogResult);
  }
  const databaseMilliseconds = new Date(watchdogResult.observed_at).getTime();
  if (Math.abs(nowMilliseconds - databaseMilliseconds) > MAX_CLOCK_SKEW_MILLISECONDS) {
    return failedTick('supervisor_clock_skew', watchdogResult);
  }

  if (!supervisorSweepDue(now, config.dueHourUtc, config.forceSweep === true)) {
    return tickResult({
      ok: true,
      execution: 'idle',
      health: 'unknown',
      status: 'idle',
      code: 'not_due',
      watchdog: watchdogResult,
      sweep: null,
      agent_stage_pack: null,
    });
  }

  const readSlotOperation = injected.readSupervisorSlot || readSupervisorSlot;
  let attempt = 0;
  if (config.forceSweep !== true) {
    let slot;
    try {
      slot = await readSlotOperation(database, now, config.dueHourUtc);
    } catch {
      return failedTick('supervisor_slot_unavailable', watchdogResult);
    }
    if (slot?.state !== 'empty') {
      if (slot?.state !== 'existing' || !RUN_STATUSES.has(slot.status)
          || !Number.isInteger(slot.attempts) || slot.attempts < 1) {
        return failedTick('supervisor_slot_unavailable', watchdogResult);
      }
      const retryable = ['failed', 'timed_out', 'blocked'].includes(slot.status)
        && slot.attempts === 1;
      if (retryable) attempt = 1;
      else {
        const retryExhausted = slot.attempts >= 2
          && ['failed', 'timed_out', 'blocked'].includes(slot.status);
        if (retryExhausted) return failedTick('supervisor_retry_exhausted', watchdogResult);
        return tickResult({
          ok: true,
          execution: 'idle',
          health: 'unknown',
          status: 'idle',
          code: slot.status === 'running' ? 'slot_busy' : 'already_run',
          watchdog: watchdogResult,
          sweep: null,
          agent_stage_pack: null,
        });
      }
    }
  }

  const runOperation = injected.runMaintenanceSupervisorPaper || runMaintenanceSupervisorPaper;
  const sweep = await runOperation(database, {
    executor: config.executor,
    now: clock,
    slot: supervisorSlotTime(now, config.dueHourUtc),
    attempt,
  }, injected.supervisorOperations || {});
  if (!sweep || typeof sweep !== 'object' || sweep.effects_performed !== false) {
    return failedTick('supervisor_sweep_invalid', watchdogResult);
  }

  if (config.forceSweep !== true && sweep.execution === 'failed'
      && sweep.code === 'control_plane_failed') {
    try {
      const recoveredSlot = await readSlotOperation(database, now, config.dueHourUtc);
      if (recoveredSlot?.state === 'existing' && recoveredSlot.status === 'succeeded') {
        return tickResult({
          ok: true,
          execution: 'idle',
          health: 'unknown',
          status: 'idle',
          code: 'already_run',
          watchdog: watchdogResult,
          sweep: null,
          agent_stage_pack: null,
        });
      }
    } catch {
      // Keep the original bounded failure when the exact daily slot cannot be confirmed.
    }
  }

  let agentStagePack = null;
  if (sweep.execution === 'succeeded' && ['stale', 'failed'].includes(sweep.health)) {
    const readOperation = injected.readPrivateMaintenancePreflight || readPrivateMaintenancePreflight;
    try {
      const response = await readOperation(database, clock());
      if (response?.statusCode !== 200) throw new Error('agent_pack_preflight_unavailable');
      const preflight = validateSupervisorPreflight(response.body, clock());
      agentStagePack = buildMaintenanceAgentStagePack({
        preflight,
        baseCommit: config.baseCommit,
      });
    } catch {
      return failedTick('agent_stage_pack_unavailable', watchdogResult, sweep);
    }
  }

  return tickResult({
    ...sweep,
    watchdog: watchdogResult,
    sweep: null,
    agent_stage_pack: agentStagePack,
  });
}
