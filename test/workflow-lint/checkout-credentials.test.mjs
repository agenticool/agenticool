import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MISSING } from '../../scripts/workflow-lint/rules/checkout-credentials.mjs';
import { lint, W } from './helpers.mjs';

/** @param {string} steps */
const job = (steps) => ({
  [`${W}ci-build.yml`]: `name: 'CI: build'
on: pull_request
jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
${steps}`,
});
const checkout =
  '      - name: Check out repository\n        uses: actions/checkout@0000000000000000000000000000000000000000 # v4\n';
const push = '      - name: Push tags\n        run: git push --tags\n';
/** @param {string} steps */
const problems = (steps) => lint('checkout-credentials', job(steps));

test('every checkout in the clean fixture drops its credentials or names the step that needs them', () => {
  assert.deepEqual(lint('checkout-credentials'), []);
});

test('a checkout without persist-credentials false and without a comment fails', () => {
  const [problem, ...rest] = problems(checkout + push);
  assert.deepEqual(rest, []);
  assert.equal(problem, `build step 1 (Check out repository) ${MISSING}`);
  // The message states both accepted fixes.
  assert.ok(problem.includes('`persist-credentials: false`'));
  assert.ok(problem.includes('# persist-credentials: kept for "'));
  assert.deepEqual(
    problems(`${checkout}        with:\n          persist-credentials: true\n`),
    [`build step 1 (Check out repository) ${MISSING}`],
  );
});

test('a checkout with persist-credentials false passes', () => {
  assert.deepEqual(
    problems(
      `${checkout}        with:\n          persist-credentials: false\n`,
    ),
    [],
  );
});

test('a kept checkout must name a later step in the same job', () => {
  /** @param {string} name */
  const comment = (name) =>
    `      # persist-credentials: kept for "${name}"\n${checkout}`;
  assert.deepEqual(problems(comment('Push tags') + push), []);
  assert.deepEqual(problems(comment('Missing step') + push), [
    'build step 1 (Check out repository) names "Missing step", which is not a later step',
  ]);
  assert.deepEqual(problems(push + comment('Push tags')), [
    'build step 2 (Check out repository) names "Push tags", which is not a later step',
  ]);
});

test('workflows without a jobs map or job steps are skipped', () => {
  assert.deepEqual(
    lint('checkout-credentials', {
      [`${W}ci-empty.yml`]: "name: 'CI: empty'\non: pull_request\njobs: []\n",
      [`${W}ci-call.yml`]:
        "name: 'CI: call'\non: pull_request\njobs:\n  call:\n    name: Call\n    uses: ./.github/workflows/_ci-build.yml\n",
    }),
    [],
  );
});
