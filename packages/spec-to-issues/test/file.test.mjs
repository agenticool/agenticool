import assert from 'node:assert/strict';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitHubError } from '@agenticool/github';
import { prefix } from '@agenticool/policy';
import { parse, render } from '@agenticool/spec-parser';
import {
  checkGroups,
  confirmPlan,
  fileSpec,
  independenceRecord,
  recordPlan,
} from '../src/index.mjs';
import {
  FakeGitHub,
  fixture,
  LABELS,
  load,
  SPEC,
  temporary,
} from './helpers.mjs';

/**
 * @typedef {import('../src/file.mjs').State} State
 * @typedef {import('./helpers.mjs').Call} Call
 */

const GROUPS = {
  Plan: [['P1.1a', 'P1.3'], ['P2.1']],
  'Phase 0': [['P0.1', 'P0.2', 'P0.3']],
  'Phase 2': [['P2.1'], ['P2.2']],
};

/**
 * A confirmed plan in a fresh state directory and a fake GitHub to file it.
 * @param {{
 *   policyName?: string, spec?: string, confirm?: boolean,
 *   groups?: unknown, assignee?: string,
 *   fake?: ConstructorParameters<typeof FakeGitHub>[0],
 * }} [options]
 */
function setup({
  policyName = 'user',
  spec = SPEC,
  confirm = true,
  groups,
  assignee,
  fake: fakeOptions,
} = {}) {
  const policy = load(policyName);
  const fake = new FakeGitHub({
    repository: policy.binding.repository,
    ...fakeOptions,
  });
  const state = join(temporary(), 'state');
  const text = readFileSync(spec, 'utf8');
  const plan = parse(text);
  const agentPrefix = policy.binding.namespace ? prefix(policy) : '';
  const bodies = render(plan, text, { prefix: agentPrefix });
  /** @param {{ groups?: unknown, assignee?: string }} [choices] */
  const replan = (choices = {}) =>
    recordPlan(state, { spec, text, plan, bodies, ...choices }).digest;
  const digest = replan({ groups, assignee });
  if (confirm) confirmPlan(state, digest);
  /** @type {string[]} */
  const logs = [];
  /** @param {Partial<import('../src/file.mjs').FileOptions>} [extra] */
  const file = (extra = {}) =>
    fileSpec({
      spec,
      state,
      policy,
      run: fake.run,
      sleep: fake.sleep,
      now: fake.now,
      log: (message) => logs.push(message),
      ...extra,
    });
  /** @returns {State} */
  const read = () =>
    JSON.parse(readFileSync(join(state, 'state.json'), 'utf8'));
  /**
   * The body an item should carry once every number is known.
   * @param {State} filed
   * @param {string} key
   * @param {Record<string, string[][]>} [groups]
   */
  const expected = (filed, key, groups = {}) =>
    (
      bodies[key] +
      (groups[key] ? independenceRecord(groups[key], agentPrefix) : '')
    ).replace(
      /@@issue:([^@]+)@@/g,
      (_, other) =>
        `#${filed.items.find((item) => item.key === other)?.number}`,
    );
  return {
    policy,
    fake,
    state,
    plan,
    logs,
    file,
    read,
    expected,
    agentPrefix,
    replan,
  };
}

/**
 * Checks after the whole filing that GitHub holds exactly the plan.
 * @param {ReturnType<typeof setup>} context
 * @param {State} filed
 * @param {Record<string, string[][]>} [groups]
 */
function assertFiled({ fake, plan, expected }, filed, groups = {}) {
  assert.equal(fake.issues.length, plan.items.length);
  assert.equal(
    new Set(fake.issues.map((i) => i.title)).size,
    plan.items.length,
  );
  const number = (/** @type {string} */ key) =>
    /** @type {number} */ (
      filed.items.find((item) => item.key === key)?.number
    );
  for (const item of plan.items) {
    const issue = fake.issue(number(item.key));
    assert.equal(issue.title, item.title);
    assert.deepEqual(issue.labels, item.labels);
    assert.equal(issue.body, expected(filed, item.key, groups));
    assert.doesNotMatch(issue.body, /@@issue:/);
    if (item.parent)
      assert.deepEqual(
        fake.subIssues
          .get(number(item.parent))
          ?.filter((n) => n === issue.number),
        [issue.number],
      );
    assert.deepEqual(
      [...(fake.blockedBy.get(issue.number) ?? [])].sort(),
      item.blockedBy.map(number).sort(),
    );
    const entry = /** @type {import('../src/file.mjs').StateItem} */ (
      filed.items.find((e) => e.key === item.key)
    );
    assert.deepEqual(
      fake.itemFields.get(/** @type {number} */ (entry.projectItemId)),
      [
        { id: 101, value: `pri-${item.priority}` },
        { id: 102, value: `size-${item.size}` },
      ],
    );
    assert.equal(entry.parentLinked, Boolean(item.parent));
    assert.deepEqual(entry.blockersLinked, item.blockedBy);
    assert.equal(entry.fieldsSet, true);
    assert.equal(entry.triaged, true);
  }
  assert.equal(filed.items[0].containersReconciled, true);
  // Triage ran once per created issue and containers once for the root.
  assert.deepEqual(
    fake.graphql
      .filter((call) => call.query.includes('projectItems(first: 20'))
      .map((call) => call.variables.number)
      .sort(),
    filed.items.map((item) => item.number).sort(),
  );
  assert.deepEqual(
    fake.graphql
      .filter((call) => call.query.includes('issue(number: $number) { id'))
      .map((call) => call.variables.number),
    [filed.items[0].number],
  );
}

