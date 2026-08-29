import express from 'express';
import pg from 'pg';
import compression from 'compression';

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }, max: 10 })
  : null;

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
             min(received_date) AS period_start,
             max(received_date) AS period_end,
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
    const params = [...bbox, type, query || null];
    if (zoom < 10 && !query) {
      const grid = zoom < 7 ? 0.35 : zoom < 9 ? 0.12 : 0.04;
      const result = await pool.query(`
        SELECT ST_X(ST_Centroid(ST_Collect(location))) AS lng,
               ST_Y(ST_Centroid(ST_Collect(location))) AS lat,
               count(*)::int AS count
        FROM cases
        WHERE published AND location && ST_MakeEnvelope($1,$2,$3,$4,4326)
          AND ($5::text IS NULL OR source_type=$5)
        GROUP BY ST_SnapToGrid(location, ${grid})
        LIMIT 5000
      `, params.slice(0, 5));
      return response.json({ type: 'FeatureCollection', features: result.rows.map((row) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [row.lng, row.lat] }, properties: { cluster: true, count: row.count },
      })) });
    }
    const result = await pool.query(`
      WITH exact_city AS (
        SELECT EXISTS (
          SELECT 1 FROM cases city_case
          WHERE city_case.published AND lower(city_case.city)=lower($6)
        ) AS found
      )
      SELECT c.case_key, c.external_id, c.source_type, c.received_date, c.status,
             c.city, c.address, c.description, c.voivodeship,
             ST_X(c.location) AS lng, ST_Y(c.location) AS lat,
             (SELECT count(*)::int
              FROM case_parcels cp JOIN parcels p ON p.parcel_id=cp.parcel_id
              WHERE cp.case_id=c.id AND p.geom IS NOT NULL AND NOT ST_IsEmpty(p.geom)) AS parcel_count
      FROM cases c CROSS JOIN exact_city
      WHERE c.published AND c.location && ST_MakeEnvelope($1,$2,$3,$4,4326)
        AND ($5::text IS NULL OR c.source_type=$5)
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
      SELECT c.case_key, c.external_id, c.source_type, c.received_date, c.status,
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

app.get('/api/cases/:caseKey', async (request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT c.case_key, c.external_id, c.source_type, c.received_date, c.decision_date,
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

app.use('/api', (_request, response) => response.status(404).json({ error: 'not_found' }));
app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'internal_error' });
});

app.listen(port, '0.0.0.0', () => console.log(`obokmnie listening on ${port}`));
