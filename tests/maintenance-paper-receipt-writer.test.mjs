import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  buildMaintenanceAgentStagePack,
  validateMaintenanceAgentResult,
} from '../lib/maintenance-agent-pack.mjs';
import {
  readMaintenancePaperReceiptInput,
  writeMaintenancePaperReceipt,
} from '../scripts/write-maintenance-paper-receipt.mjs';

const HASH = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const EVIDENCE = 'c'.repeat(64);

function input() {
  const stagePack = buildMaintenanceAgentStagePack({
    baseCommit: COMMIT,
    preflight: {
      version: 'radar_maintenance_api_v1',
      context_hash: HASH,
      observed_at: '2026-08-30T06:00:00.000Z',
      priority: 'P1',
      selected: {
        capability: 'daily_import',
        code: 'stale_import',
        priority: 'P1',
        occurrence_count: 1,
        next_action_code: 'inspect_import',
        fingerprint: 'd'.repeat(64),
      },
      observations: [{
        capability: 'daily_import',
        code: 'stale_import',
        safe_context: { data_status: 'stale', last_success_age_hours: 49 },
      }],
      open_issues: [],
    },
  });
  const agentResult = {
    version: 'radar_agent_result_v1',
    input_hash: stagePack.input_hash,
    status: 'completed',
    changed_files: ['lib/fix.mjs'],
    diff_hash: 'e'.repeat(64),
    checks: ['targeted_tests', 'git_diff_check', 'local_ci'].map((code) => ({
      code, status: 'passed', evidence_hash: EVIDENCE,
    })),
    finding_codes: [],
  };
  validateMaintenanceAgentResult(agentResult, stagePack.input_hash);
  return {
    invocationKey: 'radar-supervisor:20260830T06:a0',
    stagePack,
    agentResult,
    ci: { status: 'passed', evidence_hash: EVIDENCE },
    reviews: [{ role: 'recenzent', verdict: 'passed', evidence_hash: EVIDENCE }],
    accountability: {
      receipt_hash: EVIDENCE,
      execution_ok: true,
      health_ok: false,
      priority: 'P1',
      remaining_hash: EVIDENCE,
    },
    humanGate: null,
  };
}

test('paper receipt is durably written once and an identical retry is recovered', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-paper-'));
  try {
    const material = input();
    const first = await writeMaintenancePaperReceipt({ input: material, directory });
    const second = await writeMaintenancePaperReceipt({ input: material, directory });
    assert.equal(first.status, 'written');
    assert.equal(second.status, 'recovered');
    assert.equal(second.receipt_hash, first.receipt_hash);
    const file = join(directory, `${createHash('sha256').update(material.invocationKey).digest('hex')}.json`);
    const receipt = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(receipt.receipt_hash, first.receipt_hash);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('same invocation key with different material fails closed without overwriting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-paper-'));
  try {
    const original = input();
    await writeMaintenancePaperReceipt({ input: original, directory });
    const conflicting = input();
    conflicting.accountability = { ...conflicting.accountability, remaining_hash: 'f'.repeat(64) };
    await assert.rejects(
      writeMaintenancePaperReceipt({ input: conflicting, directory }),
      /paper_receipt_idempotency_conflict/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file input is read through the same 128 KiB bound as stdin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-paper-input-'));
  try {
    const path = join(directory, 'oversized.json');
    await writeFile(path, 'x'.repeat(128 * 1024 + 1), 'utf8');
    await assert.rejects(
      readMaintenancePaperReceiptInput(path),
      /paper_receipt_input_too_large/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
