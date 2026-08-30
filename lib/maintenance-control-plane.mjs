import { createHash } from 'node:crypto';
import { maintenanceIssuePolicy } from './maintenance-policy.mjs';

const SCOPE = 'radar_operations';
const CONTRACT_VERSION = 'radar_maintenance_control_v1';
const RECEIPT_VERSION = 'radar_accountability_v1';
const LEASE_MINUTES = 20;
const RUN_MINUTES = 50;
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_SAFE_CONTEXT_BYTES = 8 * 1024;
const PG_BIGINT_MAX = 9223372036854775807n;
const CAPABILITIES = ['web_database', 'daily_import', 'data_coverage', 'radar_diff'];
const HEALTH_VALUES = new Set(['healthy', 'unhealthy', 'unknown']);
const DATA_STATUSES = new Set(['healthy', 'updating', 'stale', 'failed']);
const NUMERIC_CONTEXT_KEYS = new Set([
  'last_success_age_hours',
  'voivodeships',
  'published_cases',
  'non_success_event_total',
]);
const ID_CONTEXT_KEYS = new Set(['latest_import_id', 'last_success_id']);
const FAILURE_CODES = new Set([
  'database_unavailable',
  'health_sweep_failed',
  'invalid_health_observation',
  'control_plane_failed',
]);

class ControlPlaneError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function controlError(code) {
  return new ControlPlaneError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function safeToken(value, maximumLength) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) return null;
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

function safeCode(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}

function safeHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function digitString(value, maximumLength = 24) {
  return typeof value === 'string' && new RegExp(`^\\d{1,${maximumLength}}$`).test(value) ? value : null;
}

function positivePgBigintString(value) {
  const text = typeof value === 'bigint'
    ? value.toString()
    : Number.isSafeInteger(value) && value > 0
      ? String(value)
      : digitString(value, 19);
  if (!text) throw controlError('invalid_handle');
  const parsed = BigInt(text);
  if (parsed <= 0n || parsed > PG_BIGINT_MAX) throw controlError('invalid_handle');
  return text;
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function isAfter(left, right) {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime > rightTime;
}

function sanitizeHandle(value) {
  if (!isPlainObject(value)) throw controlError('invalid_handle');
  const owner = safeToken(value.owner, 64);
  const contextHash = safeHash(value.context_hash);
  let runId;
  let fence;
  try {
    runId = positivePgBigintString(value.run_id);
    fence = positivePgBigintString(value.fence);
  } catch {
    throw controlError('invalid_handle');
  }
  if (!runId || !owner || !contextHash) throw controlError('invalid_handle');
  return { run_id: runId, owner, fence, context_hash: contextHash };
}

function invalidObservation() {
  throw controlError('invalid_health_observation');
}

function sanitizeContext(value) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) invalidObservation();
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'data_status') {
      if (!DATA_STATUSES.has(raw)) invalidObservation();
      result[key] = raw;
    } else if (ID_CONTEXT_KEYS.has(key)) {
      if (raw === null) result[key] = null;
      else {
        const id = digitString(raw);
        if (!id) invalidObservation();
        result[key] = id;
      }
    } else if (key === 'last_success_finished_at') {
      if (raw === null) result[key] = null;
      else {
        if (typeof raw !== 'string') invalidObservation();
        const safeTimestamp = timestamp(raw);
        if (!safeTimestamp) invalidObservation();
        result[key] = safeTimestamp;
      }
    } else if (NUMERIC_CONTEXT_KEYS.has(key)) {
      if (raw === null) result[key] = null;
      else {
        if (typeof raw !== 'number' || !Number.isFinite(raw)
            || raw < 0 || raw > Number.MAX_SAFE_INTEGER) invalidObservation();
        result[key] = raw;
      }
    }
  }
  if (byteLength(result) > MAX_SAFE_CONTEXT_BYTES) invalidObservation();
  return result;
}

