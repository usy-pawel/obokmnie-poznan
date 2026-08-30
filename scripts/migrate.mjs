import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

function connectionStringWithoutOptions(value) {
  if (!value) return null;
  const parsed = new URL(value);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function sslMode(value) {
  try { return new URL(value).searchParams.get('sslmode')?.toLowerCase() || ''; }
  catch { return ''; }
}

const privateConnectionString = process.env.DATABASE_URL || null;
const publicConnectionString = privateConnectionString ? null : process.env.DATABASE_PUBLIC_URL || null;
const connectionString = privateConnectionString || publicConnectionString;
if (!connectionString) throw new Error('Brak DATABASE_URL albo DATABASE_PUBLIC_URL');
const configuredSslMode = (process.env.PGSSLMODE || sslMode(connectionString)).toLowerCase();
if (publicConnectionString && !['verify-ca', 'verify-full'].includes(configuredSslMode || 'verify-full')) {
  throw new Error('Publiczna migracja PostgreSQL wymaga weryfikacji TLS');
}

const client = new pg.Client({
  connectionString: connectionStringWithoutOptions(connectionString),
  ssl: publicConnectionString || ['verify-ca', 'verify-full'].includes(configuredSslMode)
    ? { rejectUnauthorized: true }
    : configuredSslMode === 'disable' || configuredSslMode === ''
      ? false
      : { rejectUnauthorized: false },
  connectionTimeoutMillis: 5_000,
  statement_timeout: 60_000,
  query_timeout: 70_000,
  application_name: 'radar_schema_migration',
});

await client.connect();
await client.query("SELECT pg_advisory_lock(hashtext('obokmnie_schema_migrations'))");
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
  const migrations = (await readdir(new URL('../migrations/', import.meta.url))).filter((name) => name.endsWith('.sql')).sort();

  for (const name of migrations) {
    if (applied.has(name)) continue;
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  const version = await client.query('SELECT PostGIS_Version() AS version');
  console.log(JSON.stringify({ migrations: migrations.length, postgis: version.rows[0].version }));
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('obokmnie_schema_migrations'))");
  await client.end();
}
