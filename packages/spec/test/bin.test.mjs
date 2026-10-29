import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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
    /^Usage: agenticool-spec plan <spec> \[--bodies <dir>\] \[--json <file>\]/,
  );
  const usage = run(['list', 'spec.md']);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^Expected plan <spec>\n\nUsage:/);
});

test('plan --state records the groups and assignee that confirm, accepts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'state-'));
  const state = join(directory, 'notes');
  const groups = join(directory, 'groups.json');
  writeFileSync(
    groups,
    JSON.stringify({ 'Phase 0': [['P0.1', 'P0.3'], ['P0.2']] }),
  );
  const planned = run([
    'plan',
    fixture('conforming-spec.md'),
    '--state',
    state,
    '--groups',
    groups,
    '--assignee',
    'sam',
  ]);
  assert.equal(planned.status, 0, planned.stderr);
  const digest = /\nPlan digest: ([0-9a-f]{64})\n$/.exec(planned.stdout)?.[1];
  assert.ok(digest);
  assert.match(
    planned.stdout,
    /\n\nIndependence groups:\n {2}Plan: none\n {2}Phase 0: g1 P0\.1 P0\.3; g2 P0\.2\n {2}Phase 1: none\n {2}Phase 2: none\nTotals: 2 containers, 3 epics, 9 leaves\.\nAssignee: sam\nState: .*notes\nPlan digest: /,
  );
  const record = JSON.parse(readFileSync(join(state, 'plan.json'), 'utf8'));
  assert.equal(record.digest, digest);
  assert.equal(record.assignee, 'sam');
  assert.equal(record.confirmed, null);

  const wrong = run(['confirm', 'abc', '--state', state]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /^abc is not the recorded plan digest/);
  const confirmed = run(['confirm', digest, '--state', state]);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal(confirmed.stdout, `Confirmed plan ${digest}.\n`);
  assert.equal(
    JSON.parse(readFileSync(join(state, 'plan.json'), 'utf8')).confirmed,
    digest,
  );
  const usage = run(['file', 'spec.md']);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^--state <dir> is required/);
  const loose = run([
    'plan',
    fixture('conforming-spec.md'),
    '--assignee',
    'sam',
  ]);
  assert.equal(loose.status, 1);
  assert.match(loose.stderr, /^--groups and --assignee need --state/);
});

test('plan --bodies writes every rendered body', () => {
  const cwd = repository(BASE, ['risk: security']);
  writeFileSync(
    join(cwd, '.agents/policy.json'),
    JSON.stringify({
      labels: {
        extra: [{ name: 'risk: security', color: '000000', description: '' }],
      },
    }),
  );
  const out = join(mkdtempSync(join(tmpdir(), 'bodies-')), 'nested');
  const result = run(
    ['plan', fixture('conforming-spec.md'), '--bodies', out],
    cwd,
  );
  assert.equal(result.status, 0, result.stderr);
  const expected = fileURLToPath(new URL('expected/', import.meta.url));
  assert.deepEqual(readdirSync(out).sort(), readdirSync(expected).sort());
  for (const name of readdirSync(expected))
    assert.equal(
      readFileSync(join(out, name), 'utf8'),
      readFileSync(join(expected, name), 'utf8'),
      name,
    );
});

test('plan --bodies refuses a directory inside a git checkout', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'spec-'));
  mkdirSync(join(cwd, '.git'));
  const result = run(
    ['plan', fixture('conforming-spec.md'), '--bodies', 'bodies'],
    cwd,
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^--bodies must name a directory outside any git checkout\n/,
  );
});

test('plan fails on a rendered-body rule after the structural rules pass', () => {
  const cwd = repository([...BASE, 'risk: security']);
  const spec = join(cwd, 'spec.md');
  writeFileSync(
    spec,
    readFileSync(fixture('conforming-spec.md'), 'utf8').replace(
      '`NoteId` is a validated branded string.',
      `\`NoteId\` is a validated branded string. ${'x'.repeat(70_000)}`,
    ),
  );
  const result = run(['plan', spec], cwd);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^\[body-size\] P0\.2: the body is \d+ characters/,
  );
});
