import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyDataStatus,
  DATABASE_UNAVAILABLE,
  readDataStatus,
  readHealth,
} from '../lib/service-health.mjs';

const NOW = new Date('2026-08-30T12:00:00.000Z');

function snapshot(snapshot, overrides = {}) {
  return {
    snapshot,
    id: snapshot === 'latest' ? 11 : 10,
    status: 'success',
    started_at: '2026-08-30T09:00:00.000Z',
    finished_at: '2026-08-30T10:00:00.000Z',
    period_start: '2025-08-30',
    period_end: '2026-08-30',
    metrics: { published_cases: 100 },
    ...overrides,
  };
}

test('health is unavailable when the database is missing or unreachable', async () => {
  const missing = await readHealth(null);
  assert.equal(missing.statusCode, 503);
  assert.deepEqual(missing.body, {
    ok: false,
    database: false,
    configured: false,
    code: DATABASE_UNAVAILABLE,
  });

  const unreachable = await readHealth({ query: async () => { throw new Error('secret detail'); } });
  assert.equal(unreachable.statusCode, 503);
  assert.equal(unreachable.body.code, DATABASE_UNAVAILABLE);
  assert.equal(unreachable.body.configured, true);
  assert.doesNotMatch(JSON.stringify(unreachable.body), /secret detail/);
});

test('health succeeds only after the database query succeeds', async () => {
  const queries = [];
  const result = await readHealth({ query: async (sql) => { queries.push(sql); } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true, database: true, configured: true });
  assert.deepEqual(queries, ['SELECT 1']);
});

test('data status returns latest and the independent last successful import', async () => {
  const latest = snapshot('latest', {
    id: 12,
    status: 'failed',
    finished_at: '2026-08-30T11:30:00.000Z',
    metrics: {
      published_cases: 100,
      unsafe_note: 'postgres://user:secret@internal/database',
    },
  });
  const lastSuccess = snapshot('last_success');
  const result = await readDataStatus({ query: async () => ({ rows: [latest, lastSuccess] }) }, NOW);

  assert.equal(result.statusCode, 503);
  assert.equal(result.body.status, 'failed');
  assert.equal(result.body.latest.id, 12);
  assert.equal(result.body.latest.status, 'failed');
  assert.equal(result.body.last_success.id, 10);
  assert.equal(result.body.last_success.status, 'success');
  assert.equal(result.body.last_import.state, 'failed');
  assert.equal('status' in result.body.last_import, false);
  assert.equal('snapshot' in result.body.latest, false);
  assert.deepEqual(result.body.latest.metrics, { published_cases: 100 });
  assert.doesNotMatch(JSON.stringify(result.body), /secret|postgres:/);
});

test('data status maps stale and failed to 503, updating and healthy to 200', async () => {
  const success = snapshot('latest');
  const recentSuccess = snapshot('last_success');
  const staleSuccess = snapshot('last_success', { finished_at: '2026-08-27T11:59:59.000Z' });

  assert.equal(classifyDataStatus(success, recentSuccess, NOW), 'healthy');
  assert.equal(classifyDataStatus(success, staleSuccess, NOW), 'stale');
  assert.equal(classifyDataStatus(snapshot('latest', {
    status: 'running',
    started_at: '2026-08-30T10:00:00.000Z',
    finished_at: null,
  }), recentSuccess, NOW), 'updating');
  assert.equal(classifyDataStatus(snapshot('latest', {
    status: 'running',
    started_at: '2026-08-30T10:00:00.000Z',
    finished_at: null,
  }), null, NOW), 'stale');
  assert.equal(classifyDataStatus(snapshot('latest', {
    status: 'running',
    started_at: '2026-08-30T10:00:00.000Z',
    finished_at: null,
  }), staleSuccess, NOW), 'stale');
  assert.equal(classifyDataStatus(snapshot('latest', {
    status: 'running',
    started_at: '2026-08-30T08:59:59.000Z',
    finished_at: null,
  }), recentSuccess, NOW), 'failed');

  for (const [latest, lastSuccess, expectedStatus, expectedCode] of [
    [success, recentSuccess, 'healthy', 200],
    [success, staleSuccess, 'stale', 503],
    [snapshot('latest', { status: 'running', finished_at: null }), recentSuccess, 'updating', 200],
  ]) {
    const result = await readDataStatus({ query: async () => ({ rows: [latest, lastSuccess] }) }, NOW);
    assert.equal(result.body.status, expectedStatus);
    assert.equal(result.statusCode, expectedCode);
  }
});

test('data status reports database_unavailable without leaking connection errors', async () => {
  const result = await readDataStatus({ query: async () => { throw new Error('postgres://user:pass@host'); } }, NOW);
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, {
    status: 'failed',
    code: DATABASE_UNAVAILABLE,
    database: { configured: true, reachable: false },
    latest: null,
    last_success: null,
    last_import: null,
  });
});
