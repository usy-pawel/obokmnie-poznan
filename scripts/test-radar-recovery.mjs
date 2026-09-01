import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const suffix = `${process.pid}_${randomBytes(4).toString('hex')}`;
const containerName = `radar-recovery-${suffix.replaceAll('_', '-')}`;
const sourceDatabase = `radar_test_recovery_source_${suffix}`;
const restoredDatabase = `radar_test_recovery_restored_${suffix}`;
const dumpPath = `/tmp/${containerName}.dump`;
const databaseUser = 'radar_recovery';
const databasePassword = 'radar_recovery_test';
const databaseNames = [sourceDatabase, restoredDatabase];
const postgisImage = 'postgis/postgis@sha256:624f5195b91d424dbebf018890148cc0e5a3e80db5467da8b53cc2ed2ce49216';
const processTimeoutMilliseconds = 180_000;

for (const name of databaseNames) {
  if (!/^radar_test_recovery_(?:source|restored)_[a-z0-9_]+$/.test(name)) {
    throw new Error('Nieprawidłowa nazwa izolowanej bazy recovery');
  }
}

async function docker(...args) {
  return execFileAsync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
    killSignal: 'SIGKILL',
  });
}

function runNode(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: repositoryRoot,
      env: environment,
      stdio: 'inherit',
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, processTimeoutMilliseconds);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error(`${script} przekroczył limit ${processTimeoutMilliseconds} ms`));
      if (code === 0) resolve();
      else reject(new Error(`${script} zakończył się: ${signal || code}`));
    });
  });
}

async function waitForPostgres(connectionString) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = new pg.Client({ connectionString, ssl: false, connectionTimeoutMillis: 1_000 });
    try {
      await probe.connect();
      await probe.end();
      return;
    } catch {
      await probe.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('Izolowany PostGIS recovery nie wystartował');
}

async function recoverySnapshot(connectionString) {
  const database = new pg.Client({
    connectionString,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'radar_recovery_snapshot',
  });
  await database.connect();
  try {
    const result = await database.query(`
      SELECT
        (SELECT count(*)::integer FROM schema_migrations) AS migrations,
        (SELECT count(*)::integer FROM radar_profiles) AS profiles,
        (SELECT count(*)::integer FROM radar_watches) AS watches,
        (SELECT count(*)::integer FROM radar_watches WHERE kind='parcel') AS parcel_watches,
        (SELECT count(*)::integer FROM radar_watches WHERE kind='parcel_set') AS parcel_set_watches,
        (SELECT count(*)::integer FROM radar_watches WHERE kind='radius') AS radius_watches,
        (SELECT count(*)::integer FROM radar_watch_parcels) AS memberships,
        (SELECT count(*)::integer FROM radar_matches) AS matches,
        (SELECT count(*)::integer FROM radar_import_projections) AS projections,
        (SELECT count(*)::integer FROM maintenance_runs WHERE status='running') AS running_runs,
        (SELECT count(*)::integer FROM maintenance_leases WHERE run_id IS NOT NULL) AS active_leases,
        (SELECT bool_and(octet_length(token_hash)=32 AND octet_length(csrf_hash)=32)
           FROM radar_profiles) AS token_hashes_bounded
    `);
    return result.rows[0];
  } finally {
    await database.end();
  }
}

async function seedActiveMaintenanceLease(connectionString) {
  const database = new pg.Client({ connectionString, ssl: false, connectionTimeoutMillis: 5_000 });
  await database.connect();
  try {
    await database.query('BEGIN');
    const run = await database.query(`
      INSERT INTO maintenance_runs(
        invocation_key,contract_version,context_hash,executor,fence,deadline_at
      ) VALUES(
        'recovery-active-run','radar_maintenance_control_v1',$1,'recovery-test',7,
        clock_timestamp()+interval '40 minutes'
      ) RETURNING id
    `, ['a'.repeat(64)]);
    await database.query(`
      UPDATE maintenance_leases
      SET run_id=$1,owner='recovery-test',fence=7,context_hash=$2,
          acquired_at=clock_timestamp(),heartbeat_at=clock_timestamp(),
          expires_at=clock_timestamp()+interval '20 minutes',actions_disabled=true
      WHERE scope='radar_operations'
    `, [run.rows[0].id, 'a'.repeat(64)]);
    await database.query('COMMIT');
  } catch (error) {
    await database.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await database.end();
  }
}

async function verifyRestoreReset(connectionString) {
  const database = new pg.Client({ connectionString, ssl: false, connectionTimeoutMillis: 5_000 });
  await database.connect();
  try {
    const result = await database.query(`
      SELECT
        (SELECT count(*)::integer FROM maintenance_runs WHERE status='running') AS running_runs,
        (SELECT count(*)::integer FROM maintenance_runs
          WHERE status='blocked' AND result_code='restore_invalidated') AS invalidated_runs,
        lease.run_id IS NULL AND lease.owner IS NULL AND lease.context_hash IS NULL
          AND lease.acquired_at IS NULL AND lease.heartbeat_at IS NULL AND lease.expires_at IS NULL
          AS lease_cleared,
        lease.actions_disabled,
        lease.fence::integer AS fence
      FROM maintenance_leases lease WHERE scope='radar_operations'
    `);
    assert.deepEqual(result.rows[0], {
      running_runs: 0,
      invalidated_runs: 1,
      lease_cleared: true,
      actions_disabled: true,
      fence: 8,
    });
  } finally {
    await database.end();
  }
}

