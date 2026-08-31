import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

if (process.env.RADAR_TEST_DATABASE !== '1') {
  throw new Error('Pakiet PostGIS wymaga RADAR_TEST_DATABASE=1');
}
if (!process.env.DATABASE_URL) throw new Error('Brak DATABASE_URL lokalnego PostGIS');

const adminUrl = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(adminUrl.hostname)) {
  throw new Error('Pakiet PostGIS może działać wyłącznie przez loopback');
}
if (process.env.PGSSLMODE !== 'disable') {
  throw new Error('Lokalny pakiet PostGIS wymaga PGSSLMODE=disable');
}

const databaseName = `radar_test_${process.pid}_${randomBytes(4).toString('hex')}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${databaseName}`;

const admin = new pg.Client({
  connectionString: adminUrl.toString(),
  ssl: false,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  application_name: 'radar_test_harness',
});

function run(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: new URL('..', import.meta.url),
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} zakończył się: ${signal || code}`));
    });
  });
}

await admin.connect();
try {
  await run('scripts/test-radar-upgrade.mjs', process.env);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const environment = { ...process.env, DATABASE_URL: testUrl.toString() };
  await run('scripts/migrate.mjs', environment);
  await run('scripts/test-radar-postgis.mjs', environment);
  await run('scripts/test-radar-api.mjs', environment);
  await run('scripts/test-radar-email-api.mjs', environment);
  console.log(JSON.stringify({ ok: true, suite: 'radar_postgis_release' }));
} finally {
  await admin.query(`
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname=$1 AND pid<>pg_backend_pid()
  `, [databaseName]).catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => {});
  await admin.end();
}