function sanitizeObservations(observations) {
  try {
    if (!Array.isArray(observations) || observations.length !== CAPABILITIES.length) invalidObservation();
    const seen = new Set();
    const result = observations.map((item) => {
      if (!isPlainObject(item) || !CAPABILITIES.includes(item.capability)
          || !HEALTH_VALUES.has(item.health) || seen.has(item.capability)) invalidObservation();
      seen.add(item.capability);
      if (item.health === 'unhealthy') {
        const policy = maintenanceIssuePolicy(item.code);
        if (!policy || policy.capability !== item.capability) invalidObservation();
      } else if (item.code !== null && item.code !== undefined) invalidObservation();
      const dimensions = item.stable_dimensions === undefined ? {} : item.stable_dimensions;
      if (!isPlainObject(dimensions) || Object.keys(dimensions).length !== 0) invalidObservation();
      return {
        capability: item.capability,
        health: item.health,
        code: item.health === 'unhealthy' ? item.code : null,
        stable_dimensions: {},
        safe_context: sanitizeContext(item.safe_context),
      };
    });
    if (seen.size !== CAPABILITIES.length || CAPABILITIES.some((capability) => !seen.has(capability))) {
      invalidObservation();
    }
    return result.sort((left, right) => CAPABILITIES.indexOf(left.capability) - CAPABILITIES.indexOf(right.capability));
  } catch (error) {
    if (error instanceof ControlPlaneError && error.code === 'invalid_health_observation') throw error;
    throw controlError('invalid_health_observation');
  }
}

function issueFingerprint(observation) {
  const material = `${SCOPE}|${observation.capability}|${observation.code}|{}`;
  return createHash('sha256').update(material).digest('hex');
}

function isPool(database) {
  return typeof database?.connect === 'function'
    && typeof database?.release !== 'function'
    && !database.connectionParameters;
}

async function transaction(database, callback) {
  if (!database || typeof database.query !== 'function') throw controlError('database_unavailable');
  let client;
  try {
    client = isPool(database) ? await database.connect() : database;
  } catch {
    throw controlError('database_unavailable');
  }
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error instanceof ControlPlaneError ? error : controlError('database_unavailable');
  } finally {
    if (client !== database && typeof client.release === 'function') client.release();
  }
}

async function lockHandle(client, handle) {
  const result = await client.query(`
    WITH observed AS (SELECT clock_timestamp() AS observed_at)
    SELECT lease.actions_disabled, lease.expires_at,
           active_run.status, active_run.deadline_at, observed.observed_at
    FROM maintenance_leases lease
    JOIN maintenance_runs active_run ON active_run.id=lease.run_id
    CROSS JOIN observed
    WHERE lease.scope=$1
      AND lease.run_id=$2::bigint AND lease.owner=$3
      AND lease.fence=$4::bigint AND lease.context_hash=$5
      AND active_run.id=$2::bigint AND active_run.executor=$3
      AND active_run.fence=$4::bigint AND active_run.context_hash=$5
    FOR UPDATE OF lease, active_run
  `, [SCOPE, handle.run_id, handle.owner, handle.fence, handle.context_hash]);
  const active = result.rows[0];
  if (!active || active.status !== 'running') throw controlError('stale_fence');
  return {
    ...active,
    expired: !isAfter(active.expires_at, active.observed_at)
      || !isAfter(active.deadline_at, active.observed_at),
  };
}

async function clearLease(client, handle) {
  const result = await client.query(`
    UPDATE maintenance_leases
    SET run_id=NULL, owner=NULL, context_hash=NULL,
        acquired_at=NULL, heartbeat_at=NULL, expires_at=NULL
    WHERE scope=$1 AND run_id=$2::bigint AND owner=$3
      AND fence=$4::bigint AND context_hash=$5
  `, [SCOPE, handle.run_id, handle.owner, handle.fence, handle.context_hash]);
  if (result.rowCount !== 1) throw controlError('stale_fence');
}

