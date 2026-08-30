import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_RESULT_VERSION,
  AGENT_STAGE_PACK_VERSION,
  MAX_AGENT_ARTIFACT_BYTES,
  PAPER_RECEIPT_VERSION,
  buildMaintenanceAgentStagePack,
  buildMaintenancePaperReceipt,
  validateMaintenanceAgentResult,
} from '../lib/maintenance-agent-pack.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const COMMIT_A = '1'.repeat(40);
const COMMIT_B = '2'.repeat(40);

function preflight(overrides = {}) {
  return {
    version: 'radar_maintenance_api_v1',
    observed_at: '2026-08-30T12:00:00.000Z',
    context_hash: HASH_A,
    priority: 'P1',
    selected: {
      source: 'open_issue',
      fingerprint: HASH_B,
      capability: 'daily_import',
      code: 'daily_import_stale',
      priority: 'P1',
      owner: 'data_pipeline',
      next_action_code: 'run_import_preflight',
      occurrence_count: 3,
    },
    observations: [
      { capability: 'web_database', health: 'healthy', code: null, safe_context: {} },
      {
        capability: 'daily_import',
        health: 'unhealthy',
        code: 'daily_import_stale',
        safe_context: {
          data_status: 'stale',
          latest_import_id: '12',
          last_success_age_hours: 40,
        },
      },
    ],
    open_issues: [],
    control_plane: {
      lease: { state: 'active', run_id: 'private-run', fence: '99' },
      kill_switch: { actions_disabled: true },
    },
    private_token: 'must-never-leak',
    ...overrides,
  };
}

function stagePack(input = {}) {
  return buildMaintenanceAgentStagePack({ preflight: preflight(), baseCommit: COMMIT_A, ...input });
}

function agentResult(inputHash, overrides = {}) {
  return {
    version: AGENT_RESULT_VERSION,
    input_hash: inputHash,
    status: 'completed',
    changed_files: ['tests/change.test.mjs', 'lib/change.mjs'],
    diff_hash: HASH_B,
    checks: [
      { code: 'local_ci', status: 'passed', evidence_hash: HASH_A },
      { code: 'targeted_tests', status: 'passed', evidence_hash: HASH_B },
      { code: 'git_diff_check', status: 'passed', evidence_hash: HASH_A },
    ],
    finding_codes: ['bounded_contract_added'],
    ...overrides,
  };
}

function receiptInput(overrides = {}) {
  const pack = stagePack();
  return {
    invocationKey: 'radar-supervisor:20260830T12:a0',
    stagePack: pack,
    agentResult: agentResult(pack.input_hash),
    ci: { status: 'passed', evidence_hash: HASH_A },
    reviews: [
      { role: 'soter', verdict: 'passed', evidence_hash: HASH_B },
      { role: 'ada', verdict: 'passed', evidence_hash: HASH_A },
    ],
    accountability: {
      receipt_hash: HASH_A,
      execution_ok: true,
      health_ok: false,
      priority: 'P1',
      remaining_hash: HASH_B,
    },
    ...overrides,
  };
}

test('stage pack is a deterministic frozen projection with exactly one selected task', () => {
  const first = stagePack();
  const second = stagePack();
  assert.deepEqual(first, second);
  assert.equal(first.version, AGENT_STAGE_PACK_VERSION);
  assert.match(first.input_hash, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Array.isArray(first.selected_task), false);
  assert.equal(first.selected_task.public_reference, HASH_B);
  assert.deepEqual(first.selected_task.safe_context, {
    data_status: 'stale',
    last_success_age_hours: 40,
    latest_import_id: '12',
  });
  assert.deepEqual(first.permissions.allowed, ['local_read', 'local_patch', 'local_ci']);
  assert.equal(first.acceptance.effects_allowed, false);
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= MAX_AGENT_ARTIFACT_BYTES);
  assert.doesNotMatch(JSON.stringify(first), /private-run|must-never-leak|"fence"|"lease"/);
});

