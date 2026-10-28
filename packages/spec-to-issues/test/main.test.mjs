import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { prefix } from '@agenticool/policy';
import { parse, render } from '@agenticool/spec-parser';
import { main, recordPlan } from '../src/index.mjs';
import { FakeGitHub, fixture, load, SPEC, temporary } from './helpers.mjs';

/** A recorded, unconfirmed plan and a fake GitHub for the user policy. */
function setup() {
  const fake = new FakeGitHub();
  const directory = temporary();
  const state = join(directory, 'state');
  const text = readFileSync(SPEC, 'utf8');
  const plan = parse(text);
  const { digest } = recordPlan(state, {
    spec: SPEC,
    text,
    plan,
    bodies: render(plan, text, { prefix: prefix(load('user')) }),
    groups: { 'Phase 0': [['P0.1'], ['P0.2']] },
    assignee: 'sam',
  });
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  /** @param {string[]} argv */
  const cli = (argv) =>
    main(argv, {
      cwd: fixture('user'),
      run: fake.run,
      sleep: fake.sleep,
      now: fake.now,
      log: (message) => out.push(message),
      error: (message) => err.push(message),
    });
  return { fake, state, digest, out, err, cli };
}

test('confirm, then file, prints every issue with its URL', async () => {
  const { fake, state, digest, out, err, cli } = setup();
  assert.equal(await cli(['confirm', digest, '--state', state]), 0);
  assert.equal(out.pop(), `Confirmed plan ${digest}.`);
  assert.equal(await cli(['file', SPEC, '--state', state]), 0, err.join('\n'));
  assert.ok(
    out.includes(
      'Plan: #41 Notes service delivery plan https://github.com/example/notes/issues/41',
    ),
  );
  assert.equal(out.at(-1), `Filing complete. State: ${state}`);
  assert.ok(fake.issues.every((issue) => issue.assignees[0] === 'sam'));
  assert.match(fake.issues[1].body, /- g1: #46\n- g2: #47\n/);
  assert.equal(await cli(['resume', SPEC, '--state', state]), 0);
});

test('a failed filing names the resume command once state exists', async () => {
  const { fake, state, digest, err, cli } = setup();
  await cli(['confirm', digest, '--state', state]);
  fake.stopAfterCreate = 3;
  assert.equal(await cli(['file', SPEC, '--state', state]), 1);
  assert.match(
    err.pop() ?? '',
    new RegExp(
      `without a GitHub response.*\\nRun agenticool-spec resume ${SPEC} --state ${state} to continue\\.$`,
      's',
    ),
  );
  assert.equal(await cli(['file', SPEC, '--state', join(state, 'other')]), 1);
  assert.match(err.pop() ?? '', /^No confirmed plan for/);
});

test('usage errors and help', async () => {
  const { state, out, err, cli } = setup();
  assert.equal(await cli(['--help']), 0);
  assert.match(out.pop() ?? '', /^Usage: agenticool-spec confirm/);
  assert.equal(await cli(['file', SPEC]), 1);
  assert.match(err.pop() ?? '', /^--state <dir> is required/);
  assert.equal(await cli(['plan', SPEC, '--state', state]), 1);
  assert.match(
    err.pop() ?? '',
    /^Expected confirm <digest>, file <spec>, or resume <spec>/,
  );
  assert.equal(
    await cli(['file', SPEC, '--state', state, '--groups', 'g.json']),
    1,
  );
  assert.match(err.pop() ?? '', /^Unknown option --groups/);
});