function validateRemainingIssue(row) {
  const policy = maintenanceIssuePolicy(row?.code);
  return safeHash(row?.fingerprint) && CAPABILITIES.includes(row?.capability)
    && policy && policy.capability === row.capability
    && row.severity === policy.severity && row.owner === policy.owner
    && row.next_action_code === policy.next_action_code;
}

async function remainingIssues(client) {
  const result = await client.query(`
    SELECT fingerprint, capability, code, severity, owner, next_action_code
    FROM maintenance_issues
    WHERE scope=$1 AND status='open'
    ORDER BY fingerprint
  `, [SCOPE]);
  if (!result.rows.every(validateRemainingIssue)) throw controlError('unowned_open_issue');
  return result.rows.map((row) => ({
    fingerprint: row.fingerprint,
    capability: row.capability,
    code: row.code,
    severity: row.severity,
    owner: row.owner,
    next_action_code: row.next_action_code,
  }));
}

function boundedReceipt(value) {
  if (byteLength(value) > MAX_RECEIPT_BYTES) throw controlError('receipt_too_large');
  return value;
}

async function materializeTimeout(client, handle) {
  const remaining = await remainingIssues(client);
  const receipt = boundedReceipt({
    version: RECEIPT_VERSION,
    status: 'timed_out',
    code: 'run_timed_out',
    remaining,
  });
  const result = await client.query(`
    UPDATE maintenance_runs active_run
    SET status='timed_out', finished_at=clock_timestamp(),
        result_code='run_timed_out', receipt=$6::jsonb
    FROM maintenance_leases lease
    WHERE active_run.scope=$1
      AND active_run.id=$2::bigint AND active_run.executor=$3
      AND active_run.fence=$4::bigint AND active_run.context_hash=$5
      AND active_run.status='running'
      AND lease.scope=$1 AND lease.run_id=active_run.id
      AND lease.owner=$3 AND lease.fence=$4::bigint AND lease.context_hash=$5
  `, [
    SCOPE, handle.run_id, handle.owner, handle.fence, handle.context_hash, JSON.stringify(receipt),
  ]);
  if (result.rowCount !== 1) throw controlError('stale_fence');
  await clearLease(client, handle);
  return { status: 'timed_out', run_id: handle.run_id, code: 'run_timed_out', receipt };
}

async function reapIfExpired(client, handle) {
  const active = await lockHandle(client, handle);
  if (!active.expired) throw controlError('stale_fence');
  return materializeTimeout(client, handle);
}

function acquiredResult(run, lease, invocationKey, contextHash, executor) {
  return {
    status: 'acquired',
    invocation_key: invocationKey,
    contract_version: CONTRACT_VERSION,
    actions_disabled: lease.actions_disabled,
    deadline_at: timestamp(run.deadline_at),
    handle: {
      run_id: String(run.id),
      owner: executor,
      fence: String(run.fence),
      context_hash: contextHash,
    },
  };
}

function existingResult(run) {
  return {
    status: run.status,
    run_id: String(run.id),
    invocation_key: run.invocation_key,
    code: run.result_code || null,
    receipt: run.receipt || null,
  };
}

