import pg from 'pg';
import { pathToFileURL } from 'node:url';

const SCOPE = 'radar_operations';
const CONFIRMATION = 'radar_operations';
const CONNECTION_TIMEOUT_MILLISECONDS = 5_000;
const STATEMENT_TIMEOUT_MILLISECONDS = 15_000;
const QUERY_TIMEOUT_MILLISECONDS = 20_000;

function approvedPrivateHost(hostname, allowLocal) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (normalized.endsWith('.railway.internal')) return true;
  return allowLocal && ['localhost', '127.0.0.1', '::1'].includes(normalized);
}

export function privateDatabaseConfig(environment = process.env) {
  if (environment.CONFIRM_RADAR_RESTORE_RESET !== CONFIRMATION) {
    throw new Error('restore_reset_confirmation_required');
  }
  if (environment.DATABASE_PUBLIC_URL) {
    throw new Error('public_database_url_not_allowed');
  }
  if (!environment.DATABASE_URL && !environment.PGHOST) {
    throw new Error('private_database_configuration_required');
  }

  let connectionString;
  let urlSslMode = '';
  const allowLocal = environment.ALLOW_LOCAL_RESTORE_RESET === '1';
  if (environment.DATABASE_URL) {
    const parsed = new URL(environment.DATABASE_URL);
    if (!approvedPrivateHost(parsed.hostname, allowLocal)) {
      throw new Error('private_database_host_required');
    }
    urlSslMode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
    parsed.search = '';
    parsed.hash = '';
    connectionString = parsed.toString();
  } else if (!approvedPrivateHost(environment.PGHOST, allowLocal)) {
    throw new Error('private_database_host_required');
  }

  const configuredSslMode = (environment.PGSSLMODE || '').toLowerCase();
  if (configuredSslMode && urlSslMode && configuredSslMode !== urlSslMode) {
    throw new Error('conflicting_ssl_mode');
  }
  const sslMode = configuredSslMode || urlSslMode;
  if (sslMode && !['disable', 'verify-ca', 'verify-full'].includes(sslMode)) {
    throw new Error('verified_tls_or_private_network_required');
  }

  return {
    ...(connectionString ? { connectionString } : {}),
    ssl: ['verify-ca', 'verify-full'].includes(sslMode)
      ? { rejectUnauthorized: true }
      : false,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLISECONDS,
    statement_timeout: STATEMENT_TIMEOUT_MILLISECONDS,
    query_timeout: QUERY_TIMEOUT_MILLISECONDS,
    application_name: 'radar_maintenance_restore_reset',
    options: `-c statement_timeout=${STATEMENT_TIMEOUT_MILLISECONDS}`,
  };
}

export async function resetAfterRestore(database) {
  const client = await database.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query(`SET LOCAL statement_timeout='${STATEMENT_TIMEOUT_MILLISECONDS}ms'`);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('radar_maintenance_control'), hashtext($1))",
      [SCOPE],
    );
    await client.query(`
      INSERT INTO maintenance_leases(scope, actions_disabled)
      VALUES($1, true) ON CONFLICT(scope) DO NOTHING
    `, [SCOPE]);
    const before = await client.query(`
      SELECT fence::text AS fence
      FROM maintenance_leases
      WHERE scope=$1
      FOR UPDATE
    `, [SCOPE]);
    if (before.rowCount !== 1) throw new Error('restore_reset_precondition_failed');

    const invalidated = await client.query(`
      UPDATE maintenance_runs
      SET status='blocked',
          finished_at=clock_timestamp(),
          result_code='restore_invalidated',
          receipt=jsonb_build_object(
            'version','radar_restore_reset_v1',
            'status','blocked',
            'code','restore_invalidated',
            'accountability_status','not_evaluated_after_restore'
          )
      WHERE scope=$1 AND status='running'
    `, [SCOPE]);

    const lease = await client.query(`
      UPDATE maintenance_leases
      SET run_id=NULL,
          owner=NULL,
          context_hash=NULL,
          acquired_at=NULL,
          heartbeat_at=NULL,
          expires_at=NULL,
          fence=fence + 1,
          actions_disabled=true
      WHERE scope=$1
      RETURNING fence::text AS fence, run_id, owner, context_hash,
                acquired_at, heartbeat_at, expires_at, actions_disabled
    `, [SCOPE]);
    if (lease.rowCount !== 1) throw new Error('restore_reset_lease_failed');

    const verification = await client.query(`
      SELECT
        count(*) FILTER (WHERE status='running')::int AS running_runs,
        count(*) FILTER (
          WHERE status='blocked'
            AND result_code='restore_invalidated'
            AND receipt->>'code'='restore_invalidated'
        )::int AS invalidated_runs
      FROM maintenance_runs
      WHERE scope=$1
    `, [SCOPE]);
    const after = lease.rows[0];
    const fenceAdvanced = BigInt(after.fence) === BigInt(before.rows[0].fence) + 1n;
    const leaseCleared = after.run_id === null && after.owner === null
      && after.context_hash === null && after.acquired_at === null
      && after.heartbeat_at === null && after.expires_at === null;
    if (verification.rows[0].running_runs !== 0
        || !fenceAdvanced
        || !leaseCleared
        || after.actions_disabled !== true) {
      throw new Error('restore_reset_verification_failed');
    }

    await client.query('COMMIT');
    transactionOpen = false;
    return {
      ok: true,
      code: 'restore_reset_succeeded',
      invalidated_runs: invalidated.rowCount,
      fence: after.fence,
      actions_disabled: true,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The caller receives one stable failure code even if the connection was lost.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function runCli() {
  let database;
  try {
    database = new pg.Pool(privateDatabaseConfig());
    console.log(JSON.stringify(await resetAfterRestore(database)));
  } catch {
    console.error(JSON.stringify({ ok: false, code: 'restore_reset_failed' }));
    process.exitCode = 1;
  } finally {
    if (database) {
      try {
        await database.end();
      } catch {
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