let containerStarted = false;
let admin = null;
let adminConnected = false;
try {
  await docker(
    'run', '--name', containerName,
    '-e', `POSTGRES_USER=${databaseUser}`,
    '-e', `POSTGRES_PASSWORD=${databasePassword}`,
    '-e', 'POSTGRES_DB=postgres',
    '-p', '127.0.0.1::5432',
    '-d', postgisImage,
  );
  containerStarted = true;

  const mapping = await docker('port', containerName, '5432/tcp');
  const port = /127\.0\.0\.1:(\d+)/u.exec(mapping.stdout)?.[1];
  if (!port) throw new Error('Brak losowego portu loopback dla PostGIS recovery');
  const adminUrl = `postgresql://${databaseUser}:${databasePassword}@127.0.0.1:${port}/postgres`;
  const sourceUrl = `postgresql://${databaseUser}:${databasePassword}@127.0.0.1:${port}/${sourceDatabase}`;
  const restoredUrl = `postgresql://${databaseUser}:${databasePassword}@127.0.0.1:${port}/${restoredDatabase}`;
  const environment = {
    ...process.env,
    RADAR_TEST_DATABASE: '1',
    PGSSLMODE: 'disable',
  };
  for (const key of [
    'DATABASE_PRIVATE_URL',
    'DATABASE_PUBLIC_URL',
    'MAINTENANCE_API_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_CONTEXT_MODEL',
  ]) delete environment[key];
  await waitForPostgres(adminUrl);

  admin = new pg.Client({
    connectionString: adminUrl,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    application_name: 'radar_recovery_admin',
  });
  await admin.connect();
  adminConnected = true;
  await admin.query(`CREATE DATABASE "${sourceDatabase}"`);
  await runNode('scripts/migrate.mjs', { ...environment, DATABASE_URL: sourceUrl });
  await runNode('scripts/test-radar-postgis.mjs', { ...environment, DATABASE_URL: sourceUrl });
  await runNode('scripts/test-radar-alerts.mjs', { ...environment, DATABASE_URL: sourceUrl });
  await seedActiveMaintenanceLease(sourceUrl);
  const before = await recoverySnapshot(sourceUrl);

  await docker(
    'exec', '-e', `PGPASSWORD=${databasePassword}`, containerName,
    'pg_dump', '-U', databaseUser, '-d', sourceDatabase,
    '--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath,
  );
  await admin.query(`CREATE DATABASE "${restoredDatabase}"`);
  await docker(
    'exec', '-e', `PGPASSWORD=${databasePassword}`, containerName,
    'pg_restore', '-U', databaseUser, '-d', restoredDatabase,
    '--exit-on-error', '--no-owner', '--no-privileges', dumpPath,
  );

  const after = await recoverySnapshot(restoredUrl);
  assert.deepEqual(after, before);
  assert.equal(after.token_hashes_bounded, true);
  assert.ok(after.parcel_watches > 0 && after.parcel_set_watches > 0 && after.radius_watches > 0);
  await runNode('scripts/migrate.mjs', { ...environment, DATABASE_URL: restoredUrl });
  assert.deepEqual(await recoverySnapshot(restoredUrl), before);
  await runNode('scripts/reset-maintenance-after-restore.mjs', {
    ...environment,
    DATABASE_URL: restoredUrl,
    ALLOW_LOCAL_RESTORE_RESET: '1',
    CONFIRM_RADAR_RESTORE_RESET: 'radar_operations',
  });
  await verifyRestoreReset(restoredUrl);
  await runNode('scripts/test-radar-api.mjs', { ...environment, DATABASE_URL: restoredUrl });

  console.log(JSON.stringify({
    ok: true,
    suite: 'radar_backup_restore',
    backup_format: 'pg_dump_custom',
    restore_verified: true,
    migration_retry_after_restore_verified: true,
    restore_fence_reset_verified: true,
    api_after_restore_verified: true,
    snapshot: after,
  }));
} finally {
  const cleanupFailures = [];
  if (adminConnected) {
    for (const name of databaseNames) {
      await admin.query(`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=$1 AND pid<>pg_backend_pid()
      `, [name]).catch(() => { cleanupFailures.push(`terminate:${name}`); });
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
        .catch(() => { cleanupFailures.push(`drop:${name}`); });
    }
    await admin.end().catch(() => { cleanupFailures.push('admin:end'); });
  }
  if (containerStarted) {
    await docker('rm', '-f', containerName)
      .catch(() => { cleanupFailures.push('container:remove'); });
  }
  if (cleanupFailures.length) throw new Error(`radar_recovery_cleanup_failed:${cleanupFailures.join(',')}`);
}
