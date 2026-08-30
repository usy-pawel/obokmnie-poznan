import { createHash, timingSafeEqual } from 'node:crypto';
import { runMaintenanceHealthSweep } from './maintenance-health-sweep.mjs';
import { maintenanceIssuePolicy } from './maintenance-policy.mjs';

export const PRIVATE_PREFLIGHT_VERSION = 'radar_maintenance_api_v1';
export const MAX_PRIVATE_PREFLIGHT_BYTES = 32 * 1024;

const CAPABILITIES = ['web_database', 'daily_import', 'data_coverage', 'radar_diff'];
const HEALTH_VALUES = new Set(['healthy', 'unhealthy', 'unknown']);
const LEASE_STATES = new Set(['idle', 'active', 'expired']);
const CONTEXT_KEYS = new Set([
  'data_status',
  'latest_import_id',
  'last_success_id',
  'last_success_finished_at',
  'last_success_age_hours',
  'voivodeships',
  'published_cases',
  'non_success_event_total',
]);

const PRIVATE_STATE_SQL = `
  WITH lease_snapshot AS (
    SELECT CASE
             WHEN run_id IS NULL THEN 'idle'
             WHEN expires_at<=clock_timestamp() THEN 'expired'
             ELSE 'active'
           END AS lease_state,
           actions_disabled
    FROM maintenance_leases
    WHERE scope='radar_operations'
  ), bounded_issues AS (
    SELECT fingerprint, capability, code, severity, owner,
           next_action_code, occurrence_count
    FROM maintenance_issues
    WHERE scope='radar_operations' AND status='open'
    ORDER BY CASE severity WHEN 'P0' THEN 0 ELSE 1 END, code, fingerprint
    LIMIT 32
  )
  SELECT lease_snapshot.lease_state,
         lease_snapshot.actions_disabled,
         coalesce(
           jsonb_agg(to_jsonb(bounded_issues) ORDER BY
             CASE bounded_issues.severity WHEN 'P0' THEN 0 ELSE 1 END,
             bounded_issues.code, bounded_issues.fingerprint
           ) FILTER (WHERE bounded_issues.fingerprint IS NOT NULL),
           '[]'::jsonb
         ) AS open_issues
  FROM lease_snapshot
  LEFT JOIN bounded_issues ON true
  GROUP BY lease_snapshot.lease_state, lease_snapshot.actions_disabled
`;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function safeContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!CONTEXT_KEYS.has(key)) continue;
    if (key === 'data_status' && ['healthy', 'updating', 'stale', 'failed'].includes(item)) {
      result[key] = item;
    } else if (['latest_import_id', 'last_success_id'].includes(key)
        && (item === null || (typeof item === 'string' && /^\d{1,24}$/.test(item)))) {
      result[key] = item;
    } else if (key === 'last_success_finished_at' && item === null) {
      result[key] = null;
    } else if (key === 'last_success_finished_at' && typeof item === 'string'
        && Number.isFinite(new Date(item).getTime())) {
      result[key] = new Date(item).toISOString();
    } else if (['last_success_age_hours', 'voivodeships', 'published_cases', 'non_success_event_total'].includes(key)
        && (item === null || (typeof item === 'number' && Number.isFinite(item) && item >= 0))) {
      result[key] = item;
    }
  }
  return result;
}

function safeObservation(value, capability) {
  if (!value || value.capability !== capability || !HEALTH_VALUES.has(value.health)) {
    throw new Error('invalid_health_observation');
  }
  const code = value.health === 'unhealthy' && typeof value.code === 'string' ? value.code : null;
  const policy = maintenanceIssuePolicy(code);
  if (value.health === 'unhealthy' && (!policy || policy.capability !== capability)) {
    throw new Error('invalid_health_observation');
  }
  if (value.health !== 'unhealthy' && value.code !== null && value.code !== undefined) {
    throw new Error('invalid_health_observation');
  }
  return {
    capability,
    health: value.health,
    code,
    stable_dimensions: {},
    safe_context: safeContext(value.safe_context),
  };
}

function safeIssue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const policy = maintenanceIssuePolicy(value.code);
  const occurrenceCount = Number(value.occurrence_count);
  if (!policy || policy.capability !== value.capability
      || value.severity !== policy.severity || value.owner !== policy.owner
      || value.next_action_code !== policy.next_action_code
      || typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint)
      || !Number.isSafeInteger(occurrenceCount) || occurrenceCount < 1) return null;
  return {
    fingerprint: value.fingerprint,
    capability: value.capability,
    code: value.code,
    severity: value.severity,
    owner: value.owner,
    next_action_code: value.next_action_code,
    occurrence_count: occurrenceCount,
  };
}

function unavailableObservations() {
  return CAPABILITIES.map((capability) => ({
    capability,
    health: capability === 'web_database' ? 'unhealthy' : 'unknown',
    code: capability === 'web_database' ? 'database_unavailable' : null,
    stable_dimensions: {},
    safe_context: {},
  }));
}

function observationCandidate(observation) {
  const policy = maintenanceIssuePolicy(observation.code);
  if (!policy || observation.health !== 'unhealthy') return null;
  return {
    source: 'observation',
    capability: observation.capability,
    code: observation.code,
    severity: policy.severity,
    owner: policy.owner,
    next_action_code: policy.next_action_code,
  };
}

