import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as controlPlane from '../lib/maintenance-control-plane.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  async lock() {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }
}

class FakeControlPool {
  constructor() {
    this.now = new Date('2026-08-30T12:00:00.000Z');
    this.nextRunId = 1;
    this.runs = [];
    this.issues = new Map();
    this.lease = {
      scope: 'radar_operations', run_id: null, owner: null, fence: '0', context_hash: null,
      acquired_at: null, heartbeat_at: null, expires_at: null, actions_disabled: true,
    };
    this.mutex = new Mutex();
    this.loseNextCommitResponse = false;
    this.failBeforeFinalUpdate = false;
    this.localSettings = [];
  }

  state() {
    return structuredClone({
      now: this.now,
      nextRunId: this.nextRunId,
      runs: this.runs,
      issues: this.issues,
      lease: this.lease,
    });
  }

  restore(snapshot) {
    this.now = snapshot.now;
    this.nextRunId = snapshot.nextRunId;
    this.runs = snapshot.runs;
    this.issues = snapshot.issues;
    this.lease = snapshot.lease;
  }

  async query() {
    throw new Error('pool.query must not be used for a transaction');
  }

  async connect() {
    return new FakeControlClient(this);
  }

  advance(minutes) {
    this.now = new Date(this.now.getTime() + minutes * 60_000);
  }
}

class FakeControlClient {
  constructor(pool) {
    this.pool = pool;
    this.unlock = null;
    this.transactionSnapshot = null;
    this.savepoints = new Map();
  }

  release() {}

  response(rows = [], rowCount = rows.length) {
    return { rows, rowCount };
  }

  finishLock() {
    if (this.unlock) this.unlock();
    this.unlock = null;
  }

  matchingRun(handle) {
    return this.pool.runs.find((run) => run.id === String(handle.run_id)
      && run.executor === handle.owner && run.fence === String(handle.fence)
      && run.context_hash === handle.context_hash);
  }

  matchingLease(handle) {
    const lease = this.pool.lease;
    return lease.run_id === String(handle.run_id) && lease.owner === handle.owner
      && lease.fence === String(handle.fence) && lease.context_hash === handle.context_hash;
  }

