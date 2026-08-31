import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

if (process.env.RADAR_TEST_DATABASE !== '1') {
  throw new Error('test-radar-postgis wymaga izolowanej bazy i RADAR_TEST_DATABASE=1');
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Brak DATABASE_URL izolowanej bazy');
const testUrl = new URL(connectionString);
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(testUrl.hostname)
    || !/^\/radar_test_[a-z0-9_]+$/.test(testUrl.pathname)) {
  throw new Error('Test PostGIS wymaga bazy radar_test_* dostępnej przez loopback');
}

const client = new pg.Client({
  connectionString,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  query_timeout: 15_000,
  application_name: 'radar_postgis_integration_test',
});

const profileId = randomUUID();
const profileTwoId = randomUUID();
const watchA = randomUUID();
const watchB = randomUUID();
const watchSet = randomUUID();
const watchRadius500 = randomUUID();
const watchRadius1000 = randomUUID();
const watchRadius3000 = randomUUID();

function hash() { return randomBytes(32); }

await client.connect();
try {
  const migrations = await client.query("SELECT name FROM schema_migrations WHERE name='011_server_radar.sql'");
  assert.equal(migrations.rowCount, 1);

  await client.query(`
    TRUNCATE radar_matches,radar_watch_parcels,radar_watches,radar_profiles,
      radar_import_projections,case_events,case_parcels,cases,parcels,imports
    RESTART IDENTITY CASCADE
  `);

  const baseline = await client.query(`
    INSERT INTO imports(source_date,status,finished_at)
    VALUES(current_date,'success',clock_timestamp()) RETURNING id
  `);
  const baselineId = Number(baseline.rows[0].id);
  await client.query(`
    INSERT INTO radar_import_projections(import_id,projection_kind)
    VALUES($1,'baseline')
  `, [baselineId]);

  await client.query(`
    INSERT INTO parcels(parcel_id,geom,datasource) VALUES
      ('A',ST_Multi(ST_Buffer(ST_SetSRID(ST_Point(16.9000,52.4000),4326)::geography,0.01)::geometry),'test'),
      ('B',ST_Multi(ST_Buffer(ST_Project(ST_SetSRID(ST_Point(16.9000,52.4000),4326)::geography,499.9,radians(90)),0.01)::geometry),'test'),
      ('C',ST_Multi(ST_Buffer(ST_Project(ST_SetSRID(ST_Point(16.9000,52.4000),4326)::geography,500.1,radians(90)),0.01)::geometry),'test'),
      ('D',ST_Multi(ST_Buffer(ST_Project(ST_SetSRID(ST_Point(16.9000,52.4000),4326)::geography,999.9,radians(90)),0.01)::geometry),'test'),
      ('E',ST_Multi(ST_Buffer(ST_Project(ST_SetSRID(ST_Point(16.9000,52.4000),4326)::geography,1000.1,radians(90)),0.01)::geometry),'test'),
      ('F',ST_Multi(ST_Buffer(ST_Project(ST_SetSRID(ST_Point(16.9000,52.4000),4326)::geography,2999.9,radians(90)),0.01)::geometry),'test'),
      ('G',ST_Multi(ST_Buffer(ST_Project(ST_SetSRID(ST_Point(16.9000,52.4000),4326)::geography,3000.1,radians(90)),0.01)::geometry),'test')
  `);
  await client.query(`
    INSERT INTO radar_profiles(
      id,token_hash,csrf_hash,inactive_expires_at,absolute_expires_at
    ) VALUES
      ($1,$2,$3,clock_timestamp()+interval '90 days',clock_timestamp()+interval '365 days'),
      ($4,$5,$6,clock_timestamp()+interval '90 days',clock_timestamp()+interval '365 days')
  `, [profileId, hash(), hash(), profileTwoId, hash(), hash()]);

  const watches = [
    [watchA, profileId, randomUUID(), 'parcel', null, null],
    [watchB, profileId, randomUUID(), 'parcel', null, null],
    [watchSet, profileId, randomUUID(), 'parcel_set', null, null],
    [watchRadius500, profileId, randomUUID(), 'radius', 500, 16.9],
    [watchRadius1000, profileId, randomUUID(), 'radius', 1000, 16.9],
    [watchRadius3000, profileId, randomUUID(), 'radius', 3000, 16.9],
  ];
  for (const [id, owner, clientKey, kind, radius, lng] of watches) {
    await client.query(`
      INSERT INTO radar_watches(
        id,profile_id,client_key,request_hash,kind,anchor,radius_m,starts_after_import_id
      ) VALUES(
        $1,$2,$3,$4,$5,
        CASE WHEN $6::double precision IS NULL THEN NULL
          ELSE ST_SetSRID(ST_Point($6,52.4),4326) END,
        $7,$8
      )
    `, [id, owner, clientKey, hash(), kind, lng, radius, baselineId]);
  }
  await client.query(`
    INSERT INTO radar_watch_parcels(watch_id,parcel_id) VALUES
      ($1,'A'),($2,'B'),($3,'A'),($3,'B')
  `, [watchA, watchB, watchSet]);

  async function startImport() {
    const result = await client.query(`
      INSERT INTO imports(source_date,status) VALUES(current_date,'running') RETURNING id
    `);
    return Number(result.rows[0].id);
  }

  async function finishAndProject(importId) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('radar_watch_projection'))");
    await client.query("UPDATE imports SET status='success',finished_at=clock_timestamp() WHERE id=$1 AND status='running'", [importId]);
    const result = await client.query('SELECT * FROM radar_project_import($1)', [importId]);
    return result.rows[0];
  }

  const newImport = await startImport();
  await client.query('BEGIN');
  await client.query("SELECT set_config('obokmnie.import_id',$1,false)", [String(newImport)]);
  const insertedCase = await client.query(`
    INSERT INTO cases(
      case_key,source_type,external_id,received_date,status,voivodeship,description,
      parcel_ids,source_fingerprint,source_active,last_import_id
    ) VALUES(
      'case:1','zgloszenie','1',current_date,'nowa','wielkopolskie','Nowa sprawa',
      ARRAY['A'],'fingerprint-a',true,$1
    ) RETURNING id
  `, [newImport]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('radar_watch_projection'))");
  await client.query("UPDATE imports SET status='success',finished_at=clock_timestamp() WHERE id=$1", [newImport]);
  const smokeProjectionStartedAt = performance.now();
  const firstProjection = await client.query('SELECT * FROM radar_project_import($1)', [newImport]);
  const smokeProjectionMilliseconds = performance.now() - smokeProjectionStartedAt;
  await client.query('COMMIT');
  assert.ok(smokeProjectionMilliseconds <= 2_000);
  assert.equal(Number(firstProjection.rows[0].event_count), 1);
  assert.equal(Number(firstProjection.rows[0].match_count), 5);

  const changedImport = await startImport();
  await client.query('BEGIN');
  await client.query("SELECT set_config('obokmnie.import_id',$1,false)", [String(changedImport)]);
  await client.query(`
    UPDATE cases SET parcel_ids=ARRAY['B'],source_fingerprint='fingerprint-b',last_import_id=$2
    WHERE id=$1
  `, [insertedCase.rows[0].id, changedImport]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('radar_watch_projection'))");
  await client.query("UPDATE imports SET status='success',finished_at=clock_timestamp() WHERE id=$1", [changedImport]);
  const changedProjection = await client.query('SELECT * FROM radar_project_import($1)', [changedImport]);
  await client.query('COMMIT');
  assert.equal(Number(changedProjection.rows[0].event_count), 1);
  assert.equal(Number(changedProjection.rows[0].match_count), 6);
  const changedEvent = await client.query(`
    SELECT match_parcel_ids FROM case_events WHERE import_id=$1
  `, [changedImport]);
  assert.deepEqual(changedEvent.rows[0].match_parcel_ids, ['A', 'B']);
  const changedWatches = await client.query(`
    SELECT watch_id FROM radar_matches match
    JOIN case_events event ON event.id=match.event_id
    WHERE event.import_id=$1 ORDER BY watch_id
  `, [changedImport]);
  assert.equal(new Set(changedWatches.rows.map((row) => row.watch_id)).size, 6);
  const cursorIndex = await client.query(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname=current_schema() AND tablename='radar_matches'
      AND indexname='radar_matches_watch_cursor_idx'
  `);
  assert.equal(cursorIndex.rowCount, 1);
  assert.match(cursorIndex.rows[0].indexdef, /\(watch_id, id\)/);
  await client.query('SET enable_seqscan=off');
  const cursorPlan = await client.query(`
    EXPLAIN (FORMAT JSON)
    SELECT candidate.id,candidate.event_id
    FROM radar_matches candidate
    WHERE candidate.watch_id=$1 AND candidate.id>0
    ORDER BY candidate.id LIMIT 50
  `, [watchA]);
  await client.query('RESET enable_seqscan');
  assert.match(JSON.stringify(cursorPlan.rows[0]), /radar_matches_watch_cursor_idx/);

  const radiusCases = [
    ['C', watchRadius500, false, watchRadius1000, true, watchRadius3000, true],
    ['D', watchRadius500, false, watchRadius1000, true, watchRadius3000, true],
    ['E', watchRadius500, false, watchRadius1000, false, watchRadius3000, true],
    ['F', watchRadius500, false, watchRadius1000, false, watchRadius3000, true],
    ['G', watchRadius500, false, watchRadius1000, false, watchRadius3000, false],
  ];
  for (const [parcelId, , , , , ,] of radiusCases) {
    const importId = await startImport();
    await client.query('BEGIN');
    await client.query("SELECT set_config('obokmnie.import_id',$1,false)", [String(importId)]);
    await client.query(`
      INSERT INTO cases(
        case_key,source_type,external_id,received_date,status,voivodeship,description,
        parcel_ids,source_fingerprint,source_active,last_import_id
      ) VALUES(
        $1,'zgloszenie',$2,current_date,'nowa','wielkopolskie','Test promienia',
        ARRAY[$2],$3,true,$4
      )
    `, [`case:radius:${parcelId}`, parcelId, `fingerprint-${parcelId}`, importId]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('radar_watch_projection'))");
    await client.query("UPDATE imports SET status='success',finished_at=clock_timestamp() WHERE id=$1", [importId]);
    await client.query('SELECT * FROM radar_project_import($1)', [importId]);
    await client.query('COMMIT');
    const matched = await client.query(`
      SELECT match.watch_id FROM radar_matches match
      JOIN case_events event ON event.id=match.event_id
      WHERE event.import_id=$1
    `, [importId]);
    const ids = new Set(matched.rows.map((row) => row.watch_id));
    for (let index = 1; index < radiusCases[0].length; index += 2) {
      assert.equal(ids.has(radiusCases.find((row) => row[0] === parcelId)[index]), radiusCases.find((row) => row[0] === parcelId)[index + 1]);
    }
  }

  const performanceProfileCount = 100;
  const performanceEventCount = 200;
  await client.query(`
    INSERT INTO radar_profiles(id,token_hash,csrf_hash,inactive_expires_at,absolute_expires_at)
    SELECT
      md5('perf-profile-' || sequence)::uuid,
      decode(md5('perf-token-a-' || sequence) || md5('perf-token-b-' || sequence), 'hex'),
      decode(md5('perf-csrf-a-' || sequence) || md5('perf-csrf-b-' || sequence), 'hex'),
      clock_timestamp()+interval '90 days',
      clock_timestamp()+interval '365 days'
    FROM generate_series(1,$1) sequence
  `, [performanceProfileCount]);
  await client.query(`
    INSERT INTO radar_watches(
      id,profile_id,client_key,request_hash,kind,anchor,radius_m,starts_after_import_id
    )
    SELECT
      md5(kind || '-watch-' || sequence)::uuid,
      md5('perf-profile-' || sequence)::uuid,
      md5(kind || '-client-' || sequence)::uuid,
      decode(md5(kind || '-request-a-' || sequence) || md5(kind || '-request-b-' || sequence), 'hex'),
      kind,
      CASE WHEN kind='radius' THEN ST_SetSRID(ST_Point(16.9,52.4),4326) END,
      CASE WHEN kind='radius' THEN 3000 END,
      $2
    FROM generate_series(1,$1) sequence
    CROSS JOIN unnest(ARRAY['parcel','parcel_set','radius']) AS kinds(kind)
  `, [performanceProfileCount, baselineId]);
  await client.query(`
    INSERT INTO radar_watch_parcels(watch_id,parcel_id)
    SELECT md5(kind || '-watch-' || sequence)::uuid, parcel_id
    FROM generate_series(1,$1) sequence
    CROSS JOIN (
      VALUES ('parcel','A'),('parcel_set','A'),('parcel_set','B')
    ) membership(kind,parcel_id)
  `, [performanceProfileCount]);

  const performanceImport = await startImport();
  await client.query('BEGIN');
  await client.query("SELECT set_config('obokmnie.import_id',$1,false)", [String(performanceImport)]);
  await client.query(`
    INSERT INTO cases(
      case_key,source_type,external_id,received_date,status,voivodeship,description,
      parcel_ids,source_fingerprint,source_active,last_import_id
    )
    SELECT
      'case:performance:' || sequence,'zgloszenie','performance-' || sequence,
      current_date,'nowa','wielkopolskie','Test wydajności Radaru',
      ARRAY['A'],'performance-fingerprint-' || sequence,true,$2
    FROM generate_series(1,$1) sequence
  `, [performanceEventCount, performanceImport]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('radar_watch_projection'))");
  await client.query("UPDATE imports SET status='success',finished_at=clock_timestamp() WHERE id=$1", [performanceImport]);
  const representativeProjectionStartedAt = performance.now();
  const representativeProjection = await client.query('SELECT * FROM radar_project_import($1)', [performanceImport]);
  const representativeProjectionMilliseconds = performance.now() - representativeProjectionStartedAt;
  await client.query('COMMIT');
  assert.equal(Number(representativeProjection.rows[0].event_count), performanceEventCount);
  assert.ok(Number(representativeProjection.rows[0].match_count) >= performanceProfileCount * 3 * performanceEventCount);
  assert.ok(
    representativeProjectionMilliseconds <= 8_000,
    `Reprezentatywna projekcja przekroczyła budżet 8000 ms: ${representativeProjectionMilliseconds}`,
  );

  const zeroImport = await startImport();
  const zero = await finishAndProject(zeroImport);
  assert.equal(Number(zero.event_count), 0);
  assert.equal(Number(zero.match_count), 0);
  const replay = await client.query('SELECT * FROM radar_project_import($1)', [zeroImport]);
  assert.equal(Number(replay.rows[0].event_count), 0);

  const raceWatch = randomUUID();
  const raceImport = await startImport();
  const importer = new pg.Client({
    connectionString,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    statement_timeout: 10_000,
  });
  await importer.connect();
  try {
    await importer.query('BEGIN');
    await importer.query("SELECT set_config('obokmnie.import_id',$1,false)", [String(raceImport)]);
    await importer.query(`
      INSERT INTO cases(
        case_key,source_type,external_id,received_date,status,voivodeship,description,
        parcel_ids,source_fingerprint,source_active,last_import_id
      ) VALUES(
        'case:race','zgloszenie','race',current_date,'nowa','wielkopolskie','Race',
        ARRAY['A'],'race-a',true,$1
      )
    `, [raceImport]);

    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('radar_watch_projection'))");
    const raceBaseline = await client.query(`
      SELECT coalesce(max(id),0)::bigint AS id FROM imports
      WHERE status='success' AND finished_at IS NOT NULL
    `);
    await client.query(`
      INSERT INTO radar_watches(
        id,profile_id,client_key,request_hash,kind,starts_after_import_id
      ) VALUES($1,$2,$3,$4,'parcel',$5)
    `, [raceWatch, profileTwoId, randomUUID(), hash(), raceBaseline.rows[0].id]);
    await client.query(`
      INSERT INTO radar_watch_parcels(watch_id,parcel_id) VALUES($1,'A')
    `, [raceWatch]);

    let projectorFinished = false;
    const projected = (async () => {
      await importer.query("SELECT pg_advisory_xact_lock(hashtext('radar_watch_projection'))");
      await importer.query("UPDATE imports SET status='success',finished_at=clock_timestamp() WHERE id=$1", [raceImport]);
      const result = await importer.query('SELECT * FROM radar_project_import($1)', [raceImport]);
      await importer.query('COMMIT');
      projectorFinished = true;
      return result.rows[0];
    })();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(projectorFinished, false);
    await client.query('COMMIT');
    const raceProjection = await projected;
    assert.ok(Number(raceProjection.match_count) >= 1);
    const raceMatch = await client.query(`
      SELECT count(*)::integer AS count
      FROM radar_matches match
      JOIN case_events event ON event.id=match.event_id
      WHERE match.watch_id=$1 AND event.import_id=$2
    `, [raceWatch, raceImport]);
    assert.equal(raceMatch.rows[0].count, 1);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await importer.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await importer.end();
  }

  await assert.rejects(
    client.query("UPDATE imports SET status='failed' WHERE id=$1", [zeroImport]),
    /terminal_import_status_is_immutable/,
  );

  const failedImport = await startImport();
  await client.query("UPDATE imports SET status='failed',finished_at=clock_timestamp() WHERE id=$1", [failedImport]);
  await assert.rejects(
    client.query('SELECT * FROM radar_project_import($1)', [failedImport]),
    /radar_projection_requires_successful_import/,
  );

  const failedMatches = await client.query(`
    SELECT count(*)::integer AS count
    FROM radar_matches match
    JOIN case_events event ON event.id=match.event_id
    JOIN imports imported ON imported.id=event.import_id
    WHERE imported.status<>'success'
  `);
  assert.equal(failedMatches.rows[0].count, 0);

  const expiredProfile = randomUUID();
  await client.query(`
    INSERT INTO radar_profiles(
      id,token_hash,csrf_hash,created_at,last_active_on,inactive_expires_at,absolute_expires_at
    ) VALUES(
      $1,$2,$3,clock_timestamp()-interval '365 days',current_date-91,
      clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 second'
    )
  `, [expiredProfile, hash(), hash()]);
  const purged = await client.query('SELECT radar_purge_expired_profiles(100) AS count');
  assert.equal(purged.rows[0].count, 1);
  const expiredRemaining = await client.query('SELECT count(*)::integer AS count FROM radar_profiles WHERE id=$1', [expiredProfile]);
  assert.equal(expiredRemaining.rows[0].count, 0);
  await assert.rejects(
    client.query('SELECT radar_purge_expired_profiles(1001)'),
    /radar_purge_batch_out_of_range/,
  );

  const summary = await client.query(`
    SELECT
      (SELECT count(*)::integer FROM radar_profiles) AS profiles,
      (SELECT count(*)::integer FROM radar_watches) AS watches,
      (SELECT count(*)::integer FROM radar_matches) AS matches,
      (SELECT count(*)::integer FROM radar_import_projections WHERE projection_kind='projected') AS projections
  `);
  console.log(JSON.stringify({
    ok: true,
    projection_budget_ms: 8_000,
    projection_profiles: performanceProfileCount,
    projection_watches: performanceProfileCount * 3,
    projection_events: performanceEventCount,
    projection_elapsed_ms: Number(representativeProjectionMilliseconds.toFixed(1)),
    ...summary.rows[0],
  }));
} finally {
  await client.end();
}
