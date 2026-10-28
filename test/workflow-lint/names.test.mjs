import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG, lint, W } from './helpers.mjs';

/**
 * @param {string} name
 * @param {string} [on]
 * @param {string} [jobs]
 */
const workflow = (
  name,
  on = 'pull_request',
  jobs = '  run-job:\n    name: Run job\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n',
) => `name: ${JSON.stringify(name)}\non: ${on}\njobs:\n${jobs}`;

test('the clean fixture follows the naming convention', () => {
  assert.deepEqual(lint('names'), []);
});

test('excluded vendor workflows keep their own names', () => {
  assert.deepEqual(lint('names', {}, { config: { ...CONFIG, exclude: [] } }), [
    'is not <area>-<purpose>.yml',
    'vendor_job ID is not kebab-case',
    'vendor_job has no name',
    'vendor_job step 1 (echo vendor) has no name',
    'needs a run-name with an expression that names its subject',
  ]);
});

test('file names need <area>-<purpose>.yml, a known area, and its prefix', () => {
  assert.deepEqual(
    lint('names', {
      [`${W}CI_bad.yml`]: workflow('CI: bad'),
      [`${W}deploy-app.yml`]: workflow('Deploy: app'),
      [`${W}ci-wrong.yml`]: workflow('Tracker: wrong'),
      [`${W}ci-nameless.yml`]: 'on: pull_request\njobs: {}\n',
    }),
    [
      'is not <area>-<purpose>.yml',
      'has no name',
      'name must start with CI:',
      'has unknown area deploy',
    ],
  );
});

test('only workflows other workflows call start with _ and end with (reusable)', () => {
  assert.deepEqual(
    lint('names', {
      [`${W}_ci-plain.yml`]: workflow('CI: plain (reusable)'),
      [`${W}_ci-unmarked.yml`]: workflow('CI: unmarked', 'workflow_call'),
      [`${W}ci-called.yml`]: workflow('CI: called', 'workflow_call'),
      [`${W}ci-marked.yml`]: workflow('CI: marked (reusable)'),
      [`${W}ci-shared.yml`]: workflow(
        'CI: shared',
        '[pull_request, workflow_call]',
      ),
    }),
    [
      'only reusable workflows start with _',
      'only reusable workflow names, in files starting with _, end with (reusable)',
      'runs only on workflow_call, so its file name starts with _',
      'only reusable workflow names, in files starting with _, end with (reusable)',
    ],
  );
});

test('every job and step has a sentence-case name and a kebab-case ID', () => {
  assert.deepEqual(
    lint('names', {
      [`${W}ci-jobs.yml`]: workflow(
        'CI: jobs',
        'pull_request',
        `  Bad_ID:
    name: Bad ID
  build-2:
    name: Build
  nameless:
    runs-on: ubuntu-latest
  lower:
    name: lower case
  matrix:
    name: \${{ matrix.target }}
    steps:
      - uses: actions/checkout@v4
      - run: echo hi
      - name: lower step
      - name: Good step
`,
      ),
    }),
    [
      'Bad_ID ID is not kebab-case',
      'build-2 ID is not kebab-case',
      'nameless has no name',
      'lower name "lower case" does not start with a capital letter',
      'matrix step 1 (actions/checkout@v4) has no name',
      'matrix step 2 (echo hi) has no name',
      'matrix step lower step does not start with a capital letter',
    ],
  );
});

test('workflows not started by a pull request, push, or call name their subject', () => {
  assert.deepEqual(
    lint('names', {
      [`${W}ci-manual.yml`]: workflow('CI: manual', 'workflow_dispatch'),
      [`${W}ci-literal.yml`]: `run-name: Literal\n${workflow('CI: literal', '[schedule]')}`,
      [`${W}ci-named.yml`]: `run-name: 'CI: \${{ github.actor }}'\n${workflow('CI: named', 'workflow_dispatch')}`,
      [`${W}ci-push.yml`]: workflow('CI: push', 'push'),
      [`${W}_ci-call.yml`]: workflow('CI: call (reusable)', 'workflow_call'),
      [`${W}ci-empty.yml`]: "name: 'CI: empty'\njobs: {}\n",
    }),
    [
      'needs a run-name with an expression that names its subject',
      'needs a run-name with an expression that names its subject',
      'needs a run-name with an expression that names its subject',
    ],
  );
});

test('workflow_run triggers name existing workflows', () => {
  assert.deepEqual(
    lint('names', {
      [`${W}tracker-issue-states.yml`]: `run-name: 'Tracker: \${{ github.sha }}'\n${workflow(
        'Tracker: reconcile issue states',
        "\n  workflow_run:\n    workflows: ['CI: checks', 'CI: missing']",
      )}`,
    }),
    ['waits for unknown workflow CI: missing'],
  );
});
