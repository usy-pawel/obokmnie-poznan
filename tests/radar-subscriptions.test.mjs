import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  RADAR_LIMITS,
  RADAR_MONITOR_CREATE_VERSION,
  boundedEventFeed,
  normalizeMonitorCreate,
} from '../lib/radar-subscriptions.mjs';

const NOW = new Date('2026-08-30T12:00:00.000Z');

function request(target, overrides = {}) {
  return {
    version: RADAR_MONITOR_CREATE_VERSION,
    idempotency_key: randomUUID(),
    source: 'new',
    target,
    ...overrides,
  };
}

test('radar limits remain deliberately bounded', () => {
  assert.deepEqual(RADAR_LIMITS, { monitors: 20, parcelMemberships: 100, radiusMonitors: 3 });
});

test('parcel and parcel set targets are strict and canonical', () => {
  const parcel = normalizeMonitorCreate(request({ kind: 'parcel', parcel_id: ' 306401_1.0051/14 ' }), NOW);
  assert.deepEqual(parcel.target, { kind: 'parcel', parcel_ids: ['306401_1.0051/14'] });

  const key = randomUUID();
  const first = normalizeMonitorCreate(request(
    { kind: 'parcel_set', parcel_ids: ['B', 'A'] },
    { idempotency_key: key },
  ), NOW);
  const second = normalizeMonitorCreate(request(
    { kind: 'parcel_set', parcel_ids: ['A', 'B'] },
    { idempotency_key: key },
  ), NOW);
  assert.deepEqual(first.target.parcel_ids, ['A', 'B']);
  assert.deepEqual(first.requestHash, second.requestHash);
  assert.throws(
    () => normalizeMonitorCreate(request({ kind: 'parcel_set', parcel_ids: ['A', 'A'] }), NOW),
    /invalid_monitor_target/,
  );
  assert.throws(
    () => normalizeMonitorCreate(request({ kind: 'parcel', parcel_id: 'A', label: 'adres' }), NOW),
    /invalid_monitor_target/,
  );
  assert.throws(
    () => normalizeMonitorCreate(request({ kind: 'parcel', parcel_id: 123 }), NOW),
    /invalid_parcel_id/,
  );
});

test('radius allows only the three product distances and rounds the point', () => {
  const normalized = normalizeMonitorCreate(request({
    kind: 'radius', lat: 52.406412, lng: 16.925212, radius_m: 3000,
  }), NOW);
  assert.deepEqual(normalized.target, {
    kind: 'radius', lat: 52.4064, lng: 16.9252, radius_m: 3000,
  });
  for (const radius of [499, 501, 999, 1001, 2999, 3001]) {
    assert.throws(
      () => normalizeMonitorCreate(request({ kind: 'radius', lat: 52.4, lng: 16.9, radius_m: radius }), NOW),
      /invalid_monitor_target/,
    );
  }
  assert.throws(
    () => normalizeMonitorCreate(request({ kind: 'radius', lat: Number.NaN, lng: 16.9, radius_m: 500 }), NOW),
    /invalid_monitor_target/,
  );
  assert.throws(
    () => normalizeMonitorCreate(request({ kind: 'radius', lat: '52.4', lng: 16.9, radius_m: 500 }), NOW),
    /invalid_monitor_target/,
  );
});

test('localStorage transition clamps old history and rejects future timestamps', () => {
  const old = normalizeMonitorCreate(request(
    { kind: 'parcel', parcel_id: 'A' },
    { source: 'local_storage_v1', observed_since: '2020-01-01T00:00:00.000Z' },
  ), NOW);
  assert.equal(old.baselineClamped, true);
  assert.equal(old.observedSince.toISOString(), '2026-06-01T12:00:00.000Z');

  assert.throws(() => normalizeMonitorCreate(request(
    { kind: 'parcel', parcel_id: 'A' },
    { source: 'local_storage_v1', observed_since: '2026-08-30T12:06:00.000Z' },
  ), NOW), /invalid_observed_since/);
  assert.throws(() => normalizeMonitorCreate(request(
    { kind: 'parcel', parcel_id: 'A' },
    { observed_since: '2026-08-20T12:00:00.000Z' },
  ), NOW), /invalid_observed_since/);
  assert.throws(() => normalizeMonitorCreate(request(
    { kind: 'parcel', parcel_id: 'A' },
    { source: 'local_storage_v1', observed_since: 1788091200000 },
  ), NOW), /invalid_observed_since/);
});

test('event feed advances only through rows that fit the 256 KiB envelope', () => {
  const rows = [
    { match_id: '41', snapshot: { parcel_ids: ['ą'.repeat(300_000)] } },
    { match_id: '42', snapshot: { parcel_ids: ['B'] } },
  ];
  const feed = boundedEventFeed(rows, '40', '2026-08-30T12:00:00.000Z');
  assert.equal(feed.events.length, 2);
  assert.equal(feed.next_after_match_id, '42');
  assert.equal(feed.events[0].snapshot.parcel_ids[0].length, 120);
  assert.ok(Buffer.byteLength(JSON.stringify(feed)) <= 256 * 1024);
});

test('top-level payload rejects extra or missing properties', () => {
  assert.throws(
    () => normalizeMonitorCreate({ ...request({ kind: 'parcel', parcel_id: 'A' }), email: 'x@example.com' }, NOW),
    /invalid_monitor_request/,
  );
  assert.throws(
    () => normalizeMonitorCreate({ version: RADAR_MONITOR_CREATE_VERSION, source: 'new', target: {} }, NOW),
    /invalid_monitor_request/,
  );
});