function selectedPriority(observations, openIssues, databaseUnavailable) {
  const candidates = [
    ...openIssues.map((issue) => ({ ...issue, source: 'open_issue' })),
    ...observations.map(observationCandidate).filter(Boolean),
  ];
  if (databaseUnavailable) {
    candidates.push({
      source: 'observation',
      capability: 'web_database',
      code: 'database_unavailable',
      severity: 'P1',
      owner: 'data_pipeline',
      next_action_code: 'inspect_database_connectivity',
    });
  }
  candidates.sort((left, right) => (
    (left.severity === 'P0' ? 0 : 1) - (right.severity === 'P0' ? 0 : 1)
    || left.code.localeCompare(right.code)
    || (left.source === 'open_issue' ? 0 : 1) - (right.source === 'open_issue' ? 0 : 1)
  ));
  if (candidates[0]) return { priority: candidates[0].severity, ...candidates[0] };
  return {
    priority: 'plan',
    source: 'plan',
    capability: null,
    code: 'health_sweep_planned',
    owner: 'data_pipeline',
    next_action_code: 'run_health_sweep',
  };
}

export function maintenanceApiAuthorized(authorizationHeader, configuredToken) {
  if (typeof configuredToken !== 'string'
      || configuredToken.length < 32 || configuredToken.length > 256
      || typeof authorizationHeader !== 'string') return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorizationHeader);
  if (!match) return false;
  const expectedDigest = createHash('sha256').update(configuredToken, 'utf8').digest();
  const suppliedDigest = createHash('sha256').update(match[1], 'utf8').digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

export function buildPrivateMaintenancePreflight({
  sweep,
  leaseState = 'idle',
  actionsDisabled = true,
  openIssues = [],
  maxBytes = MAX_PRIVATE_PREFLIGHT_BYTES,
}) {
  const databaseUnavailable = sweep?.ok !== true || !Array.isArray(sweep?.observations);
  const observations = databaseUnavailable
    ? unavailableObservations()
    : CAPABILITIES.map((capability, index) => safeObservation(sweep.observations[index], capability));
  const issues = openIssues.slice(0, 32).map(safeIssue);
  if (issues.some((issue) => issue === null)) throw new Error('invalid_maintenance_issue');
  issues.sort((left, right) => (
    (left.severity === 'P0' ? 0 : 1) - (right.severity === 'P0' ? 0 : 1)
    || left.code.localeCompare(right.code)
    || left.fingerprint.localeCompare(right.fingerprint)
  ));
  const safeLeaseState = LEASE_STATES.has(leaseState) ? leaseState : 'expired';
  const context = {
    observations,
    control_plane: {
      lease: { state: databaseUnavailable ? 'unavailable' : safeLeaseState },
      kill_switch: { actions_disabled: databaseUnavailable ? null : actionsDisabled === true },
    },
    open_issues: issues,
    selected: selectedPriority(observations, issues, databaseUnavailable),
  };
  const preflight = {
    version: PRIVATE_PREFLIGHT_VERSION,
    observed_at: typeof sweep?.observed_at === 'string'
      && Number.isFinite(new Date(sweep.observed_at).getTime())
      ? new Date(sweep.observed_at).toISOString()
      : new Date(0).toISOString(),
    ok: !databaseUnavailable,
    code: databaseUnavailable ? 'database_unavailable' : null,
    priority: context.selected.priority,
    ...context,
    context_hash: createHash('sha256').update(stableJson(context)).digest('hex'),
  };
  if (payloadBytes(preflight) > maxBytes) {
    const error = new Error('preflight_payload_too_large');
    error.code = 'preflight_payload_too_large';
    throw error;
  }
  return preflight;
}

export async function readPrivateMaintenancePreflight(database, now = new Date()) {
  const unavailable = () => ({
    statusCode: 503,
    body: buildPrivateMaintenancePreflight({
      sweep: {
        ok: false,
        code: 'database_unavailable',
        observations: null,
        observed_at: now.toISOString(),
      },
    }),
  });
  if (!database || typeof database.connect !== 'function') return unavailable();
  let client;
  let transactionOpen = false;
  try {
    client = await database.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    const sweep = await runMaintenanceHealthSweep(client, now);
    if (!sweep.ok) throw new Error('database_unavailable');
    const state = await client.query(PRIVATE_STATE_SQL);
    const row = state.rows[0];
    if (!row || !LEASE_STATES.has(row.lease_state) || typeof row.actions_disabled !== 'boolean'
        || !Array.isArray(row.open_issues)) throw new Error('invalid_control_plane_state');
    const result = {
      statusCode: 200,
      body: buildPrivateMaintenancePreflight({
        sweep,
        leaseState: row.lease_state,
        actionsDisabled: row.actions_disabled,
        openIssues: row.open_issues,
      }),
    };
    await client.query('COMMIT');
    transactionOpen = false;
    return result;
  } catch {
    if (transactionOpen && client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The endpoint always returns the same redacted unavailable payload.
      }
    }
    return unavailable();
  } finally {
    if (client) client.release();
  }
}

function hiddenNotFound(response) {
  return response.set('Cache-Control', 'no-store').status(404).json({ error: 'not_found' });
}

export function createPrivateMaintenancePreflightHandler({
  database,
  tokenProvider = () => process.env.MAINTENANCE_API_TOKEN,
  now = () => new Date(),
}) {
  return async (request, response) => {
    let authorized = false;
    try {
      authorized = maintenanceApiAuthorized(request.headers.authorization, tokenProvider());
    } catch {
      authorized = false;
    }
    if (!authorized) {
      return hiddenNotFound(response);
    }
    response.set('Cache-Control', 'no-store');
    try {
      const result = await readPrivateMaintenancePreflight(database, now());
      return response.status(result.statusCode).json(result.body);
    } catch {
      return response.status(503).json({
        version: PRIVATE_PREFLIGHT_VERSION,
        ok: false,
        code: 'maintenance_preflight_unavailable',
      });
    }
  };
}