test('file runs every stage in order and records state after each write', async () => {
  const context = setup({ assignee: 'sam', groups: GROUPS });
  const { fake, state, file, read, plan } = context;
  // Each write starts only after the previous write is in state.json.
  let creates = 0;
  let parents = 0;
  let blockers = 0;
  let fields = 0;
  fake.beforeWrite = (/** @type {Call} */ call) => {
    const saved = read();
    if (call.path.endsWith('/issues')) {
      assert.equal(
        saved.items.filter((i) => i.number !== null).length,
        creates++,
      );
      assert.ok(saved.startedAt);
    } else if (call.path.endsWith('/sub_issues'))
      assert.equal(saved.items.filter((i) => i.parentLinked).length, parents++);
    else if (call.path.endsWith('/blocked_by'))
      assert.equal(
        saved.items.reduce((sum, i) => sum + i.blockersLinked.length, 0),
        blockers++,
      );
    else if (/\/items\/\d+$/.test(call.path))
      assert.equal(saved.items.filter((i) => i.fieldsSet).length, fields++);
  };
  const filed = await file();

  assert.match(fake.calls[0].path, /^repos\/example\/notes\/labels\?/);
  const creates_ = fake.writes.filter(
    (c) => c.path === 'repos/example/notes/issues',
  );
  assert.deepEqual(
    creates_.map((c) => c.input.title),
    plan.items.map((item) => item.title),
  );
  assert.ok(creates_.every((c) => c.input.assignees[0] === 'sam'));
  assert.deepEqual(
    filed.items.map((item) => item.number),
    plan.items.map((_, index) => 41 + index),
  );
  assert.deepEqual(
    filed.items.map((item) => item.predicted),
    filed.items.map((item) => item.number),
  );
  assert.equal(filed.mismatch, false);
  assert.ok(
    !fake.writes.some(
      (c) => c.method === 'PATCH' && c.path.includes('/issues/'),
    ),
  );
  // Stage order: creates, then parents, then blockers, then project fields.
  const stages = fake.writes.map((c) =>
    c.path.endsWith('/issues')
      ? 'create'
      : c.path.endsWith('/sub_issues')
        ? 'parent'
        : c.path.endsWith('/blocked_by')
          ? 'blocker'
          : 'fields',
  );
  assert.deepEqual(
    stages,
    [...stages].sort(
      (a, b) =>
        ['create', 'parent', 'blocker', 'fields'].indexOf(a) -
        ['create', 'parent', 'blocker', 'fields'].indexOf(b),
    ),
  );
  assertFiled(context, filed, GROUPS);
  // The deferred epic is blocked by its Deferred until slice.
  const number = (/** @type {string} */ key) =>
    filed.items.find((item) => item.key === key)?.number;
  assert.deepEqual(
    fake.blockedBy.get(/** @type {number} */ (number('Phase 2'))),
    [number('P1.2')],
  );
  assert.match(
    fake.issue(/** @type {number} */ (number('Phase 0'))).body,
    /### Independence groups\n\n<!-- acme-independence-groups -->\n- g1: #46 #47 #48\n<!-- \/acme-independence-groups -->$/,
  );
  // The plan-wide record on the root names leaves of different epics.
  assert.match(
    fake.issue(/** @type {number} */ (number('Plan'))).body,
    /### Independence groups\n\n<!-- acme-independence-groups -->\n- g1: #49 #52\n- g2: #53\n<!-- \/acme-independence-groups -->$/,
  );

  const saved = read();
  assert.deepEqual(saved, filed);
  assert.equal(saved.startedAt, '2026-10-27T11:55:00Z');
  assert.equal(saved.login, 'filer');
  assert.equal(saved.assignee, 'sam');
  assert.equal(saved.spec, SPEC);
  assert.deepEqual(
    saved.items.find((i) => i.key === 'Phase 0')?.groups,
    GROUPS['Phase 0'],
  );
  assert.deepEqual(
    saved.items.find((i) => i.key === 'Plan')?.groups,
    GROUPS.Plan,
  );
  assert.equal(saved.items.find((i) => i.key === 'Phase 1')?.groups, null);
  assert.ok(existsSync(join(state, 'bodies', 'Stack P1.1.md')));
  assert.equal(
    readFileSync(join(state, 'sent', 'P0.2.md'), 'utf8'),
    fake.issue(/** @type {number} */ (number('P0.2'))).body,
  );
  // A rerun of a complete filing writes nothing.
  const before = fake.writes.length;
  await file();
  assert.equal(fake.writes.length, before);
});

