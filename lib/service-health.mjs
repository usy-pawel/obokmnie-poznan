export const DATABASE_UNAVAILABLE = 'database_unavailable';

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

const SAFE_METRICS = new Set([
  'normalized_rows',
  'unique_cases_staged',
  'unique_parcel_ids',
  'baseline_cases',
  'baseline_published_cases',
  'staged_voivodeships',
  'parcel_lookup_results_reused',
  'unique_cases',
  'published_cases',
  'voivodeships',
  'parcel_cache_rows',
  'case_parcel_refs',
  'inactive_cases',
]);

const DATA_STATUS_SQL = `
  WITH latest AS (
    SELECT id, status, started_at, finished_at,
           to_char(period_start,'YYYY-MM-DD') AS period_start,
           to_char(period_end,'YYYY-MM-DD') AS period_end,
           metrics
    FROM imports
    ORDER BY id DESC
    LIMIT 1
  ), last_success AS (
    SELECT id, status, started_at, finished_at,
           to_char(period_start,'YYYY-MM-DD') AS period_start,
           to_char(period_end,'YYYY-MM-DD') AS period_end,
           metrics
    FROM imports
    WHERE status='success'
    ORDER BY finished_at DESC NULLS LAST, id DESC
    LIMIT 1
  )
  SELECT 'latest' AS snapshot, * FROM latest
  UNION ALL
  SELECT 'last_success' AS snapshot, * FROM last_success
`;

function validTime(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function classifyDataStatus(latest, lastSuccess, now = new Date()) {
  if (!latest) return 'stale';
  if (latest.status === 'failed') return 'failed';
  if (latest.status === 'running') {
    const startedAt = validTime(latest.started_at);
    if (startedAt === null || now.getTime() - startedAt > THREE_HOURS_MS) return 'failed';
    const lastSuccessAt = validTime(lastSuccess?.finished_at);
    if (lastSuccessAt === null || now.getTime() - lastSuccessAt > FORTY_EIGHT_HOURS_MS) return 'stale';
    return 'updating';
  }
  if (latest.status !== 'success') return 'failed';
  const finishedAt = validTime(lastSuccess?.finished_at);
  if (finishedAt === null || now.getTime() - finishedAt > FORTY_EIGHT_HOURS_MS) return 'stale';
  return 'healthy';
}

function databaseUnavailable(configured) {
  return {
    statusCode: 503,
    body: {
      status: 'failed',
      code: DATABASE_UNAVAILABLE,
      database: { configured, reachable: false },
      latest: null,
      last_success: null,
      last_import: null,
    },
  };
}

function importSnapshot(row) {
  if (!row) return null;
  const { snapshot: _snapshot, ...importData } = row;
  return { ...importData, metrics: sanitizeImportMetrics(importData.metrics) };
}

function legacyLastImport(latest) {
  if (!latest) return null;
  const { status, ...snapshot } = latest;
  return { ...snapshot, state: status };
}

export function sanitizeImportMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return {};
  return Object.fromEntries(Object.entries(metrics).filter(([key, value]) => (
    SAFE_METRICS.has(key) && typeof value === 'number' && Number.isFinite(value)
  )));
}

export async function readHealth(databasePool) {
  if (!databasePool) {
    return {
      statusCode: 503,
      body: { ok: false, database: false, configured: false, code: DATABASE_UNAVAILABLE },
    };
  }
  try {
    await databasePool.query('SELECT 1');
    return { statusCode: 200, body: { ok: true, database: true, configured: true } };
  } catch {
    return {
      statusCode: 503,
      body: { ok: false, database: false, configured: true, code: DATABASE_UNAVAILABLE },
    };
  }
}

export async function readDataStatus(databasePool, now = new Date()) {
  if (!databasePool) return databaseUnavailable(false);
  try {
    const result = await databasePool.query(DATA_STATUS_SQL);
    const latest = importSnapshot(result.rows.find((row) => row.snapshot === 'latest'));
    const lastSuccess = importSnapshot(result.rows.find((row) => row.snapshot === 'last_success'));
    const status = classifyDataStatus(latest, lastSuccess, now);
    return {
      statusCode: ['failed', 'stale'].includes(status) ? 503 : 200,
      body: {
        status,
        latest,
        last_success: lastSuccess,
        last_import: legacyLastImport(latest),
      },
    };
  } catch {
    return databaseUnavailable(true);
  }
}
