import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

if (process.env.RADAR_TEST_DATABASE !== '1') {
  throw new Error('test-radar-upgrade wymaga izolowanej bazy i RADAR_TEST_DATABASE=1');
}
if (!process.env.DATABASE_URL) throw new Error('Brak DATABASE_URL izolowanej bazy');
const sourceUrl = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(sourceUrl.hostname)) {
  throw new Error('Test upgrade może działać wyłącznie przez loopback');
}

const databaseName = `radar_upgrade_${process.pid}_${randomBytes(4).toString('hex')}`;
if (!/^radar_upgrade_[a-z0-9_]+$/.test(databaseName)) throw new Error('Nieprawidłowa nazwa bazy testowej');
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = '/postgres';
const upgradeUrl = new URL(sourceUrl);
upgradeUrl.pathname = `/${databaseName}`;
const config = (connectionString, applicationName) => ({
  connectionString: connectionString.toString(),
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  query_timeout: 40_000,
  application_name: applicationName,
});

const admin = new pg.Client(config(adminUrl, 'radar_upgrade_test_admin'));
let upgrade;
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  upgrade = new pg.Client(config(upgradeUrl, 'radar_upgrade_test'));
  await upgrade.connect();
  await upgrade.query(`
    CREATE TABLE schema_migrations(
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const migrations = (await readdir(new URL('../migrations/', import.meta.url)))
    .filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations.filter((candidate) => candidate < '011_server_radar.sql')) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    await upgrade.query('BEGIN');
    try {
      await upgrade.query(sql);
      await upgrade.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      await upgrade.query('COMMIT');
    } catch (error) {
      await upgrade.query('ROLLBACK');
      throw error;
    }
  }

  const imported = await upgrade.query(`
    INSERT INTO imports(source_date,status,finished_at)
    VALUES(current_date,'success',clock_timestamp()) RETURNING id
  `);
  const caseRow = await upgrade.query(`
    INSERT INTO cases(
      case_key,source_type,external_id,received_date,status,voivodeship,description,
      parcel_ids,source_fingerprint,source_active,last_import_id
    ) VALUES(
      'upgrade:case','zgloszenie','upgrade',current_date,'nowa','wielkopolskie','Upgrade',
      ARRAY['A'],'upgrade-a',true,$1
    ) RETURNING id
  `, [imported.rows[0].id]);
  await upgrade.query(`
    INSERT INTO case_events(case_id,import_id,event_type,changed_fields,snapshot)
    VALUES($1,$2,'new',ARRAY['case'],jsonb_build_object('parcel_ids',jsonb_build_array('A')))
  `, [caseRow.rows[0].id, imported.rows[0].id]);
  const legacyChangedImport = await upgrade.query(`
    INSERT INTO imports(source_date,status,finished_at)
    VALUES(current_date,'success',clock_timestamp()) RETURNING id
  `);
  await upgrade.query(`
    UPDATE cases SET parcel_ids=ARRAY['B'],source_fingerprint='upgrade-legacy-b',last_import_id=$2
    WHERE id=$1
  `, [caseRow.rows[0].id, legacyChangedImport.rows[0].id]);
  await upgrade.query(`
    INSERT INTO case_events(case_id,import_id,event_type,changed_fields,snapshot)
    VALUES($1,$2,'changed',ARRAY['parcel_ids'],jsonb_build_object('parcel_ids',jsonb_build_array('B')))
  `, [caseRow.rows[0].id, legacyChangedImport.rows[0].id]);

  const migration011 = await readFile(new URL('../migrations/011_server_radar.sql', import.meta.url), 'utf8');
  await upgrade.query('BEGIN');
  await upgrade.query(migration011);
  const interruptedConnection = new Promise((resolve) => upgrade.once('error', resolve));
  const interruptedBackend = await upgrade.query('SELECT pg_backend_pid() AS pid');
  await admin.query('SELECT pg_terminate_backend($1)', [interruptedBackend.rows[0].pid]);
  const interruptedConnectionError = await interruptedConnection;
  await upgrade.end().catch(() => {});
  assert.equal(interruptedConnectionError.code, '57P01');
  upgrade = new pg.Client(config(upgradeUrl, 'radar_upgrade_test_reconnected'));
  await upgrade.connect();
  const interruptedDeployment = await upgrade.query(`
    SELECT to_regclass('radar_profiles') IS NULL AS schema_rolled_back,
           NOT EXISTS(
             SELECT 1 FROM schema_migrations WHERE name='011_server_radar.sql'
           ) AS migration_unrecorded
  `);
  assert.equal(interruptedDeployment.rows[0].schema_rolled_back, true);
  assert.equal(interruptedDeployment.rows[0].migration_unrecorded, true);

  await upgrade.query('BEGIN');
  try {
    await upgrade.query(migration011);
    await upgrade.query("INSERT INTO schema_migrations(name) VALUES('011_server_radar.sql')");
    await upgrade.query('COMMIT');
  } catch (error) {
    await upgrade.query('ROLLBACK');
    throw error;
  }
  await upgrade.query("UPDATE cases SET published=true WHERE id=$1", [caseRow.rows[0].id]);
  const migration012 = await readFile(new URL('../migrations/012_case_publication_history.sql', import.meta.url), 'utf8');
  await upgrade.query('BEGIN');
  try {
    await upgrade.query("SET LOCAL statement_timeout='1s'");
    await upgrade.query(migration012);
    await upgrade.query("INSERT INTO schema_migrations(name) VALUES('012_case_publication_history.sql')");
    await upgrade.query('COMMIT');
  } catch (error) {
    await upgrade.query('ROLLBACK');
    throw error;
  }
  const currentPublication = await upgrade.query('SELECT published,ever_published FROM cases WHERE id=$1', [caseRow.rows[0].id]);
  assert.deepEqual(currentPublication.rows[0], { published: true, ever_published: false });
  await upgrade.query('UPDATE cases SET published=false WHERE id=$1', [caseRow.rows[0].id]);
  const withdrawnPublication = await upgrade.query('SELECT published,ever_published FROM cases WHERE id=$1', [caseRow.rows[0].id]);
  assert.deepEqual(withdrawnPublication.rows[0], { published: false, ever_published: true });

  const migration013 = await readFile(new URL('../migrations/013_radar_email_double_opt_in.sql', import.meta.url), 'utf8');
  await upgrade.query('BEGIN');
  try {
    await upgrade.query("SET LOCAL statement_timeout='2s'");
    await upgrade.query(migration013);
    await upgrade.query("INSERT INTO schema_migrations(name) VALUES('013_radar_email_double_opt_in.sql')");
    await upgrade.query('COMMIT');
  } catch (error) {
    await upgrade.query('ROLLBACK');
    throw error;
  }

  const migration014 = await readFile(new URL('../migrations/014_radar_email_alert_outbox.sql', import.meta.url), 'utf8');
  await upgrade.query('BEGIN');
  try {
    await upgrade.query("SET LOCAL statement_timeout='2s'");
    await upgrade.query(migration014);
    await upgrade.query("INSERT INTO schema_migrations(name) VALUES('014_radar_email_alert_outbox.sql')");
    await upgrade.query('COMMIT');
  } catch (error) {
    await upgrade.query('ROLLBACK');
    throw error;
  }

  const oldEvent = await upgrade.query('SELECT match_parcel_ids FROM case_events ORDER BY id LIMIT 1');
  assert.equal(oldEvent.rows[0].match_parcel_ids, null);
  const baseline = await upgrade.query(`
    SELECT projection_kind FROM radar_import_projections WHERE import_id=$1
  `, [imported.rows[0].id]);
  assert.equal(baseline.rows[0].projection_kind, 'baseline');

  await upgrade.query("INSERT INTO parcels(parcel_id,datasource) VALUES('A','test'),('B','test'),('C','test')");
  const legacyProfile = randomUUID();
  const legacyWatch = randomUUID();
  const clientKey = randomUUID();
  await upgrade.query(`
    INSERT INTO radar_profiles(id,token_hash,csrf_hash,inactive_expires_at,absolute_expires_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '90 days',clock_timestamp()+interval '365 days')
  `, [legacyProfile, randomBytes(32), randomBytes(32)]);
  await upgrade.query(`
    INSERT INTO radar_email_subscriptions(
      profile_id,email,email_fingerprint,state,confirmation_token_hash,
      confirmation_expires_at,unconfirmed_delete_at,resend_available_at,
      service_consent_version,service_consent_text,service_consented_at,
      marketing_consent,marketing_consent_version,marketing_consent_text
    ) VALUES(
      $1,'upgrade@example.com',$2,'pending',$3,
      clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',clock_timestamp(),
      'service-v1','Service consent',clock_timestamp(),false,'marketing-v1','Marketing consent'
    )
  `, [legacyProfile, randomBytes(32), randomBytes(32)]);
  await upgrade.query(`
    INSERT INTO radar_email_deliveries(
      id,profile_id,custom_id,kind,provider_message_id,provider_message_uuid,created_at,expires_at
    ) VALUES($1,$2,'upgrade:delivery','confirmation','provider-id','provider-uuid',
      clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day')
  `, [randomUUID(), legacyProfile]);
  const purgedEmail = await upgrade.query('SELECT * FROM radar_purge_email_data(1000)');
  assert.deepEqual(purgedEmail.rows[0], {
    pending_subscriptions: 1, deliveries: 1, suppressions: 0,
  });
  const suppression = await upgrade.query(`
    SELECT count(*)::integer AS count FROM radar_email_suppressions
    WHERE email_fingerprint IS NOT NULL AND expires_at>clock_timestamp()
  `);
  assert.equal(suppression.rows[0].count, 1);
  await upgrade.query(`
    UPDATE radar_email_suppressions SET
      suppressed_at=clock_timestamp()-interval '31 days',
      expires_at=clock_timestamp()-interval '1 day'
  `);
  const purgedSuppression = await upgrade.query('SELECT * FROM radar_purge_email_data(1000)');
  assert.equal(purgedSuppression.rows[0].suppressions, 1);
  assert.equal((await upgrade.query("SELECT radar_charge_global_rate('email_confirmation',10) AS charged")).rows[0].charged, 1);
  await upgrade.query(`
    INSERT INTO radar_watches(id,profile_id,client_key,request_hash,kind,starts_after_import_id)
    VALUES($1,$2,$3,$4,'parcel',$5)
  `, [legacyWatch, legacyProfile, clientKey, randomBytes(32), imported.rows[0].id]);
  await upgrade.query('INSERT INTO radar_watch_parcels(watch_id,parcel_id) VALUES($1,\'A\')', [legacyWatch]);
  const legacyBackfill = await upgrade.query('SELECT radar_backfill_watch($1) AS count', [legacyWatch]);
  assert.equal(legacyBackfill.rows[0].count, 1);
  const legacyMatch = await upgrade.query(`
    SELECT event.import_id FROM radar_matches match
    JOIN case_events event ON event.id=match.event_id
    WHERE match.watch_id=$1
  `, [legacyWatch]);
  assert.equal(String(legacyMatch.rows[0].import_id), String(legacyChangedImport.rows[0].id));

  const nextImport = await upgrade.query(`
    INSERT INTO imports(source_date,status) VALUES(current_date,'running') RETURNING id
  `);
  await upgrade.query('BEGIN');
  await upgrade.query("SELECT set_config('obokmnie.import_id',$1,false)", [String(nextImport.rows[0].id)]);
  await upgrade.query(`
    UPDATE cases SET parcel_ids=ARRAY['C'],source_fingerprint='upgrade-c',last_import_id=$2
    WHERE id=$1
  `, [caseRow.rows[0].id, nextImport.rows[0].id]);
  await upgrade.query("SELECT pg_advisory_xact_lock(hashtext('radar_watch_projection'))");
  await upgrade.query(`
    UPDATE imports SET status='success',finished_at=clock_timestamp() WHERE id=$1
  `, [nextImport.rows[0].id]);
  const projection = await upgrade.query('SELECT * FROM radar_project_import($1)', [nextImport.rows[0].id]);
  await upgrade.query('COMMIT');
  assert.equal(Number(projection.rows[0].event_count), 1);
  const newEvent = await upgrade.query('SELECT match_parcel_ids FROM case_events WHERE import_id=$1', [nextImport.rows[0].id]);
  assert.deepEqual(newEvent.rows[0].match_parcel_ids, ['B', 'C']);

  const rollbackImport = await upgrade.query(`
    INSERT INTO imports(source_date,status) VALUES(current_date,'running') RETURNING id
  `);
  await upgrade.query('BEGIN');
  await upgrade.query("SELECT set_config('obokmnie.import_id',$1,false)", [String(rollbackImport.rows[0].id)]);
  await upgrade.query(`
    UPDATE cases SET parcel_ids=ARRAY['A'],source_fingerprint='upgrade-old-importer',last_import_id=$2
    WHERE id=$1
  `, [caseRow.rows[0].id, rollbackImport.rows[0].id]);
  await upgrade.query(`
    UPDATE imports SET status='success',finished_at=clock_timestamp() WHERE id=$1
  `, [rollbackImport.rows[0].id]);
  await upgrade.query('COMMIT');
  const gap = await upgrade.query(`
    SELECT count(*)::integer AS count FROM imports imported
    LEFT JOIN radar_import_projections projection ON projection.import_id=imported.id
    WHERE imported.id=$1 AND projection.import_id IS NULL
  `, [rollbackImport.rows[0].id]);
  assert.equal(gap.rows[0].count, 1);
  const recovered = await upgrade.query('SELECT * FROM radar_recover_missing_projections(10)');
  assert.equal(recovered.rows.some((row) => String(row.import_id) === String(rollbackImport.rows[0].id)), true);

  const version = await upgrade.query('SELECT PostGIS_Version() AS version');
  console.log(JSON.stringify({
    ok: true,
    upgrade: '010_to_014',
    interrupted_deployment_rollback: true,
    postgis: version.rows[0].version,
  }));
} finally {
  if (upgrade) await upgrade.end().catch(() => {});
  await admin.query(`
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname=$1 AND pid<>pg_backend_pid()
  `, [databaseName]).catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => {});
  await admin.end();
}
