import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '@agenticool/agents';
import { binding, loadPolicy, project, tokenEnv } from '@agenticool/policy';

// The monorepo consumes its own packages, so its policy, generated agent
// files, and synced files must stay current with them.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the repository policy validates for every section its packages read', () => {
  const policy = loadPolicy(ROOT, {
    sections: [
      'binding',
      'capabilities',
      'roles',
      'supported',
      'implementationEffort',
    ],
  });
  assert.equal(binding(policy).repository, 'agenticool/agenticool');
  assert.equal(project(policy).ownerType, 'organization');
  assert.equal(tokenEnv(policy), 'AGENTICOOL_PROJECT_TOKEN');
});

test('agenticool-agents check finds no stale generated or synced file', () => {
  assert.deepEqual(check(ROOT), []);
});
