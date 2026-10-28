import assert from 'node:assert/strict';
import test from 'node:test';
import { graphqlBudget } from '@agenticool/github';
import {
  DONE_FILTERS,
  eligible,
  MissingIssueError,
  reconcile,
  reconcileDone,
  reconcileEpicLabels,
  runTracker,
  SETTLED_STATUSES,
  SWEEP_FILTER,
  trackerGraphql,
} from '../src/index.mjs';
import {
  board,
  epicApi,
  exhausted,
  ghFails,
  httpResponse,
  isProjectQuery,
  mockApi,
  notFound,
  orgPolicy,
  POLICIES,
  REPOSITORY,
  RESET,
  RESET_AT,
  userPolicy,
} from './helpers.mjs';

/** @param {Record<string, any>} [overrides] */
function issue(overrides = {}) {
  return {
    id: 'item',
    type: 'ISSUE',
    content: {
      id: 'issue',
      __typename: 'Issue',
      number: 1,
      state: 'OPEN',
      repository: { nameWithOwner: REPOSITORY },
    },
    labels: ['severity: none'],
    fields: { Status: 'Inbox', Priority: 'P2', Size: 'M' },
    ...overrides,
  };
}

/** @param {Record<string, any>} item */
const qualifies = (item) => eligible(item, userPolicy);

test('the exact metadata predicate includes all supported priorities, severities and sizes', () => {
  for (const Priority of ['P0', 'P1', 'P2', 'P3']) {
    for (const Size of ['XS', 'S', 'M', 'L']) {
      for (const severity of ['critical', 'high', 'medium', 'low', 'none']) {
        assert.equal(
          qualifies(
            issue({
              fields: { Status: 'Inbox', Priority, Size },
              labels: [`severity: ${severity}`, 'type: epic'],
            }),
          ),
          true,
        );
      }
    }
  }
  // Neither acceptance text nor type, area, and package labels are predicate requirements.
  assert.equal(qualifies(issue()), true);
});

test('an empty Status qualifies like Inbox', () => {
  const base = issue();
  assert.equal(
    qualifies(issue({ fields: { ...base.fields, Status: 'Inbox' } })),
    true,
  );
  assert.equal(
    qualifies(issue({ fields: { ...base.fields, Status: undefined } })),
    true,
  );
  assert.equal(
    qualifies(issue({ fields: { ...base.fields, Status: 'Ready' } })),
    false,
  );
});

test('reject PRs, drafts, other repositories, closed issues, invalid metadata and later states', () => {
  const base = issue();
  const cases = [
    { type: 'PULL_REQUEST' },
    { type: 'DRAFT_ISSUE', content: null },
    { content: { ...base.content, __typename: 'PullRequest' } },
    {
      content: {
        ...base.content,
        repository: { nameWithOwner: 'other/repository' },
      },
    },
    { content: { ...base.content, state: 'CLOSED' } },
    ...['Ready', 'In progress', 'In review', 'Done'].map((Status) => ({
      fields: { ...base.fields, Status },
    })),
    ...['P4', undefined].map((Priority) => ({
      fields: { ...base.fields, Priority },
    })),
    ...['XL', undefined].map((Size) => ({ fields: { ...base.fields, Size } })),
    ...[
      [],
      ['severity: unknown'],
      ['severity: none', 'severity: high'],
      ['severity: none', 'severity:unknown'],
    ].map((labels) => ({ labels })),
  ];
  for (const value of cases)
    assert.equal(qualifies(issue(value)), false, JSON.stringify(value));
});

test('eligibility follows the configured repository', () => {
  const item = issue();
  assert.equal(eligible(item, userPolicy), true);
  assert.equal(eligible(item, orgPolicy), false);
  item.content.repository.nameWithOwner = orgPolicy.binding.repository;
  assert.equal(eligible(item, orgPolicy), true);
});

