import express from 'express';
import pg from 'pg';
import compression from 'compression';
import {
  buildContextFacts,
  contextFingerprint,
  deterministicContext,
  generateAiContext,
} from './lib/case-context.mjs';

const app = express();
const port = Number(process.env.PORT || 3000);
const VOIVODESHIPS = new Set([
  'dolnośląskie', 'kujawsko-pomorskie', 'lubelskie', 'lubuskie', 'łódzkie', 'małopolskie',
  'mazowieckie', 'opolskie', 'podkarpackie', 'podlaskie', 'pomorskie', 'śląskie',
  'świętokrzyskie', 'warmińsko-mazurskie', 'wielkopolskie', 'zachodniopomorskie',
]);
const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }, max: 10 })
  : null;
const contextInFlight = new Map();
const contextRateLimits = new Map();
const CONTEXT_RATE_LIMIT = 20;
const CONTEXT_RATE_WINDOW_MS = 60 * 60 * 1000;

function contextClientId(request) {
  return String(request.headers['x-forwarded-for'] || request.ip || 'unknown').split(',')[0].trim();
}

function canGenerateContext(request) {
  const key = contextClientId(request);
  const now = Date.now();
  if (contextRateLimits.size > 1_000) {
    for (const [clientId, entry] of contextRateLimits) {
      if (now - entry.startedAt >= CONTEXT_RATE_WINDOW_MS) contextRateLimits.delete(clientId);
    }
  }
  const current = contextRateLimits.get(key);
  if (!current || now - current.startedAt >= CONTEXT_RATE_WINDOW_MS) {
    contextRateLimits.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= CONTEXT_RATE_LIMIT) return false;
  current.count += 1;
  return true;
}

app.disable('x-powered-by');
app.use(compression());
app.use(express.static('public', { maxAge: '1h', etag: true }));

app.get('/health', async (_request, response) => {
  try {
    if (pool) await pool.query('SELECT 1');
    response.json({ ok: true, database: Boolean(pool) });
  } catch {
    response.status(503).json({ ok: false, database: true });
  }
});

