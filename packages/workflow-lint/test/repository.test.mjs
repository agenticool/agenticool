import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lintWorkflows } from '@agenticool/workflow-lint';

test("this repository's workflows pass every rule", () => {
  assert.deepEqual(
    lintWorkflows(
      fileURLToPath(new URL('../../../.github/workflows', import.meta.url)),
      {
        config: {
          areas: { ci: 'CI', release: 'Release', tracker: 'Tracker' },
          requiredChecks: [
            {
              file: 'ci-pr-title.yml',
              job: 'check-pr-title',
              name: 'Check PR title follows Conventional Commits',
            },
            {
              file: 'ci-secret-scan.yml',
              job: 'scan-secrets',
              name: 'Scan commits for secrets',
            },
          ],
        },
        repository: 'agenticool/agenticool',
      },
    ),
    [],
  );
});