test('every frozen material mutation changes input hash while object key order does not', () => {
  const original = stagePack();
  const reordered = buildMaintenanceAgentStagePack({
    preflight: {
      ...preflight(),
      selected: {
        occurrence_count: 3,
        next_action_code: 'run_import_preflight',
        owner: 'data_pipeline',
        priority: 'P1',
        code: 'daily_import_stale',
        capability: 'daily_import',
        fingerprint: HASH_B,
        source: 'open_issue',
      },
    },
    baseCommit: COMMIT_A,
  });
  assert.equal(reordered.input_hash, original.input_hash);
  assert.notEqual(stagePack({ baseCommit: COMMIT_B }).input_hash, original.input_hash);
  assert.notEqual(buildMaintenanceAgentStagePack({
    preflight: preflight({ observed_at: '2026-08-30T13:00:00.000Z' }),
    baseCommit: COMMIT_A,
  }).input_hash, original.input_hash);
  assert.notEqual(buildMaintenanceAgentStagePack({
    preflight: preflight({ selected: { ...preflight().selected, occurrence_count: 4 } }),
    baseCommit: COMMIT_A,
  }).input_hash, original.input_hash);
});

test('stage pack rejects malformed or sensitive safe context instead of forwarding it', () => {
  const invalid = preflight();
  invalid.observations[1].safe_context = {
    data_status: 'stale',
    nested: { email: 'person@example.com' },
  };
  assert.throws(
    () => buildMaintenanceAgentStagePack({ preflight: invalid, baseCommit: COMMIT_A }),
    /invalid_safe_context/,
  );
  assert.throws(
    () => buildMaintenanceAgentStagePack({ preflight: preflight(), baseCommit: 'not-a-commit' }),
    /invalid_preflight/,
  );
});

test('agent result is normalized deterministically and bound to the expected input hash', () => {
  const pack = stagePack();
  const first = validateMaintenanceAgentResult(agentResult(pack.input_hash), pack.input_hash);
  const second = validateMaintenanceAgentResult(agentResult(pack.input_hash, {
    changed_files: ['lib/change.mjs', 'tests/change.test.mjs'],
    checks: [
      { code: 'targeted_tests', status: 'passed', evidence_hash: HASH_B },
      { code: 'local_ci', status: 'passed', evidence_hash: HASH_A },
      { code: 'git_diff_check', status: 'passed', evidence_hash: HASH_A },
    ],
  }), pack.input_hash);
  assert.deepEqual(first, second);
  assert.deepEqual(first.changed_files, ['lib/change.mjs', 'tests/change.test.mjs']);
  assert.match(first.output_hash, /^[0-9a-f]{64}$/);
  const changed = validateMaintenanceAgentResult(agentResult(pack.input_hash, {
    finding_codes: ['different_finding'],
  }), pack.input_hash);
  assert.notEqual(changed.output_hash, first.output_hash);
  assert.throws(
    () => validateMaintenanceAgentResult(agentResult(HASH_B), pack.input_hash),
    /invalid_agent_result/,
  );
  assert.throws(
    () => validateMaintenanceAgentResult(agentResult(pack.input_hash, {
      checks: [{ code: 'targeted_tests', status: 'passed', evidence_hash: HASH_A }],
    }), pack.input_hash),
    /agent_acceptance_not_met/,
  );
});

test('agent result rejects extra properties, raw logs and sensitive nested values', () => {
  const pack = stagePack();
  const leaks = [
    { raw_log: 'test output' },
    { details: { email: 'person@example.com' } },
    { details: { phone: '+48 600 700 800' } },
    { details: { source: '192.168.1.10' } },
    { details: { header: 'Bearer abcdefghijklmnopqrstuvwxyz' } },
    { details: { jwt: 'eyJabcdefghijk.abcdefghijk.abcdefghijk' } },
    { details: { access_token: 'abcdefghijklmnopqrstuvwxyz' } },
    { details: { note: 'password=top-secret-value' } },
    { details: { cookie: 'session-value' } },
  ];
  for (const leak of leaks) {
    assert.throws(
      () => validateMaintenanceAgentResult({ ...agentResult(pack.input_hash), ...leak }, pack.input_hash),
      /sensitive_agent_result|invalid_agent_result/,
    );
  }
  assert.throws(
    () => validateMaintenanceAgentResult({ ...agentResult(pack.input_hash), extra: true }, pack.input_hash),
    /invalid_agent_result/,
  );
});

test('agent result rejects absolute and escaping paths', () => {
  const pack = stagePack();
  for (const path of [
    'C:/Users/Lenovo/project/file.mjs',
    '/etc/passwd',
    '../outside.mjs',
    'lib/../../outside.mjs',
    '\\\\server\\share\\file.mjs',
    'https://example.com/file.mjs',
  ]) {
    assert.throws(
      () => validateMaintenanceAgentResult(agentResult(pack.input_hash, {
        changed_files: [path],
        diff_hash: HASH_A,
      }), pack.input_hash),
      /invalid_repository_path/,
    );
  }
  for (const path of ['fixtures/phone-600700800.json', 'fixtures/ip-192.168.1.10.json']) {
    assert.throws(
      () => validateMaintenanceAgentResult(agentResult(pack.input_hash, {
        changed_files: [path],
        diff_hash: HASH_A,
      }), pack.input_hash),
      /sensitive_agent_result/,
    );
  }
});

