import { createHash } from 'node:crypto';
import { sanitizeImportMetrics } from './service-health.mjs';

export const PREFLIGHT_VERSION = 'radar_maintenance_api_v1';
export const RECEIPT_VERSION = 'radar_maintenance_receipt_v1';
export const MAX_PREFLIGHT_BYTES = 32 * 1024;
export const DATABASE_UNAVAILABLE = 'database_unavailable';
export const DATA_STATUS_UNAVAILABLE = 'data_status_unavailable';
export const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://obokmnie-poznan-production.up.railway.app',
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeImportStatus(value) {
  return ['running', 'success', 'failed'].includes(value) ? value : null;
}

function safeDataStatus(value) {
  return ['healthy', 'updating', 'stale', 'failed'].includes(value) ? value : null;
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(new Date(value).getTime())) return null;
  return value;
}

function safeDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function safeImport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = typeof value.id === 'number' || (typeof value.id === 'string' && /^\d{1,24}$/.test(value.id))
    ? value.id
    : null;
  return {
    id,
    status: safeImportStatus(value.status),
    started_at: safeTimestamp(value.started_at),
    finished_at: safeTimestamp(value.finished_at),
    period_start: safeDate(value.period_start),
    period_end: safeDate(value.period_end),
    metrics: sanitizeImportMetrics(value.metrics),
  };
}

function ageHours(timestamp, now) {
  const milliseconds = new Date(timestamp).getTime();
  if (!Number.isFinite(milliseconds)) return null;
  return Math.max(0, Math.round(((now.getTime() - milliseconds) / 3_600_000) * 10) / 10);
}

function selectedIssue(databaseReachable, dataStatus) {
  if (!databaseReachable || dataStatus?.code === DATABASE_UNAVAILABLE) {
    return { severity: 'P1', code: DATABASE_UNAVAILABLE, owner: 'engineer' };
  }
  if (dataStatus?.code === DATA_STATUS_UNAVAILABLE) {
    return { severity: 'P1', code: DATA_STATUS_UNAVAILABLE, owner: 'engineer' };
  }
  if (dataStatus?.status === 'failed') {
    return { severity: 'P0', code: 'daily_import_failed', owner: 'engineer' };
  }
  if (dataStatus?.status === 'stale') {
    return { severity: 'P1', code: 'daily_import_stale', owner: 'engineer' };
  }
  if (!['healthy', 'updating'].includes(dataStatus?.status)) {
    return { severity: 'P0', code: 'daily_import_failed', owner: 'engineer' };
  }
  return null;
}

function assertPayloadLimit(value, maxBytes) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) {
    const error = new Error('preflight_payload_too_large');
    error.code = 'preflight_payload_too_large';
    throw error;
  }
}

export function buildMaintenancePreflight({ health, dataStatus, now = new Date(), maxBytes = MAX_PREFLIGHT_BYTES }) {
  const databaseReachable = health?.ok === true && health?.database === true
    && dataStatus?.code !== DATABASE_UNAVAILABLE;
  const latest = safeImport(dataStatus?.latest);
  const lastSuccess = safeImport(dataStatus?.last_success);
  const issue = selectedIssue(databaseReachable, dataStatus);
  const context = {
    database: {
      configured: health?.configured === true,
      reachable: databaseReachable,
    },
    daily_import: {
      status: databaseReachable ? safeDataStatus(dataStatus?.status) || 'failed' : 'failed',
      latest,
      last_success: lastSuccess,
      last_success_age_hours: ageHours(lastSuccess?.finished_at, now),
    },
    selected_issue: issue,
    missing_capabilities: !databaseReachable
      ? ['web_database', 'daily_import']
      : dataStatus?.code === DATA_STATUS_UNAVAILABLE ? ['daily_import'] : [],
    autonomy: { mode: 'paper', mutations_allowed: false },
    control_plane: { lease: 'not_available', kill_switch: 'not_configured' },
  };
  const preflight = {
    version: PREFLIGHT_VERSION,
    observed_at: now.toISOString(),
    ok: issue === null,
    code: issue?.code || null,
    ...context,
    context_hash: createHash('sha256').update(stableJson(context)).digest('hex'),
  };
  assertPayloadLimit(preflight, maxBytes);
  return preflight;
}

