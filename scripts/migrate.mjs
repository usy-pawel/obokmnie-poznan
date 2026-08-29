import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString && !process.env.PGHOST) throw new Error('Brak konfiguracji PostgreSQL');

const client = new pg.Client({
  ...(connectionString ? { connectionString } : {}),
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
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
