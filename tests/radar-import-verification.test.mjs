import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  buildRadarImportVerification,
  DATABASE_UNAVAILABLE,
  CONNECTION_TIMEOUT_MILLISECONDS,
  QUERY_TIMEOUT_MILLISECONDS,
  RADAR_IMPORT_VERIFICATION_VERSION,
  STATEMENT_TIMEOUT_MILLISECONDS,
  verificationDatabaseConfig,
  verifyRadarImport,
} from '../lib/radar-import-verification.mjs';

const OBSERVED_AT = '2026-08-30T12:00:00.000Z';

function healthyRow(overrides = {}) {
  return {
    observed_at: OBSERVED_AT,
    import_id: '42',
    started_at: '2026-08-30T09:00:00.000Z',
    finished_at: '2026-08-30T11:00:00.000Z',
    period_start: '2025-08-30',
    period_end: '2026-08-30',
    metric_voivodeships: '16',
    metric_published_cases: '2581496',
    event_new: '10',
    event_changed: '4',
    event_removed: '2',
    event_total: '16',
    first_event_at: '2026-08-30T09:05:00.000Z',
    last_event_at: '2026-08-30T10:55:00.000Z',
    non_success_event_total: '0',
    ...overrides,
  };
}

test('verification performs one read-only aggregate query and returns only aggregate evidence', async () => {
  const queries = [];
  const database = {
    query: async (sql) => {
      queries.push(sql);
      return { rows: [healthyRow({ email: 'person@example.com', snapshot: { secret: 'token' } })] };
    },
  };
  const result = await verifyRadarImport(database, new Date(OBSERVED_AT));

  assert.equal(queries.length, 1);
  assert.match(queries[0], /^\s*WITH observation/);
  assert.doesNotMatch(queries[0], /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
  assert.match(queries[0], /invalid_import\.status<>'success'/);
  assert.match(queries[0], /metrics->>'voivodeships'/);
  assert.match(queries[0], /metrics->>'published_cases'/);
  assert.equal(result.version, RADAR_IMPORT_VERIFICATION_VERSION);
  assert.equal(result.ok, true);
  assert.equal(result.code, null);
  assert.equal(result.latest_success.voivodeships, 16);
  assert.equal(result.latest_success.published_cases, 2581496);
  assert.deepEqual(result.events, {
    new: 10,
    changed: 4,
    removed: 2,
    total: 16,
    first_occurred_at: '2026-08-30T09:05:00.000Z',
    last_occurred_at: '2026-08-30T10:55:00.000Z',
    for_non_success_imports: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), /person@example\.com|secret|token/);
});

test('verification deterministically checks event totals, import status, ranges and freshness', () => {
  const cases = [
    [{ non_success_event_total: '1' }, 'events_for_non_success_import'],
    [{ event_total: '17' }, 'event_count_mismatch'],
    [{ finished_at: null }, 'invalid_import_time_range'],
    [{ started_at: '2026-08-30T11:30:00.000Z' }, 'invalid_import_time_range'],
    [{ period_start: '2026-09-01' }, 'invalid_import_period'],
    [{ metric_voivodeships: null }, 'invalid_voivodeship_coverage'],
    [{ metric_voivodeships: '15' }, 'invalid_voivodeship_coverage'],
    [{ metric_voivodeships: '17' }, 'invalid_voivodeship_coverage'],
    [{ last_event_at: '2026-08-30T11:01:00.000Z' }, 'event_time_out_of_range'],
    [{ finished_at: '2026-08-28T11:59:59.000Z', started_at: '2026-08-28T10:00:00.000Z', first_event_at: '2026-08-28T10:05:00.000Z', last_event_at: '2026-08-28T11:55:00.000Z' }, 'latest_success_stale'],
  ];

  for (const [overrides, expectedCode] of cases) {
    const result = buildRadarImportVerification(healthyRow(overrides));
    assert.equal(result.ok, false, expectedCode);
    assert.equal(result.code, expectedCode);
  }
});

test('zero-event successful import has a valid empty event time range', () => {
  const result = buildRadarImportVerification(healthyRow({
    event_new: '0',
    event_changed: '0',
    event_removed: '0',
    event_total: '0',
    first_event_at: null,
    last_event_at: null,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.checks.event_count_matches_types, true);
  assert.equal(result.checks.event_time_range_valid, true);
});

test('metric values are sanitized and missing coverage fails closed', () => {
  const invalidPublishedCases = buildRadarImportVerification(healthyRow({
    metric_published_cases: 'person@example.com',
  }));
  assert.equal(invalidPublishedCases.ok, false);
  assert.equal(invalidPublishedCases.code, 'invalid_published_case_count');
  assert.equal(invalidPublishedCases.latest_success.published_cases, null);
  assert.doesNotMatch(JSON.stringify(invalidPublishedCases), /person@example\.com/);

  const missingCoverage = buildRadarImportVerification(healthyRow({ metric_voivodeships: null }));
  assert.equal(missingCoverage.ok, false);
  assert.equal(missingCoverage.code, 'invalid_voivodeship_coverage');
  assert.equal(missingCoverage.latest_success.voivodeships, null);

  const emptyImport = buildRadarImportVerification(healthyRow({ metric_published_cases: '0' }));
  assert.equal(emptyImport.ok, false);
  assert.equal(emptyImport.code, 'invalid_published_case_count');
});

test('database config prefers private networking and enforces bounded read-only sessions', () => {
  const config = verificationDatabaseConfig({
    DATABASE_URL: 'postgres://private-host/radar?options=-c%20default_transaction_read_only%3Doff&statement_timeout=0&query_timeout=0',
    DATABASE_PUBLIC_URL: 'postgres://public-host/radar?sslmode=disable',
  });
  assert.equal(config.connectionString, 'postgres://private-host/radar');
  assert.equal(config.ssl, false);
  assert.equal(config.connectionTimeoutMillis, CONNECTION_TIMEOUT_MILLISECONDS);
  assert.equal(config.statement_timeout, STATEMENT_TIMEOUT_MILLISECONDS);
  assert.equal(config.query_timeout, QUERY_TIMEOUT_MILLISECONDS);
  assert.match(config.options, /default_transaction_read_only=on/);
  assert.match(config.options, new RegExp(`statement_timeout=${STATEMENT_TIMEOUT_MILLISECONDS}`));

  const client = new pg.Client(config);
  assert.equal(client.connectionParameters.options, config.options);
  assert.equal(client.connectionParameters.statement_timeout, STATEMENT_TIMEOUT_MILLISECONDS);
  assert.equal(client.connectionParameters.query_timeout, QUERY_TIMEOUT_MILLISECONDS);
  assert.equal(client._connectionTimeoutMillis, CONNECTION_TIMEOUT_MILLISECONDS);
});

test('public database URLs fail closed unless certificate verification is enabled', () => {
  assert.throws(() => verificationDatabaseConfig({
    DATABASE_PUBLIC_URL: 'postgres://public-host/radar?sslmode=disable',
  }), /weryfikacji TLS/);

  const verified = verificationDatabaseConfig({
    DATABASE_PUBLIC_URL: 'postgres://public-host/radar?sslmode=disable&options=-c%20default_transaction_read_only%3Doff&statement_timeout=0&query_timeout=0',
    PGSSLMODE: 'verify-full',
  });
  assert.deepEqual(verified.ssl, { rejectUnauthorized: true });
  const client = new pg.Client(verified);
  assert.deepEqual(client.connectionParameters.ssl, { rejectUnauthorized: true });
  assert.equal(client.connectionParameters.options, verified.options);
  assert.equal(client.connectionParameters.statement_timeout, STATEMENT_TIMEOUT_MILLISECONDS);
  assert.equal(client.connectionParameters.query_timeout, QUERY_TIMEOUT_MILLISECONDS);
  assert.equal(client._connectionTimeoutMillis, CONNECTION_TIMEOUT_MILLISECONDS);
  assert.equal(verificationDatabaseConfig({}), null);
});

test('missing successful import and database failures have stable sanitized codes', async () => {
  const missing = buildRadarImportVerification(healthyRow({
    import_id: null,
    started_at: null,
    finished_at: null,
    period_start: null,
    period_end: null,
    event_new: '0',
    event_changed: '0',
    event_removed: '0',
    event_total: '0',
    first_event_at: null,
    last_event_at: null,
  }));
  assert.equal(missing.code, 'no_successful_import');
  assert.equal(missing.latest_success, null);

  const unavailable = await verifyRadarImport({
    query: async () => { throw new Error('postgres://user:password@private-host/database'); },
  }, new Date(OBSERVED_AT));
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, DATABASE_UNAVAILABLE);
  assert.doesNotMatch(JSON.stringify(unavailable), /password|private-host|postgres:/);
});
