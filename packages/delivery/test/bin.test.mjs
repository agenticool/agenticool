import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(
  new URL('../bin/agenticool-delivery.mjs', import.meta.url),
);
const cwd = fileURLToPath(new URL('./fixtures', import.meta.url));
/** @param {string[]} args */
const run = (...args) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd });

test('the bin lists its commands and rejects a missing or unknown one', () => {
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /queue <issue>/);
  assert.match(help.stdout, /branch-name <issue>/);
  assert.equal(run().status, 1);
  assert.match(run().stderr, /Give a command/);
  assert.match(run('merge').stderr, /Unknown command merge/);
});

test('branch-name prints its own help and fails before calling GitHub', () => {
  const help = run('branch-name', '-h');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--layer/);
  assert.match(help.stdout, /--actor/);
  const invalid = run('branch-name', 'abc');
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr.trim(), 'Issue must be a positive number');
});