test('a prediction mismatch keeps creating, then patches every stale body', async () => {
  const context = setup({ fake: { skip: [43] } });
  const { fake, file, logs } = context;
  const filed = await file();
  assert.equal(filed.mismatch, true);
  assert.deepEqual(
    filed.items.slice(0, 4).map((item) => [item.predicted, item.number]),
    [
      [41, 41],
      [42, 42],
      [43, 44],
      [45, 45],
    ],
  );
  const patched = fake.writes.filter(
    (c) => c.method === 'PATCH' && c.path.includes('/issues/'),
  );
  assert.ok(patched.length > 0);
  assert.ok(logs.includes(`Patch pass: ${patched.length} bodies changed`));
  assertFiled(context, filed);
});

test('resume after a stop between a create and its state write adopts the issue by title', async () => {
  const context = setup({ groups: GROUPS });
  const { fake, file, read, logs } = context;
  fake.stopAfterCreate = 5;
  await assert.rejects(file(), GitHubError);
  const stopped = read();
  assert.equal(stopped.items.filter((i) => i.number !== null).length, 4);
  assert.equal(fake.issues.length, 5);
  fake.time += 60_000;

  const filed = await file({ resume: true });
  assert.ok(logs.includes('Adopted #45 for Stack P1.1'));
  assert.equal(filed.items[4].number, 45);
  assert.ok(logs.includes('Patch pass: 0 bodies changed'));
  assertFiled(context, filed, GROUPS);
});

test('resume stops when two issues share an unrecorded title', async () => {
  const { fake, file } = setup();
  fake.stopAfterCreate = 2;
  await assert.rejects(file(), GitHubError);
  fake.issues.push({ ...fake.issues[1], number: 99, id: 5099 });
  await assert.rejects(file({ resume: true }), /#42 and #99 share the title/);
});

test('resume refuses another specification, a changed specification, a changed plan, and new groups', async () => {
  const spec = join(temporary(), 'spec.md');
  copyFileSync(SPEC, spec);
  const { fake, file, state, policy, replan } = setup({ spec });
  fake.stopAfterCreate = 1;
  await assert.rejects(file(), GitHubError);
  confirmPlan(state, replan({ groups: GROUPS }));
  await assert.rejects(
    file(),
    /The confirmed groups or assignee differ from the ones .* recorded when filing began/,
  );
  await assert.rejects(
    file({ resume: true, spec: SPEC }),
    new RegExp(`belongs to ${spec}, not ${SPEC}`),
  );
  await assert.rejects(
    file({
      resume: true,
      policy: { ...policy, binding: { ...policy.binding, namespace: 'other' } },
    }),
    /The plan changed since filing began/,
  );
  appendFileSync(spec, '\n');
  await assert.rejects(file({ resume: true }), /changed after filing began/);
  assert.ok(existsSync(join(state, 'state.json')));
});

test('resume needs a state file', async () => {
  const { file } = setup();
  await assert.rejects(file({ resume: true }), /Nothing to resume/);
});

test('file refuses to run without a confirmed plan digest', async () => {
  const { fake, file, state } = setup({ confirm: false });
  await assert.rejects(file(), /No confirmed plan for/);
  const empty = join(temporary(), 'none');
  await assert.rejects(file({ state: empty }), /No confirmed plan for/);
  assert.equal(fake.calls.length, 0);
  assert.ok(!existsSync(join(state, 'state.json')));
});

test('changing the groups or assignee after confirm makes file refuse', async () => {
  const { fake, file, state, replan } = setup({
    groups: GROUPS,
    assignee: 'sam',
  });
  // Re-running plan with other choices resets the confirmation.
  replan({ groups: GROUPS, assignee: 'other' });
  await assert.rejects(file(), /No confirmed plan for/);
  // Editing plan.json after confirm no longer matches the confirmed digest.
  for (const edit of [
    { groups: { 'Phase 0': [['P0.1'], ['P0.2', 'P0.3']] } },
    { assignee: 'other' },
    { assignee: null },
  ]) {
    confirmPlan(state, replan({ groups: GROUPS, assignee: 'sam' }));
    const path = join(state, 'plan.json');
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...edit }),
    );
    await assert.rejects(file(), /No confirmed plan for/);
  }
  assert.equal(fake.calls.length, 0);
});