app.get('/api/meta', async (_request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT count(*)::int AS published_cases,
             to_char(min(received_date),'YYYY-MM-DD') AS period_start,
             to_char(max(received_date),'YYYY-MM-DD') AS period_end,
             count(DISTINCT voivodeship)::int AS voivodeships
      FROM cases WHERE published
    `);
    response.json(result.rows[0]);
  } catch (error) { next(error); }
});

app.get('/api/map', async (request, response, next) => {
  try {
    const bbox = String(request.query.bbox || '14,49,24.2,55.2').split(',').map(Number);
    const zoom = Math.max(5, Math.min(18, Number(request.query.zoom || 6)));
    if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) return response.status(400).json({ error: 'invalid_bbox' });
    const type = ['wniosek_decyzja', 'zgloszenie'].includes(request.query.type) ? request.query.type : null;
    const query = String(request.query.q || '').trim();
    const requestedRegion = String(request.query.region || '').trim().toLocaleLowerCase('pl-PL');
    const region = VOIVODESHIPS.has(requestedRegion) ? requestedRegion : null;
    const params = [...bbox, type, query || null, region];
    if (zoom < 7.5 && !query && !region) {
      const result = await pool.query(`
        SELECT voivodeship,
               ST_X(ST_Centroid(ST_Collect(location))) AS lng,
               ST_Y(ST_Centroid(ST_Collect(location))) AS lat,
               min(ST_X(location)) AS min_lng, min(ST_Y(location)) AS min_lat,
               max(ST_X(location)) AS max_lng, max(ST_Y(location)) AS max_lat,
               count(*)::int AS count
        FROM cases
        WHERE published AND location && ST_MakeEnvelope($1,$2,$3,$4,4326)
          AND ($5::text IS NULL OR source_type=$5)
          AND ($6::text IS NULL OR voivodeship=$6)
        GROUP BY voivodeship
        ORDER BY voivodeship
      `, [...params.slice(0, 5), region]);
      return response.json({ type: 'FeatureCollection', features: result.rows.map((row) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [row.lng, row.lat] },
        properties: {
          cluster: true,
          cluster_scope: 'voivodeship',
          count: row.count,
          label: row.voivodeship.charAt(0).toLocaleUpperCase('pl-PL') + row.voivodeship.slice(1),
          region: row.voivodeship,
          bounds: [row.min_lng, row.min_lat, row.max_lng, row.max_lat].map(Number),
        },
      })) });
    }
    if (zoom < 8.2 && !query && region) {
      const result = await pool.query(`
        WITH clustered AS (
          SELECT location, ST_ClusterKMeans(location, 8) OVER () AS area_id
          FROM cases
          WHERE published AND voivodeship=$2
            AND ($1::text IS NULL OR source_type=$1)
        )
        SELECT area_id,
               ST_X(ST_Centroid(ST_Collect(location))) AS lng,
               ST_Y(ST_Centroid(ST_Collect(location))) AS lat,
               min(ST_X(location)) AS min_lng, min(ST_Y(location)) AS min_lat,
               max(ST_X(location)) AS max_lng, max(ST_Y(location)) AS max_lat,
               count(*)::int AS count
        FROM clustered
        GROUP BY area_id
        ORDER BY area_id
      `, [type, region]);
      return response.json({ type: 'FeatureCollection', features: result.rows.map((row) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [row.lng, row.lat] },
        properties: {
          cluster: true, cluster_scope: 'area', count: row.count,
          label: `Obszar ${Number(row.area_id) + 1}`,
          bounds: [row.min_lng, row.min_lat, row.max_lng, row.max_lat].map(Number),
        },
      })) });
    }
    if (zoom < 10 && !query) {
      const result = await pool.query(`
        WITH scoped AS (
          SELECT c.id, c.location, min(left(cp.parcel_id,4)) AS powiat
          FROM cases c
          JOIN case_parcels cp ON cp.case_id=c.id
          WHERE c.published AND c.location && ST_MakeEnvelope($1,$2,$3,$4,4326)
            AND ($5::text IS NULL OR c.source_type=$5)
            AND ($6::text IS NULL OR c.voivodeship=$6)
          GROUP BY c.id, c.location
        )
        SELECT powiat AS label,
               ST_X(ST_Centroid(ST_Collect(location))) AS lng,
               ST_Y(ST_Centroid(ST_Collect(location))) AS lat,
               min(ST_X(location)) AS min_lng, min(ST_Y(location)) AS min_lat,
               max(ST_X(location)) AS max_lng, max(ST_Y(location)) AS max_lat,
               count(*)::int AS count
        FROM scoped
        GROUP BY powiat
        LIMIT 5000
      `, [...params.slice(0, 5), region]);
      return response.json({ type: 'FeatureCollection', features: result.rows.map((row) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [row.lng, row.lat] },
        properties: {
          cluster: true, cluster_scope: 'powiat', count: row.count, label: `Powiat ${row.label}`,
          bounds: [row.min_lng, row.min_lat, row.max_lng, row.max_lat].map(Number),
        },
      })) });
    }
    if (zoom < 14 && !query) {
      const result = await pool.query(`
        WITH clustered AS (
          SELECT location, ST_ClusterKMeans(location, 12) OVER () AS group_id
          FROM cases c
          WHERE c.published AND c.location && ST_MakeEnvelope($1,$2,$3,$4,4326)
            AND ($5::text IS NULL OR c.source_type=$5)
            AND ($6::text IS NULL OR c.voivodeship=$6)
        )
        SELECT group_id,
               ST_X(ST_Centroid(ST_Collect(location))) AS lng,
               ST_Y(ST_Centroid(ST_Collect(location))) AS lat,
               min(ST_X(location)) AS min_lng, min(ST_Y(location)) AS min_lat,
               max(ST_X(location)) AS max_lng, max(ST_Y(location)) AS max_lat,
               count(*)::int AS count
        FROM clustered
        GROUP BY group_id
        ORDER BY group_id
      `, [...params.slice(0, 5), region]);
      return response.json({ type: 'FeatureCollection', features: result.rows.map((row) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [row.lng, row.lat] },
        properties: {
          cluster: true, cluster_scope: 'local', count: row.count,
          label: `Grupa ${Number(row.group_id) + 1}`,
          bounds: [row.min_lng, row.min_lat, row.max_lng, row.max_lat].map(Number),
        },
      })) });
    }
    const result = await pool.query(`
      WITH exact_city AS (
        SELECT EXISTS (
          SELECT 1 FROM cases city_case
          WHERE city_case.published AND lower(city_case.city)=lower($6)
        ) AS found
      )
      SELECT c.case_key, c.external_id, c.source_type,
             to_char(c.received_date,'YYYY-MM-DD') AS received_date, c.status,
             c.city, c.address, c.description, c.voivodeship,
             ST_X(c.location) AS lng, ST_Y(c.location) AS lat,
             (SELECT count(*)::int
              FROM case_parcels cp JOIN parcels p ON p.parcel_id=cp.parcel_id
              WHERE cp.case_id=c.id AND p.geom IS NOT NULL AND NOT ST_IsEmpty(p.geom)) AS parcel_count
      FROM cases c CROSS JOIN exact_city
      WHERE c.published AND c.location && ST_MakeEnvelope($1,$2,$3,$4,4326)
        AND ($5::text IS NULL OR c.source_type=$5)
        AND ($7::text IS NULL OR c.voivodeship=$7)
        AND ($6::text IS NULL
          OR (exact_city.found AND lower(c.city)=lower($6))
          OR (NOT exact_city.found AND (c.search_vector @@ plainto_tsquery('simple',$6)
            OR c.city ILIKE '%'||$6||'%' OR c.address ILIKE '%'||$6||'%'
            OR c.external_id ILIKE '%'||$6||'%' OR c.voivodeship ILIKE '%'||$6||'%'
            OR c.description ILIKE '%'||$6||'%')))
      ORDER BY c.received_date DESC LIMIT 5000
    `, params);
    response.json({ type: 'FeatureCollection', features: result.rows.map((row) => ({
      type: 'Feature', id: row.case_key, geometry: { type: 'Point', coordinates: [row.lng, row.lat] }, properties: row,
    })) });
  } catch (error) { next(error); }
});

app.get('/api/search', async (request, response, next) => {
  try {
    const query = String(request.query.q || '').trim();
    if (query.length < 2) return response.json([]);
    const result = await pool.query(`
      WITH exact_city AS (
        SELECT EXISTS (
          SELECT 1 FROM cases city_case
          WHERE city_case.published AND lower(city_case.city)=lower($1)
        ) AS found
      )
      SELECT c.case_key, c.external_id, c.source_type,
             to_char(c.received_date,'YYYY-MM-DD') AS received_date, c.status,
             c.city, c.address, c.description, c.voivodeship,
             ST_X(c.location) AS lng, ST_Y(c.location) AS lat,
             (SELECT count(*)::int
              FROM case_parcels cp JOIN parcels p ON p.parcel_id=cp.parcel_id
              WHERE cp.case_id=c.id AND p.geom IS NOT NULL AND NOT ST_IsEmpty(p.geom)) AS parcel_count
      FROM cases c CROSS JOIN exact_city
      WHERE c.published
        AND ((exact_city.found AND lower(c.city)=lower($1))
          OR (NOT exact_city.found AND (c.search_vector @@ plainto_tsquery('simple',$1)
            OR c.city ILIKE '%'||$1||'%' OR c.address ILIKE '%'||$1||'%'
            OR c.external_id ILIKE '%'||$1||'%' OR c.voivodeship ILIKE '%'||$1||'%'
            OR c.description ILIKE '%'||$1||'%')))
      ORDER BY c.received_date DESC LIMIT 100
    `, [query]);
    response.json(result.rows);
  } catch (error) { next(error); }
});

app.get('/api/suggestions', async (request, response, next) => {
  try {
    const query = String(request.query.q || '').trim().slice(0, 80)
      .replace(/[^\p{L}\p{N}\s-]/gu, '');
    if (query.length < 2) return response.json([]);
    const result = await pool.query(`
      SELECT label, context, kind
      FROM (
        SELECT city AS label,
               CASE WHEN count(DISTINCT voivodeship)=1 THEN min(voivodeship)
                    ELSE 'kilka województw' END AS context,
               'city' AS kind,
               count(*)::int AS frequency,
               (lower(city)=lower($1))::int AS exact_match,
               1 AS kind_order
        FROM cases
        WHERE published AND city<>'' AND lower(city) LIKE lower($1)||'%'
        GROUP BY city
        UNION ALL
        SELECT voivodeship AS label, 'województwo' AS context, 'voivodeship' AS kind,
               count(*)::int AS frequency,
               (lower(voivodeship)=lower($1))::int AS exact_match,
               0 AS kind_order
        FROM cases
        WHERE published AND voivodeship<>'' AND lower(voivodeship) LIKE lower($1)||'%'
        GROUP BY voivodeship
      ) suggestions
      ORDER BY exact_match DESC, kind_order, frequency DESC, label
      LIMIT 7
    `, [query]);
    response.json(result.rows);
  } catch (error) { next(error); }
});

app.get('/api/cases/:caseKey', async (request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT c.case_key, c.external_id, c.source_type,
             to_char(c.received_date,'YYYY-MM-DD') AS received_date,
             to_char(c.decision_date,'YYYY-MM-DD') AS decision_date,
             c.status, c.office, c.voivodeship, c.city, c.address, c.case_kind, c.description,
             c.parcel_ids, ST_AsGeoJSON(c.location)::json AS location,
             coalesce(json_agg(json_build_object('parcel_id',p.parcel_id,'geometry',ST_AsGeoJSON(p.geom)::json))
               FILTER (WHERE p.geom IS NOT NULL), '[]') AS parcels
      FROM cases c
      LEFT JOIN case_parcels cp ON cp.case_id=c.id
      LEFT JOIN parcels p ON p.parcel_id=cp.parcel_id
      WHERE c.case_key=$1 AND c.published
      GROUP BY c.id
    `, [request.params.caseKey]);
    if (!result.rowCount) return response.status(404).json({ error: 'not_found' });
    response.json(result.rows[0]);
  } catch (error) { next(error); }
});

