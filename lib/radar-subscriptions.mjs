import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';

export const RADAR_PROFILE_VERSION = 'radar_profile_v1';
export const RADAR_MONITOR_VERSION = 'radar_monitor_v1';
export const RADAR_MONITOR_CREATE_VERSION = 'radar_monitor_create_v1';
export const RADAR_LIMITS = Object.freeze({ monitors: 20, parcelMemberships: 100, radiusMonitors: 3 });

const PARCEL_ID = /^[\p{L}\p{N}_.\/-]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PROFILE_INACTIVITY_DAYS = 90;
const PROFILE_ABSOLUTE_DAYS = 365;
const MAX_EVENTS = 50;
const MAX_FEED_BYTES = 256 * 1024;
const CREATE_WINDOW_MS = 60 * 60 * 1000;
const CREATE_LIMIT_PER_IP = 5;
const MAX_PROFILE_RATE_KEYS = 2_000;
const PROFILE_RATE_LIMITS = Object.freeze({ monitor_create: 25, mutation: 60, feed_read: 600 });

class RadarError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function optionalObject(value, requiredKeys, optionalKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => actual.includes(key)) && actual.every((key) => allowed.has(key));
}

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

function safeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left || '');
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  const result = new Map();
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) result.set(name, value);
  }
  return result;
}

function cookieConfig(environment) {
  const secure = environment.RADAR_SECURE_COOKIES !== 'false';
  return {
    secure,
    profileName: secure ? '__Host-radar_profile' : 'radar_profile',
    csrfName: secure ? '__Host-radar_csrf' : 'radar_csrf',
  };
}

function cookieOptions(secure, httpOnly) {
  return {
    httpOnly,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: PROFILE_ABSOLUTE_DAYS * 86400 * 1000,
  };
}

function setProfileCookies(response, environment, token, csrf) {
  const config = cookieConfig(environment);
  response.cookie(config.profileName, token, cookieOptions(config.secure, true));
  response.cookie(config.csrfName, csrf, cookieOptions(config.secure, false));
}

function clearProfileCookies(response, environment) {
  const config = cookieConfig(environment);
  response.clearCookie(config.profileName, cookieOptions(config.secure, true));
  response.clearCookie(config.csrfName, cookieOptions(config.secure, false));
}

function allowedOrigins(environment) {
  const configured = String(environment.RADAR_ALLOWED_ORIGINS || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  return new Set(configured.length ? configured : [
    'https://radarzmian.pl',
    'https://www.radarzmian.pl',
    'https://obokmnie-poznan-production.up.railway.app',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
  ]);
}

function requireSameOrigin(request, environment) {
  const origin = String(request.headers.origin || '');
  const fetchSite = String(request.headers['sec-fetch-site'] || '');
  if (!allowedOrigins(environment).has(origin)) throw new RadarError(403, 'origin_forbidden');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    throw new RadarError(403, 'origin_forbidden');
  }
}

function requireJson(request) {
  if (!request.is('application/json')) throw new RadarError(415, 'json_required');
}

function normalizeParcelId(value) {
  if (typeof value !== 'string') throw new RadarError(400, 'invalid_parcel_id');
  const parcelId = value.trim();
  if (!parcelId || parcelId.length > 120 || !PARCEL_ID.test(parcelId)) {
    throw new RadarError(400, 'invalid_parcel_id');
  }
  return parcelId;
}