export async function acquire(database, invocationKey, contextHash, executor) {
  const safeInvocationKey = safeToken(invocationKey, 128);
  const safeContextHash = safeHash(contextHash);
  const safeExecutor = safeToken(executor, 64);
  if (!safeInvocationKey) throw controlError('invalid_invocation_key');
  if (!safeContextHash) throw controlError('invalid_context_hash');
  if (!safeExecutor) throw controlError('invalid_executor');

  return transaction(database, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('radar_maintenance_control'), hashtext($1))",
      [SCOPE],
    );
    await client.query(`
      INSERT INTO maintenance_leases(scope, actions_disabled)
      VALUES($1, true) ON CONFLICT(scope) DO NOTHING
    `, [SCOPE]);
    const leaseResult = await client.query(`
      SELECT scope, run_id::text AS run_id, owner, fence::text AS fence,
             context_hash, acquired_at, expires_at, actions_disabled,
             clock_timestamp() AS observed_at
      FROM maintenance_leases WHERE scope=$1 FOR UPDATE
    `, [SCOPE]);
    const lease = leaseResult.rows[0];
    if (!lease) throw controlError('lease_state_invalid');

    const existingRunResult = await client.query(`
      SELECT id::text AS id, invocation_key, contract_version, context_hash,
             executor, fence::text AS fence, status, deadline_at,
             result_code, receipt
      FROM maintenance_runs
      WHERE scope=$1 AND invocation_key=$2
      FOR UPDATE
    `, [SCOPE, safeInvocationKey]);
    const existing = existingRunResult.rows[0];
    if (existing) {
      if (existing.context_hash !== safeContextHash
          || existing.contract_version !== CONTRACT_VERSION) throw controlError('idempotency_conflict');
      if (existing.status !== 'running') return existingResult(existing);
      const handle = {
        run_id: existing.id,
        owner: existing.executor,
        fence: existing.fence,
        context_hash: existing.context_hash,
      };
      const identityMatches = lease.run_id === handle.run_id && lease.owner === handle.owner
        && lease.fence === handle.fence && lease.context_hash === handle.context_hash;
      if (!identityMatches) throw controlError('lease_state_invalid');
      const unexpired = isAfter(lease.expires_at, lease.observed_at)
        && isAfter(existing.deadline_at, lease.observed_at);
      if (unexpired) {
        return acquiredResult(existing, lease, safeInvocationKey, safeContextHash, existing.executor);
      }
      return materializeTimeout(client, handle);
    }

    if (lease.run_id) {
      const activeResult = await client.query(`
        SELECT id::text AS id, executor, fence::text AS fence, context_hash,
               status, deadline_at
        FROM maintenance_runs WHERE scope=$1 AND id=$2::bigint FOR UPDATE
      `, [SCOPE, lease.run_id]);
      const active = activeResult.rows[0];
      if (!active || active.executor !== lease.owner || active.fence !== lease.fence
          || active.context_hash !== lease.context_hash) throw controlError('lease_state_invalid');
      const activeHandle = {
        run_id: active.id,
        owner: active.executor,
        fence: active.fence,
        context_hash: active.context_hash,
      };
      if (active.status === 'running') {
        const unexpired = isAfter(lease.expires_at, lease.observed_at)
          && isAfter(active.deadline_at, lease.observed_at);
        if (unexpired) return { status: 'busy', code: 'lease_busy' };
        await materializeTimeout(client, activeHandle);
      } else {
        await clearLease(client, activeHandle);
      }
    }

    const nextFence = (BigInt(lease.fence) + 1n).toString();
    const runResult = await client.query(`
      WITH observed AS (SELECT clock_timestamp() AS started_at)
      INSERT INTO maintenance_runs(
        scope, invocation_key, contract_version, context_hash, executor, fence,
        started_at, heartbeat_at, deadline_at
      )
      SELECT $1,$2,$3,$4,$5,$6::bigint,
             observed.started_at, observed.started_at,
             observed.started_at + interval '${RUN_MINUTES} minutes'
      FROM observed
      RETURNING id::text AS id, executor, fence::text AS fence, started_at, deadline_at
    `, [SCOPE, safeInvocationKey, CONTRACT_VERSION, safeContextHash, safeExecutor, nextFence]);
    const run = runResult.rows[0];
    if (!run) throw controlError('run_create_failed');
    const updatedLease = await client.query(`
      UPDATE maintenance_leases
      SET run_id=$2::bigint, owner=$3, fence=$4::bigint, context_hash=$5,
          acquired_at=$6::timestamptz, heartbeat_at=$6::timestamptz,
          expires_at=LEAST($6::timestamptz + interval '${LEASE_MINUTES} minutes', $7::timestamptz)
      WHERE scope=$1
      RETURNING actions_disabled, expires_at
    `, [SCOPE, run.id, safeExecutor, nextFence, safeContextHash, run.started_at, run.deadline_at]);
    if (updatedLease.rowCount !== 1) throw controlError('lease_state_invalid');
    return acquiredResult(
      { ...run, fence: nextFence },
      updatedLease.rows[0],
      safeInvocationKey,
      safeContextHash,
      safeExecutor,
    );
  });
}

