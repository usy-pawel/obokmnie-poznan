import {
  acquire,
  completeHealthSweep,
  failRun,
  heartbeat,
} from './maintenance-control-plane.mjs';
import { runMaintenanceHealthSweep } from './maintenance-health-sweep.mjs';
import {
  PRIVATE_PREFLIGHT_VERSION,
  buildPrivateMaintenancePreflight,
  readPrivateMaintenancePreflight,
} from './maintenance-private-api.mjs';
import { maintenanceIssuePolicy } from './maintenance-policy.mjs';

export const MAINTENANCE_SUPERVISOR_PAPER_VERSION = 'radar_maintenance_supervisor_paper_v1';
export const MAX_PREFLIGHT_AGE_MILLISECONDS = 15 * 60 * 1000;
export const MAX_CLOCK_SKEW_MILLISECONDS = 30 * 1000;

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'blocked']);
const MAX_PAYLOAD_BYTES = 32 * 1024;
const RECEIPT_VERSION = 'radar_accountability_v1';
const DEFAULT_EXECUTOR = 'maintenance-supervisor-paper';

class PaperSupervisorError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function paperError(code) {
  return new PaperSupervisorError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeToken(value, maximumLength) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximumLength
    && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

function safeHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function safeCode(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}

function normalizeNow(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw paperError('supervisor_clock_invalid');
  return date;
}

function normalizedTimestamp(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function validateSupervisorPreflight(value, now = new Date()) {
  if (!isPlainObject(value) || byteLength(value) > MAX_PAYLOAD_BYTES
      || value.version !== PRIVATE_PREFLIGHT_VERSION || typeof value.ok !== 'boolean'
      || !safeHash(value.context_hash)) throw paperError('preflight_invalid');
  const current = normalizeNow(now);
  const observedAt = normalizedTimestamp(value.observed_at);
  if (!observedAt) throw paperError('preflight_invalid');
  const age = current.getTime() - new Date(observedAt).getTime();
  if (age < -MAX_CLOCK_SKEW_MILLISECONDS || age > MAX_PREFLIGHT_AGE_MILLISECONDS) {
    throw paperError('preflight_stale');
  }

  let canonical;
  try {
    canonical = buildPrivateMaintenancePreflight({
      sweep: value.ok ? {
        observed_at: observedAt,
        ok: true,
        code: null,
        observations: value.observations,
      } : {
        observed_at: observedAt,
        ok: false,
        code: value.code,
        observations: null,
      },
      leaseState: value.control_plane?.lease?.state,
      actionsDisabled: value.control_plane?.kill_switch?.actions_disabled,
      openIssues: value.open_issues,
    });
  } catch {
    throw paperError('preflight_invalid');
  }
  if (stableJson(canonical) !== stableJson(value)) throw paperError('preflight_invalid');
  return canonical;
}

export function supervisorInvocationKey(preflight, now = new Date(), attempt = 0) {
  if (!safeHash(preflight?.context_hash)) throw paperError('preflight_invalid');
  if (![0, 1].includes(attempt)) throw paperError('supervisor_attempt_invalid');
  const slot = normalizeNow(now).toISOString().slice(0, 13).replace(/[-:]/g, '');
  return `radar-supervisor:${slot}:a${attempt}`;
}

export function classifySupervisorHealth(preflight) {
  if (!preflight?.ok) return 'failed';
  const codes = new Set([
    ...(preflight.observations || [])
      .filter((item) => item.health === 'unhealthy')
      .map((item) => item.code),
    ...(preflight.open_issues || []).map((item) => item.code),
  ]);
  if ([...codes].some((code) => code !== 'daily_import_stale')) return 'failed';
  if (codes.has('daily_import_stale')) return 'stale';
  if ((preflight.observations || []).some((item) => item.health === 'unknown')) return 'unknown';
  return 'healthy';
}

function sanitizeReceiptIssue(value) {
  if (!isPlainObject(value)) throw paperError('receipt_invalid');
  const policy = maintenanceIssuePolicy(value.code);
  const expectedKeys = [
    'capability', 'code', 'fingerprint', 'next_action_code', 'owner', 'severity',
  ];
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])
      || !safeHash(value.fingerprint) || !policy || policy.capability !== value.capability
      || policy.severity !== value.severity || policy.owner !== value.owner
      || policy.next_action_code !== value.next_action_code) throw paperError('receipt_invalid');
  return {
    fingerprint: value.fingerprint,
    capability: value.capability,
    code: value.code,
    severity: value.severity,
    owner: value.owner,
    next_action_code: value.next_action_code,
  };
}

function sanitizeReceiptObservations(value) {
  let canonical;
  try {
    canonical = buildPrivateMaintenancePreflight({
      sweep: {
        observed_at: new Date(0).toISOString(),
        ok: true,
        code: null,
        observations: value,
      },
    }).observations;
  } catch {
    throw paperError('receipt_invalid');
  }
  if (stableJson(canonical) !== stableJson(value)) throw paperError('receipt_invalid');
  return canonical;
}

