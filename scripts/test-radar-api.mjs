import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';

if (process.env.RADAR_TEST_DATABASE !== '1') {
  throw new Error('test-radar-api wymaga izolowanej bazy i RADAR_TEST_DATABASE=1');
}
if (!process.env.DATABASE_URL) throw new Error('Brak DATABASE_URL izolowanej bazy');
const testUrl = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(testUrl.hostname)
    || !/^\/radar_test_[a-z0-9_]+$/.test(testUrl.pathname)) {
  throw new Error('Test API wymaga bazy radar_test_* dostępnej przez loopback');
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function cookiesFrom(response) {
  const result = new Map();
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(';');
    const separator = pair.indexOf('=');
    result.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return result;
}

function cookieHeader(cookies) {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const logs = [];
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    PGSSLMODE: 'disable',
    RADAR_SERVER_ENABLED: '1',
    RADAR_ALLOWED_ORIGINS: origin,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
server.stderr.on('data', (chunk) => logs.push(chunk.toString()));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Serwer testowy nie wystartował: ${logs.join('').slice(-2000)}`);
}

async function api(path, {
  method = 'GET', cookies, csrf, body, requestOrigin = origin,
} = {}) {
  const headers = { Origin: requestOrigin, 'Sec-Fetch-Site': 'same-origin' };
  if (cookies) headers.Cookie = cookieHeader(cookies);
  if (csrf) headers['X-Radar-CSRF'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${origin}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  if (response.status !== 204) payload = await response.json();
  return { response, payload };
}

const database = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
  statement_timeout: 10_000,
});

try {
  await waitForServer();
  await database.connect();

  const createdProfile = await api('/api/radar/profile', { method: 'POST', body: {} });
  assert.equal(createdProfile.response.status, 201);
  assert.equal(createdProfile.payload.version, 'radar_profile_v1');
  assert.match(createdProfile.response.headers.get('cache-control'), /no-store/);
  const profileCookies = cookiesFrom(createdProfile.response);
  assert.match(profileCookies.get('__Host-radar_profile'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(profileCookies.get('__Host-radar_csrf'), /^[A-Za-z0-9_-]{43}$/);
  const setCookies = createdProfile.response.headers.getSetCookie();
  const profileSetCookie = setCookies.find((value) => value.startsWith('__Host-radar_profile='));
  assert.match(profileSetCookie, /; Path=\//);
  assert.match(profileSetCookie, /; HttpOnly/);
  assert.match(profileSetCookie, /; Secure/);
  assert.match(profileSetCookie, /; SameSite=Strict/);
  const csrfSetCookie = setCookies.find((value) => value.startsWith('__Host-radar_csrf='));
  assert.match(csrfSetCookie, /; Path=\//);
  assert.match(csrfSetCookie, /; Secure/);
  assert.match(csrfSetCookie, /; SameSite=Strict/);
  assert.doesNotMatch(csrfSetCookie, /HttpOnly/);
  let csrf = profileCookies.get('__Host-radar_csrf');
  const recoveredProfile = await api('/api/radar/profile', {
    method: 'POST', cookies: profileCookies, body: {},
  });
  assert.equal(recoveredProfile.response.status, 200);
  const recoveredCookies = cookiesFrom(recoveredProfile.response);
  assert.notEqual(recoveredCookies.get('__Host-radar_csrf'), csrf);
  profileCookies.set('__Host-radar_profile', recoveredCookies.get('__Host-radar_profile'));
  profileCookies.set('__Host-radar_csrf', recoveredCookies.get('__Host-radar_csrf'));
  csrf = recoveredCookies.get('__Host-radar_csrf');

  const rejectedOrigin = await api('/api/radar/profile', {
    method: 'POST', body: {}, requestOrigin: 'https://attacker.example',
  });
  assert.equal(rejectedOrigin.response.status, 403);

  const clientKey = randomUUID();
  const createBody = {
    version: 'radar_monitor_create_v1', idempotency_key: clientKey, source: 'new',
    target: { kind: 'parcel', parcel_id: 'A' },
  };
  const createdWatch = await api('/api/radar/monitors', {
    method: 'POST', cookies: profileCookies, csrf, body: createBody,
  });
  assert.equal(createdWatch.response.status, 201);
  assert.equal(createdWatch.payload.target.parcel_id, 'A');
  const watchId = createdWatch.payload.monitor_id;

  const replay = await api('/api/radar/monitors', {
    method: 'POST', cookies: profileCookies, csrf, body: createBody,
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.payload.monitor_id, watchId);
  const conflict = await api('/api/radar/monitors', {
    method: 'POST', cookies: profileCookies, csrf,
    body: { ...createBody, target: { kind: 'parcel', parcel_id: 'B' } },
  });
  assert.equal(conflict.response.status, 409);

  const extraData = await api('/api/radar/monitors', {
    method: 'POST', cookies: profileCookies, csrf,
    body: { ...createBody, idempotency_key: randomUUID(), label: 'prywatny adres' },
  });
  assert.equal(extraData.response.status, 400);
  const badCsrf = await api(`/api/radar/monitors/${watchId}/pause`, {
    method: 'POST', cookies: profileCookies, csrf: 'x'.repeat(43), body: {},
  });
  assert.equal(badCsrf.response.status, 403);

  const profileTwo = await api('/api/radar/profile', { method: 'POST', body: {} });
  const profileTwoCookies = cookiesFrom(profileTwo.response);
  const profileTwoList = await api('/api/radar/monitors', { cookies: profileTwoCookies });
  assert.equal(profileTwoList.response.status, 200);
  assert.equal(profileTwoList.payload.monitors.length, 0);
  const foreignPause = await api(`/api/radar/monitors/${watchId}/pause`, {
    method: 'POST', cookies: profileTwoCookies, csrf: profileTwoCookies.get('__Host-radar_csrf'), body: {},
  });
  assert.equal(foreignPause.response.status, 404);

  async function publishCase(suffix, parcelId = 'A') {
    await database.query('BEGIN');
    try {
      const imported = await database.query(`
        INSERT INTO imports(source_date,status) VALUES(current_date,'running') RETURNING id
      `);
      const importId = imported.rows[0].id;
      await database.query("SELECT set_config('obokmnie.import_id',$1,false)", [String(importId)]);
      await database.query(`
        INSERT INTO cases(
          case_key,source_type,external_id,received_date,status,voivodeship,description,
          parcel_ids,source_fingerprint,source_active,last_import_id
        ) VALUES($1,'zgloszenie',$2,current_date,'nowa','wielkopolskie',$3,ARRAY[$4],$5,true,$6)
      `, [
        `case:api:${suffix}`, `api-${suffix}`, `API ${suffix}`, parcelId,
        `api-fingerprint-${suffix}`, importId,
      ]);
      await database.query("SELECT pg_advisory_xact_lock(hashtext('radar_watch_projection'))");
      await database.query(`
        UPDATE imports SET status='success',finished_at=clock_timestamp() WHERE id=$1
      `, [importId]);
      await database.query('SELECT * FROM radar_project_import($1)', [importId]);
      await database.query('COMMIT');
    } catch (error) {
      await database.query('ROLLBACK');
      throw error;
    }
  }

  await publishCase('one');
  const firstFeed = await api('/api/radar/events', { cookies: profileCookies });
  assert.equal(firstFeed.response.status, 200);
  assert.equal(firstFeed.payload.events.length, 1);
  assert.deepEqual(firstFeed.payload.events[0].matched_monitor_ids, [watchId]);
  const firstCursor = firstFeed.payload.next_after_match_id;
  const isolatedFeed = await api('/api/radar/events', { cookies: profileTwoCookies });
  assert.equal(isolatedFeed.payload.events.length, 0);
  const invalidCursor = await api('/api/radar/events?after_match_id=99999999999999999999', { cookies: profileCookies });
  assert.equal(invalidCursor.response.status, 400);

  const observationStarted = new Date().toISOString();
  await publishCase('late-b', 'B');
  const migratedWatch = await api('/api/radar/monitors', {
    method: 'POST', cookies: profileCookies, csrf,
    body: {
      version: 'radar_monitor_create_v1', idempotency_key: randomUUID(), source: 'local_storage_v1',
      observed_since: observationStarted,
      target: { kind: 'parcel', parcel_id: 'B' },
    },
  });
  assert.equal(migratedWatch.response.status, 201);
  const lateFeed = await api(`/api/radar/events?after_match_id=${firstCursor}`, { cookies: profileCookies });
  assert.equal(lateFeed.payload.events.length, 1);
  assert.equal(lateFeed.payload.events[0].snapshot.parcel_ids[0], 'B');
  const lateCursor = lateFeed.payload.next_after_match_id;

  const paused = await api(`/api/radar/monitors/${watchId}/pause`, {
    method: 'POST', cookies: profileCookies, csrf, body: {},
  });
  assert.equal(paused.payload.status, 'paused');
  await publishCase('two');
  const pausedFeed = await api(`/api/radar/events?after_match_id=${lateCursor}`, { cookies: profileCookies });
  assert.equal(pausedFeed.payload.events.length, 0);
  const resumed = await api(`/api/radar/monitors/${watchId}/resume`, {
    method: 'POST', cookies: profileCookies, csrf, body: {},
  });
  assert.equal(resumed.payload.status, 'active');
  const resumedFeed = await api(`/api/radar/events?after_match_id=${lateCursor}`, { cookies: profileCookies });
  assert.equal(resumedFeed.payload.events.length, 0);
  await publishCase('three');
  const afterResumeFeed = await api(`/api/radar/events?after_match_id=${lateCursor}`, { cookies: profileCookies });
  assert.equal(afterResumeFeed.payload.events.length, 1);

  const removed = await api(`/api/radar/monitors/${watchId}`, {
    method: 'DELETE', cookies: profileCookies, csrf, body: {},
  });
  assert.equal(removed.response.status, 204);
  const removedAgain = await api(`/api/radar/monitors/${watchId}`, {
    method: 'DELETE', cookies: profileCookies, csrf, body: {},
  });
  assert.equal(removedAgain.response.status, 204);

  const radius = await api('/api/radar/monitors', {
    method: 'POST', cookies: profileCookies, csrf,
    body: {
      version: 'radar_monitor_create_v1', idempotency_key: randomUUID(), source: 'new',
      target: { kind: 'radius', lat: 52.4, lng: 16.9, radius_m: 3000 },
    },
  });
  assert.equal(radius.response.status, 201);
  const parcelSet = await api('/api/radar/monitors', {
    method: 'POST', cookies: profileCookies, csrf,
    body: {
      version: 'radar_monitor_create_v1', idempotency_key: randomUUID(), source: 'new',
      target: { kind: 'parcel_set', parcel_ids: ['A', 'B'] },
    },
  });
  assert.equal(parcelSet.response.status, 201);

  for (let index = 0; index < 17; index += 1) {
    const added = await api('/api/radar/monitors', {
      method: 'POST', cookies: profileCookies, csrf,
      body: {
        version: 'radar_monitor_create_v1', idempotency_key: randomUUID(), source: 'new',
        target: { kind: 'parcel', parcel_id: 'A' },
      },
    });
    assert.equal(added.response.status, 201);
  }
  const overLimit = await api('/api/radar/monitors', {
    method: 'POST', cookies: profileCookies, csrf,
    body: {
      version: 'radar_monitor_create_v1', idempotency_key: randomUUID(), source: 'new',
      target: { kind: 'parcel', parcel_id: 'A' },
    },
  });
  assert.equal(overLimit.response.status, 422);

  const owner = await database.query('SELECT profile_id FROM radar_watches WHERE id=$1', [migratedWatch.payload.monitor_id]);
  await database.query(`
    UPDATE radar_profiles SET rate_window_started_at=date_trunc('hour',clock_timestamp()),monitor_create_count=25
    WHERE id=$1
  `, [owner.rows[0].profile_id]);
  const profileRateLimited = await api('/api/radar/monitors', {
    method: 'POST', cookies: profileCookies, csrf,
    body: {
      version: 'radar_monitor_create_v1', idempotency_key: randomUUID(), source: 'new',
      target: { kind: 'parcel', parcel_id: 'A' },
    },
  });
  assert.equal(profileRateLimited.response.status, 429);

  await database.query(`
    INSERT INTO radar_rate_windows(scope,window_started_at,attempts)
    VALUES('monitor_create',date_trunc('hour',clock_timestamp()),10000)
    ON CONFLICT(scope) DO UPDATE SET
      window_started_at=excluded.window_started_at,attempts=excluded.attempts
  `);
  const globallyLimited = await api('/api/radar/monitors', {
    method: 'POST', cookies: profileTwoCookies, csrf: profileTwoCookies.get('__Host-radar_csrf'),
    body: {
      version: 'radar_monitor_create_v1', idempotency_key: randomUUID(), source: 'new',
      target: { kind: 'parcel', parcel_id: 'A' },
    },
  });
  assert.equal(globallyLimited.response.status, 429);
  await database.query("DELETE FROM radar_rate_windows WHERE scope='monitor_create'");

  const profileRows = await database.query(`
    SELECT count(*)::integer AS count FROM radar_profiles
    WHERE token_hash=$1 OR csrf_hash=$2
  `, [Buffer.from(profileCookies.get('__Host-radar_profile')), Buffer.from(csrf)]);
  assert.equal(profileRows.rows[0].count, 0);

  const deletedProfile = await api('/api/radar/profile', {
    method: 'DELETE', cookies: profileCookies, csrf, body: {},
  });
  assert.equal(deletedProfile.response.status, 204);
  const unavailable = await api('/api/radar/profile', { cookies: profileCookies });
  assert.equal(unavailable.response.status, 401);
  assert.equal(unavailable.payload.error, 'profile_unavailable');

  console.log(JSON.stringify({ ok: true, profile_isolation: true, csrf: true, idempotency: true, limits: true }));
} finally {
  await database.end().catch(() => {});
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once('exit', resolve);
    setTimeout(resolve, 2000).unref();
  });
}
