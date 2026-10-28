import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG, lint, W } from './helpers.mjs';

test('required status checks in the clean fixture keep their names', () => {
  assert.deepEqual(lint('required-checks'), []);
});

test('a renamed, matrix, or missing required check fails', () => {
  assert.deepEqual(
    lint(
      'required-checks',
      {
        [`${W}ci-pr-title.yml`]: `name: 'CI: PR title'
on: pull_request
jobs:
  check-pr-title:
    name: Check the PR title
    runs-on: ubuntu-latest
    timeout-minutes: 5
    strategy:
      matrix:
        os: [ubuntu-latest]
`,
      },
      {
        config: {
          ...CONFIG,
          requiredChecks: [
            ...(CONFIG.requiredChecks ?? []),
            { file: 'ci-checks.yml', job: 'gone', name: 'Gone' },
            { file: 'ci-missing.yml', job: 'scan', name: 'Scan' },
          ],
        },
      },
    ),
    [
      'check-pr-title required check is named "Check the PR title", not "Check PR title follows Conventional Commits"',
      'check-pr-title required check must not be a matrix',
      'gone required check "Gone" does not exist',
      'scan required check "Scan" does not exist',
    ],
  );
});
