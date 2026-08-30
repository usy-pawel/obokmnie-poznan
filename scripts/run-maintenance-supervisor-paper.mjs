import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runMaintenanceSupervisorTick } from '../lib/maintenance-supervisor-tick.mjs';
import { healthRunnerDatabaseConfig } from './run-maintenance-health-sweep.mjs';

const DEFAULT_EXECUTOR_PREFIX = 'maintenance-supervisor';
const DEFAULT_DUE_HOUR_UTC = 6;
const FORCE_CONFIRMATION = 'paper_manual_once';
export const SUPERVISOR_PROCESS_DEADLINE_MILLISECONDS = 4 * 60 * 1000;
export const SUPERVISOR_OPERATION_DEADLINE_MILLISECONDS = 230 * 1000;

function safeExecutor(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
    && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

export function supervisorPaperConfig(environment = process.env) {
  if (environment.MAINTENANCE_SUPERVISOR_MODE !== 'paper') {
    throw new Error('maintenance_supervisor_paper_mode_required');
  }
  const executor = safeExecutor(
    environment.MAINTENANCE_EXECUTOR
      || `${DEFAULT_EXECUTOR_PREFIX}-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
  );
  if (!executor) throw new Error('maintenance_executor_invalid');
  const dueHourUtc = environment.MAINTENANCE_SWEEP_HOUR_UTC === undefined
    ? DEFAULT_DUE_HOUR_UTC
    : Number(environment.MAINTENANCE_SWEEP_HOUR_UTC);
  if (!Number.isInteger(dueHourUtc) || dueHourUtc < 0 || dueHourUtc > 23) {
    throw new Error('maintenance_sweep_hour_invalid');
  }
  if (environment.MAINTENANCE_FORCE_SWEEP !== undefined
      && !['0', '1'].includes(environment.MAINTENANCE_FORCE_SWEEP)) {
    throw new Error('maintenance_force_sweep_invalid');
  }
  const forceSweep = environment.MAINTENANCE_FORCE_SWEEP === '1';
  if (forceSweep && environment.MAINTENANCE_FORCE_CONFIRM !== FORCE_CONFIRMATION) {
    throw new Error('maintenance_force_confirmation_required');
  }
  if (!forceSweep && environment.MAINTENANCE_FORCE_CONFIRM !== undefined) {
    throw new Error('maintenance_force_confirmation_unexpected');
  }
  const baseCommit = environment.MAINTENANCE_BASE_COMMIT
    || environment.RAILWAY_GIT_COMMIT_SHA
    || null;
  if (baseCommit !== null && !/^[0-9a-f]{40}$/.test(baseCommit)) {
    throw new Error('maintenance_base_commit_invalid');
  }
  return {
    executor,
    dueHourUtc,
    forceSweep,
    baseCommit,
  };
}

export async function runSupervisorWithDeadline(
  database,
  config,
  runOperation = runMaintenanceSupervisorTick,
  deadlineMilliseconds = SUPERVISOR_OPERATION_DEADLINE_MILLISECONDS,
) {
  if (!Number.isInteger(deadlineMilliseconds) || deadlineMilliseconds < 1
      || deadlineMilliseconds >= 5 * 60 * 1000) {
    throw new Error('maintenance_supervisor_deadline_invalid');
  }
  let timer;
  try {
    return await Promise.race([
      runOperation(database, config),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('maintenance_supervisor_deadline_exceeded')),
          deadlineMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function armSupervisorProcessDeadline(
  deadlineMilliseconds = SUPERVISOR_PROCESS_DEADLINE_MILLISECONDS,
) {
  if (!Number.isInteger(deadlineMilliseconds) || deadlineMilliseconds < 1
      || deadlineMilliseconds >= 5 * 60 * 1000) {
    throw new Error('maintenance_supervisor_deadline_invalid');
  }
  return setTimeout(() => {
    process.stderr.write(`${JSON.stringify({
      version: 'radar_maintenance_supervisor_paper_v1',
      ok: false,
      execution: 'failed',
      health: 'failed',
      status: 'failed',
      code: 'maintenance_supervisor_process_deadline_exceeded',
      effects_performed: false,
    })}\n`);
    process.exit(2);
  }, deadlineMilliseconds);
}

export function supervisorPaperDatabaseConfig(environment = process.env) {
  return {
    ...healthRunnerDatabaseConfig(environment),
    application_name: 'radar_maintenance_supervisor_paper',
  };
}

export function supervisorPaperExitCode(result) {
  if (['idle', 'busy'].includes(result?.execution)) return 0;
  if (result?.execution === 'succeeded' && result.health === 'healthy' && result.ok) return 0;
  if (result?.health === 'failed') return 2;
  return 1;
}

export async function closeSupervisorDatabase(database, hardDeadline) {
  try {
    if (database) await database.end();
  } finally {
    if (hardDeadline) clearTimeout(hardDeadline);
  }
}

async function main() {
  let database;
  let hardDeadline;
  try {
    const config = supervisorPaperConfig();
    hardDeadline = armSupervisorProcessDeadline();
    database = new pg.Pool(supervisorPaperDatabaseConfig());
    const result = await runSupervisorWithDeadline(database, config);
    console.log(JSON.stringify(result));
    process.exitCode = supervisorPaperExitCode(result);
  } catch {
    console.error(JSON.stringify({
      version: 'radar_maintenance_supervisor_paper_v1',
      ok: false,
      execution: 'failed',
      health: 'failed',
      status: 'failed',
      code: 'maintenance_supervisor_paper_failed',
      effects_performed: false,
    }));
    process.exitCode = 2;
  } finally {
    await closeSupervisorDatabase(database, hardDeadline).catch(() => { process.exitCode = 2; });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
