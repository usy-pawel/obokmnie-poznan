import { classifyDataStatus } from './service-health.mjs';

const SWEEP_VERSION = 'radar_maintenance_health_sweep_v1';
const DATABASE_UNAVAILABLE = 'database_unavailable';

const HEALTH_SWEEP_SQL = `
  WITH observed AS (
    SELECT clock_timestamp() AS observed_at
  ), latest AS (
    SELECT id, status, started_at, finished_at
    FROM imports ORDER BY id DESC LIMIT 1
  ), last_success AS (
    SELECT id, status, started_at, finished_at,
           metrics->>'voivodeships' AS voivodeships,
           metrics->>'published_cases' AS published_cases
    FROM imports
    WHERE status='success'
    ORDER BY finished_at DESC NULLS LAST, id DESC
    LIMIT 1
  ), invalid_events AS (
    SELECT count(case_events.id) AS event_total
    FROM case_events
    JOIN imports ON imports.id=case_events.import_id
    WHERE imports.status<>'success'
  )
  SELECT observed.observed_at,
         latest.id::text AS latest_id,
         latest.status AS latest_status,
         latest.started_at AS latest_started_at,
         latest.finished_at AS latest_finished_at,
         last_success.id::text AS last_success_id,
         last_success.status AS last_success_status,
         last_success.started_at AS last_success_started_at,
         last_success.finished_at AS last_success_finished_at,
         last_success.voivodeships,
         last_success.published_cases,
         invalid_events.event_total AS non_success_event_total
  FROM observed
  LEFT JOIN latest ON true
  LEFT JOIN last_success ON true
  CROSS JOIN invalid_events
`;

function isoTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function aggregate(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function importSnapshot(row, prefix) {
  const id = row?.[`${prefix}_id`];
  if (!/^\d{1,24}$/.test(id || '')) return null;
  return {
    id,
    status: row[`${prefix}_status`],
    started_at: isoTimestamp(row[`${prefix}_started_at`]),
    finished_at: isoTimestamp(row[`${prefix}_finished_at`]),
  };
}

function observation(capability, health, code, safeContext = {}) {
  return {
    capability,
    health,
    code,
    stable_dimensions: {},
    safe_context: safeContext,
  };
}

export function buildMaintenanceHealthSweep(row) {
  const observedAt = isoTimestamp(row?.observed_at);
  if (!observedAt) throw new Error(DATABASE_UNAVAILABLE);
  const now = new Date(observedAt);
  const latest = importSnapshot(row, 'latest');
  const lastSuccess = importSnapshot(row, 'last_success');
  const dataStatus = classifyDataStatus(latest, lastSuccess, now);
  const voivodeships = aggregate(row?.voivodeships);
  const publishedCases = aggregate(row?.published_cases);
  const nonSuccessEventTotal = aggregate(row?.non_success_event_total);

  const dailyImport = ['healthy', 'updating'].includes(dataStatus)
    ? observation('daily_import', 'healthy', null, {
      data_status: dataStatus,
      latest_import_id: latest?.id || null,
      last_success_id: lastSuccess?.id || null,
      last_success_finished_at: lastSuccess?.finished_at || null,
    })
    : observation('daily_import', 'unhealthy', `daily_import_${dataStatus}`, {
      data_status: dataStatus,
      latest_import_id: latest?.id || null,
      last_success_id: lastSuccess?.id || null,
      last_success_finished_at: lastSuccess?.finished_at || null,
    });
  const dataCoverage = voivodeships === 16 && publishedCases !== null && publishedCases > 0
    ? observation('data_coverage', 'healthy', null, {
      last_success_id: lastSuccess?.id || null,
      voivodeships,
      published_cases: publishedCases,
    })
    : observation('data_coverage', 'unhealthy', 'invalid_data_coverage', {
      last_success_id: lastSuccess?.id || null,
      voivodeships,
      published_cases: publishedCases,
    });
  const radarDiff = nonSuccessEventTotal === null
    ? observation('radar_diff', 'unknown', null, {})
    : nonSuccessEventTotal === 0
      ? observation('radar_diff', 'healthy', null, { non_success_event_total: 0 })
      : observation('radar_diff', 'unhealthy', 'events_for_non_success_import', {
        non_success_event_total: nonSuccessEventTotal,
      });

  return {
    version: SWEEP_VERSION,
    observed_at: observedAt,
    ok: true,
    code: null,
    observations: [
      observation('web_database', 'healthy', null, {}),
      dailyImport,
      dataCoverage,
      radarDiff,
    ],
  };
}

export async function runMaintenanceHealthSweep(database, fallbackObservedAt = new Date()) {
  try {
    const result = await database.query(HEALTH_SWEEP_SQL);
    if (!result.rows[0]) throw new Error(DATABASE_UNAVAILABLE);
    return buildMaintenanceHealthSweep(result.rows[0]);
  } catch {
    return {
      version: SWEEP_VERSION,
      observed_at: fallbackObservedAt.toISOString(),
      ok: false,
      code: DATABASE_UNAVAILABLE,
      observations: null,
    };
  }
}
