import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '@agenticool/policy';
import { lintWorkflows } from '@agenticool/workflow-lint';

test("this repository's workflows pass every rule with its own policy", () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const policy = loadPolicy(root, {
    sections: ['binding.repository', 'workflowLint'],
  });
  assert.deepEqual(
    lintWorkflows(`${root}.github/workflows`, {
      config: policy.workflowLint,
      repository: policy.binding.repository,
    }),
    [],
  );
});
