import pg from 'pg';
import { pathToFileURL } from 'node:url';
import {
  acquire,
  completeHealthSweep,
  failRun,
} from '../lib/maintenance-control-plane.mjs';
import { runMaintenanceHealthSweep } from '../lib/maintenance-health-sweep.mjs';

const DEFAULT_EXECUTOR = 'maintenance-health-cli';
const REQUIRED_PREFLIGHT_VERSION = 'radar_maintenance_api_v1';
const CONNECTION_TIMEOUT_MILLISECONDS = 5_000;
const STATEMENT_TIMEOUT_MILLISECONDS = 15_000;
const QUERY_TIMEOUT_MILLISECONDS = 20_000;

function safeInvocationKey(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

function safeContextHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function safeExecutor(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
    && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

export function healthRunnerConfig(environment = process.env) {
  const invocationKey = safeInvocationKey(environment.MAINTENANCE_INVOCATION_KEY);
  const contextHash = safeContextHash(environment.MAINTENANCE_CONTEXT_HASH);
  const executor = safeExecutor(environment.MAINTENANCE_EXECUTOR || DEFAULT_EXECUTOR);
  if (environment.MAINTENANCE_PREFLIGHT_VERSION !== REQUIRED_PREFLIGHT_VERSION) {
    throw new Error('maintenance_preflight_version_invalid');
  }
  if (!invocationKey) throw new Error('maintenance_invocation_key_required');
  if (!contextHash) throw new Error('maintenance_context_hash_required');
  if (!executor) throw new Error('maintenance_executor_invalid');
  return {
    preflightVersion: REQUIRED_PREFLIGHT_VERSION,
    invocationKey,
    contextHash,
    executor,
  };
}

function receiptPriority(receipt) {
  if (!Array.isArray(receipt?.remaining)) return null;
  if (receipt.remaining.some((issue) => issue?.severity === 'P0')) return 'P0';
  if (receipt.remaining.some((issue) => issue?.severity === 'P1')) return 'P1';
  return 'healthy';
}

function publicResult(result) {
  const executionOk = result?.status === 'succeeded';
  const priority = receiptPriority(result?.receipt);
  const healthOk = executionOk ? priority === 'healthy' : null;
  return {
    ok: executionOk && healthOk,
    execution_ok: executionOk,
    health_ok: healthOk,
    priority,
    status: result?.status || 'failed',
    code: result?.code || null,
    run_id: result?.run_id || null,
    receipt: result?.receipt || null,
    effects_performed: false,
  };
}

export async function runHealthSweepCli(database, config, operations = {}) {
  const acquireOperation = operations.acquire || acquire;
  const sweepOperation = operations.runMaintenanceHealthSweep || runMaintenanceHealthSweep;
  const completeOperation = operations.completeHealthSweep || completeHealthSweep;
  const failOperation = operations.failRun || failRun;
  const claimed = await acquireOperation(
    database,
    config.invocationKey,
    config.contextHash,
    config.executor,
  );
  if (claimed.status !== 'acquired') return publicResult(claimed);

  let sweep;
  try {
    sweep = await sweepOperation(database);
  } catch {
    return publicResult(await failOperation(database, claimed.handle, 'health_sweep_failed'));
  }
  if (!sweep.ok || !Array.isArray(sweep.observations)) {
    return publicResult(await failOperation(database, claimed.handle, 'database_unavailable'));
  }
  return publicResult(await completeOperation(database, claimed.handle, sweep.observations));
}

function approvedPrivateHost(hostname, allowLocal) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (normalized.endsWith('.railway.internal')) return true;
  return allowLocal && ['localhost', '127.0.0.1', '::1'].includes(normalized);
}

export function healthRunnerDatabaseConfig(environment = process.env) {
  if (!environment.DATABASE_URL && !environment.PGHOST) throw new Error('database_unavailable');
  const allowLocal = environment.ALLOW_LOCAL_MAINTENANCE_RUNNER === '1';
  let connectionString;
  let urlSslMode = '';
  if (environment.DATABASE_URL) {
    const parsed = new URL(environment.DATABASE_URL);
    if (!approvedPrivateHost(parsed.hostname, allowLocal)) {
      throw new Error('private_database_host_required');
    }
    urlSslMode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
    parsed.search = '';
    parsed.hash = '';
    connectionString = parsed.toString();
  } else if (!approvedPrivateHost(environment.PGHOST, allowLocal)) {
    throw new Error('private_database_host_required');
  }
  const configuredSslMode = (environment.PGSSLMODE || '').toLowerCase();
  if (configuredSslMode && urlSslMode && configuredSslMode !== urlSslMode) {
    throw new Error('conflicting_ssl_mode');
  }
  const sslMode = configuredSslMode || urlSslMode;
  if (sslMode && !['disable', 'verify-ca', 'verify-full'].includes(sslMode)) {
    throw new Error('verified_tls_or_private_network_required');
  }
  return {
    ...(connectionString ? { connectionString } : {}),
    ssl: ['verify-ca', 'verify-full'].includes(sslMode)
      ? { rejectUnauthorized: true }
      : false,
    max: 2,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLISECONDS,
    statement_timeout: STATEMENT_TIMEOUT_MILLISECONDS,
    query_timeout: QUERY_TIMEOUT_MILLISECONDS,
    application_name: 'radar_maintenance_health_sweep',
    options: `-c statement_timeout=${STATEMENT_TIMEOUT_MILLISECONDS}`,
  };
}

async function main() {
  let database;
  try {
    const config = healthRunnerConfig();
    database = new pg.Pool(healthRunnerDatabaseConfig());
    const result = await runHealthSweepCli(database, config);
    console.log(JSON.stringify(result));
    if (result.status === 'busy') process.exitCode = 0;
    else if (result.priority === 'P0') process.exitCode = 2;
    else if (!result.ok) process.exitCode = 1;
  } catch {
    console.error(JSON.stringify({
      ok: false,
      status: 'failed',
      code: 'maintenance_health_sweep_failed',
      effects_performed: false,
    }));
    process.exitCode = 1;
  } finally {
    if (database) await database.end().catch(() => { process.exitCode = 1; });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