  async query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (normalized === 'BEGIN') {
      this.transactionSnapshot = this.pool.state();
      return this.response();
    }
    if (normalized.startsWith('SET LOCAL ')) {
      this.pool.localSettings.push(normalized);
      return this.response();
    }
    if (normalized.startsWith('SAVEPOINT ')) {
      this.savepoints.set(normalized.slice('SAVEPOINT '.length), this.pool.state());
      return this.response();
    }
    if (normalized.startsWith('ROLLBACK TO SAVEPOINT ')) {
      const name = normalized.slice('ROLLBACK TO SAVEPOINT '.length);
      this.pool.restore(this.savepoints.get(name));
      return this.response();
    }
    if (normalized === 'COMMIT') {
      this.transactionSnapshot = null;
      this.savepoints.clear();
      this.finishLock();
      if (this.pool.loseNextCommitResponse) {
        this.pool.loseNextCommitResponse = false;
        throw new Error('lost commit response');
      }
      return this.response();
    }
    if (normalized === 'ROLLBACK') {
      if (this.transactionSnapshot) this.pool.restore(this.transactionSnapshot);
      this.transactionSnapshot = null;
      this.savepoints.clear();
      this.finishLock();
      return this.response();
    }
    if (normalized.includes('pg_advisory_xact_lock')) {
      this.unlock = await this.pool.mutex.lock();
      return this.response([{}]);
    }
    if (normalized.startsWith('INSERT INTO maintenance_leases')) return this.response();
    if (normalized.includes('FROM maintenance_leases WHERE scope=$1 FOR UPDATE')) {
      return this.response([{ ...structuredClone(this.pool.lease), observed_at: new Date(this.pool.now) }]);
    }
    if (normalized.includes('WHERE scope=$1 AND invocation_key=$2')) {
      const run = this.pool.runs.find((candidate) => candidate.invocation_key === params[1]);
      return this.response(run ? [structuredClone(run)] : []);
    }
    if (normalized.startsWith('WITH observed AS') && normalized.includes('INSERT INTO maintenance_runs')) {
      const [scope, invocationKey, contractVersion, contextHash, executor, fence] = params;
      const startedAt = new Date(this.pool.now);
      const run = {
        id: String(this.pool.nextRunId++), scope, invocation_key: invocationKey,
        contract_version: contractVersion, context_hash: contextHash, executor,
        fence: String(fence), status: 'running', started_at: startedAt,
        heartbeat_at: startedAt, deadline_at: new Date(startedAt.getTime() + 50 * 60_000),
        finished_at: null, result_code: null, receipt: null,
      };
      this.pool.runs.push(run);
      return this.response([{
        id: run.id, executor: run.executor, fence: run.fence,
        started_at: run.started_at, deadline_at: run.deadline_at,
      }]);
    }
    if (normalized.startsWith('UPDATE maintenance_leases SET run_id=$2::bigint')) {
      const [, runId, owner, fence, contextHash, startedAt, deadlineAt] = params;
      const acquiredAt = new Date(startedAt);
      Object.assign(this.pool.lease, {
        run_id: String(runId), owner, fence: String(fence), context_hash: contextHash,
        acquired_at: acquiredAt, heartbeat_at: acquiredAt,
        expires_at: new Date(Math.min(acquiredAt.getTime() + 20 * 60_000, new Date(deadlineAt).getTime())),
      });
      return this.response([{
        actions_disabled: this.pool.lease.actions_disabled,
        expires_at: this.pool.lease.expires_at,
      }]);
    }
    if (normalized.includes('FROM maintenance_leases lease JOIN maintenance_runs active_run')) {
      const [, runId, owner, fence, contextHash] = params;
      const handle = { run_id: String(runId), owner, fence: String(fence), context_hash: contextHash };
      const run = this.matchingRun(handle);
      const valid = run && this.matchingLease(handle);
      return this.response(valid ? [{
        actions_disabled: this.pool.lease.actions_disabled,
        expires_at: this.pool.lease.expires_at,
        status: run.status,
        deadline_at: run.deadline_at,
        observed_at: new Date(this.pool.now),
      }] : []);
    }
    if (normalized.includes('FROM maintenance_runs WHERE scope=$1 AND id=$2::bigint FOR UPDATE')) {
      const run = this.pool.runs.find((candidate) => candidate.id === String(params[1]));
      return this.response(run ? [structuredClone(run)] : []);
    }
    if (normalized.startsWith('UPDATE maintenance_leases lease SET heartbeat_at=')) {
      const [, runId, owner, fence, contextHash] = params;
      const handle = { run_id: String(runId), owner, fence: String(fence), context_hash: contextHash };
      const run = this.matchingRun(handle);
      if (!run || !this.matchingLease(handle) || run.status !== 'running'
          || this.pool.lease.expires_at <= this.pool.now || run.deadline_at <= this.pool.now) return this.response();
      this.pool.lease.heartbeat_at = new Date(this.pool.now);
      this.pool.lease.expires_at = new Date(Math.min(
        this.pool.now.getTime() + 20 * 60_000,
        run.deadline_at.getTime(),
      ));
      return this.response([{ expires_at: this.pool.lease.expires_at }]);
    }
    if (normalized.startsWith('UPDATE maintenance_runs active_run SET heartbeat_at=')) {
      const [, runId, owner, fence, contextHash] = params;
      const handle = { run_id: String(runId), owner, fence: String(fence), context_hash: contextHash };
      const run = this.matchingRun(handle);
      if (!run || !this.matchingLease(handle) || run.status !== 'running'
          || this.pool.lease.expires_at <= this.pool.now || run.deadline_at <= this.pool.now) return this.response();
      run.heartbeat_at = new Date(this.pool.now);
      return this.response([], 1);
    }
    if (normalized.startsWith('UPDATE maintenance_issues SET status=')) {
      const [, capability, runId] = params;
      let count = 0;
      for (const issue of this.pool.issues.values()) {
        if (issue.capability === capability && issue.status === 'open') {
          issue.status = 'resolved';
          issue.resolved_at = new Date(this.pool.now);
          issue.last_observed_run_id = String(runId);
          count += 1;
        }
      }
      return this.response([], count);
    }
    if (normalized.startsWith('INSERT INTO maintenance_issues')) {
      const [scope, fingerprint, capability, code, severity, owner, nextAction, context, runId] = params;
      const existing = this.pool.issues.get(fingerprint);
      if (!existing) {
        this.pool.issues.set(fingerprint, {
          scope, fingerprint, capability, code, severity, owner, next_action_code: nextAction,
          stable_dimensions: {}, safe_context: JSON.parse(context), status: 'open',
          occurrence_count: 1, last_occurrence_run_id: String(runId),
          last_observed_run_id: String(runId), resolved_at: null,
        });
      } else {
        if (existing.last_occurrence_run_id !== String(runId)) existing.occurrence_count += 1;
        Object.assign(existing, {
          capability, code, severity, owner, next_action_code: nextAction,
          stable_dimensions: {}, safe_context: JSON.parse(context), status: 'open',
          last_occurrence_run_id: String(runId), last_observed_run_id: String(runId), resolved_at: null,
        });
      }
      return this.response([], 1);
    }
    if (normalized.startsWith('SELECT fingerprint, capability, code, severity, owner, next_action_code')) {
      const rows = [...this.pool.issues.values()]
        .filter((issue) => issue.status === 'open')
        .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint))
        .map((issue) => structuredClone(issue));
      return this.response(rows);
    }
    if (normalized.includes("SET status='succeeded'")) {
      if (this.pool.failBeforeFinalUpdate) {
        this.pool.failBeforeFinalUpdate = false;
        throw new Error('injected before final update');
      }
      const [, runId, owner, fence, contextHash, receipt] = params;
      const handle = { run_id: String(runId), owner, fence: String(fence), context_hash: contextHash };
      const run = this.matchingRun(handle);
      if (!run || !this.matchingLease(handle) || run.status !== 'running'
          || this.pool.lease.expires_at <= this.pool.now || run.deadline_at <= this.pool.now) return this.response();
      Object.assign(run, {
        status: 'succeeded', result_code: 'health_sweep_succeeded',
        receipt: JSON.parse(receipt), finished_at: new Date(this.pool.now),
      });
      return this.response([], 1);
    }
    if (normalized.includes("SET status='failed'")) {
      const [, runId, owner, fence, contextHash, code, receipt] = params;
      const handle = { run_id: String(runId), owner, fence: String(fence), context_hash: contextHash };
      const run = this.matchingRun(handle);
      if (!run || !this.matchingLease(handle) || run.status !== 'running'
          || this.pool.lease.expires_at <= this.pool.now || run.deadline_at <= this.pool.now) return this.response();
      Object.assign(run, {
        status: 'failed', result_code: code, receipt: JSON.parse(receipt), finished_at: new Date(this.pool.now),
      });
      return this.response([], 1);
    }
    if (normalized.includes("SET status='timed_out'")) {
      const [, runId, owner, fence, contextHash, receipt] = params;
      const handle = { run_id: String(runId), owner, fence: String(fence), context_hash: contextHash };
      const run = this.matchingRun(handle);
      if (!run || !this.matchingLease(handle) || run.status !== 'running') return this.response();
      Object.assign(run, {
        status: 'timed_out', result_code: 'run_timed_out',
        receipt: JSON.parse(receipt), finished_at: new Date(this.pool.now),
      });
      return this.response([], 1);
    }
    if (normalized.startsWith('UPDATE maintenance_leases SET run_id=NULL')) {
      const [, runId, owner, fence, contextHash] = params;
      const handle = { run_id: String(runId), owner, fence: String(fence), context_hash: contextHash };
      if (!this.matchingLease(handle)) return this.response();
      Object.assign(this.pool.lease, {
        run_id: null, owner: null, context_hash: null,
        acquired_at: null, heartbeat_at: null, expires_at: null,
      });
      return this.response([], 1);
    }
    throw new Error(`Unhandled SQL in fake: ${normalized}`);
  }
}

