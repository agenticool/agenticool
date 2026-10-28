import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse, render } from '@agenticool/spec-parser';
import {
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

test('recordPlan writes an unconfirmed digest of the bodies in creation order', () => {
  const state = join(temporary(), 'nested', 'state');
  const digest = recordPlan(state, { spec: SPEC, text, plan, bodies });
  assert.equal(
    digest,
    sha256(plan.items.map((item) => `${bodies[item.key]}\n`).join('')),
  );
  assert.equal(digest, planDigest(plan, bodies));
  assert.deepEqual(readPlan(state), {
    spec: SPEC,
    specSha256: sha256(text),
    planSha256: digest,
    confirmed: false,
  });
  assert.throws(
    () => confirmPlan(state, 'abc'),
    /abc is not the recorded plan digest/,
  );
  confirmPlan(state, digest);
  assert.equal(readPlan(state)?.confirmed, true);
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