test('artifact size is measured in UTF-8 bytes, not JavaScript characters', () => {
  const pack = stagePack();
  const oversized = {
    ...agentResult(pack.input_hash),
    details: { note: 'ą'.repeat(7_000) },
  };
  assert.equal(JSON.stringify(oversized).length < MAX_AGENT_ARTIFACT_BYTES, true);
  assert.equal(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > MAX_AGENT_ARTIFACT_BYTES, true);
  assert.throws(
    () => validateMaintenanceAgentResult(oversized, pack.input_hash),
    /agent_result_too_large/,
  );
});

test('paper receipt binds input, output, CI, reviews and accountability with no effects', () => {
  const first = buildMaintenancePaperReceipt(receiptInput());
  const second = buildMaintenancePaperReceipt(receiptInput());
  assert.deepEqual(first, second);
  assert.equal(first.version, PAPER_RECEIPT_VERSION);
  assert.equal(first.effects_performed, false);
  assert.equal(first.human_gate, null);
  for (const field of ['input_hash', 'output_hash', 'ci_hash', 'reviews_hash', 'accountability_hash', 'receipt_hash']) {
    assert.match(first[field], /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(first.reviews.map((review) => review.role), ['ada', 'soter']);
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 32 * 1024);

  const changedCi = buildMaintenancePaperReceipt(receiptInput({
    ci: { status: 'failed', evidence_hash: HASH_B },
  }));
  assert.notEqual(changedCi.ci_hash, first.ci_hash);
  assert.notEqual(changedCi.receipt_hash, first.receipt_hash);

  const failedExecution = buildMaintenancePaperReceipt(receiptInput({
    accountability: {
      receipt_hash: HASH_A,
      execution_ok: false,
      health_ok: null,
      priority: 'P0',
      remaining_hash: HASH_B,
    },
  }));
  assert.equal(failedExecution.accountability.priority, 'P0');
});

test('typed human gate binds exact production material and never performs the effect', () => {
  const input = receiptInput({
    humanGate: {
      type: 'production_deploy',
      environment: 'production',
      commit_sha: COMMIT_A,
      migration_id: null,
      expires_at: '2026-08-30T15:00:00.000Z',
    },
  });
  const receipt = buildMaintenancePaperReceipt(input);
  assert.equal(receipt.effects_performed, false);
  assert.equal(receipt.human_gate.status, 'required');
  assert.equal(receipt.human_gate.context_hash, receipt.context_hash);
  assert.equal(receipt.human_gate.input_hash, receipt.input_hash);
  assert.equal(receipt.human_gate.output_hash, receipt.output_hash);
  assert.match(receipt.human_gate.material_hash, /^[0-9a-f]{64}$/);
  assert.throws(
    () => buildMaintenancePaperReceipt(receiptInput({
      humanGate: {
        type: 'production_deploy', environment: 'production', commit_sha: null,
        migration_id: null, expires_at: '2026-08-30T15:00:00.000Z',
      },
    })),
    /invalid_human_gate/,
  );
  assert.throws(
    () => buildMaintenancePaperReceipt(receiptInput({
      humanGate: {
        type: 'production_deploy', environment: 'staging', commit_sha: COMMIT_A,
        migration_id: null, expires_at: '2026-08-30T15:00:00.000Z',
      },
    })),
    /invalid_human_gate/,
  );
});

test('paper receipt rejects a tampered stage pack and an agent result with extra fields', () => {
  const input = receiptInput();
  assert.throws(
    () => buildMaintenancePaperReceipt({ ...input, invocationKey: 'paper:person@example.com' }),
    /invalid_invocation_key/,
  );
  const tamperedPack = {
    ...input.stagePack,
    base_commit: COMMIT_B,
  };
  assert.throws(
    () => buildMaintenancePaperReceipt({ ...input, stagePack: tamperedPack }),
    /invalid_agent_stage_pack_hash/,
  );
  assert.throws(
    () => buildMaintenancePaperReceipt({
      ...input,
      agentResult: { ...input.agentResult, raw_log: 'private output' },
    }),
    /sensitive_agent_result/,
  );
});