async function readJsonLimited(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('response_too_large');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('response_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publicBaseUrl(value, allowedOrigins, allowLocalhost) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('invalid_base_url');
  }
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(allowLocalhost && localhost) && !allowedOrigins.has(url.origin)) {
    throw new Error('base_url_not_allowed');
  }
  return url;
}

function validEndpointPayload(kind, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (kind === 'health') {
    return typeof payload.ok === 'boolean'
      && typeof payload.database === 'boolean'
      && typeof payload.configured === 'boolean';
  }
  if (!['healthy', 'updating', 'stale', 'failed'].includes(payload.status)) return false;
  if (payload.code !== undefined
      && ![DATABASE_UNAVAILABLE, DATA_STATUS_UNAVAILABLE].includes(payload.code)) return false;
  if (payload.code === DATABASE_UNAVAILABLE) return payload.status === 'failed';

  const validSnapshot = (value, expectedStatus = null) => (
    value && typeof value === 'object' && !Array.isArray(value)
    && ['running', 'success', 'failed'].includes(value.status)
    && (expectedStatus === null || value.status === expectedStatus)
    && safeTimestamp(value.started_at) !== null
  );
  const validSuccess = validSnapshot(payload.last_success, 'success')
    && safeTimestamp(payload.last_success.finished_at) !== null;
  if (payload.status === 'healthy') {
    return validSnapshot(payload.latest, 'success') && validSuccess;
  }
  if (payload.status === 'updating') {
    return validSnapshot(payload.latest, 'running') && validSuccess;
  }
  if (payload.status === 'stale' && payload.latest == null && payload.last_success == null) {
    return true;
  }
  return validSnapshot(payload.latest)
    && (payload.last_success == null || validSuccess);
}

async function collectEndpoint(url, { fetchImpl, signal, maxBytes, kind }) {
  const response = await fetchImpl(url, { signal, redirect: 'error' });
  if (![200, 503].includes(response.status)) throw new Error(`${kind}_http_status`);
  const payload = await readJsonLimited(response, maxBytes);
  if (!validEndpointPayload(kind, payload)) throw new Error(`${kind}_invalid_payload`);
  return payload;
}

export async function collectMaintenancePreflight({
  baseUrl,
  fetchImpl = fetch,
  now = new Date(),
  timeoutMs = 5_000,
  maxBytes = MAX_PREFLIGHT_BYTES,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  allowLocalhost = false,
}) {
  const base = publicBaseUrl(baseUrl, new Set(allowedOrigins), allowLocalhost);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let health;
  let dataStatus;
  try {
    const [healthResult, dataStatusResult] = await Promise.allSettled([
      collectEndpoint(new URL('/health', base), {
        fetchImpl, signal: controller.signal, maxBytes, kind: 'health',
      }),
      collectEndpoint(new URL('/api/data-status', base), {
        fetchImpl, signal: controller.signal, maxBytes, kind: 'data_status',
      }),
    ]);
    health = healthResult.status === 'fulfilled'
      ? healthResult.value
      : { ok: false, database: false, configured: false, code: DATABASE_UNAVAILABLE };
    dataStatus = dataStatusResult.status === 'fulfilled'
      ? dataStatusResult.value
      : { status: 'failed', code: DATA_STATUS_UNAVAILABLE };
  } finally {
    clearTimeout(timeout);
  }
  return buildMaintenancePreflight({ health, dataStatus, now, maxBytes });
}

export function maintenanceReceipt(preflight, generatedAt = new Date()) {
  return {
    version: RECEIPT_VERSION,
    generated_at: generatedAt.toISOString(),
    preflight,
  };
}