export async function heartbeat(database, rawHandle) {
  const handle = sanitizeHandle(rawHandle);
  return transaction(database, async (client) => {
    const active = await lockHandle(client, handle);
    if (active.expired) return materializeTimeout(client, handle);
    await client.query('SAVEPOINT heartbeat_mutation');
    const leaseResult = await client.query(`
      UPDATE maintenance_leases lease
      SET heartbeat_at=clock_timestamp(),
          expires_at=LEAST(clock_timestamp() + interval '${LEASE_MINUTES} minutes', active_run.deadline_at)
      FROM maintenance_runs active_run
      WHERE lease.scope=$1
        AND lease.run_id=$2::bigint AND lease.owner=$3
        AND lease.fence=$4::bigint AND lease.context_hash=$5
        AND active_run.id=lease.run_id AND active_run.executor=$3
        AND active_run.fence=$4::bigint AND active_run.context_hash=$5
        AND active_run.status='running'
        AND lease.expires_at>clock_timestamp()
        AND active_run.deadline_at>clock_timestamp()
      RETURNING lease.expires_at
    `, [SCOPE, handle.run_id, handle.owner, handle.fence, handle.context_hash]);
    const runResult = leaseResult.rowCount === 1 ? await client.query(`
      UPDATE maintenance_runs active_run
      SET heartbeat_at=clock_timestamp()
      FROM maintenance_leases lease
      WHERE active_run.scope=$1
        AND active_run.id=$2::bigint AND active_run.executor=$3
        AND active_run.fence=$4::bigint AND active_run.context_hash=$5
        AND active_run.status='running'
        AND lease.scope=$1 AND lease.run_id=active_run.id
        AND lease.owner=$3 AND lease.fence=$4::bigint AND lease.context_hash=$5
        AND lease.expires_at>clock_timestamp()
        AND active_run.deadline_at>clock_timestamp()
    `, [SCOPE, handle.run_id, handle.owner, handle.fence, handle.context_hash]) : { rowCount: 0 };
    if (leaseResult.rowCount !== 1 || runResult.rowCount !== 1) {
      await client.query('ROLLBACK TO SAVEPOINT heartbeat_mutation');
      return reapIfExpired(client, handle);
    }
    return {
      status: 'running',
      run_id: handle.run_id,
      actions_disabled: active.actions_disabled,
      expires_at: timestamp(leaseResult.rows[0].expires_at),
      handle,
    };
  });
}

