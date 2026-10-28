import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '@agenticool/workflow-lint';
import { CLEAN, repo, W } from './helpers.mjs';

const BIN = fileURLToPath(
  new URL('../bin/agenticool-workflow-lint.mjs', import.meta.url),
);

/**
 * @param {string[]} argv
 * @param {string} cwd
 */
function run(argv, cwd) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, {
    cwd,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

test('a clean repository exits 0 with no output', () => {
  assert.deepEqual(run([], CLEAN), { code: 0, stdout: '', stderr: '' });
});

test('each violation prints its file, job, and rule, and the exit code is 1', () => {
  const root = repo({
    [`${W}ci-checks.yml`]: `name: 'CI: checks'
on: pull_request
jobs:
  run-checks:
    name: Run checks
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@0000000000000000000000000000000000000000
        with:
          persist-credentials: false
      - name: Set up Node.js
        uses: actions/setup-node@0000000000000000000000000000000000000000
        with:
          node-version-file: .tool-versions
`,
    '.tool-versions': 'nodejs 24\n',
  });
  assert.deepEqual(run([], root), {
    code: 1,
    stdout:
      '.github/workflows/ci-checks.yml run-checks [timeouts] needs timeout-minutes, a positive whole number\n' +
      '.tool-versions [node-version] does not pin nodejs <major>.<minor>.<patch>\n',
    stderr: '',
  });
});

test('--dir picks another workflow directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-lint-'));
  const result = run(['--dir', join(CLEAN, W)], root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\.agents\/policy\.json/);
  assert.deepEqual(run([`--dir=${W}`], CLEAN).code, 0);
});

test('errors print to stderr and exit 1; help prints to stdout and exits 0', () => {
  const help = run(['--help'], CLEAN);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: agenticool-workflow-lint/);
  const unknown = run(['--fix'], CLEAN);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /^Unknown option --fix/);
  const broken = run([], repo({ [`${W}ci-broken.yml`]: 'on: [push\n' }));
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /^\.github\/workflows\/ci-broken\.yml: /);
  const empty = repo({ [W]: null });
  mkdirSync(join(empty, W));
  assert.match(run([], empty).stderr, /^No workflow files in /);
});

test('the bin runs main on its arguments and sets the exit code', () => {
  assert.equal(execFileSync(BIN, [], { cwd: CLEAN, encoding: 'utf8' }), '');
  const failed = spawnSync(BIN, [], {
    cwd: repo({ '.tool-versions': null }),
    encoding: 'utf8',
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /\[node-version\]/);
});
