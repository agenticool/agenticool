import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint, W } from './helpers.mjs';

/** @param {string} steps */
const job = (steps) => ({
  [`${W}ci-checks.yml`]: `name: 'CI: checks'
on: pull_request
jobs:
  run-checks:
    name: Run checks
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
${steps}`,
});
const checkout = (with_ = '') =>
  `      - name: Check out repository\n        uses: actions/checkout@0000000000000000000000000000000000000000 # v4\n${with_}`;
const setup = (with_ = '          node-version-file: .tool-versions\n') =>
  `      - name: Set up Node.js\n        uses: actions/setup-node@0000000000000000000000000000000000000000 # v4\n        with:\n${with_}`;

test('the clean fixture reads the Node version from .tool-versions', () => {
  assert.deepEqual(lint('node-version'), []);
});

test('.tool-versions pins the Node version', () => {
  assert.deepEqual(lint('node-version', { '.tool-versions': 'nodejs 24\n' }), [
    'does not pin nodejs <major>.<minor>.<patch>',
  ]);
  assert.deepEqual(lint('node-version', { '.tool-versions': null }), [
    'does not pin nodejs <major>.<minor>.<patch>',
  ]);
});

test('every setup-node step reads the Node version from .tool-versions', () => {
  assert.deepEqual(
    lint(
      'node-version',
      job(checkout() + setup('          node-version: 24\n')),
    ),
    [
      'run-checks step 2 (Set up Node.js) must read node-version-file: .tool-versions, not node-version',
      'sets node-version',
    ],
  );
  assert.deepEqual(
    lint(
      'node-version',
      job(checkout() + setup('          node-version-file: .nvmrc\n')),
    ),
    [
      'run-checks step 2 (Set up Node.js) must read node-version-file: .tool-versions, not node-version',
    ],
  );
});

test('setup-node runs after a checkout of the repository root', () => {
  const late =
    'run-checks step 2 (Set up Node.js) runs before the repository root is checked out';
  assert.deepEqual(lint('node-version', job(setup())), [
    late.replace('step 2', 'step 1'),
  ]);
  assert.deepEqual(
    lint(
      'node-version',
      job(checkout('        with:\n          path: sub\n') + setup()),
    ),
    [late],
  );
  assert.deepEqual(
    lint(
      'node-version',
      job(
        checkout(
          '        with:\n          sparse-checkout-cone-mode: false\n',
        ) + setup(),
      ),
    ),
    [late],
  );
  // Sparse checkouts in cone mode keep root files.
  assert.deepEqual(
    lint(
      'node-version',
      job(
        checkout('        with:\n          sparse-checkout: src\n') + setup(),
      ),
    ),
    [],
  );
});

test('composite actions are checked like workflows', () => {
  assert.deepEqual(
    lint('node-version', {
      '.github/actions/node/action.yaml': `name: Node
runs:
  using: composite
  steps:
    - uses: actions/setup-node@0000000000000000000000000000000000000000
      with:
        node-version: 24
`,
      '.github/actions/empty/README': 'no action file',
    }),
    [
      'step 1 (actions/setup-node@0000000000000000000000000000000000000000) must read node-version-file: .tool-versions, not node-version',
      'step 1 (actions/setup-node@0000000000000000000000000000000000000000) runs before the repository root is checked out',
      'sets node-version',
    ],
  );
  assert.deepEqual(lint('node-version', { '.github/actions': null }), []);
});

test('a repository without a setup-node step fails', () => {
  assert.deepEqual(
    lint('node-version', job('      - name: Test\n        run: echo\n')),
    ['has no setup-node step'],
  );
});