function fourObservations(overrides = {}) {
  const defaults = {
    web_database: { capability: 'web_database', health: 'healthy', code: null, stable_dimensions: {}, safe_context: {} },
    daily_import: {
      capability: 'daily_import', health: 'unhealthy', code: 'daily_import_failed',
      stable_dimensions: {}, safe_context: { data_status: 'failed', latest_import_id: '42' },
    },
    data_coverage: {
      capability: 'data_coverage', health: 'healthy', code: null,
      stable_dimensions: {}, safe_context: { voivodeships: 16, published_cases: 100 },
    },
    radar_diff: {
      capability: 'radar_diff', health: 'healthy', code: null,
      stable_dimensions: {}, safe_context: { non_success_event_total: 0 },
    },
  };
  return Object.values({ ...defaults, ...overrides });
}

function capability(value) {
  return { capability: value, health: 'healthy', code: null, stable_dimensions: {}, safe_context: {} };
}

test('migration keeps exactly three tables, Newton statuses, strict JSON and Notion ownership policy', async () => {
  const migration = await readFile(new URL('../migrations/010_maintenance_control_plane.sql', import.meta.url), 'utf8');
  assert.equal((migration.match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 3);
  assert.match(migration, /status IN \('running','succeeded','failed','timed_out','blocked'\)/);
  assert.match(migration, /status='running' AND finished_at IS NULL AND result_code IS NULL AND receipt IS NULL/);
  assert.match(migration, /status<>'running' AND finished_at IS NOT NULL\s+AND result_code IS NOT NULL AND receipt IS NOT NULL/);
  assert.match(migration, /actions_disabled boolean NOT NULL DEFAULT true/);
  assert.match(migration, /jsonb_typeof\(receipt\)='object'\) IS TRUE/);
  assert.match(migration, /jsonb_typeof\(safe_context\)='object'\) IS TRUE/);
  for (const field of ['severity text NOT NULL', 'owner text NOT NULL', 'next_action_code text NOT NULL']) {
    assert.match(migration, new RegExp(field));
  }
  assert.match(migration, /daily_import_failed' AND severity='P0'/);
  assert.match(migration, /daily_import_stale' AND severity='P1'/);
  assert.match(migration, /invalid_data_coverage' AND severity='P0'/);
  assert.match(migration, /events_for_non_success_import' AND severity='P0'/);
});

test('module exports exactly four operations and every transaction sets local timeouts', async () => {
  assert.deepEqual(Object.keys(controlPlane).sort(), ['acquire', 'completeHealthSweep', 'failRun', 'heartbeat']);
  const pool = new FakeControlPool();
  await controlPlane.acquire(pool, 'timeouts', HASH_A, 'engineer-a');
  assert.deepEqual(pool.localSettings, [
    "SET LOCAL lock_timeout='5s'",
    "SET LOCAL statement_timeout='10s'",
  ]);
});

test('concurrent acquire returns one immutable handle and busy leaks no identity', async () => {
  const pool = new FakeControlPool();
  const results = await Promise.all([
    controlPlane.acquire(pool, 'invocation-a', HASH_A, 'engineer-a'),
    controlPlane.acquire(pool, 'invocation-b', HASH_B, 'engineer-b'),
  ]);
  const acquired = results.find((result) => result.status === 'acquired');
  const busy = results.find((result) => result.status === 'busy');
  assert.deepEqual(Object.keys(acquired.handle).sort(), ['context_hash', 'fence', 'owner', 'run_id']);
  assert.equal(acquired.actions_disabled, true);
  assert.deepEqual(busy, { status: 'busy', code: 'lease_busy' });
});

test('full handle identity rejects a correct fence with wrong run, owner or context', async () => {
  const pool = new FakeControlPool();
  const acquired = await controlPlane.acquire(pool, 'handle', HASH_A, 'engineer-a');
  for (const handle of [
    { ...acquired.handle, run_id: '999' },
    { ...acquired.handle, owner: 'engineer-b' },
    { ...acquired.handle, context_hash: HASH_B },
  ]) {
    await assert.rejects(controlPlane.heartbeat(pool, handle), (error) => error.code === 'stale_fence');
  }
  assert.equal(pool.runs[0].status, 'running');
});

test('handle validation rejects PostgreSQL bigint overflow before opening a transaction', async () => {
  const pool = new FakeControlPool();
  const acquired = await controlPlane.acquire(pool, 'handle-range', HASH_A, 'engineer-a');
  const localSettingsCount = pool.localSettings.length;
  for (const handle of [
    { ...acquired.handle, run_id: '9223372036854775808' },
    { ...acquired.handle, fence: 9223372036854775808n },
  ]) {
    await assert.rejects(
      controlPlane.heartbeat(pool, handle),
      (error) => error.code === 'invalid_handle',
    );
  }
  assert.equal(pool.localSettings.length, localSettingsCount);
});

test('acquire detects idempotency conflict and recovers a receipt after COMMIT response loss', async () => {
  const pool = new FakeControlPool();
  const acquired = await controlPlane.acquire(pool, 'lost-response', HASH_A, 'engineer-a');
  const activeRetry = await controlPlane.acquire(pool, 'lost-response', HASH_A, 'engineer-b');
  assert.equal(activeRetry.status, 'acquired');
  assert.equal(activeRetry.handle.owner, 'engineer-a');
  await assert.rejects(
    controlPlane.acquire(pool, 'lost-response', HASH_B, 'engineer-a'),
    (error) => error.code === 'idempotency_conflict',
  );
  pool.loseNextCommitResponse = true;
  await assert.rejects(
    controlPlane.completeHealthSweep(pool, acquired.handle, fourObservations()),
    (error) => error.code === 'database_unavailable',
  );
  const recovered = await controlPlane.acquire(pool, 'lost-response', HASH_A, 'engineer-b');
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.receipt.code, 'health_sweep_succeeded');
});

test('expired contact atomically materializes timed_out and a new acquire increments fence', async () => {
  const pool = new FakeControlPool();
  const first = await controlPlane.acquire(pool, 'expired', HASH_A, 'engineer-a');
  pool.advance(21);
  const timeout = await controlPlane.heartbeat(pool, first.handle);
  assert.equal(timeout.status, 'timed_out');
  assert.equal(pool.runs[0].status, 'timed_out');
  assert.equal(pool.lease.run_id, null);
  const second = await controlPlane.acquire(pool, 'takeover', HASH_B, 'engineer-b');
  assert.equal(BigInt(second.handle.fence), BigInt(first.handle.fence) + 1n);
  await assert.rejects(controlPlane.heartbeat(pool, first.handle), (error) => error.code === 'stale_fence');
});

test('heartbeat caps the lease at 50 minutes and reaps contact at the deadline', async () => {
  const pool = new FakeControlPool();
  const acquired = await controlPlane.acquire(pool, 'bounded', HASH_A, 'engineer-a');
  pool.advance(19);
  await controlPlane.heartbeat(pool, acquired.handle);
  pool.advance(19);
  const heartbeat = await controlPlane.heartbeat(pool, acquired.handle);
  assert.equal(heartbeat.expires_at, '2026-08-30T12:50:00.000Z');
  pool.advance(12);
  const timeout = await controlPlane.completeHealthSweep(pool, acquired.handle, fourObservations());
  assert.equal(timeout.status, 'timed_out');
});

test('complete requires exactly one global observation per capability with null code outside unhealthy', async () => {
  const pool = new FakeControlPool();
  const acquired = await controlPlane.acquire(pool, 'crafted', HASH_A, 'engineer-a');
  const invalid = [
    fourObservations().slice(0, 3),
    [capability('web_database'), capability('daily_import'), capability('data_coverage'), capability('daily_import')],
    fourObservations({ web_database: { ...capability('web_database'), code: 'daily_import_failed' } }),
    fourObservations({ radar_diff: { ...capability('radar_diff'), health: 'unknown', code: 'events_for_non_success_import' } }),
    fourObservations({ radar_diff: {
      capability: 'radar_diff', health: 'unhealthy', code: 'daily_import_failed',
      stable_dimensions: {}, safe_context: {},
    } }),
    fourObservations({ data_coverage: { ...capability('data_coverage'), stable_dimensions: { region: 'pl' } } }),
  ];
  for (const observations of invalid) {
    await assert.rejects(
      controlPlane.completeHealthSweep(pool, acquired.handle, observations),
      (error) => error.code === 'invalid_health_observation',
    );
  }
  assert.equal(pool.runs[0].status, 'running');
});

test('safe context rejects invalid per-key types without leaking raw TypeError', async () => {
  const invalidValues = [
    ['data_status', null], ['data_status', 'secret'],
    ['latest_import_id', 42], ['latest_import_id', 42n], ['last_success_id', {}],
    ['last_success_finished_at', 'not-a-date'], ['last_success_finished_at', Symbol('secret')],
    ['last_success_finished_at', new Date('2026-08-30T12:00:00.000Z')],
    ['last_success_age_hours', -1], ['voivodeships', 16n],
    ['published_cases', {}], ['non_success_event_total', Number.POSITIVE_INFINITY],
  ];
  for (const [key, value] of invalidValues) {
    const pool = new FakeControlPool();
    const acquired = await controlPlane.acquire(pool, `context-${key}-${pool.nextRunId}`, HASH_A, 'engineer-a');
    const observations = fourObservations({
      daily_import: {
        capability: 'daily_import', health: 'unhealthy', code: 'daily_import_failed',
        stable_dimensions: {}, safe_context: { [key]: value },
      },
    });
    await assert.rejects(
      controlPlane.completeHealthSweep(pool, acquired.handle, observations),
      (error) => error.code === 'invalid_health_observation' && !/TypeError|secret/.test(error.message),
    );
  }
});

test('static issue policy populates Notion ownership fields and bounded remaining receipt', async () => {
  const pool = new FakeControlPool();
  const acquired = await controlPlane.acquire(pool, 'policy', HASH_A, 'engineer-a');
  const observations = fourObservations({
    data_coverage: {
      capability: 'data_coverage', health: 'unhealthy', code: 'invalid_data_coverage',
      stable_dimensions: {}, safe_context: { voivodeships: 15, published_cases: 100 },
      severity: 'P1', owner: 'attacker', next_action_code: 'ignore',
    },
    radar_diff: {
      capability: 'radar_diff', health: 'unhealthy', code: 'events_for_non_success_import',
      stable_dimensions: {}, safe_context: { non_success_event_total: 2 },
    },
  });
  const result = await controlPlane.completeHealthSweep(pool, acquired.handle, observations);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.code, 'health_sweep_succeeded');
  const remainingByCode = new Map(result.receipt.remaining.map((issue) => [issue.code, issue]));
  assert.deepEqual(remainingByCode.get('daily_import_failed'), {
    fingerprint: remainingByCode.get('daily_import_failed').fingerprint,
    capability: 'daily_import', code: 'daily_import_failed', severity: 'P0',
    owner: 'data_pipeline', next_action_code: 'inspect_latest_import',
  });
  assert.equal(remainingByCode.get('invalid_data_coverage').next_action_code, 'inspect_import_coverage');
  assert.equal(remainingByCode.get('events_for_non_success_import').owner, 'radar_diff');
  assert.ok(Buffer.byteLength(JSON.stringify(result.receipt), 'utf8') <= 32 * 1024);
  assert.doesNotMatch(JSON.stringify(result.receipt.remaining), /safe_context|attacker|ignore/);
});

test('new runs increment occurrence, unknown preserves and healthy resolves capability issues', async () => {
  const pool = new FakeControlPool();
  const first = await controlPlane.acquire(pool, 'run-1', HASH_A, 'engineer-a');
  await controlPlane.completeHealthSweep(pool, first.handle, fourObservations());
  const issue = [...pool.issues.values()][0];
  assert.equal(issue.occurrence_count, 1);

  const second = await controlPlane.acquire(pool, 'run-2', HASH_B, 'engineer-b');
  await controlPlane.completeHealthSweep(pool, second.handle, fourObservations());
  assert.equal(issue.occurrence_count, 2);

  const third = await controlPlane.acquire(pool, 'run-3', 'c'.repeat(64), 'engineer-c');
  await controlPlane.completeHealthSweep(pool, third.handle, fourObservations({
    daily_import: { ...capability('daily_import'), health: 'unknown' },
  }));
  assert.equal(issue.status, 'open');

  const fourth = await controlPlane.acquire(pool, 'run-4', 'd'.repeat(64), 'engineer-d');
  await controlPlane.completeHealthSweep(pool, fourth.handle, fourObservations({
    daily_import: capability('daily_import'),
  }));
  assert.equal(issue.status, 'resolved');
});

test('rollback restores issue, lease and run when failure occurs before final UPDATE', async () => {
  const pool = new FakeControlPool();
  const acquired = await controlPlane.acquire(pool, 'rollback', HASH_A, 'engineer-a');
  pool.failBeforeFinalUpdate = true;
  await assert.rejects(
    controlPlane.completeHealthSweep(pool, acquired.handle, fourObservations()),
    (error) => error.code === 'database_unavailable',
  );
  assert.equal(pool.issues.size, 0);
  assert.equal(pool.runs[0].status, 'running');
  assert.equal(pool.lease.run_id, acquired.handle.run_id);
  const retried = await controlPlane.completeHealthSweep(pool, acquired.handle, fourObservations());
  assert.equal(retried.status, 'succeeded');
});

test('release is rejected if an open issue lacks deterministic ownership fields', async () => {
  const pool = new FakeControlPool();
  pool.issues.set('f'.repeat(64), {
    fingerprint: 'f'.repeat(64), capability: 'daily_import', code: 'daily_import_failed',
    severity: null, owner: null, next_action_code: null, status: 'open', occurrence_count: 1,
  });
  const acquired = await controlPlane.acquire(pool, 'unowned', HASH_A, 'engineer-a');
  await assert.rejects(
    controlPlane.completeHealthSweep(pool, acquired.handle, fourObservations({
      daily_import: { ...capability('daily_import'), health: 'unknown' },
    })),
    (error) => error.code === 'unowned_open_issue',
  );
  assert.equal(pool.runs[0].status, 'running');
  assert.equal(pool.lease.run_id, acquired.handle.run_id);
});

test('failRun stores a closed typed code, remaining accountability and clears the lease', async () => {
  const pool = new FakeControlPool();
  const acquired = await controlPlane.acquire(pool, 'failed', HASH_A, 'engineer-a');
  const failed = await controlPlane.failRun(pool, acquired.handle, 'health_sweep_failed');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.receipt.remaining, []);
  assert.equal(pool.lease.run_id, null);
  await assert.rejects(
    controlPlane.failRun(pool, acquired.handle, 'passwordsecret'),
    (error) => error.code === 'invalid_typed_code',
  );
});
