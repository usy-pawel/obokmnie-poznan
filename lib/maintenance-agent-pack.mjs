import { createHash } from 'node:crypto';

export const AGENT_STAGE_PACK_VERSION = 'radar_agent_stage_pack_v1';
export const AGENT_RESULT_VERSION = 'radar_agent_result_v1';
export const PAPER_RECEIPT_VERSION = 'radar_supervisor_paper_receipt_v1';
export const MAX_AGENT_ARTIFACT_BYTES = 12_000;
export const MAX_PAPER_RECEIPT_BYTES = 32 * 1024;

const PREFLIGHT_VERSION = 'radar_maintenance_api_v1';
const CAPABILITIES = new Set(['web_database', 'daily_import', 'data_coverage', 'radar_diff']);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'plan']);
const RESULT_STATUSES = new Set(['completed', 'blocked', 'failed']);
const CHECK_CODES = new Set([
  'targeted_tests',
  'git_diff_check',
  'local_ci',
  'postgis_migration_smoke',
  'production_smoke',
]);
const CHECK_STATUSES = new Set(['passed', 'failed', 'skipped']);
const REVIEW_ROLES = new Set([
  'newton', 'ada', 'soter', 'eva', 'darek', 'iga', 'felix', 'leon', 'alicja', 'recenzent',
]);
const REVIEW_VERDICTS = new Set(['passed', 'failed']);
const HUMAN_GATE_TYPES = new Set([
  'production_deploy',
  'production_migration',
  'autonomy_activation',
  'cost_change',
  'credential_change',
  'retention_change',
  'dns_change',
  'external_contact',
  'publication',
  'destructive_data',
]);
const SAFE_CONTEXT_KEYS = new Set([
  'data_status',
  'latest_import_id',
  'last_success_id',
  'last_success_finished_at',
  'last_success_age_hours',
  'voivodeships',
  'published_cases',
  'non_success_event_total',
]);

const PACK_PERMISSIONS = Object.freeze({
  allowed: Object.freeze(['local_read', 'local_patch', 'local_ci']),
  denied: Object.freeze([
    'private_api',
    'lease_handle',
    'production_credentials',
    'railway',
    'push',
    'deploy',
    'migration',
    'external_action',
  ]),
});

const PACK_ACCEPTANCE = Object.freeze({
  required_checks: Object.freeze(['targeted_tests', 'git_diff_check', 'local_ci']),
  required_evidence: Object.freeze(['diff_hash', 'check_hashes', 'review_hashes']),
  effects_allowed: false,
});

function contractError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, code) {
  if (!isPlainObject(value)) throw contractError(code);
  return value;
}

function assertExactKeys(value, expected, code) {
  assertPlainObject(value, code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw contractError(code);
  }
}

function jsonBytes(value, code) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw contractError(code);
  }
}

function assertBytes(value, maximum, code) {
  if (jsonBytes(value, code) > maximum) throw contractError(code);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw contractError('non_canonical_value');
  return serialized;
}