export function normalizeMonitorCreate(body, now = new Date()) {
  if (!optionalObject(body, ['version', 'idempotency_key', 'source', 'target'], ['observed_since'])
      || body.version !== RADAR_MONITOR_CREATE_VERSION
      || typeof body.idempotency_key !== 'string'
      || !UUID.test(body.idempotency_key)
      || !['new', 'local_storage_v1'].includes(body.source)) {
    throw new RadarError(400, 'invalid_monitor_request');
  }
  if ((body.source === 'local_storage_v1') !== Object.hasOwn(body, 'observed_since')) {
    throw new RadarError(400, 'invalid_observed_since');
  }

  let observedSince = null;
  let requestedObservedSince = null;
  let baselineClamped = false;
  if (body.source === 'local_storage_v1') {
    if (typeof body.observed_since !== 'string') throw new RadarError(400, 'invalid_observed_since');
    requestedObservedSince = new Date(body.observed_since);
    if (Number.isNaN(requestedObservedSince.getTime())) throw new RadarError(400, 'invalid_observed_since');
    observedSince = new Date(requestedObservedSince);
    const earliest = new Date(now.getTime() - PROFILE_INACTIVITY_DAYS * 86400 * 1000);
    const latest = new Date(now.getTime() + 5 * 60 * 1000);
    if (observedSince < earliest) { observedSince = earliest; baselineClamped = true; }
    if (observedSince > latest) throw new RadarError(400, 'invalid_observed_since');
    if (observedSince > now) { observedSince = now; baselineClamped = true; }
  }

  const target = body.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new RadarError(400, 'invalid_monitor_target');
  }
  let normalizedTarget;
  if (target.kind === 'parcel') {
    if (!exactObject(target, ['kind', 'parcel_id'])) throw new RadarError(400, 'invalid_monitor_target');
    normalizedTarget = { kind: 'parcel', parcel_ids: [normalizeParcelId(target.parcel_id)] };
  } else if (target.kind === 'parcel_set') {
    if (!exactObject(target, ['kind', 'parcel_ids']) || !Array.isArray(target.parcel_ids)) {
      throw new RadarError(400, 'invalid_monitor_target');
    }
    const parcelIds = [...new Set(target.parcel_ids.map(normalizeParcelId))].sort();
    if (parcelIds.length < 2 || parcelIds.length > 20 || parcelIds.length !== target.parcel_ids.length) {
      throw new RadarError(400, 'invalid_monitor_target');
    }
    normalizedTarget = { kind: 'parcel_set', parcel_ids: parcelIds };
  } else if (target.kind === 'radius') {
    if (!exactObject(target, ['kind', 'lat', 'lng', 'radius_m'])) {
      throw new RadarError(400, 'invalid_monitor_target');
    }
    if (typeof target.lat !== 'number' || typeof target.lng !== 'number'
        || typeof target.radius_m !== 'number') {
      throw new RadarError(400, 'invalid_monitor_target');
    }
    const lat = target.lat;
    const lng = target.lng;
    const radius = target.radius_m;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)
        || lat < 48.5 || lat > 55.5 || lng < 13.5 || lng > 24.8
        || ![500, 1000, 3000].includes(radius)) {
      throw new RadarError(400, 'invalid_monitor_target');
    }
    normalizedTarget = {
      kind: 'radius',
      lat: Math.round(lat * 10000) / 10000,
      lng: Math.round(lng * 10000) / 10000,
      radius_m: radius,
    };
  } else {
    throw new RadarError(400, 'invalid_monitor_target');
  }

  const canonical = JSON.stringify({
    version: RADAR_MONITOR_CREATE_VERSION,
    source: body.source,
    observed_since: requestedObservedSince?.toISOString() || null,
    target: normalizedTarget,
  });
  return {
    clientKey: body.idempotency_key.toLowerCase(),
    source: body.source,
    observedSince,
    baselineClamped,
    target: normalizedTarget,
    requestHash: sha256(canonical),
  };
}

async function transaction(database, callback) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='5s'");
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function authenticatedProfile(request, client, environment, { csrf = false, lock = false } = {}) {
  const config = cookieConfig(environment);
  const cookies = parseCookies(request.headers.cookie);
  const rawToken = cookies.get(config.profileName) || '';
  if (!TOKEN.test(rawToken)) throw new RadarError(401, 'profile_unavailable');
  const params = [sha256(rawToken)];
  let where = 'token_hash=$1 AND inactive_expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp()';
  if (csrf) {
    const rawCsrf = String(request.headers['x-radar-csrf'] || '');
    const cookieCsrf = cookies.get(config.csrfName) || '';
    if (!TOKEN.test(rawCsrf) || !TOKEN.test(cookieCsrf) || !safeEqual(rawCsrf, cookieCsrf)) {
      throw new RadarError(403, 'csrf_invalid');
    }
    params.push(sha256(rawCsrf));
    where += ' AND csrf_hash=$2';
  }
  const result = await client.query(`
    SELECT id,created_at,last_active_on,inactive_expires_at,absolute_expires_at
    FROM radar_profiles WHERE ${where} ${lock ? 'FOR UPDATE' : ''}
  `, params);
  if (!result.rowCount) throw new RadarError(401, 'profile_unavailable');
  const profile = result.rows[0];
  const refreshed = await client.query(`
    UPDATE radar_profiles
    SET last_active_on=current_date,
        inactive_expires_at=least(absolute_expires_at,clock_timestamp()+interval '90 days')
    WHERE id=$1 AND last_active_on<current_date
    RETURNING id,created_at,last_active_on,inactive_expires_at,absolute_expires_at
  `, [profile.id]);
  return refreshed.rows[0] || profile;
}