test('a label missing from the live repository stops filing before any write', async () => {
  const { fake, file, state } = setup({
    fake: { labels: LABELS.filter((l) => l !== 'risk: security') },
  });
  await assert.rejects(
    file(),
    /^Error: \[label-exists\] P0\.3: label "risk: security" is missing from the labels of example\/notes\.$/,
  );
  assert.equal(fake.calls.length, 1);
  assert.ok(!existsSync(join(state, 'state.json')));
});

test('an unassignable assignee or a missing project field or option stops filing', async () => {
  await assert.rejects(
    setup({ assignee: 'nobody' }).file(),
    /nobody cannot be assigned issues in example\/notes/,
  );
  const fields = new FakeGitHub().fields;
  await assert.rejects(
    setup({ fake: { fields: fields.filter((f) => f.name !== 'Size') } }).file(),
    /Notes delivery needs one Size field/,
  );
  await assert.rejects(
    setup({
      fake: {
        fields: fields.map((f) =>
          f.name === 'Priority'
            ? {
                ...f,
                options: f.options.filter(
                  (/** @type {any} */ o) => o.name.raw !== 'P3',
                ),
              }
            : f,
        ),
      },
    }).file(),
    /Notes delivery has no Priority option P3, which Phase 2 uses/,
  );
  const failing = setup({ assignee: 'sam' });
  const answer = failing.fake.answer.bind(failing.fake);
  failing.fake.answer = (call) => {
    if (!call.path.includes('/assignees/')) return answer(call);
    throw Object.assign(new Error('gh'), {
      stdout: 'HTTP/2.0 500 Error\r\n\r\n{"message":"boom"}',
      status: 1,
    });
  };
  await assert.rejects(failing.file(), /HTTP 500/);
});

test('an organization project item that never appears is added after one wait', async () => {
  const context = setup({
    policyName: 'organization',
    fake: { projectDelay: Infinity },
  });
  const { fake, file, logs } = context;
  const filed = await file();
  const adds = fake.writes.filter(
    (c) => c.path === 'orgs/example-org/projectsV2/3/items',
  );
  assert.equal(adds.length, 14);
  assert.equal(adds[0].fields.type, 'Issue');
  assert.equal(fake.listings, 19);
  assert.equal(fake.sleeps.filter((ms) => ms === 10_000).length, 18);
  assert.ok(logs.includes('Added #41 to Notes board'));
  assert.ok(fake.calls.every((c) => !c.path.startsWith('users/')));
  assert.equal(filed.items[0].projectItemId, 8041);
  assertFiled(context, filed);
});

test('project items the automation adds during the wait are used without an add', async () => {
  const context = setup({ fake: { projectDelay: 2 } });
  const { fake, file } = context;
  const filed = await file();
  assert.equal(fake.listings, 3);
  assert.ok(!fake.writes.some((c) => c.path.endsWith('/items')));
  assertFiled(context, filed);
});

test('a specification that fails pre-flight files nothing', async () => {
  const { file } = setup();
  await assert.rejects(
    file({ spec: fixture('../../../spec-parser/fixtures/violating-spec.md') }),
    /\[acyclic\]/,
  );
});

test('checkGroups accepts each epic’s own leaves and any leaf of the plan under Plan', () => {
  const plan = parse(readFileSync(SPEC, 'utf8'));
  assert.deepEqual(checkGroups(plan, GROUPS), GROUPS);
  for (const [groups, message] of /** @type {[unknown, RegExp][]} */ ([
    [null, /must be a JSON object keyed by epic/],
    [[], /must be a JSON object keyed by epic/],
    [{ 'Phase 9': [['P0.1']] }, /Phase 9, which is neither Plan nor an epic/],
    [{ 'Stack P1.1': [['P1.1a']] }, /Stack P1\.1, which is neither Plan/],
    [{ Plan: [['Phase 0']] }, /Phase 0, which is not its leaf/],
    [{ Plan: [['P0.1'], ['P2.1', 'P0.1']] }, /Plan name P0\.1 twice/],
    [{ 'Phase 0': [] }, /must be a list of non-empty lists/],
    [{ 'Phase 0': [[]] }, /must be a list of non-empty lists/],
    [{ 'Phase 0': [[1]] }, /must be a list of non-empty lists/],
    [{ 'Phase 1': [['P1.1a']] }, /P1\.1a, which is not its leaf/],
    [{ 'Phase 0': [['P0.1'], ['P0.1']] }, /P0\.1 twice/],
  ]))
    assert.throws(() => checkGroups(plan, groups), message);
});
