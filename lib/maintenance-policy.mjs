const POLICIES = Object.freeze({
  daily_import_failed: Object.freeze({
    capability: 'daily_import',
    severity: 'P0',
    owner: 'data_pipeline',
    next_action_code: 'inspect_latest_import',
  }),
  daily_import_stale: Object.freeze({
    capability: 'daily_import',
    severity: 'P1',
    owner: 'data_pipeline',
    next_action_code: 'run_import_preflight',
  }),
  invalid_data_coverage: Object.freeze({
    capability: 'data_coverage',
    severity: 'P0',
    owner: 'data_pipeline',
    next_action_code: 'inspect_import_coverage',
  }),
  events_for_non_success_import: Object.freeze({
    capability: 'radar_diff',
    severity: 'P0',
    owner: 'radar_diff',
    next_action_code: 'inspect_event_integrity',
  }),
});

export function maintenanceIssuePolicy(code) {
  return typeof code === 'string' ? POLICIES[code] || null : null;
}

export const MAINTENANCE_ISSUE_CODES = Object.freeze(Object.keys(POLICIES));