function materialHash(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function sha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function commitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

function identifier(value, maximum = 64) {
  return typeof value === 'string' && value.length <= maximum
    && /^[a-z][a-z0-9_:-]*$/.test(value) ? value : null;
}

function isoTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function safeCount(value, fallback = null) {
  const number = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function uniqueSorted(values, code) {
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) throw contractError(code);
  return sorted;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function sanitizeSafeContext(value) {
  if (value === undefined) return {};
  assertPlainObject(value, 'invalid_safe_context');
  if (Object.keys(value).some((key) => !SAFE_CONTEXT_KEYS.has(key))) {
    throw contractError('invalid_safe_context');
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'data_status') {
      if (!['healthy', 'updating', 'stale', 'failed'].includes(item)) throw contractError('invalid_safe_context');
      result[key] = item;
    } else if (['latest_import_id', 'last_success_id'].includes(key)) {
      if (item === null) result[key] = null;
      else if (typeof item === 'string' && /^\d{1,24}$/.test(item)) result[key] = item;
      else throw contractError('invalid_safe_context');
    } else if (key === 'last_success_finished_at') {
      if (item === null) result[key] = null;
      else {
        const timestamp = isoTimestamp(item);
        if (!timestamp) throw contractError('invalid_safe_context');
        result[key] = timestamp;
      }
    } else {
      if (item === null) result[key] = null;
      else {
        const count = safeCount(item);
        if (count === null) throw contractError('invalid_safe_context');
        result[key] = count;
      }
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => compareText(left, right)));
}

function selectedSafeContext(preflight, selected) {
  if (!Array.isArray(preflight.observations)) return {};
  const observations = preflight.observations.filter((item) => (
    isPlainObject(item)
      && item.capability === selected.capability
      && item.code === selected.code
  ));
  if (observations.length > 1) throw contractError('invalid_preflight');
  return sanitizeSafeContext(observations[0]?.safe_context);
}

function selectedOccurrence(preflight, selected) {
  const direct = safeCount(selected.occurrence_count);
  if (direct !== null && direct >= 1) return direct;
  if (Array.isArray(preflight.open_issues)) {
    const issue = preflight.open_issues.find((item) => (
      isPlainObject(item) && item.capability === selected.capability && item.code === selected.code
    ));
    const occurrence = safeCount(issue?.occurrence_count);
    if (occurrence !== null && occurrence >= 1) return occurrence;
  }
  return 1;
}

function normalizeSelectedTask(preflight) {
  const selected = assertPlainObject(preflight.selected, 'selected_task_required');
  const capability = selected.capability === null ? null
    : CAPABILITIES.has(selected.capability) ? selected.capability : null;
  if (selected.capability !== null && capability === null) throw contractError('invalid_selected_task');
  const code = identifier(selected.code);
  const nextActionCode = identifier(selected.next_action_code);
  const priority = PRIORITIES.has(selected.priority) ? selected.priority
    : PRIORITIES.has(preflight.priority) ? preflight.priority : null;
  if (!code || !nextActionCode || !priority) throw contractError('invalid_selected_task');
  const fingerprint = sha256(selected.fingerprint);
  const publicReference = fingerprint || materialHash({
    capability,
    code,
    context_hash: preflight.context_hash,
  });
  return {
    public_reference: publicReference,
    capability,
    code,
    priority,
    occurrence_count: selectedOccurrence(preflight, selected),
    next_action_code: nextActionCode,
    safe_context: selectedSafeContext(preflight, selected),
  };
}

export function buildMaintenanceAgentStagePack({ preflight, baseCommit }) {
  assertPlainObject(preflight, 'invalid_preflight');
  const contextHash = sha256(preflight.context_hash);
  const observedAt = isoTimestamp(preflight.observed_at);
  const safeBaseCommit = commitSha(baseCommit);
  if (preflight.version !== PREFLIGHT_VERSION || !contextHash || !observedAt || !safeBaseCommit) {
    throw contractError('invalid_preflight');
  }
  const body = {
    version: AGENT_STAGE_PACK_VERSION,
    stage: 'implementer',
    role: 'engineer',
    work_class: 'maintenance_repair',
    preflight: {
      version: PREFLIGHT_VERSION,
      context_hash: contextHash,
      observed_at: observedAt,
    },
    base_commit: safeBaseCommit,
    selected_task: normalizeSelectedTask(preflight),
    permissions: {
      allowed: [...PACK_PERMISSIONS.allowed],
      denied: [...PACK_PERMISSIONS.denied],
    },
    acceptance: {
      required_checks: [...PACK_ACCEPTANCE.required_checks],
      required_evidence: [...PACK_ACCEPTANCE.required_evidence],
      effects_allowed: false,
    },
  };
  const pack = { ...body, input_hash: materialHash(body) };
  assertBytes(pack, MAX_AGENT_ARTIFACT_BYTES, 'agent_stage_pack_too_large');
  return deepFreeze(pack);
}

function assertNoSensitiveArtifact(value) {
  const sensitiveKey = /^(?:raw_?logs?|stdout|stderr|email|phone|telephone|nip|pesel|password|cookie|secret|authorization|credential|api_?key|access_?token|refresh_?token|session(?:_?id)?)$/i;
  const visit = (item) => {
    if (typeof item === 'string') {
      if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(item)) throw contractError('sensitive_agent_result');
      if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(item)) throw contractError('sensitive_agent_result');
      const phoneCandidate = item.match(/\+?\d[\d\s()-]{7,}\d/g) || [];
      if (phoneCandidate.some((candidate) => {
        const digits = candidate.replace(/\D/g, '');
        return digits.length === 9 || (digits.length === 11 && digits.startsWith('48'));
      })) throw contractError('sensitive_agent_result');
      if (/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/i.test(item)) throw contractError('sensitive_agent_result');
      if (/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/.test(item)) throw contractError('sensitive_agent_result');
      if (/\b(?:password|cookie|secret|authorization|credential|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]/i.test(item)) {
        throw contractError('sensitive_agent_result');
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!isPlainObject(item)) return;
    for (const [key, nested] of Object.entries(item)) {
      if (sensitiveKey.test(key)) throw contractError('sensitive_agent_result');
      visit(nested);
    }
  };
  visit(value);
}