function sanitizeReceipt(value) {
  if (!isPlainObject(value) || byteLength(value) > MAX_PAYLOAD_BYTES
      || value.version !== RECEIPT_VERSION || !TERMINAL_STATUSES.has(value.status)
      || !safeCode(value.code) || !Array.isArray(value.remaining) || value.remaining.length > 32) {
    throw paperError('receipt_invalid');
  }
  const receipt = {
    version: RECEIPT_VERSION,
    status: value.status,
    code: value.code,
  };
  if (value.observations !== undefined) {
    receipt.observations = sanitizeReceiptObservations(value.observations);
  }
  const seen = new Set();
  receipt.remaining = value.remaining.map((item) => {
    const issue = sanitizeReceiptIssue(item);
    if (seen.has(issue.fingerprint)) throw paperError('receipt_invalid');
    seen.add(issue.fingerprint);
    return issue;
  });
  if (stableJson(receipt) !== stableJson(value)) throw paperError('receipt_invalid');
  return receipt;
}

function safeRunId(value) {
  return typeof value === 'string' && /^\d{1,19}$/.test(value) ? value : null;
}

function publicResult({
  execution,
  health,
  status,
  code,
  runId = null,
  invocationKey = null,
  receipt = null,
  preflightObservedAt = null,
  postflightObservedAt = null,
  postflightVerified = false,
}) {
  return {
    version: MAINTENANCE_SUPERVISOR_PAPER_VERSION,
    ok: execution === 'succeeded' && health === 'healthy' && postflightVerified,
    execution,
    health,
    status,
    code,
    run_id: safeRunId(runId),
    invocation_key: safeToken(invocationKey, 128),
    receipt,
    preflight_observed_at: preflightObservedAt,
    postflight_observed_at: postflightObservedAt,
    postflight_verified: postflightVerified,
    effects_performed: false,
  };
}

async function getPreflight(database, readOperation, now) {
  const response = await readOperation(database, now);
  if (!isPlainObject(response) || !Number.isInteger(response.statusCode)) {
    throw paperError('preflight_invalid');
  }
  const preflight = validateSupervisorPreflight(response.body, now);
  if ((preflight.ok && response.statusCode !== 200)
      || (!preflight.ok && response.statusCode !== 503)) throw paperError('preflight_invalid');
  return preflight;
}

function receiptMatchesPostflight(receipt, postflight) {
  const issueIdentity = (issue) => stableJson({
    fingerprint: issue.fingerprint,
    capability: issue.capability,
    code: issue.code,
    severity: issue.severity,
    owner: issue.owner,
    next_action_code: issue.next_action_code,
  });
  const receiptIssues = receipt.remaining.map(issueIdentity).sort();
  const preflightIssues = postflight.open_issues.map(issueIdentity).sort();
  return receiptIssues.length === preflightIssues.length
    && receiptIssues.every((item, index) => item === preflightIssues[index]);
}

function failedResult(code, initialPreflight = null, invocationKey = null) {
  return publicResult({
    execution: 'failed', health: 'failed', status: 'failed', code,
    invocationKey,
    preflightObservedAt: initialPreflight?.observed_at || null,
  });
}

async function verifyTerminal({
  database,
  terminal,
  initialPreflight,
  invocationKey,
  readOperation,
  clock,
}) {
  let receipt;
  try {
    receipt = sanitizeReceipt(terminal.receipt);
  } catch {
    return failedResult('receipt_invalid', initialPreflight, invocationKey);
  }
  if (receipt.status !== terminal.status
      || (terminal.code !== null && terminal.code !== undefined && receipt.code !== terminal.code)) {
    return failedResult('receipt_invalid', initialPreflight, invocationKey);
  }
  let postflight;
  try {
    postflight = await getPreflight(database, readOperation, clock());
  } catch (error) {
    return failedResult(
      error instanceof PaperSupervisorError ? error.code : 'postflight_unavailable',
      initialPreflight,
      invocationKey,
    );
  }
  if (!postflight.ok || postflight.control_plane.lease.state !== 'idle'
      || !receiptMatchesPostflight(receipt, postflight)) {
    return publicResult({
      execution: 'failed', health: 'failed', status: 'failed', code: 'postflight_inconsistent',
      runId: terminal.run_id, invocationKey, receipt,
      preflightObservedAt: initialPreflight.observed_at,
      postflightObservedAt: postflight.observed_at,
    });
  }
  const execution = terminal.status === 'succeeded' ? 'succeeded' : 'failed';
  return publicResult({
    execution,
    health: execution === 'succeeded' ? classifySupervisorHealth(postflight) : 'failed',
    status: terminal.status,
    code: terminal.code || receipt.code,
    runId: terminal.run_id,
    invocationKey,
    receipt,
    preflightObservedAt: initialPreflight.observed_at,
    postflightObservedAt: postflight.observed_at,
    postflightVerified: true,
  });
}

