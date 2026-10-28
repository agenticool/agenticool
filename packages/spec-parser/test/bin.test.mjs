import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const bin = fileURLToPath(
  new URL('../bin/agenticool-spec.mjs', import.meta.url),
);
/** @param {string} name */
const fixture = (name) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
const run = (args, cwd = mkdtempSync(join(tmpdir(), 'spec-'))) =>
  spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });

/**
 * A working directory with a label catalog and, optionally, a policy.
 * @param {string[]} names
 * @param {string[]} [extra]
 */
const repository = (names, extra) => {
  const cwd = mkdtempSync(join(tmpdir(), 'spec-'));
  mkdirSync(join(cwd, '.github'));
  writeFileSync(
    join(cwd, '.github/labels.json'),
    JSON.stringify({
      labels: names.map((name) => ({ name, color: '000000', description: '' })),
    }),
  );
  if (extra) {
    mkdirSync(join(cwd, '.agents'));
    writeFileSync(
      join(cwd, '.agents/policy.json'),
      JSON.stringify({
        labels: {
          extra: extra.map((name) => ({
            name,
            color: '000000',
            description: '',
          })),
        },
      }),
    );
  }
  return cwd;
};
const BASE = [
  'enhancement',
  'epic',
  'severity: none',
  'area: repository',
  'risk: data-contract',
];

test('plan prints the tree and exits 0 for a clean specification', () => {
  const cwd = repository(BASE, ['risk: security']);
  const json = join(cwd, 'plan.json');
  const result = run(
    ['plan', fixture('conforming-spec.md'), '--json', json],
    cwd,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^#n +kind/);
  assert.match(result.stdout, /Totals: 2 containers, 3 epics, 9 leaves\.\n$/);
  const plan = JSON.parse(readFileSync(json, 'utf8'));
  assert.equal(plan.items.length, 14);
});

test('plan prints each violation and exits 1', () => {
  const result = run(['plan', fixture('violating-spec.md')]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'label-exists skipped: no .github/labels.json\n[acyclic] Blocked-by cycle: P0.1 -> P0.2 -> P0.1.\n',
  );
});

test('plan checks labels against the catalog and the policy extras', () => {
  const result = run(['plan', fixture('conforming-spec.md')], repository(BASE));
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    '[label-exists] P0.3: label "risk: security" is missing from .github/labels.json.\n',
  );
});

test('help exits 0 and a usage error exits 1', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(
    help.stdout,
    /^Usage: agenticool-spec plan <spec> \[--json <file>\]/,
  );
  const usage = run(['file', 'spec.md']);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^Expected plan <spec>\n\nUsage:/);
});