function profileBody(profile) {
  return {
    version: RADAR_PROFILE_VERSION,
    created_at: profile.created_at,
    inactive_expires_at: profile.inactive_expires_at,
    absolute_expires_at: profile.absolute_expires_at,
    limits: {
      monitors: RADAR_LIMITS.monitors,
      parcel_memberships: RADAR_LIMITS.parcelMemberships,
      radius_monitors: RADAR_LIMITS.radiusMonitors,
    },
  };
}

function targetFromRow(row) {
  if (row.kind === 'radius') {
    return { kind: 'radius', lat: Number(row.lat), lng: Number(row.lng), radius_m: Number(row.radius_m) };
  }
  if (row.kind === 'parcel') return { kind: 'parcel', parcel_id: row.parcel_ids[0] };
  return { kind: 'parcel_set', parcel_ids: row.parcel_ids };
}

function watchBody(row, baselineClamped = false) {
  return {
    version: RADAR_MONITOR_VERSION,
    monitor_id: row.id,
    status: row.state,
    target: targetFromRow(row),
    created_at: row.created_at,
    baseline_import_id: String(row.starts_after_import_id),
    ...(baselineClamped ? { baseline_clamped: true } : {}),
  };
}

const WATCH_SELECT = `
  SELECT watch.id,watch.state,watch.kind,watch.radius_m,watch.starts_after_import_id,
         watch.created_at,ST_Y(watch.anchor) AS lat,ST_X(watch.anchor) AS lng,
         coalesce(array_agg(membership.parcel_id ORDER BY membership.parcel_id)
           FILTER (WHERE membership.parcel_id IS NOT NULL),'{}') AS parcel_ids
  FROM radar_watches watch
  LEFT JOIN radar_watch_parcels membership ON membership.watch_id=watch.id
`;

function rateLimitKey(request, salt) {
  const address = String(request.ip || request.socket?.remoteAddress || 'unknown');
  return createHash('sha256').update(salt).update(address).digest('hex');
}

function bigintCursor(value) {
  const cursor = String(value || '0');
  if (!/^\d{1,19}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n) {
    throw new RadarError(400, 'invalid_event_cursor');
  }
  return cursor.replace(/^0+(?=\d)/, '');
}

function canCreateProfile(rateLimits, request, salt, now = Date.now()) {
  const key = rateLimitKey(request, salt);
  for (const [candidate, entry] of rateLimits) {
    if (now - entry.startedAt >= CREATE_WINDOW_MS) rateLimits.delete(candidate);
  }
  const current = rateLimits.get(key);
  if (!current || now - current.startedAt >= CREATE_WINDOW_MS) {
    if (!current && rateLimits.size >= MAX_PROFILE_RATE_KEYS) return false;
    rateLimits.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= CREATE_LIMIT_PER_IP) return false;
  current.count += 1;
  return true;
}

function configuredPositiveInteger(environment, name, fallback, maximum = 1_000_000) {
  const configured = Number(environment[name] || fallback);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= maximum ? configured : fallback;
}

async function chargeGlobalRate(client, scope, limit) {
  try {
    await client.query('SELECT radar_charge_global_rate($1,$2)', [scope, limit]);
  } catch (error) {
    if (String(error?.message || '').includes('radar_global_rate_limited')) {
      throw new RadarError(429, 'capacity_limited');
    }
    throw error;
  }
}

