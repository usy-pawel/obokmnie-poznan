export const RADAR_IMPORT_VERIFICATION_VERSION = 'radar_import_verification_v2';
export const DATABASE_UNAVAILABLE = 'database_unavailable';
export const FRESHNESS_HOURS = 48;
export const CONNECTION_TIMEOUT_MILLISECONDS = 5_000;
export const STATEMENT_TIMEOUT_MILLISECONDS = 8_000;
export const QUERY_TIMEOUT_MILLISECONDS = 10_000;

const VERIFY_RADAR_IMPORT_SQL = `
  WITH observation AS (
    SELECT clock_timestamp() AS observed_at
  ), latest_success AS (
    SELECT id, started_at, finished_at, period_start, period_end,
           metrics->>'voivodeships' AS metric_voivodeships,
           metrics->>'published_cases' AS metric_published_cases
    FROM imports
    WHERE status='success'
    ORDER BY finished_at DESC NULLS LAST, id DESC
    LIMIT 1
  )
  SELECT observation.observed_at,
         latest_success.id::text AS import_id,
         latest_success.started_at,
         latest_success.finished_at,
         to_char(latest_success.period_start,'YYYY-MM-DD') AS period_start,
         to_char(latest_success.period_end,'YYYY-MM-DD') AS period_end,
         latest_success.metric_voivodeships,
         latest_success.metric_published_cases,
         count(case_events.id) FILTER (WHERE case_events.event_type='new') AS event_new,
         count(case_events.id) FILTER (WHERE case_events.event_type='changed') AS event_changed,
         count(case_events.id) FILTER (WHERE case_events.event_type='removed') AS event_removed,
         count(case_events.id) AS event_total,
         min(case_events.occurred_at) AS first_event_at,
         max(case_events.occurred_at) AS last_event_at,
         (
           SELECT count(invalid_event.id)
           FROM case_events invalid_event
           JOIN imports invalid_import ON invalid_import.id=invalid_event.import_id
           WHERE invalid_import.status<>'success'
         ) AS non_success_event_total,
         (
           SELECT count(*)
           FROM imports successful_import
           LEFT JOIN radar_import_projections projection
             ON projection.import_id=successful_import.id
           WHERE successful_import.status='success'
             AND successful_import.finished_at IS NOT NULL
             AND projection.import_id IS NULL
         ) AS missing_projection_total,
         (
           SELECT projection.projection_kind
           FROM radar_import_projections projection
           WHERE projection.import_id=latest_success.id
         ) AS latest_projection_kind
  FROM observation
  LEFT JOIN latest_success ON true
  LEFT JOIN case_events ON case_events.import_id=latest_success.id
  GROUP BY observation.observed_at, latest_success.id, latest_success.started_at,
           latest_success.finished_at, latest_success.period_start, latest_success.period_end,
           latest_success.metric_voivodeships, latest_success.metric_published_cases
`;

function isoTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function aggregate(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function validPeriod(start, end) {
  return /^\d{4}-\d{2}-\d{2}$/.test(start || '')
    && /^\d{4}-\d{2}-\d{2}$/.test(end || '')
    && start <= end;
}

function resultCode(checks) {
  if (!checks.latest_success_present) return 'no_successful_import';
  if (!checks.no_events_for_non_success_imports) return 'events_for_non_success_import';
  if (!checks.all_successful_imports_projected) return 'missing_radar_projection';
  if (!checks.latest_success_projection_present) return 'missing_latest_radar_projection';
  if (!checks.event_count_matches_types) return 'event_count_mismatch';
  if (!checks.import_time_range_valid) return 'invalid_import_time_range';
  if (!checks.period_range_valid) return 'invalid_import_period';
  if (!checks.complete_voivodeship_coverage) return 'invalid_voivodeship_coverage';
  if (!checks.published_cases_present) return 'invalid_published_case_count';
  if (!checks.event_time_range_valid) return 'event_time_out_of_range';
  if (!checks.fresh) return 'latest_success_stale';
  return null;
}

export function buildRadarImportVerification(row, freshnessHours = FRESHNESS_HOURS) {
  const observedAt = isoTimestamp(row?.observed_at);
  const startedAt = isoTimestamp(row?.started_at);
  const finishedAt = isoTimestamp(row?.finished_at);
  const firstEventAt = isoTimestamp(row?.first_event_at);
  const lastEventAt = isoTimestamp(row?.last_event_at);
  const eventNew = aggregate(row?.event_new);
  const eventChanged = aggregate(row?.event_changed);
  const eventRemoved = aggregate(row?.event_removed);
  const eventTotal = aggregate(row?.event_total);
  const nonSuccessEventTotal = aggregate(row?.non_success_event_total);
  const missingProjectionTotal = aggregate(row?.missing_projection_total);
  const latestProjectionKind = ['baseline', 'projected'].includes(row?.latest_projection_kind)
    ? row.latest_projection_kind : null;
  const voivodeships = aggregate(row?.metric_voivodeships);
  const publishedCases = aggregate(row?.metric_published_cases);
  const latestSuccessPresent = /^\d{1,24}$/.test(row?.import_id || '');
  const ageMilliseconds = latestSuccessPresent && observedAt && finishedAt
    ? new Date(observedAt).getTime() - new Date(finishedAt).getTime()
    : null;
  const ageHours = ageMilliseconds === null
    ? null
    : Math.round((ageMilliseconds / 3_600_000) * 10) / 10;
  const importTimeRangeValid = latestSuccessPresent && startedAt !== null && observedAt !== null
    && startedAt <= finishedAt && finishedAt <= observedAt;
  const countsValid = [eventNew, eventChanged, eventRemoved, eventTotal, nonSuccessEventTotal]
    .every((value) => value !== null);
  const eventTimeRangeValid = eventTotal === 0
    ? firstEventAt === null && lastEventAt === null
    : importTimeRangeValid && firstEventAt !== null && lastEventAt !== null
      && startedAt <= firstEventAt && firstEventAt <= lastEventAt && lastEventAt <= finishedAt;
  const checks = {
    latest_success_present: latestSuccessPresent,
    no_events_for_non_success_imports: nonSuccessEventTotal === 0,
    all_successful_imports_projected: missingProjectionTotal === 0,
    latest_success_projection_present: latestProjectionKind !== null,
    event_count_matches_types: countsValid && eventTotal === eventNew + eventChanged + eventRemoved,
    import_time_range_valid: importTimeRangeValid,
    period_range_valid: latestSuccessPresent && validPeriod(row?.period_start, row?.period_end),
    complete_voivodeship_coverage: voivodeships === 16,
    published_cases_present: publishedCases !== null && publishedCases > 0,
    event_time_range_valid: eventTimeRangeValid,
    fresh: ageMilliseconds !== null && ageMilliseconds >= 0
      && ageMilliseconds <= freshnessHours * 3_600_000,
  };
  const code = resultCode(checks);
  return {
    version: RADAR_IMPORT_VERIFICATION_VERSION,
    observed_at: observedAt,
    ok: code === null,
    code,
    freshness_limit_hours: freshnessHours,
    latest_success: latestSuccessPresent ? {
      id: row.import_id,
      started_at: startedAt,
      finished_at: finishedAt,
      period_start: row.period_start,
      period_end: row.period_end,
      voivodeships,
      published_cases: publishedCases,
      age_hours: ageHours,
    } : null,
    events: {
      new: eventNew,
      changed: eventChanged,
      removed: eventRemoved,
      total: eventTotal,
      first_occurred_at: firstEventAt,
      last_occurred_at: lastEventAt,
      for_non_success_imports: nonSuccessEventTotal,
    },
    projections: {
      missing_successful_imports: missingProjectionTotal,
      latest_kind: latestProjectionKind,
    },
    checks,
  };
}

function sslModeFromUrl(connectionString) {
  try {
    return new URL(connectionString).searchParams.get('sslmode');
  } catch {
    return null;
  }
}

function connectionStringWithoutOptions(connectionString) {
  if (!connectionString) return null;
  const parsed = new URL(connectionString);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function verificationDatabaseConfig(environment = process.env) {
  const privateConnectionString = environment.DATABASE_URL || null;
  const publicConnectionString = privateConnectionString ? null : environment.DATABASE_PUBLIC_URL || null;
  const connectionString = privateConnectionString || publicConnectionString;
  if (!connectionString) return null;

  const configuredMode = (environment.PGSSLMODE || sslModeFromUrl(connectionString) || '').toLowerCase();
  if (publicConnectionString && !['verify-ca', 'verify-full'].includes(configuredMode || 'verify-full')) {
    throw new Error('Publiczne połączenie PostgreSQL wymaga weryfikacji TLS');
  }
  const ssl = publicConnectionString || ['verify-ca', 'verify-full'].includes(configuredMode)
    ? { rejectUnauthorized: true }
    : configuredMode === 'disable' || configuredMode === ''
      ? false
      : { rejectUnauthorized: false };

  return {
    connectionString: connectionStringWithoutOptions(connectionString),
    ssl,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLISECONDS,
    statement_timeout: STATEMENT_TIMEOUT_MILLISECONDS,
    query_timeout: QUERY_TIMEOUT_MILLISECONDS,
    application_name: 'radar_import_verification',
    options: `-c default_transaction_read_only=on -c statement_timeout=${STATEMENT_TIMEOUT_MILLISECONDS}`,
  };
}

export function databaseUnavailableVerification(observedAt = new Date()) {
  return {
    version: RADAR_IMPORT_VERIFICATION_VERSION,
    observed_at: observedAt.toISOString(),
    ok: false,
    code: DATABASE_UNAVAILABLE,
    freshness_limit_hours: FRESHNESS_HOURS,
    latest_success: null,
    events: null,
    projections: null,
    checks: null,
  };
}

export async function verifyRadarImport(database, fallbackObservedAt = new Date()) {
  try {
    const result = await database.query(VERIFY_RADAR_IMPORT_SQL);
    if (!result.rows[0]) return databaseUnavailableVerification(fallbackObservedAt);
    return buildRadarImportVerification(result.rows[0]);
  } catch {
    return databaseUnavailableVerification(fallbackObservedAt);
  }
}
