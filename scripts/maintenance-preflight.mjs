import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectMaintenancePreflight,
  maintenanceReceipt,
} from '../lib/maintenance-preflight.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

async function main() {
  const baseUrl = option('--base-url', process.env.BASE_URL || 'http://localhost:3000');
  const output = path.resolve(option(
    '--output',
    process.env.MAINTENANCE_RECEIPT_PATH || path.join(PROJECT, '.cache', 'maintenance-receipt.json'),
  ));
  const allowedOrigins = option('--allowed-origins', process.env.MAINTENANCE_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const preflight = await collectMaintenancePreflight({
    baseUrl,
    ...(allowedOrigins.length ? { allowedOrigins } : {}),
    allowLocalhost: flag('--allow-localhost'),
  });
  const receipt = maintenanceReceipt(preflight);
  await mkdir(path.dirname(output), { recursive: true });
  const temporaryOutput = `${output}.${process.pid}.tmp`;
  await writeFile(temporaryOutput, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryOutput, output);
  console.log(JSON.stringify({
    ok: preflight.ok,
    code: preflight.code,
    context_hash: preflight.context_hash,
  }));
  if (!preflight.ok) process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error.code || 'preflight_failed' }));
  process.exitCode = 2;
});