async function chargeProfileRate(client, profileId, kind, limit) {
  const result = await client.query(`
    WITH moment AS (SELECT date_trunc('hour',clock_timestamp()) AS window_start)
    UPDATE radar_profiles profile SET
      monitor_create_count=CASE
        WHEN profile.rate_window_started_at<moment.window_start THEN CASE WHEN $2='monitor_create' THEN 1 ELSE 0 END
        ELSE profile.monitor_create_count + CASE WHEN $2='monitor_create' THEN 1 ELSE 0 END
      END,
      mutation_count=CASE
        WHEN profile.rate_window_started_at<moment.window_start THEN CASE WHEN $2='mutation' THEN 1 ELSE 0 END
        ELSE profile.mutation_count + CASE WHEN $2='mutation' THEN 1 ELSE 0 END
      END,
      feed_read_count=CASE
        WHEN profile.rate_window_started_at<moment.window_start THEN CASE WHEN $2='feed_read' THEN 1 ELSE 0 END
        ELSE profile.feed_read_count + CASE WHEN $2='feed_read' THEN 1 ELSE 0 END
      END,
      rate_window_started_at=moment.window_start
    FROM moment
    WHERE profile.id=$1
    RETURNING CASE $2
      WHEN 'monitor_create' THEN profile.monitor_create_count
      WHEN 'mutation' THEN profile.mutation_count
      WHEN 'feed_read' THEN profile.feed_read_count
    END AS charged
  `, [profileId, kind]);
  if (!result.rowCount || Number(result.rows[0].charged) > limit) {
    throw new RadarError(429, 'rate_limited');
  }
}

export function boundedEventFeed(rows, after, checkedAt = new Date().toISOString(), maximumEvents = MAX_EVENTS) {
  const events = [];
  for (const row of rows) {
    if (events.length >= maximumEvents) break;
    const boundedRow = {
      match_id: String(row.match_id).slice(0, 19),
      event_id: String(row.event_id).slice(0, 19),
      import_id: String(row.import_id).slice(0, 19),
      event_type: typeof row.event_type === 'string' ? row.event_type.slice(0, 20) : null,
      changed_fields: Array.isArray(row.changed_fields)
        ? row.changed_fields.filter((value) => typeof value === 'string')
          .slice(0, 20).map((value) => value.slice(0, 80))
        : [],
      snapshot: {
        case_key: typeof row.snapshot?.case_key === 'string' ? row.snapshot.case_key.slice(0, 200) : null,
        external_id: typeof row.snapshot?.external_id === 'string' ? row.snapshot.external_id.slice(0, 200) : null,
        source_type: typeof row.snapshot?.source_type === 'string' ? row.snapshot.source_type.slice(0, 40) : null,
        received_date: typeof row.snapshot?.received_date === 'string' ? row.snapshot.received_date.slice(0, 40) : null,
        decision_date: typeof row.snapshot?.decision_date === 'string' ? row.snapshot.decision_date.slice(0, 40) : null,
        status: typeof row.snapshot?.status === 'string' ? row.snapshot.status.slice(0, 120) : null,
        city: typeof row.snapshot?.city === 'string' ? row.snapshot.city.slice(0, 120) : null,
        address: typeof row.snapshot?.address === 'string' ? row.snapshot.address.slice(0, 200) : null,
        description: typeof row.snapshot?.description === 'string' ? row.snapshot.description.slice(0, 1000) : null,
        parcel_ids: Array.isArray(row.snapshot?.parcel_ids)
          ? row.snapshot.parcel_ids.filter((value) => typeof value === 'string')
            .slice(0, 20).map((value) => value.slice(0, 120))
          : [],
        parcel_ids_truncated: row.snapshot?.parcel_ids_truncated === true
          || (Array.isArray(row.snapshot?.parcel_ids) && row.snapshot.parcel_ids.length > 20),
      },
      occurred_at: row.occurred_at,
      detected_at: row.detected_at,
      matched_monitor_ids: Array.isArray(row.matched_monitor_ids)
        ? row.matched_monitor_ids.filter((value) => typeof value === 'string')
          .slice(0, 20).map((value) => value.slice(0, 36))
        : [],
    };
    const candidate = [...events, boundedRow];
    const body = {
      version: 'radar_event_feed_v1',
      events: candidate,
      next_after_match_id: boundedRow.match_id,
      has_more: rows.length > candidate.length,
      checked_at: checkedAt,
    };
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_FEED_BYTES) break;
    events.push(boundedRow);
  }
  return {
    version: 'radar_event_feed_v1',
    events,
    next_after_match_id: events.length ? String(events.at(-1).match_id) : after,
    has_more: rows.length > events.length,
    checked_at: checkedAt,
  };
}

