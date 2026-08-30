import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MAINTENANCE_ISSUE_CODES,
  maintenanceIssuePolicy,
} from '../lib/maintenance-policy.mjs';

const EXPECTED = {
  daily_import_failed: ['daily_import', 'P0', 'data_pipeline', 'inspect_latest_import'],
  daily_import_stale: ['daily_import', 'P1', 'data_pipeline', 'run_import_preflight'],
  invalid_data_coverage: ['data_coverage', 'P0', 'data_pipeline', 'inspect_import_coverage'],
  events_for_non_success_import: ['radar_diff', 'P0', 'radar_diff', 'inspect_event_integrity'],
};

test('one JavaScript policy source matches the database policy constraints', async () => {
  assert.deepEqual([...MAINTENANCE_ISSUE_CODES].sort(), Object.keys(EXPECTED).sort());
  const migration = await readFile(
    new URL('../migrations/010_maintenance_control_plane.sql', import.meta.url),
    'utf8',
  );
  for (const [code, [capability, severity, owner, nextAction]] of Object.entries(EXPECTED)) {
    assert.deepEqual(maintenanceIssuePolicy(code), {
      capability,
      severity,
      owner,
      next_action_code: nextAction,
    });
    assert.match(migration, new RegExp(
      `code='${code}' AND severity='${severity}'[\\s\\S]+owner='${owner}' AND next_action_code='${nextAction}'`,
    ));
  }
  assert.equal(maintenanceIssuePolicy('unknown'), null);

  for (const relativePath of [
    '../lib/maintenance-control-plane.mjs',
    '../lib/maintenance-private-api.mjs',
    '../lib/maintenance-preflight.mjs',
  ]) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /maintenanceIssuePolicy/);
    assert.doesNotMatch(source, /const ISSUE_POLICY/);
  }
});