function relativeRepoPath(value) {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 240
      || value.includes('\\') || value.includes('\0') || value.includes('://')
      || value.startsWith('/') || /^[a-zA-Z]:/.test(value)
      || !/^[a-zA-Z0-9._/-]+$/.test(value)) return null;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return value;
}

function normalizeAgentResult(value, expectedInputHash) {
  assertExactKeys(value, [
    'version', 'input_hash', 'status', 'changed_files', 'diff_hash', 'checks', 'finding_codes',
  ], 'invalid_agent_result');
  if (value.version !== AGENT_RESULT_VERSION || value.input_hash !== expectedInputHash
      || !RESULT_STATUSES.has(value.status)) throw contractError('invalid_agent_result');
  if (!Array.isArray(value.changed_files) || value.changed_files.length > 32) throw contractError('invalid_agent_result');
  const changedFiles = value.changed_files.map(relativeRepoPath);
  if (changedFiles.some((path) => path === null)) throw contractError('invalid_repository_path');
  const sortedFiles = uniqueSorted(changedFiles, 'duplicate_repository_path');
  const diffHash = value.diff_hash === null ? null : sha256(value.diff_hash);
  if ((sortedFiles.length === 0) !== (diffHash === null)) throw contractError('invalid_diff_hash');

  if (!Array.isArray(value.checks) || value.checks.length > 8) throw contractError('invalid_agent_checks');
  const checks = value.checks.map((check) => {
    assertExactKeys(check, ['code', 'status', 'evidence_hash'], 'invalid_agent_check');
    if (!CHECK_CODES.has(check.code) || !CHECK_STATUSES.has(check.status)) throw contractError('invalid_agent_check');
    const evidenceHash = check.evidence_hash === null ? null : sha256(check.evidence_hash);
    if ((check.status === 'skipped') !== (evidenceHash === null)) throw contractError('invalid_agent_check');
    return { code: check.code, status: check.status, evidence_hash: evidenceHash };
  }).sort((left, right) => compareText(left.code, right.code));
  if (new Set(checks.map((check) => check.code)).size !== checks.length) throw contractError('duplicate_agent_check');
  if (value.status === 'completed') {
    const passedChecks = new Set(
      checks.filter((check) => check.status === 'passed').map((check) => check.code),
    );
    if (PACK_ACCEPTANCE.required_checks.some((code) => !passedChecks.has(code))) {
      throw contractError('agent_acceptance_not_met');
    }
  }

  if (!Array.isArray(value.finding_codes) || value.finding_codes.length > 16) {
    throw contractError('invalid_finding_codes');
  }
  const findingCodes = value.finding_codes.map((code) => identifier(code));
  if (findingCodes.some((code) => code === null)) throw contractError('invalid_finding_codes');
  const sortedFindingCodes = uniqueSorted(findingCodes, 'duplicate_finding_code');
  return {
    version: AGENT_RESULT_VERSION,
    input_hash: expectedInputHash,
    status: value.status,
    changed_files: sortedFiles,
    diff_hash: diffHash,
    checks,
    finding_codes: sortedFindingCodes,
  };
}