export function createRadarSubscriptionsRouter({ database, environment = process.env } = {}) {
  const router = express.Router();
  const profileRateLimits = new Map();
  const profileRateSalt = randomBytes(32);
  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    response.vary('Cookie');
    response.vary('Origin');
    next();
  });
  router.use(express.json({ limit: '8kb', strict: true, type: 'application/json' }));

  router.post('/profile', async (request, response, next) => {
    try {
      if (!database) throw new RadarError(503, 'database_unavailable');
      requireSameOrigin(request, environment);
      requireJson(request);
      if (!exactObject(request.body, [])) throw new RadarError(400, 'invalid_profile_request');
      const config = cookieConfig(environment);
      const existingToken = parseCookies(request.headers.cookie).get(config.profileName) || '';
      if (TOKEN.test(existingToken)) {
        try {
          const rawCsrf = randomBytes(32).toString('base64url');
          const existing = await transaction(database, async (client) => {
            const profile = await authenticatedProfile(request, client, environment, { lock: true });
            await client.query('UPDATE radar_profiles SET csrf_hash=$2 WHERE id=$1', [profile.id, sha256(rawCsrf)]);
            return profile;
          });
          setProfileCookies(response, environment, existingToken, rawCsrf);
          return response.status(200).json(profileBody(existing));
        } catch (error) {
          if (!(error instanceof RadarError) || error.status !== 401) throw error;
        }
      }
      if (!canCreateProfile(profileRateLimits, request, profileRateSalt)) throw new RadarError(429, 'capacity_limited');
      const rawToken = randomBytes(32).toString('base64url');
      const rawCsrf = randomBytes(32).toString('base64url');
      const maxProfiles = configuredPositiveInteger(environment, 'RADAR_MAX_PROFILES', 50_000);
      const profileCreatesPerHour = configuredPositiveInteger(
        environment, 'RADAR_PROFILE_CREATES_PER_HOUR', 1_000,
      );
      const profile = await transaction(database, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('radar_profile_capacity'))");
        await chargeGlobalRate(client, 'profile_create', profileCreatesPerHour);
        const capacity = await client.query(`
          SELECT count(*)::integer AS count FROM radar_profiles
          WHERE inactive_expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp()
        `);
        if (capacity.rows[0].count >= maxProfiles) throw new RadarError(429, 'capacity_limited');
        const inserted = await client.query(`
          INSERT INTO radar_profiles(
            id,token_hash,csrf_hash,inactive_expires_at,absolute_expires_at
          ) VALUES (
            $1,$2,$3,clock_timestamp()+interval '90 days',clock_timestamp()+interval '365 days'
          )
          RETURNING id,created_at,last_active_on,inactive_expires_at,absolute_expires_at
        `, [randomUUID(), sha256(rawToken), sha256(rawCsrf)]);
        return inserted.rows[0];
      });
      setProfileCookies(response, environment, rawToken, rawCsrf);
      response.status(201).json(profileBody(profile));
    } catch (error) { next(error); }
  });

  router.get('/profile', async (request, response, next) => {
    try {
      if (!database) throw new RadarError(503, 'database_unavailable');
      const profile = await transaction(database, (client) => authenticatedProfile(request, client, environment));
      response.json(profileBody(profile));
    } catch (error) {
      if (error instanceof RadarError && error.status === 401) clearProfileCookies(response, environment);
      next(error);
    }
  });

  router.delete('/profile', async (request, response, next) => {
    try {
      if (!database) throw new RadarError(503, 'database_unavailable');
      requireSameOrigin(request, environment);
      requireJson(request);
      if (!exactObject(request.body, [])) throw new RadarError(400, 'invalid_profile_request');
      await transaction(database, async (client) => {
        const profile = await authenticatedProfile(request, client, environment, { csrf: true, lock: true });
        await chargeProfileRate(client, profile.id, 'mutation', PROFILE_RATE_LIMITS.mutation);
        await client.query('DELETE FROM radar_profiles WHERE id=$1', [profile.id]);
      });
      clearProfileCookies(response, environment);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.post('/monitors', async (request, response, next) => {
    try {
      if (!database) throw new RadarError(503, 'database_unavailable');
      requireSameOrigin(request, environment);
      requireJson(request);
      const normalized = normalizeMonitorCreate(request.body);
      const monitorCreatesPerHour = configuredPositiveInteger(
        environment, 'RADAR_MONITOR_CREATES_PER_HOUR', 10_000,
      );
      const replay = await transaction(database, async (client) => {
        const profile = await authenticatedProfile(request, client, environment, { csrf: true, lock: true });
        const existing = await client.query(`
          ${WATCH_SELECT}
          WHERE watch.profile_id=$1 AND watch.client_key=$2
          GROUP BY watch.id
        `, [profile.id, normalized.clientKey]);
        if (existing.rowCount) {
          const hashes = await client.query(
            'SELECT request_hash FROM radar_watches WHERE profile_id=$1 AND client_key=$2',
            [profile.id, normalized.clientKey],
          );
          if (!safeEqual(hashes.rows[0].request_hash, normalized.requestHash)) {
            throw new RadarError(409, 'idempotency_conflict');
          }
          return existing.rows[0];
        }
        await chargeProfileRate(client, profile.id, 'monitor_create', PROFILE_RATE_LIMITS.monitor_create);
        await chargeGlobalRate(client, 'monitor_create', monitorCreatesPerHour);
        return null;
      });
      if (replay) return response.status(200).json(watchBody(replay, normalized.baselineClamped));

      const result = await transaction(database, async (client) => {
        const profile = await authenticatedProfile(request, client, environment, { csrf: true, lock: true });
        await client.query("SELECT pg_advisory_xact_lock(hashtext('radar_watch_projection'))");
        const existing = await client.query(`
          ${WATCH_SELECT}
          WHERE watch.profile_id=$1 AND watch.client_key=$2
          GROUP BY watch.id
        `, [profile.id, normalized.clientKey]);
        if (existing.rowCount) {
          const hashes = await client.query(
            'SELECT request_hash FROM radar_watches WHERE profile_id=$1 AND client_key=$2',
            [profile.id, normalized.clientKey],
          );
          if (!safeEqual(hashes.rows[0].request_hash, normalized.requestHash)) {
            throw new RadarError(409, 'idempotency_conflict');
          }
          return { status: 200, watch: existing.rows[0] };
        }
        const usage = await client.query(`
          SELECT count(DISTINCT watch.id)::integer AS monitors,
                 count(membership.parcel_id)::integer AS memberships,
                 count(DISTINCT watch.id) FILTER (WHERE watch.kind='radius')::integer AS radius_monitors
          FROM radar_watches watch
          LEFT JOIN radar_watch_parcels membership ON membership.watch_id=watch.id
          WHERE watch.profile_id=$1
        `, [profile.id]);
        const counts = usage.rows[0];
        const membershipDelta = normalized.target.parcel_ids?.length || 0;
        if (counts.monitors >= RADAR_LIMITS.monitors
            || counts.memberships + membershipDelta > RADAR_LIMITS.parcelMemberships
            || (normalized.target.kind === 'radius' && counts.radius_monitors >= RADAR_LIMITS.radiusMonitors)) {
          throw new RadarError(422, 'monitor_limit_reached');
        }
        if (membershipDelta) {
          const known = await client.query(
            'SELECT parcel_id FROM parcels WHERE parcel_id=ANY($1::text[])',
            [normalized.target.parcel_ids],
          );
          if (known.rowCount !== membershipDelta) throw new RadarError(422, 'parcel_not_found');
        }
        const baseline = await client.query(`
          SELECT coalesce(max(id),0)::bigint AS id
          FROM imports
          WHERE status='success' AND finished_at IS NOT NULL
            AND ($1::timestamptz IS NULL OR finished_at<=$1)
        `, [normalized.observedSince]);
        const watchId = randomUUID();
        const radius = normalized.target.kind === 'radius' ? normalized.target : null;
        await client.query(`
          INSERT INTO radar_watches(
            id,profile_id,client_key,request_hash,kind,anchor,radius_m,starts_after_import_id
          ) VALUES (
            $1,$2,$3,$4,$5,
            CASE WHEN $6::double precision IS NULL THEN NULL
              ELSE ST_SetSRID(ST_MakePoint($6,$7),4326) END,
            $8,$9
          )
        `, [
          watchId, profile.id, normalized.clientKey, normalized.requestHash, normalized.target.kind,
          radius?.lng ?? null, radius?.lat ?? null, radius?.radius_m ?? null, baseline.rows[0].id,
        ]);
        if (membershipDelta) {
          await client.query(`
            INSERT INTO radar_watch_parcels(watch_id,parcel_id)
            SELECT $1,unnest($2::text[])
          `, [watchId, normalized.target.parcel_ids]);
        }
        await client.query('SELECT * FROM radar_backfill_watch($1)', [watchId]);
        const created = await client.query(`
          ${WATCH_SELECT}
          WHERE watch.id=$1 AND watch.profile_id=$2
          GROUP BY watch.id
        `, [watchId, profile.id]);
        return { status: 201, watch: created.rows[0] };
      });
      response.status(result.status).json(watchBody(result.watch, normalized.baselineClamped));
    } catch (error) { next(error); }
  });

  router.get('/monitors', async (request, response, next) => {
    try {
      if (!database) throw new RadarError(503, 'database_unavailable');
      const watches = await transaction(database, async (client) => {
        const profile = await authenticatedProfile(request, client, environment);
        const result = await client.query(`
          ${WATCH_SELECT}
          WHERE watch.profile_id=$1
          GROUP BY watch.id
          ORDER BY watch.created_at,watch.id
          LIMIT 20
        `, [profile.id]);
        return result.rows;
      });
      response.json({ version: 'radar_monitor_list_v1', monitors: watches.map((row) => watchBody(row)) });
    } catch (error) { next(error); }
  });

  for (const action of ['pause', 'resume']) {
    router.post(`/monitors/:id/${action}`, async (request, response, next) => {
      try {
        if (!database) throw new RadarError(503, 'database_unavailable');
        requireSameOrigin(request, environment);
        requireJson(request);
        if (!exactObject(request.body, []) || !UUID.test(request.params.id)) {
          throw new RadarError(404, 'monitor_not_found');
        }
        const state = action === 'pause' ? 'paused' : 'active';
        const watch = await transaction(database, async (client) => {
          const profile = await authenticatedProfile(request, client, environment, { csrf: true, lock: true });
          await chargeProfileRate(client, profile.id, 'mutation', PROFILE_RATE_LIMITS.mutation);
          await client.query("SELECT pg_advisory_xact_lock(hashtext('radar_watch_projection'))");
          const updated = await client.query(`
            UPDATE radar_watches SET state=$3,
              starts_after_import_id=CASE
                WHEN $3='active' AND state='paused' THEN (
                  SELECT coalesce(max(id),0) FROM imports
                  WHERE status='success' AND finished_at IS NOT NULL
                )
                ELSE starts_after_import_id
              END,
              state_changed_at=CASE WHEN state<>$3 THEN clock_timestamp() ELSE state_changed_at END
            WHERE id=$1 AND profile_id=$2
            RETURNING id
          `, [request.params.id, profile.id, state]);
          if (!updated.rowCount) throw new RadarError(404, 'monitor_not_found');
          const selected = await client.query(`
            ${WATCH_SELECT}
            WHERE watch.id=$1 AND watch.profile_id=$2
            GROUP BY watch.id
          `, [request.params.id, profile.id]);
          return selected.rows[0];
        });
        response.json(watchBody(watch));
      } catch (error) { next(error); }
    });
  }

  router.delete('/monitors/:id', async (request, response, next) => {
    try {
      if (!database) throw new RadarError(503, 'database_unavailable');
      requireSameOrigin(request, environment);
      requireJson(request);
      if (!exactObject(request.body, []) || !UUID.test(request.params.id)) {
        throw new RadarError(404, 'monitor_not_found');
      }
      await transaction(database, async (client) => {
        const profile = await authenticatedProfile(request, client, environment, { csrf: true, lock: true });
        await chargeProfileRate(client, profile.id, 'mutation', PROFILE_RATE_LIMITS.mutation);
        await client.query("SELECT pg_advisory_xact_lock(hashtext('radar_watch_projection'))");
        await client.query('DELETE FROM radar_watches WHERE id=$1 AND profile_id=$2', [request.params.id, profile.id]);
      });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.get('/events', async (request, response, next) => {
    try {
      if (!database) throw new RadarError(503, 'database_unavailable');
      const after = bigintCursor(request.query.after_match_id || '0');
      const limit = Math.max(1, Math.min(MAX_EVENTS, Number.parseInt(String(request.query.limit || MAX_EVENTS), 10) || MAX_EVENTS));
      await transaction(database, async (client) => {
        const profile = await authenticatedProfile(request, client, environment, { lock: true });
        await chargeProfileRate(client, profile.id, 'feed_read', PROFILE_RATE_LIMITS.feed_read);
      });
      const events = await transaction(database, async (client) => {
        await client.query("SET LOCAL statement_timeout='3s'");
        const profile = await authenticatedProfile(request, client, environment);
        const result = await client.query(`
          SELECT match.id AS match_id,event.id AS event_id,event.import_id,event.event_type,event.changed_fields,
                  jsonb_build_object(
                   'case_key',event.snapshot->>'case_key',
                   'external_id',event.snapshot->>'external_id',
                   'source_type',event.snapshot->>'source_type',
                   'received_date',event.snapshot->>'received_date',
                   'decision_date',event.snapshot->>'decision_date',
                   'status',event.snapshot->>'status',
                    'city',left(event.snapshot->>'city',120),
                    'address',left(event.snapshot->>'address',200),
                    'description',left(event.snapshot->>'description',1000),
                    'parcel_ids',(
                      SELECT coalesce(jsonb_agg(parcel_id),'[]'::jsonb)
                      FROM (
                        SELECT left(parcel_id,120) AS parcel_id
                        FROM jsonb_array_elements_text(
                          CASE WHEN jsonb_typeof(event.snapshot->'parcel_ids')='array'
                            THEN event.snapshot->'parcel_ids' ELSE '[]'::jsonb END
                        ) AS expanded(parcel_id)
                        LIMIT 20
                      ) bounded_parcels
                    ),
                    'parcel_ids_truncated',CASE
                      WHEN jsonb_typeof(event.snapshot->'parcel_ids')='array'
                        THEN jsonb_array_length(event.snapshot->'parcel_ids')>20
                      ELSE false
                    END
                  ) AS snapshot,
                  event.occurred_at,imported.finished_at AS detected_at,
                  ARRAY[watch.id] AS matched_monitor_ids
          FROM radar_watches watch
          CROSS JOIN LATERAL (
            SELECT candidate.id,candidate.event_id
            FROM radar_matches candidate
            WHERE candidate.watch_id=watch.id AND candidate.id>$2
            ORDER BY candidate.id
            LIMIT $3
          ) match
          JOIN case_events event ON event.id=match.event_id
          JOIN imports imported ON imported.id=event.import_id
            AND imported.status='success' AND imported.finished_at IS NOT NULL
          WHERE watch.profile_id=$1 AND watch.state='active'
          ORDER BY match.id
          LIMIT $3
        `, [profile.id, after, limit + 1]);
        return result.rows;
      });
      response.json(boundedEventFeed(events, after, new Date().toISOString(), limit));
    } catch (error) { next(error); }
  });

  router.use((error, _request, response, next) => {
    if (error instanceof RadarError) return response.status(error.status).json({ error: error.code });
    if (error?.type === 'entity.too.large') return response.status(413).json({ error: 'request_too_large' });
    if (error instanceof SyntaxError && Object.hasOwn(error, 'body')) {
      return response.status(400).json({ error: 'invalid_json' });
    }
    return next(error);
  });
  return router;
}
