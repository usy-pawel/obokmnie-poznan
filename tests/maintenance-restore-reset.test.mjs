import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { privateDatabaseConfig } from '../scripts/reset-maintenance-after-restore.mjs';

test('restore reset is explicit, private, fenced, fail-closed and verifiable', async () => {
  const script = await readFile(
    new URL('../scripts/reset-maintenance-after-restore.mjs', import.meta.url),
    'utf8',
  );
  assert.match(script, /CONFIRM_RADAR_RESTORE_RESET/);
  assert.match(script, /public_database_url_not_allowed/);
  assert.match(script, /pg_advisory_xact_lock/);
  assert.match(script, /SET status='blocked'/);
  assert.match(script, /result_code='restore_invalidated'/);
  assert.match(script, /accountability_status','not_evaluated_after_restore'/);
  assert.doesNotMatch(script, /'remaining','\[\]'::jsonb/);
  assert.match(script, /fence=fence \+ 1/);
  assert.match(script, /actions_disabled=true/);
  assert.match(script, /running_runs !== 0/);
  assert.match(script, /await client\.query\('ROLLBACK'\)/);
});

test('restore config accepts only Railway private hosts or explicit local tests without TLS downgrade', () => {
  const base = { CONFIRM_RADAR_RESTORE_RESET: 'radar_operations' };
  assert.throws(
    () => privateDatabaseConfig({
      ...base,
      DATABASE_URL: 'postgres://user:password@db.example.com/radar',
    }),
    /private_database_host_required/,
  );
  assert.throws(
    () => privateDatabaseConfig({ ...base, PGHOST: 'db.example.com' }),
    /private_database_host_required/,
  );
  assert.throws(
    () => privateDatabaseConfig({ ...base, PGHOST: '127.0.0.1', PGSSLMODE: 'disable' }),
    /private_database_host_required/,
  );

  const verified = privateDatabaseConfig({
    ...base,
    DATABASE_URL: 'postgres://user:password@postgres.railway.internal/radar?sslmode=verify-full',
  });
  assert.deepEqual(verified.ssl, { rejectUnauthorized: true });
  assert.doesNotMatch(verified.connectionString, /sslmode/);

  const local = privateDatabaseConfig({
    ...base,
    PGHOST: '127.0.0.1',
    PGSSLMODE: 'disable',
    ALLOW_LOCAL_RESTORE_RESET: '1',
  });
  assert.equal(local.ssl, false);
});

test('malformed database URL never appears in CLI output', () => {
  const marker = 'SHOULD_NOT_LEAK_92f7';
  const scriptPath = fileURLToPath(
    new URL('../scripts/reset-maintenance-after-restore.mjs', import.meta.url),
  );
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: {
      SystemRoot: process.env.SystemRoot || '',
      WINDIR: process.env.WINDIR || '',
      TEMP: process.env.TEMP || '',
      TMP: process.env.TMP || '',
      CONFIRM_RADAR_RESTORE_RESET: 'radar_operations',
      DATABASE_URL: `postgres://user:${marker}@[broken/radar`,
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.doesNotMatch(output, new RegExp(marker));
  assert.match(output, /"code":"restore_reset_failed"/);
});

test('run history blocks deletion, truncation, identity edits and terminal rewrites', async () => {
  const migration = await readFile(
    new URL('../migrations/010_maintenance_control_plane.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /TG_OP IN \('DELETE', 'TRUNCATE'\)/);
  assert.match(migration, /maintenance_run_identity_is_immutable/);
  assert.match(migration, /OLD\.status <> 'running' AND NEW IS DISTINCT FROM OLD/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON maintenance_runs/);
  assert.match(migration, /BEFORE TRUNCATE ON maintenance_runs/);
});
