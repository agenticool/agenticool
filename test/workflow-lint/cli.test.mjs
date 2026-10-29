import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { main } from '../../scripts/workflow-lint.mjs';
import { W } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/workflow-lint.mjs');

/** @param {string} cwd */
function run(cwd) {
  let stdout = '';
  let stderr = '';
  const code = main({
    cwd,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

/**
 * Copies this repository's workflows and `.tool-versions` and writes
 * `changes` over them, by path from the root; `null` deletes a file.
 * @param {Record<string, string | null>} [changes]
 */
function copy(changes = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-lint-'));
  cpSync(join(ROOT, '.github'), join(root, '.github'), { recursive: true });
  cpSync(join(ROOT, '.tool-versions'), join(root, '.tool-versions'));
  for (const [path, text] of Object.entries(changes))
    if (text === null) rmSync(join(root, path), { recursive: true });
    else writeFileSync(join(root, path), text);
  return root;
}

test("this repository's workflows pass every rule", () => {
  assert.deepEqual(run(ROOT), { code: 0, stdout: '', stderr: '' });
});

test('only the _board-* workflows in this repository run on workflow_call', () => {
  const called = readdirSync(join(ROOT, W)).filter(
    (file) =>
      'workflow_call' in
      (parse(readFileSync(join(ROOT, W, file), 'utf8')).on ?? {}),
  );
  assert.ok(called.length > 0);
  for (const file of called) assert.match(file, /^_board-/, file);
});

test('each violation prints its file, job, and rule, and the exit code is 1', () => {
  const checks = readFileSync(join(ROOT, W, 'ci-checks.yml'), 'utf8');
  const root = copy({
    [`${W}ci-checks.yml`]: checks.replace(/^ +timeout-minutes: .*\n/m, ''),
    '.tool-versions': 'nodejs 24\n',
  });
  assert.deepEqual(run(root), {
    code: 1,
    stdout:
      '.github/workflows/ci-checks.yml run-checks [timeouts] needs timeout-minutes, a positive whole number\n' +
      '.tool-versions [node-version] does not pin nodejs <major>.<minor>.<patch>\n',
    stderr: '',
  });
});

test('errors print to stderr and exit 1', () => {
  const broken = copy({ [`${W}ci-broken.yml`]: 'on: [push\n' });
  assert.deepEqual(run(broken).code, 1);
  assert.match(run(broken).stderr, /^\.github\/workflows\/ci-broken\.yml: /);
  const empty = copy({ [W]: null });
  mkdirSync(join(empty, W));
  assert.match(run(empty).stderr, /^No workflow files in /);
});

test('the script runs main and sets the exit code', () => {
  assert.equal(
    execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' }),
    '',
  );
  const failed = spawnSync(process.execPath, [SCRIPT], {
    cwd: copy({ '.tool-versions': null }),
    encoding: 'utf8',
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /\[node-version\]/);
});