export function validateMaintenanceAgentResult(value, expectedInputHash) {
  if (!sha256(expectedInputHash)) throw contractError('invalid_expected_input_hash');
  assertBytes(value, MAX_AGENT_ARTIFACT_BYTES, 'agent_result_too_large');
  assertNoSensitiveArtifact(value);
  const normalized = normalizeAgentResult(value, expectedInputHash);
  const result = { ...normalized, output_hash: materialHash(normalized) };
  assertBytes(result, MAX_AGENT_ARTIFACT_BYTES, 'agent_result_too_large');
  return deepFreeze(result);
}

function validateStagePack(pack) {
  assertExactKeys(pack, [
    'version', 'stage', 'role', 'work_class', 'preflight', 'base_commit', 'selected_task',
    'permissions', 'acceptance', 'input_hash',
  ], 'invalid_agent_stage_pack');
  if (pack.version !== AGENT_STAGE_PACK_VERSION || pack.stage !== 'implementer'
      || pack.role !== 'engineer' || pack.work_class !== 'maintenance_repair'
      || !commitSha(pack.base_commit) || !sha256(pack.input_hash)) throw contractError('invalid_agent_stage_pack');
  assertExactKeys(pack.preflight, ['version', 'context_hash', 'observed_at'], 'invalid_agent_stage_pack');
  assertExactKeys(pack.selected_task, [
    'public_reference', 'capability', 'code', 'priority', 'occurrence_count', 'next_action_code', 'safe_context',
  ], 'invalid_agent_stage_pack');
  assertExactKeys(pack.permissions, ['allowed', 'denied'], 'invalid_agent_stage_pack');
  assertExactKeys(pack.acceptance, ['required_checks', 'required_evidence', 'effects_allowed'], 'invalid_agent_stage_pack');
  if (pack.preflight.version !== PREFLIGHT_VERSION || !sha256(pack.preflight.context_hash)
      || isoTimestamp(pack.preflight.observed_at) !== pack.preflight.observed_at
      || !sha256(pack.selected_task.public_reference)
      || !identifier(pack.selected_task.code) || !identifier(pack.selected_task.next_action_code)
      || !PRIORITIES.has(pack.selected_task.priority)
      || (pack.selected_task.capability !== null && !CAPABILITIES.has(pack.selected_task.capability))
      || !Number.isSafeInteger(pack.selected_task.occurrence_count)
      || pack.selected_task.occurrence_count < 1) throw contractError('invalid_agent_stage_pack');
  const safeContext = sanitizeSafeContext(pack.selected_task.safe_context);
  if (stableJson(safeContext) !== stableJson(pack.selected_task.safe_context)) {
    throw contractError('invalid_agent_stage_pack');
  }
  if (stableJson(pack.permissions) !== stableJson(PACK_PERMISSIONS)
      || stableJson(pack.acceptance) !== stableJson(PACK_ACCEPTANCE)) throw contractError('invalid_agent_stage_pack');
  const { input_hash: suppliedHash, ...body } = pack;
  if (materialHash(body) !== suppliedHash) throw contractError('invalid_agent_stage_pack_hash');
  assertBytes(pack, MAX_AGENT_ARTIFACT_BYTES, 'agent_stage_pack_too_large');
  return pack;
}

function normalizeCi(value) {
  assertExactKeys(value, ['status', 'evidence_hash'], 'invalid_ci_evidence');
  if (!['passed', 'failed', 'not_run'].includes(value.status)) throw contractError('invalid_ci_evidence');
  const evidenceHash = value.evidence_hash === null ? null : sha256(value.evidence_hash);
  if ((value.status === 'not_run') !== (evidenceHash === null)) throw contractError('invalid_ci_evidence');
  return { status: value.status, evidence_hash: evidenceHash };
}

function normalizeReviews(value) {
  if (!Array.isArray(value) || value.length > 10) throw contractError('invalid_reviews');
  const reviews = value.map((review) => {
    assertExactKeys(review, ['role', 'verdict', 'evidence_hash'], 'invalid_review');
    if (!REVIEW_ROLES.has(review.role) || !REVIEW_VERDICTS.has(review.verdict)
        || !sha256(review.evidence_hash)) throw contractError('invalid_review');
    return { role: review.role, verdict: review.verdict, evidence_hash: review.evidence_hash };
  }).sort((left, right) => compareText(left.role, right.role));
  if (new Set(reviews.map((review) => review.role)).size !== reviews.length) throw contractError('duplicate_review');
  return reviews;
}