app.get('/api/cases/:caseKey/context', async (request, response, next) => {
  try {
    const subjectResult = await pool.query(`
      SELECT c.id, c.case_key, c.external_id, c.source_type,
             to_char(c.received_date,'YYYY-MM-DD') AS received_date,
             to_char(c.decision_date,'YYYY-MM-DD') AS decision_date,
             c.status, c.office, c.voivodeship, c.city, c.address, c.case_kind, c.description,
             c.parcel_ids, c.location
      FROM cases c
      WHERE c.case_key=$1 AND c.published
    `, [request.params.caseKey]);
    if (!subjectResult.rowCount) return response.status(404).json({ error: 'not_found' });
    const subject = subjectResult.rows[0];
    const [nearbyResult, relatedResult] = await Promise.all([
      pool.query(`
        WITH subject AS (SELECT id, location FROM cases WHERE id=$1)
        SELECT
          count(c.id) FILTER (WHERE ST_DWithin(c.location::geography, s.location::geography, 250))::int AS within_250m,
          count(c.id)::int AS within_1km,
          count(c.id) FILTER (WHERE c.source_type='wniosek_decyzja')::int AS permits_within_1km,
          count(c.id) FILTER (WHERE c.source_type='zgloszenie')::int AS notices_within_1km,
          (SELECT count(DISTINCT related.case_id)::int
           FROM case_parcels own
           JOIN case_parcels related ON related.parcel_id=own.parcel_id AND related.case_id<>s.id
           JOIN cases related_case ON related_case.id=related.case_id AND related_case.published
           WHERE own.case_id=s.id) AS same_parcel_count
        FROM subject s
        LEFT JOIN cases c ON c.published AND c.id<>s.id
          AND c.location && ST_Expand(s.location, 0.02)
          AND ST_DWithin(c.location::geography, s.location::geography, 1000)
        GROUP BY s.id
      `, [subject.id]),
      pool.query(`
        SELECT related_case.source_type,
               to_char(related_case.received_date,'YYYY-MM-DD') AS received_date,
               related_case.status, related_case.description
        FROM cases related_case
        WHERE related_case.published AND related_case.id IN (
          SELECT related.case_id
          FROM case_parcels own
          JOIN case_parcels related ON related.parcel_id=own.parcel_id AND related.case_id<>own.case_id
          WHERE own.case_id=$1
        )
        ORDER BY related_case.received_date DESC, related_case.id
        LIMIT 5
      `, [subject.id]),
    ]);
    const facts = buildContextFacts(subject, nearbyResult.rows[0] || {}, relatedResult.rows);
    const fingerprint = contextFingerprint(facts);
    const cached = await pool.query(`
      SELECT context, model, generated_at
      FROM case_contexts
      WHERE case_id=$1 AND source_fingerprint=$2
    `, [subject.id, fingerprint]);
    if (cached.rowCount) {
      return response.json({
        ...cached.rows[0].context,
        facts: facts.surroundings,
        generated_by: 'ai',
        cached: true,
        generated_at: cached.rows[0].generated_at,
      });
    }

    const fallback = deterministicContext(facts);
    if (!process.env.OPENAI_API_KEY || !canGenerateContext(request)) {
      return response.json({ ...fallback, facts: facts.surroundings, generated_by: 'rules', cached: false });
    }

    let generation = contextInFlight.get(subject.case_key);
    if (!generation) {
      generation = (async () => {
        const generated = await generateAiContext(facts);
        await pool.query(`
          INSERT INTO case_contexts(case_id, source_fingerprint, context, model, generated_at)
          VALUES($1,$2,$3,$4,now())
          ON CONFLICT(case_id) DO UPDATE SET
            source_fingerprint=excluded.source_fingerprint,
            context=excluded.context,
            model=excluded.model,
            generated_at=now()
        `, [subject.id, fingerprint, generated.context, generated.model]);
        return generated.context;
      })();
      contextInFlight.set(subject.case_key, generation);
    }
    try {
      const context = await generation;
      return response.json({ ...context, facts: facts.surroundings, generated_by: 'ai', cached: false });
    } catch (error) {
      console.error('case context generation failed', { caseKey: subject.case_key, message: error.message });
      return response.json({ ...fallback, facts: facts.surroundings, generated_by: 'rules', cached: false });
    } finally {
      if (contextInFlight.get(subject.case_key) === generation) contextInFlight.delete(subject.case_key);
    }
  } catch (error) { next(error); }
});

app.use('/api', (_request, response) => response.status(404).json({ error: 'not_found' }));
app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'internal_error' });
});

app.listen(port, '0.0.0.0', () => console.log(`obokmnie listening on ${port}`));