test('a sweep reads the project in pages with nested metadata and re-reads only candidates', async () => {
  for (const policy of POLICIES) {
    const { api, state } = mockApi({ additionalIssue: true, policy });
    assert.deepEqual(await reconcile({ api, policy, log: () => {} }), {
      candidates: 2,
      updated: 0,
    });
    // Issue #2 fits in its nested pages; issue #1 overflows both connections.
    assert.deepEqual(state.queries, [
      'definitions-0',
      'definitions-1',
      'items-0',
      'items-1',
      'values-item',
      'labels-issue',
      'read-item',
      'values-item',
      'labels-issue',
      'read-item-2',
    ]);
  }
});

test('a sweep at the current project size costs a few calls, not two per item', async () => {
  /** @type {string[]} */
  const calls = [];
  const items = Array.from({ length: 251 }, (_, index) => ({
    id: `item-${index}`,
    type: 'ISSUE',
    project: { id: 'project' },
    fieldValues: {
      nodes: [{ field: { id: 'field-Status' }, optionId: 'option-Done' }],
      pageInfo: { hasNextPage: false },
    },
    content: {
      __typename: 'Issue',
      id: `issue-${index}`,
      number: index + 1,
      state: 'OPEN',
      repository: { nameWithOwner: REPOSITORY },
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
    },
  }));
  /**
   * @param {string} query
   * @param {Record<string, any>} variables
   */
  const api = async (query, variables) => {
    calls.push(query);
    if (isProjectQuery(query))
      return {
        user: {
          projectV2: {
            id: 'project',
            fields: {
              nodes: Object.entries({
                Status: ['Inbox', 'Ready', 'Done'],
                Priority: ['P0', 'P1', 'P2', 'P3'],
                Size: ['XS', 'S', 'M', 'L'],
              }).map(([name, options]) => ({
                id: `field-${name}`,
                name,
                options: options.map((name) => ({
                  id: `option-${name}`,
                  name,
                })),
              })),
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    assert.match(query, /items\(first: 100/);
    const start = Number(variables.cursor ?? 0);
    const end = start + 100;
    return {
      node: {
        items: {
          nodes: items.slice(start, end),
          pageInfo: {
            hasNextPage: end < items.length,
            endCursor: String(end),
          },
        },
      },
    };
  };
  assert.deepEqual(
    await reconcile({ api, policy: userPolicy, log: () => {} }),
    { candidates: 0, updated: 0 },
  );
  assert.equal(calls.length, 4);
});

test('dry-run discovers every item page and never mutates; apply is idempotent', async () => {
  const { api, state } = mockApi();
  const policy = userPolicy;
  assert.deepEqual(await reconcile({ api, policy, log: () => {} }), {
    candidates: 1,
    updated: 0,
  });
  assert.equal(state.mutations.length, 0);
  assert.ok(state.queries.includes('items-1'));
  // Every page asks only for open issues whose Status can still qualify.
  assert.deepEqual(state.itemFilters, [SWEEP_FILTER, SWEEP_FILTER]);
  assert.deepEqual(
    await reconcile({ api, policy, dryRun: false, log: () => {} }),
    { candidates: 1, updated: 1 },
  );
  assert.deepEqual(state.mutations, [
    {
      project: 'project',
      item: 'item',
      field: 'field-Status',
      option: 'option-Ready',
    },
  ]);
  assert.deepEqual(
    await reconcile({ api, policy, dryRun: false, log: () => {} }),
    { candidates: 0, updated: 0 },
  );
  assert.equal(state.mutations.length, 1);
});

test('re-read rejects eligibility changes at the mutation boundary', async () => {
  for (const race of [
    (/** @type {any} */ fields) => {
      fields.Status = 'In progress';
    },
    (/** @type {any} */ fields) => {
      fields.Priority = 'invalid';
    },
    (/** @type {any} */ fields) => {
      fields.Size = undefined;
    },
    (/** @type {any} */ _fields, /** @type {any} */ state) => {
      state.extraSeverity = true;
    },
    (/** @type {any} */ _fields, /** @type {any} */ state) => {
      state.closed = true;
    },
    (/** @type {any} */ _fields, /** @type {any} */ state) => {
      state.foreign = true;
    },
  ]) {
    const { api, state } = mockApi({ race });
    assert.deepEqual(
      await reconcile({
        api,
        policy: userPolicy,
        dryRun: false,
        log: () => {},
      }),
      { candidates: 0, updated: 0 },
    );
    assert.deepEqual(state.readItems, ['item']);
    assert.equal(state.mutations.length, 0);
  }
});

test('an issue with no Status value moves to Ready', async () => {
  const { api, state } = mockApi();
  state.status = undefined;
  /** @type {string[]} */
  const logs = [];
  assert.deepEqual(
    await reconcile({
      api,
      policy: userPolicy,
      issueNumber: 1,
      dryRun: false,
      log: (line) => logs.push(line),
    }),
    { candidates: 1, updated: 1 },
  );
  assert.match(logs[0], /issue #1 empty Status -> Ready/);
  assert.equal(state.status, 'Ready');
  assert.equal(state.mutations.length, 1);
});

test('issue filter reads only that issue and leaves another eligible issue untouched', async () => {
  for (const policy of POLICIES)
    for (const issueNumber of [1, 2]) {
      const { api, state } = mockApi({ additionalIssue: true, policy });
      /** @type {string[]} */
      const logs = [];
      assert.deepEqual(
        await reconcile({
          api,
          policy,
          issueNumber,
          log: (line) => logs.push(line),
        }),
        { candidates: 1, updated: 0 },
      );
      assert.equal(state.mutations.length, 0);
      assert.equal(state.status, 'Inbox');
      assert.equal(state.otherStatus, 'Inbox');
      assert.match(logs[0], new RegExp(`issue #${issueNumber} Inbox -> Ready`));
      const selectedId = issueNumber === 1 ? 'item' : 'item-2';
      assert.deepEqual(state.readItems, [selectedId]);
      // The project is never listed for one issue.
      assert.ok(
        !state.queries.some((/** @type {string} */ query) =>
          query.startsWith('items-'),
        ),
      );
      assert.ok(state.queries.includes(`issue-items-${issueNumber}`));
      assert.deepEqual(
        await reconcile({
          api,
          policy,
          issueNumber,
          dryRun: false,
          log: () => {},
        }),
        { candidates: 1, updated: 1 },
      );
      assert.deepEqual(
        state.mutations.map((/** @type {any} */ mutation) => mutation.item),
        [selectedId],
      );
      assert.equal(
        issueNumber === 1 ? state.otherStatus : state.status,
        'Inbox',
      );
      assert.deepEqual(
        await reconcile({
          api,
          policy,
          issueNumber,
          dryRun: false,
          log: () => {},
        }),
        { candidates: 0, updated: 0 },
      );
      assert.ok(
        state.readItems.every((/** @type {string} */ id) => id === selectedId),
      );
      // Project-wide reconciliation still processes the remaining eligible issue.
      assert.deepEqual(
        await reconcile({ api, policy, dryRun: false, log: () => {} }),
        { candidates: 1, updated: 1 },
      );
      assert.equal(state.status, 'Ready');
      assert.equal(state.otherStatus, 'Ready');
    }
});

test('an issue outside the project reads no item metadata and performs no writes', async () => {
  const { api, state } = mockApi({ additionalIssue: true });
  assert.deepEqual(
    await reconcile({
      api,
      policy: userPolicy,
      issueNumber: 3,
      dryRun: false,
      log: () => {},
    }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(state.readItems, []);
  assert.deepEqual(state.mutations, []);
});

test('an archived project item is excluded from a single-issue run', async () => {
  const { api, state } = mockApi();
  state.archived = ['item'];
  assert.deepEqual(
    await reconcile({
      api,
      policy: userPolicy,
      issueNumber: 1,
      dryRun: false,
      log: () => {},
    }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(state.readItems, []);
  assert.deepEqual(state.mutations, []);
  assert.equal(state.status, 'Inbox');
});

test('issue filter is rechecked against fresh issue metadata before mutation', async () => {
  const { api, state } = mockApi({
    race: (_fields, state) => {
      state.renumbered = true;
    },
  });
  assert.deepEqual(
    await reconcile({
      api,
      policy: userPolicy,
      issueNumber: 1,
      dryRun: false,
      log: () => {},
    }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(state.mutations, []);
});

test('closed issues move to Done, reopened issues leave Done, and everything else stays', async () => {
  for (const policy of POLICIES) {
    const f = board(
      [
        { number: 1, state: 'CLOSED', status: 'In review' },
        { number: 2, state: 'CLOSED', status: 'Ready' },
        { number: 3, state: 'CLOSED' },
        { number: 4, state: 'CLOSED', status: 'Done' },
        { number: 5, state: 'OPEN', status: 'In review' },
        { number: 6, state: 'MERGED', type: 'PULL_REQUEST' },
        {
          number: 7,
          state: 'CLOSED',
          status: 'Ready',
          repository: 'other/repo',
        },
        { number: 8, state: 'OPEN', status: 'Done' },
        { number: 9, state: 'OPEN' },
      ],
      { policy },
    );
    /** @type {string[]} */
    const lines = [];
    assert.deepEqual(
      await reconcileDone({
        api: f.api,
        policy,
        dryRun: false,
        log: (line) => lines.push(line),
      }),
      { candidates: 4, updated: 4 },
    );
    assert.deepEqual(f.filters, DONE_FILTERS);
    assert.deepEqual(f.reads, ['item-1', 'item-2', 'item-3', 'item-8']);
    assert.deepEqual(
      f.mutations,
      [
        ['item-1', 'Done'],
        ['item-2', 'Done'],
        ['item-3', 'Done'],
        ['item-8', 'Ready'],
      ].map(([item, status]) => ({
        project: 'project',
        item,
        field: 'field-Status',
        option: `option-${status}`,
      })),
    );
    assert.deepEqual(lines, [
      'Moving closed issue #1 In review -> Done',
      'Moving closed issue #2 Ready -> Done',
      'Moving closed issue #3 without Status -> Done',
      'Moving reopened issue #8 Done -> Ready',
      'Done reconciliation: 4 eligible, 4 updated; DRY_RUN=false',
    ]);
    assert.deepEqual(
      await reconcileDone({ api: f.api, policy, dryRun: false, log() {} }),
      { candidates: 0, updated: 0 },
    );
  }
});

test('Done reconciliation dry-runs and re-reads every item before writing', async () => {
  const dry = board([{ number: 1, state: 'CLOSED', status: 'In review' }]);
  /** @type {string[]} */
  const lines = [];
  assert.deepEqual(
    await reconcileDone({
      api: dry.api,
      policy: userPolicy,
      log: (line) => lines.push(line),
    }),
    { candidates: 1, updated: 0 },
  );
  assert.deepEqual(dry.mutations, []);
  assert.deepEqual(lines, [
    'DRY_RUN would move closed issue #1 In review -> Done',
    'Done reconciliation: 1 eligible, 0 updated; DRY_RUN=true',
  ]);

  /** @type {Record<string, Record<string, string>>} */
  const changes = {
    'item-1': { state: 'OPEN' },
    'item-2': { status: 'Done' },
    'item-3': { state: 'CLOSED' },
    'item-4': { repository: 'other/repo' },
  };
  /** @type {string[]} */
  const warnings = [];
  const raced = board(
    [
      { number: 1, state: 'CLOSED', status: 'In review' },
      { number: 2, state: 'CLOSED', status: 'In review' },
      { number: 3, state: 'OPEN', status: 'Done' },
      { number: 4, state: 'CLOSED', status: 'Ready' },
      { number: 5, state: 'CLOSED', status: 'Ready' },
    ],
    {
      onRead: (entry, id) =>
        id === 'item-5' ? null : Object.assign(entry, changes[id]),
    },
  );
  assert.deepEqual(
    await reconcileDone({
      api: raced.api,
      policy: userPolicy,
      dryRun: false,
      log() {},
      warn: (line) => warnings.push(line),
    }),
    { candidates: 0, updated: 0 },
  );
  assert.deepEqual(raced.mutations, []);
  assert.deepEqual(warnings, [
    'Issue #4 no longer exists in the repository; skipping',
    'Issue #5 left the project; skipping',
  ]);

  await assert.rejects(
    reconcileDone({ api: dry.api, policy: userPolicy, issueNumber: 0 }),
    /positive safe integer/,
  );
});

test('a single-issue Done run reads only that issue and never lists the project', async () => {
  const f = board([
    { number: 1, state: 'CLOSED', status: 'In review' },
    { number: 2, state: 'OPEN', status: 'Done' },
  ]);
  for (const [issueNumber, target] of /** @type {const} */ ([
    [1, 'Done'],
    [2, 'Ready'],
  ]))
    assert.deepEqual(
      await reconcileDone({
        api: f.api,
        policy: userPolicy,
        dryRun: false,
        issueNumber,
        log() {},
      }),
      { candidates: 1, updated: 1 },
      target,
    );
  assert.deepEqual(f.filters, []);
  assert.deepEqual(f.reads, ['item-1', 'item-2']);
  assert.deepEqual(
    f.mutations.map((mutation) => [mutation.item, mutation.option]),
    [
      ['item-1', 'option-Done'],
      ['item-2', 'option-Ready'],
    ],
  );
});

test('invalid programmatic issue filters fail before any API access', async () => {
  for (const issueNumber of [
    0,
    -1,
    1.5,
    '1',
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(
      reconcile({
        api: () => {
          assert.fail('API access with invalid issue filter');
        },
        policy: userPolicy,
        issueNumber: /** @type {number} */ (issueNumber),
      }),
      /positive safe integer/,
    );
  }
});

test('epic label reconciliation removes standard and type labels from epics only', async () => {
  for (const policy of POLICIES) {
    const github = epicApi(policy);
    /** @type {string[]} */
    const logs = [];
    await reconcileEpicLabels({
      api: github.api,
      policy,
      dryRun: false,
      log: (line) => logs.push(line),
    });
    assert.deepEqual(github.writes, [
      { id: 'E7', labels: ['L_bug', 'L_type'] },
      { id: 'E9', labels: ['L_docs'] },
    ]);
    assert.deepEqual(logs, [
      'Removing 2 conflicting category labels from epic #7',
      'Removing 1 conflicting category labels from epic #9',
    ]);
    // One listing plus one follow-up page for the epic that overflowed.
    assert.equal(github.calls.length - github.writes.length, 2);
    const dry = epicApi(policy);
    /** @type {string[]} */
    const dryLogs = [];
    await reconcileEpicLabels({
      api: dry.api,
      policy,
      log: (line) => dryLogs.push(line),
    });
    assert.deepEqual(dry.writes, []);
    assert.match(dryLogs[0], /^DRY_RUN would remove 2/);
  }
});

test('epic label reconciliation for one issue reads only that issue', async () => {
  const github = epicApi();
  await reconcileEpicLabels({
    api: github.api,
    policy: userPolicy,
    dryRun: false,
    issueNumber: 7,
    log: () => {},
  });
  assert.deepEqual(github.writes, [{ id: 'E7', labels: ['L_bug', 'L_type'] }]);
  assert.equal(github.calls.length, 2);
  assert.ok(!github.calls.some((query) => query.includes('labels: ["epic"]')));
  // A non-epic issue keeps its labels.
  const plain = epicApi();
  await reconcileEpicLabels({
    api: plain.api,
    policy: userPolicy,
    dryRun: false,
    issueNumber: 1,
    log: () => {},
  });
  assert.deepEqual(plain.writes, []);
  assert.equal(plain.calls.length, 1);
});

test('epic label reconciliation skips an epic deleted after the listing', async () => {
  const github = epicApi();
  /**
   * @param {string} query
   * @param {Record<string, any>} variables
   */
  const api = async (query, variables) =>
    variables?.id === 'E9' && /node\(id: \$id\)/.test(query)
      ? { node: null }
      : github.api(query, variables);
  await reconcileEpicLabels({
    api,
    policy: userPolicy,
    dryRun: false,
    log: () => {},
  });
  assert.deepEqual(github.writes, [{ id: 'E7', labels: ['L_bug', 'L_type'] }]);
});

test('the sweep filter excludes exactly the statuses eligible() never moves', () => {
  assert.equal(
    SWEEP_FILTER,
    'is:issue is:open -status:Ready,"In progress","In review",Done',
  );
  const base = issue();
  /** @param {string | undefined} Status */
  const movable = (Status) =>
    qualifies(issue({ fields: { ...base.fields, Status } }));
  for (const Status of SETTLED_STATUSES)
    assert.equal(movable(Status), false, Status);
  for (const Status of [undefined, 'Inbox'])
    assert.equal(movable(Status), true, String(Status));
});

test('a write to a target deleted mid-run is skipped and later items are still written', async () => {
  const mutation =
    'mutation($id: ID!) { closeIssue(input: { issueId: $id }) { issue { id } } }';
  const skipped = [
    'A write target was deleted or transferred during the run; skipping it',
  ];
  const deleted = () =>
    trackerGraphql(
      mutation,
      {},
      notFound({ closeIssue: null }, ['closeIssue']),
    );
  const ready = mockApi({ additionalIssue: true });
  /** @type {string[]} */
  const readyWarnings = [];
  assert.deepEqual(
    await reconcile({
      api: async (query, variables) =>
        query.startsWith('mutation') && variables.item === 'item'
          ? deleted()
          : ready.api(query, variables),
      policy: userPolicy,
      dryRun: false,
      log: () => {},
      warn: (line) => readyWarnings.push(line),
    }),
    { candidates: 2, updated: 1 },
  );
  assert.deepEqual(readyWarnings, skipped);
  assert.deepEqual(
    ready.state.mutations.map((/** @type {any} */ mutation) => mutation.item),
    ['item-2'],
  );
  const done = board([
    { number: 1, state: 'CLOSED', status: 'In review' },
    { number: 2, state: 'CLOSED', status: 'Ready' },
  ]);
  /** @type {string[]} */
  const doneWarnings = [];
  assert.deepEqual(
    await reconcileDone({
      api: async (query, variables) =>
        query.startsWith('mutation') && variables.item === 'item-1'
          ? deleted()
          : done.api(query, variables),
      policy: userPolicy,
      dryRun: false,
      log: () => {},
      warn: (line) => doneWarnings.push(line),
    }),
    { candidates: 2, updated: 1 },
  );
  assert.deepEqual(doneWarnings, skipped);
  assert.deepEqual(
    done.mutations.map((mutation) => mutation.item),
    ['item-2'],
  );
  const epics = epicApi();
  /** @type {string[]} */
  const epicWarnings = [];
  await reconcileEpicLabels({
    api: async (query, variables) =>
      query.startsWith('mutation') && variables.id === 'E7'
        ? deleted()
        : epics.api(query, variables),
    policy: userPolicy,
    dryRun: false,
    log: () => {},
    warn: (line) => epicWarnings.push(line),
  });
  assert.deepEqual(epicWarnings, skipped);
  assert.deepEqual(epics.writes, [{ id: 'E9', labels: ['L_docs'] }]);
});

test('a single-issue run for a missing issue stops with MissingIssueError', async () => {
  const { api, state } = mockApi();
  await assert.rejects(
    reconcile({
      api,
      policy: userPolicy,
      issueNumber: 404,
      dryRun: false,
      log: () => {},
    }),
    (/** @type {any} */ error) =>
      error instanceof MissingIssueError &&
      error.message ===
        'Issue #404 no longer exists in the repository; skipping',
  );
  assert.deepEqual(state.mutations, []);
  const epics = epicApi();
  await assert.rejects(
    reconcileEpicLabels({
      api: async () => ({ repository: { issue: null } }),
      policy: userPolicy,
      dryRun: false,
      issueNumber: 404,
      log: () => {},
    }),
    MissingIssueError,
  );
  assert.deepEqual(epics.writes, []);
});

test('a sweep skips deleted and transferred issues with a warning and moves the rest', async () => {
  for (const [change, warning] of /** @type {const} */ ([
    [
      (/** @type {any} */ state) => (state.deleted = ['item']),
      'Issue #1 left the project; skipping',
    ],
    [
      (/** @type {any} */ state) => (state.transferred = ['item']),
      'Issue #1 no longer exists in the repository; skipping',
    ],
  ])) {
    const { api, state } = mockApi({ additionalIssue: true });
    // The listing still shows issue #1; it changes before the re-read.
    /** @type {string[]} */
    const warnings = [];
    /**
     * @param {string} query
     * @param {Record<string, any>} variables
     */
    const wrapped = async (query, variables) => {
      if (query.includes('... on ProjectV2Item {') && variables.id === 'item')
        change(state);
      return api(query, variables);
    };
    assert.deepEqual(
      await reconcile({
        api: wrapped,
        policy: userPolicy,
        dryRun: false,
        log: () => {},
        warn: (line) => warnings.push(line),
      }),
      { candidates: 1, updated: 1 },
    );
    assert.deepEqual(warnings, [warning]);
    assert.deepEqual(
      state.mutations.map((/** @type {any} */ mutation) => mutation.item),
      ['item-2'],
    );
  }
  /** @type {string[]} */
  const warnings = [];
  const { api, state } = mockApi();
  await reconcile({
    api: async (query, variables) => {
      const data = await api(query, variables);
      if (query.includes('items(first: 100') && variables.cursor)
        data.node.items.nodes.unshift({
          id: 'gone',
          type: 'ISSUE',
          content: null,
        });
      return data;
    },
    policy: userPolicy,
    dryRun: false,
    log: () => {},
    warn: (line) => warnings.push(line),
  });
  assert.deepEqual(warnings, [
    'Project item gone has no readable issue; skipping',
  ]);
  assert.deepEqual(state.mutations.length, 1);
  // Done reconciliation skips an unreadable item the same way.
  const done = board([{ number: 1, state: 'CLOSED', status: 'Ready' }]);
  /** @type {string[]} */
  const doneWarnings = [];
  assert.deepEqual(
    await reconcileDone({
      api: async (query, variables) => {
        const data = await done.api(query, variables);
        if (query.includes('items(first: 100'))
          data.node.items.nodes.unshift({
            id: 'gone',
            type: 'ISSUE',
            content: null,
          });
        return data;
      },
      policy: userPolicy,
      dryRun: false,
      log: () => {},
      warn: (line) => doneWarnings.push(line),
    }),
    { candidates: 1, updated: 1 },
  );
  assert.deepEqual(doneWarnings, [
    'Project item gone has no readable issue; skipping',
    'Project item gone has no readable issue; skipping',
  ]);
});

// Runs the three triage reconcilers through runTracker against a stand-in for
// gh whose GraphQL calls all return `graphql` and whose free REST rate_limit
// endpoint reports a healthy budget. gh's stderr carries the token.
/**
 * @param {string} graphql
 * @param {number | undefined} issueNumber
 */
async function triageRun(graphql, issueNumber) {
  const out = {
    /** @type {string[]} */ logs: [],
    /** @type {string[]} */ warnings: [],
    /** @type {string[]} */ errors: [],
  };
  /** @type {import('@agenticool/github').Run} */
  const run = (_command, args) => {
    if (args.includes('rate_limit'))
      return httpResponse(
        200,
        {},
        {
          resources: {
            graphql: { limit: 5000, remaining: 4000, used: 1000, reset: RESET },
          },
        },
      );
    return ghFails(graphql, {
      stderr: `gh: stderr-marker ${process.env.WIDGETS_PROJECT_TOKEN}`,
    })();
  };
  /**
   * @param {string} query
   * @param {Record<string, unknown>} variables
   */
  const api = (query, variables) => trackerGraphql(query, variables, run);
  const options = {
    api,
    policy: userPolicy,
    dryRun: false,
    issueNumber,
    log: (/** @type {string} */ line) => out.logs.push(line),
    warn: (/** @type {string} */ line) => out.warnings.push(line),
  };
  const status = await runTracker({
    policy: userPolicy,
    sweep: issueNumber === undefined,
    task: async () => {
      await reconcileEpicLabels(options);
      await reconcile(options);
      await reconcileDone(options);
    },
    budget: () => graphqlBudget(run),
    log: options.log,
    warn: options.warn,
    error: (line) => out.errors.push(line),
  });
  return { ...out, status };
}

const RATE_LIMITED_GRAPHQL = httpResponse(200, exhausted, {
  errors: [
    {
      type: 'RATE_LIMITED',
      message: 'API rate limit already exceeded for user ID 1.',
    },
  ],
});
const RATE_LIMIT_MESSAGE = `GitHub GraphQL request failed: RATE_LIMITED: API rate limit already exceeded for user ID 1. Rate limit reached; the limit resets at ${RESET_AT}.`;

test('a rate-limited sweep fails with the shared rate-limit message', async (t) => {
  process.env.WIDGETS_PROJECT_TOKEN = 'widgets-project-token-value';
  t.after(() => delete process.env.WIDGETS_PROJECT_TOKEN);
  const result = await triageRun(RATE_LIMITED_GRAPHQL, undefined);
  assert.equal(result.status, 1);
  assert.ok(
    result.logs.every((line) => line.startsWith('GraphQL budget ')),
    result.logs.join('\n'),
  );
  assert.deepEqual(result.errors, [RATE_LIMIT_MESSAGE]);
});

test('a rate-limited single-issue run warns and succeeds without the token', async (t) => {
  const secret = 'widgets-project-token-value';
  process.env.WIDGETS_PROJECT_TOKEN = secret;
  t.after(() => delete process.env.WIDGETS_PROJECT_TOKEN);
  const result = await triageRun(RATE_LIMITED_GRAPHQL, 5);
  assert.equal(result.status, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [
    `${RATE_LIMIT_MESSAGE} The next scheduled sweep reconciles this issue.`,
  ]);
  assert.match(result.logs[0], /^GraphQL budget before: 4000 of 5000/);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('a single-issue run skips a missing issue and still fails on other not-found errors', async () => {
  const missing = await triageRun(
    httpResponse(
      200,
      {},
      {
        data: { repository: { issue: null } },
        errors: [
          {
            type: 'NOT_FOUND',
            path: ['repository', 'issue'],
            message: 'Could not resolve to an Issue with the number of 5.',
          },
        ],
      },
    ),
    5,
  );
  assert.equal(missing.status, 0, missing.errors.join('\n'));
  assert.deepEqual(missing.errors, []);
  assert.deepEqual(missing.warnings, [
    'Issue #5 no longer exists in the repository; skipping',
  ]);
  const failed = await triageRun(
    httpResponse(
      200,
      {},
      {
        data: { repository: null },
        errors: [
          {
            type: 'NOT_FOUND',
            path: ['repository'],
            message: 'Could not resolve to a Repository.',
          },
        ],
      },
    ),
    5,
  );
  assert.equal(failed.status, 1);
  assert.deepEqual(failed.errors, [
    'GitHub GraphQL request failed: NOT_FOUND: Could not resolve to a Repository.',
  ]);
});