function normalizeAccountability(value) {
  assertExactKeys(value, [
    'receipt_hash', 'execution_ok', 'health_ok', 'priority', 'remaining_hash',
  ], 'invalid_accountability');
  if (!sha256(value.receipt_hash) || !sha256(value.remaining_hash)
      || typeof value.execution_ok !== 'boolean'
      || ![true, false, null].includes(value.health_ok)
      || !['healthy', 'P0', 'P1', 'P2', null].includes(value.priority)) {
    throw contractError('invalid_accountability');
  }
  if (!value.execution_ok && value.health_ok !== null) {
    throw contractError('invalid_accountability');
  }
  if (value.execution_ok && typeof value.health_ok !== 'boolean') throw contractError('invalid_accountability');
  if (value.execution_ok && value.health_ok === true && value.priority !== 'healthy') {
    throw contractError('invalid_accountability');
  }
  if (value.execution_ok && value.health_ok === false && !['P0', 'P1', 'P2'].includes(value.priority)) {
    throw contractError('invalid_accountability');
  }
  return {
    receipt_hash: value.receipt_hash,
    execution_ok: value.execution_ok,
    health_ok: value.health_ok,
    priority: value.priority,
    remaining_hash: value.remaining_hash,
  };
}

function normalizeHumanGate(value, pack, agentResult) {
  if (value === null || value === undefined) return null;
  assertExactKeys(value, [
    'type', 'environment', 'commit_sha', 'migration_id', 'expires_at',
  ], 'invalid_human_gate');
  const type = HUMAN_GATE_TYPES.has(value.type) ? value.type : null;
  const safeCommit = value.commit_sha === null ? null : commitSha(value.commit_sha);
  const migrationId = value.migration_id === null ? null : identifier(value.migration_id, 96);
  const expiresAt = isoTimestamp(value.expires_at);
  if (!type || value.environment !== 'production' || !expiresAt
      || (value.commit_sha !== null && !safeCommit)
      || (value.migration_id !== null && !migrationId)) throw contractError('invalid_human_gate');
  if (type === 'production_deploy' && !safeCommit) throw contractError('invalid_human_gate');
  if (type === 'production_migration' && !migrationId) throw contractError('invalid_human_gate');
  const material = {
    type,
    environment: 'production',
    context_hash: pack.preflight.context_hash,
    input_hash: pack.input_hash,
    output_hash: agentResult.output_hash,
    commit_sha: safeCommit,
    migration_id: migrationId,
  };
  return {
    status: 'required',
    ...material,
    material_hash: materialHash(material),
    expires_at: expiresAt,
  };
}

export function buildMaintenancePaperReceipt({
  invocationKey,
  stagePack,
  agentResult,
  ci,
  reviews,
  accountability,
  humanGate = null,
}) {
  if (typeof invocationKey !== 'string'
      || !/^radar-supervisor:\d{8}T\d{2}:a[01]$/.test(invocationKey)) {
    throw contractError('invalid_invocation_key');
  }
  const pack = validateStagePack(stagePack);
  const result = validateMaintenanceAgentResult(agentResult, pack.input_hash);
  const safeCi = normalizeCi(ci);
  const safeReviews = normalizeReviews(reviews);
  const safeAccountability = normalizeAccountability(accountability);
  const gate = normalizeHumanGate(humanGate, pack, result);
  const body = {
    version: PAPER_RECEIPT_VERSION,
    invocation_key: invocationKey,
    stage_pack_version: pack.version,
    agent_result_version: result.version,
    context_hash: pack.preflight.context_hash,
    base_commit: pack.base_commit,
    input_hash: pack.input_hash,
    output_hash: result.output_hash,
    ci_hash: materialHash(safeCi),
    reviews_hash: materialHash(safeReviews),
    accountability_hash: materialHash(safeAccountability),
    agent_status: result.status,
    ci: safeCi,
    reviews: safeReviews,
    accountability: safeAccountability,
    effects_performed: false,
    human_gate: gate,
  };
  const receipt = { ...body, receipt_hash: materialHash(body) };
  assertBytes(receipt, MAX_PAPER_RECEIPT_BYTES, 'paper_receipt_too_large');
  return deepFreeze(receipt);
}
