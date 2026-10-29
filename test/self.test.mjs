import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '@agenticool/agents';
import { binding, DEFAULTS, loadPolicy, project } from '@agenticool/core';

// The monorepo consumes its own packages, so its policy, generated agent
// files, and synced files must stay current with them.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the repository policy binds only the project and relies on the shipped defaults', () => {
  const file = JSON.parse(
    readFileSync(new URL('../.agents/policy.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(Object.keys(file).sort(), ['binding', 'description']);
  const policy = loadPolicy(ROOT, { sections: ['binding.project'] });
  assert.equal(binding(policy).repository, 'agenticool/agenticool');
  assert.equal(project(policy).ownerType, 'organization');
  for (const key of [
    'capabilities',
    'roles',
    'supported',
    'implementationEffort',
  ])
    assert.deepEqual(policy[key], DEFAULTS[key], key);
});

test('agenticool-agents check finds no stale generated or synced file', () => {
  assert.deepEqual(check(ROOT), []);
});