export async function completeHealthSweep(database, rawHandle, observations) {
  const handle = sanitizeHandle(rawHandle);
  const safeObservations = sanitizeObservations(observations);
  return transaction(database, async (client) => {
    const active = await lockHandle(client, handle);
    if (active.expired) return materializeTimeout(client, handle);
    await client.query('SAVEPOINT health_sweep_mutations');
    for (const item of safeObservations) {
      if (item.health === 'unknown') continue;
      if (item.health === 'healthy') {
        await client.query(`
          UPDATE maintenance_issues
          SET status='resolved', resolved_at=clock_timestamp(),
              last_observed_run_id=$3::bigint
          WHERE scope=$1 AND capability=$2 AND status='open'
        `, [SCOPE, item.capability, handle.run_id]);
        continue;
      }
      const policy = maintenanceIssuePolicy(item.code);
      await client.query(`
        INSERT INTO maintenance_issues(
          scope, fingerprint, capability, code, severity, owner, next_action_code,
          stable_dimensions, safe_context, last_occurrence_run_id, last_observed_run_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8::jsonb,$9::bigint,$9::bigint)
        ON CONFLICT(scope, fingerprint) DO UPDATE SET
          capability=excluded.capability,
          code=excluded.code,
          severity=excluded.severity,
          owner=excluded.owner,
          next_action_code=excluded.next_action_code,
          stable_dimensions='{}'::jsonb,
          safe_context=excluded.safe_context,
          status='open',
          resolved_at=NULL,
          occurrence_count=maintenance_issues.occurrence_count +
            CASE WHEN maintenance_issues.last_occurrence_run_id IS DISTINCT FROM excluded.last_occurrence_run_id
              THEN 1 ELSE 0 END,
          last_seen_at=CASE
            WHEN maintenance_issues.last_occurrence_run_id IS DISTINCT FROM excluded.last_occurrence_run_id
              THEN clock_timestamp() ELSE maintenance_issues.last_seen_at END,
          last_occurrence_run_id=excluded.last_occurrence_run_id,
          last_observed_run_id=excluded.last_observed_run_id
      `, [
        SCOPE,
        issueFingerprint(item),
        item.capability,
        item.code,
        policy.severity,
        policy.owner,
        policy.next_action_code,
        JSON.stringify(item.safe_context),
        handle.run_id,
      ]);
    }
    const remaining = await remainingIssues(client);
    const receipt = boundedReceipt({
      version: RECEIPT_VERSION,
      status: 'succeeded',
      code: 'health_sweep_succeeded',
      observations: safeObservations,
      remaining,
    });
    const runResult = await client.query(`
      UPDATE maintenance_runs active_run
      SET status='succeeded', finished_at=clock_timestamp(),
          result_code='health_sweep_succeeded', receipt=$6::jsonb
      FROM maintenance_leases lease
      WHERE active_run.scope=$1
        AND active_run.id=$2::bigint AND active_run.executor=$3
        AND active_run.fence=$4::bigint AND active_run.context_hash=$5
        AND active_run.status='running'
        AND lease.scope=$1 AND lease.run_id=active_run.id
        AND lease.owner=$3 AND lease.fence=$4::bigint AND lease.context_hash=$5
        AND lease.expires_at>clock_timestamp()
        AND active_run.deadline_at>clock_timestamp()
    `, [
      SCOPE, handle.run_id, handle.owner, handle.fence, handle.context_hash, JSON.stringify(receipt),
    ]);
    if (runResult.rowCount !== 1) {
      await client.query('ROLLBACK TO SAVEPOINT health_sweep_mutations');
      return reapIfExpired(client, handle);
    }
    await clearLease(client, handle);
    return {
      status: 'succeeded',
      run_id: handle.run_id,
      code: 'health_sweep_succeeded',
      receipt,
    };
  });
}

export async function failRun(database, rawHandle, typedCode) {
  const handle = sanitizeHandle(rawHandle);
  const code = safeCode(typedCode);
  if (!code || !FAILURE_CODES.has(code)) throw controlError('invalid_typed_code');
  return transaction(database, async (client) => {
    const active = await lockHandle(client, handle);
    if (active.expired) return materializeTimeout(client, handle);
    const remaining = await remainingIssues(client);
    const receipt = boundedReceipt({ version: RECEIPT_VERSION, status: 'failed', code, remaining });
    const runResult = await client.query(`
      UPDATE maintenance_runs active_run
      SET status='failed', finished_at=clock_timestamp(),
          result_code=$6, receipt=$7::jsonb
      FROM maintenance_leases lease
      WHERE active_run.scope=$1
        AND active_run.id=$2::bigint AND active_run.executor=$3
        AND active_run.fence=$4::bigint AND active_run.context_hash=$5
        AND active_run.status='running'
        AND lease.scope=$1 AND lease.run_id=active_run.id
        AND lease.owner=$3 AND lease.fence=$4::bigint AND lease.context_hash=$5
        AND lease.expires_at>clock_timestamp()
        AND active_run.deadline_at>clock_timestamp()
    `, [
      SCOPE, handle.run_id, handle.owner, handle.fence, handle.context_hash,
      code, JSON.stringify(receipt),
    ]);
    if (runResult.rowCount !== 1) return reapIfExpired(client, handle);
    await clearLease(client, handle);
    return { status: 'failed', run_id: handle.run_id, code, receipt };
  });
}
