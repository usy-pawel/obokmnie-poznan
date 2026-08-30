import pg from 'pg';
import {
  databaseUnavailableVerification,
  verificationDatabaseConfig,
  verifyRadarImport,
} from '../lib/radar-import-verification.mjs';

let result;
let client = null;
try {
  const databaseConfig = verificationDatabaseConfig();
  if (!databaseConfig) {
    result = databaseUnavailableVerification();
  } else {
    client = new pg.Client(databaseConfig);
    await client.connect();
    result = await verifyRadarImport(client);
  }
} catch {
  result = databaseUnavailableVerification();
} finally {
  if (client) await client.end().catch(() => {});
}

console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 2;
