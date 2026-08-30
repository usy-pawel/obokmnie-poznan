import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMaintenancePaperReceipt } from '../lib/maintenance-agent-pack.mjs';

const MAX_INPUT_BYTES = 128 * 1024;
const DEFAULT_DIRECTORY = '.cache/maintenance-paper';

function safeFileName(invocationKey) {
  return `${createHash('sha256').update(invocationKey, 'utf8').digest('hex')}.json`;
}

export async function readMaintenancePaperReceiptInput(path) {
  const buffer = path
    ? await readBoundedFile(resolve(path))
    : await new Promise((resolveInput, rejectInput) => {
      const chunks = [];
      let size = 0;
      process.stdin.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_INPUT_BYTES) rejectInput(new Error('paper_receipt_input_too_large'));
        else chunks.push(chunk);
      });
      process.stdin.on('end', () => resolveInput(Buffer.concat(chunks)));
      process.stdin.on('error', rejectInput);
    });
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('paper_receipt_input_too_large');
  return JSON.parse(buffer.toString('utf8'));
}

async function readBoundedFile(path) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_INPUT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_INPUT_BYTES) throw new Error('paper_receipt_input_too_large');
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function syncDirectory(path) {
  if (platform() === 'win32') return;
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function sameExistingReceipt(path, serialized) {
  try {
    return await readFile(path, 'utf8') === serialized;
  } catch {
    return false;
  }
}

export async function writeMaintenancePaperReceipt({ input, directory = DEFAULT_DIRECTORY }) {
  const receipt = buildMaintenancePaperReceipt(input);
  const absoluteDirectory = resolve(directory);
  const destination = join(absoluteDirectory, safeFileName(receipt.invocation_key));
  const serialized = `${JSON.stringify(receipt)}\n`;
  await mkdir(absoluteDirectory, { recursive: true, mode: 0o700 });

  if (await sameExistingReceipt(destination, serialized)) {
    return { status: 'recovered', receipt_hash: receipt.receipt_hash, effects_performed: false };
  }

  const temporary = join(
    absoluteDirectory,
    `.${safeFileName(receipt.invocation_key)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(serialized, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error?.code !== 'EEXIST' || !await sameExistingReceipt(destination, serialized)) {
        throw new Error('paper_receipt_idempotency_conflict');
      }
      return { status: 'recovered', receipt_hash: receipt.receipt_hash, effects_performed: false };
    }
    await syncDirectory(absoluteDirectory);
    return { status: 'written', receipt_hash: receipt.receipt_hash, effects_performed: false };
  } finally {
    if (file) await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function main() {
  try {
    const input = await readMaintenancePaperReceiptInput(process.argv[2]);
    const result = await writeMaintenancePaperReceipt({ input });
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch {
    console.error(JSON.stringify({
      ok: false,
      status: 'failed',
      code: 'paper_receipt_write_failed',
      effects_performed: false,
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