async function runClaimedSweep(database, claimed, operations) {
  const heartbeatResult = await operations.heartbeat(database, claimed.handle);
  if (heartbeatResult.status !== 'running') return heartbeatResult;
  if (heartbeatResult.actions_disabled !== true) {
    return operations.failRun(database, claimed.handle, 'control_plane_failed');
  }
  let sweep;
  try {
    sweep = await operations.runMaintenanceHealthSweep(database);
  } catch {
    return operations.failRun(database, claimed.handle, 'health_sweep_failed');
  }
  if (!sweep?.ok || !Array.isArray(sweep.observations)) {
    return operations.failRun(database, claimed.handle, 'database_unavailable');
  }
  return operations.completeHealthSweep(database, claimed.handle, sweep.observations);
}

export async function runMaintenanceSupervisorPaper(database, config = {}, injected = {}) {
  const executor = safeToken(config.executor || DEFAULT_EXECUTOR, 64);
  if (!executor) return failedResult('supervisor_executor_invalid');
  const clock = typeof config.now === 'function' ? config.now : () => new Date();
  const operations = {
    readPrivateMaintenancePreflight: injected.readPrivateMaintenancePreflight
      || readPrivateMaintenancePreflight,
    acquire: injected.acquire || acquire,
    heartbeat: injected.heartbeat || heartbeat,
    runMaintenanceHealthSweep: injected.runMaintenanceHealthSweep
      || runMaintenanceHealthSweep,
    completeHealthSweep: injected.completeHealthSweep || completeHealthSweep,
    failRun: injected.failRun || failRun,
  };

  let initialPreflight;
  try {
    initialPreflight = await getPreflight(database, operations.readPrivateMaintenancePreflight, clock());
  } catch (error) {
    return failedResult(error instanceof PaperSupervisorError ? error.code : 'preflight_unavailable');
  }
  if (!initialPreflight.ok) return failedResult(initialPreflight.code, initialPreflight);
  if (initialPreflight.control_plane.kill_switch.actions_disabled !== true) {
    return failedResult('paper_mode_kill_switch_required', initialPreflight);
  }

  let invocationKey;
  try {
    invocationKey = supervisorInvocationKey(
      initialPreflight,
      config.slot || clock(),
      config.attempt || 0,
    );
  } catch (error) {
    return failedResult(
      error instanceof PaperSupervisorError ? error.code : 'supervisor_clock_invalid',
      initialPreflight,
    );
  }

  let claimed;
  try {
    claimed = await operations.acquire(
      database,
      invocationKey,
      initialPreflight.context_hash,
      executor,
    );
  } catch {
    try {
      claimed = await operations.acquire(
        database,
        invocationKey,
        initialPreflight.context_hash,
        executor,
      );
    } catch {
      return failedResult('control_plane_failed', initialPreflight, invocationKey);
    }
  }
  if (claimed?.status === 'busy') {
    return publicResult({
      execution: 'busy',
      health: classifySupervisorHealth(initialPreflight),
      status: 'busy',
      code: 'lease_busy',
      invocationKey,
      preflightObservedAt: initialPreflight.observed_at,
    });
  }
  if (TERMINAL_STATUSES.has(claimed?.status)) {
    return verifyTerminal({
      database, terminal: claimed, initialPreflight, invocationKey,
      readOperation: operations.readPrivateMaintenancePreflight, clock,
    });
  }
  if (claimed?.status !== 'acquired' || !isPlainObject(claimed.handle)) {
    return failedResult('control_plane_failed', initialPreflight, invocationKey);
  }
  if (claimed.actions_disabled !== true) {
    let terminal;
    try {
      terminal = await operations.failRun(database, claimed.handle, 'control_plane_failed');
    } catch {
      return failedResult('control_plane_failed', initialPreflight, invocationKey);
    }
    return verifyTerminal({
      database, terminal, initialPreflight, invocationKey,
      readOperation: operations.readPrivateMaintenancePreflight, clock,
    });
  }

  let terminal;
  try {
    terminal = await runClaimedSweep(database, claimed, operations);
  } catch {
    // A completion may have committed before its response was lost. Recover once with
    // the same idempotency material; a terminal receipt prevents a duplicate sweep.
    let recovered;
    try {
      recovered = await operations.acquire(
        database,
        invocationKey,
        initialPreflight.context_hash,
        executor,
      );
    } catch {
      return failedResult('completion_unconfirmed', initialPreflight, invocationKey);
    }
    if (TERMINAL_STATUSES.has(recovered?.status)) terminal = recovered;
    else if (recovered?.status === 'acquired' && isPlainObject(recovered.handle)) {
      try {
        terminal = await runClaimedSweep(database, recovered, operations);
      } catch {
        return failedResult('completion_unconfirmed', initialPreflight, invocationKey);
      }
    } else return failedResult('completion_unconfirmed', initialPreflight, invocationKey);
  }
  if (!TERMINAL_STATUSES.has(terminal?.status)) {
    return failedResult('control_plane_failed', initialPreflight, invocationKey);
  }
  return verifyTerminal({
    database, terminal, initialPreflight, invocationKey,
    readOperation: operations.readPrivateMaintenancePreflight, clock,
  });
}
