import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse, printTree, render } from '@agenticool/spec-parser';
import {
  confirmationDigest,
  confirmPlan,
  planDigest,
  readPlan,
  recordPlan,
  sha256,
  stateDirectory,
} from '../src/index.mjs';
import { SPEC, temporary } from './helpers.mjs';

const text = readFileSync(SPEC, 'utf8');
const plan = parse(text);
const bodies = render(plan, text);

test('recordPlan records the plan, groups, and assignee and prints them with the digest', () => {
  const state = join(temporary(), 'nested', 'state');
  const groups = {
    'Phase 2': [['P2.1'], ['P2.2']],
    'Phase 0': [['P0.1', 'P0.3'], ['P0.2']],
  };
  const { digest, output } = recordPlan(state, {
    spec: SPEC,
    text,
    plan,
    bodies,
    groups,
    assignee: 'sam',
  });
  const planSha256 = sha256(
    plan.items.map((item) => `${bodies[item.key]}\n`).join(''),
  );
  assert.equal(planSha256, planDigest(plan, bodies));
  assert.equal(
    digest,
    confirmationDigest({ planSha256, groups, assignee: 'sam' }),
  );
  // Epic order in the groups object does not change the digest.
  assert.equal(
    digest,
    confirmationDigest({
      planSha256,
      groups: { 'Phase 0': groups['Phase 0'], 'Phase 2': groups['Phase 2'] },
      assignee: 'sam',
    }),
  );
  assert.notEqual(
    digest,
    confirmationDigest({ planSha256, groups, assignee: null }),
  );
  assert.notEqual(
    digest,
    confirmationDigest({ planSha256, groups: {}, assignee: 'sam' }),
  );
  assert.deepEqual(readPlan(state), {
    spec: SPEC,
    specSha256: sha256(text),
    planSha256,
    groups,
    assignee: 'sam',
    digest,
    confirmed: null,
  });
  assert.ok(output.startsWith(printTree(plan).split('\n\nTotals: ')[0]));
  assert.ok(
    output.endsWith(
      [
        '',
        'Independence groups:',
        '  Phase 0: g1 P0.1 P0.3; g2 P0.2',
        '  Phase 1: none',
        '  Phase 2: g1 P2.1; g2 P2.2',
        'Totals: 2 containers, 3 epics, 9 leaves.',
        'Assignee: sam',
        `State: ${state}`,
        `Plan digest: ${digest}`,
      ].join('\n'),
    ),
  );
  assert.match(
    recordPlan(state, { spec: SPEC, text, plan, bodies }).output,
    /Phase 0: none\n.*\nAssignee: none\n/s,
  );
  assert.equal(readPlan(state)?.confirmed, null);
  confirmPlan(
    state,
    recordPlan(state, {
      spec: SPEC,
      text,
      plan,
      bodies,
      groups,
      assignee: 'sam',
    }).digest,
  );
  assert.throws(
    () => confirmPlan(state, 'abc'),
    /abc is not the recorded plan digest/,
  );
  assert.equal(readPlan(state)?.confirmed, digest);
  assert.throws(
    () => recordPlan(state, { spec: SPEC, text, plan, bodies, groups: [] }),
    /must be a JSON object keyed by epic/,
  );
});

test('confirm needs a recorded plan and state stays outside git checkouts', () => {
  const empty = temporary();
  assert.equal(readPlan(empty), null);
  assert.throws(() => confirmPlan(empty, 'abc'), /No plan is recorded/);
  const checkout = fileURLToPath(
    new URL('../state-in-checkout', import.meta.url),
  );
  assert.throws(() => stateDirectory(checkout), /is inside a git checkout/);
  assert.throws(
    () => recordPlan(checkout, { spec: SPEC, text, plan, bodies }),
    /is inside a git checkout/,
  );
});
