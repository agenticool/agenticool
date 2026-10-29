import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubError } from '@agenticool/core';
import {
  completeItem,
  discover,
  eligible,
  issueItems,
  listItems,
  MissingIssueError,
  paginate,
  readItem,
  runBoard,
  SWEEP_FLOOR,
  boardGraphql,
  updateProjectStatus,
  warning,
} from '../src/index.mjs';
import {
  exhausted,
  ghFails,
  httpResponse,
  mockApi,
  notFound,
  orgPolicy,
  POLICIES,
  RESET,
  RESET_AT,
  userPolicy,
} from './helpers.mjs';

/**
 * @param {number} remaining
 * @param {Record<string, number>} [overrides]
 */
const budget = (remaining, overrides = {}) => ({
  limit: 5000,
  remaining,
  used: 5000 - remaining,
  reset: RESET,
  ...overrides,
});

/**
 * @param {any[]} readings
 * @param {() => Promise<void>} task
 * @param {boolean} sweep
 */
function boardTask(readings, task, sweep) {
  /** @type {{ logs: string[], warnings: string[], errors: string[], ran: boolean }} */
  const out = { logs: [], warnings: [], errors: [], ran: false };
  const queue = [...readings];
  const promise = runBoard({
    sweep,
    task: async () => {
      out.ran = true;
      await task();
    },
    budget: () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    log: (line) => out.logs.push(line),
    warn: (line) => out.warnings.push(line),
    error: (line) => out.errors.push(line),
  });
  return promise.then((status) => ({ ...out, status }));
}

const rateLimited = () =>
  new GitHubError('GitHub GraphQL request failed: RATE_LIMITED.', {
    kind: 'rate-limit',
  });

test('a run logs the GraphQL points used between its two budget readings', async () => {
  const result = await boardTask(
    [budget(4800), budget(4786)],
    async () => {},
    true,
  );
  assert.equal(result.status, 0);
  assert.deepEqual(result.logs, [
    `GraphQL budget before: 4800 of 5000 points remain; the window resets at ${RESET_AT}.`,
    'GraphQL budget after: 4786 points remain; 14 were used during the run, counting every client of this account.',
  ]);
  const reset = await boardTask(
    [budget(1200), budget(4990, { reset: RESET + 3600 })],
    async () => {},
    true,
  );
  assert.equal(
    reset.logs[1],
    'GraphQL budget after: 4990 points remain; the window reset during the run.',
  );
});

test('a sweep below the floor skips with a warning; a single-issue run still runs', async () => {
  const skipped = await boardTask(
    [budget(SWEEP_FLOOR - 1)],
    async () => {},
    true,
  );
  assert.equal(skipped.status, 0);
  assert.equal(skipped.ran, false);
  assert.deepEqual(skipped.warnings, [
    `Skipped the sweep: ${SWEEP_FLOOR - 1} GraphQL points remain, below the floor of ${SWEEP_FLOOR}. The next scheduled sweep reconciles.`,
  ]);
  const atFloor = await boardTask(
    [budget(SWEEP_FLOOR), budget(SWEEP_FLOOR)],
    async () => {},
    true,
  );
  assert.equal(atFloor.ran, true);
  const event = await boardTask([budget(10), budget(5)], async () => {}, false);
  assert.equal(event.ran, true);
  assert.deepEqual(event.warnings, []);
});

test('only a single-issue run tolerates a rate limit; other failures fail the run', async () => {
  const event = await boardTask(
    [budget(10), budget(0)],
    async () => {
      throw rateLimited();
    },
    false,
  );
  assert.equal(event.status, 0);
  assert.deepEqual(event.errors, []);
  assert.deepEqual(event.warnings, [
    'GitHub GraphQL request failed: RATE_LIMITED. The next scheduled sweep reconciles this issue.',
  ]);
  const sweep = await boardTask(
    [budget(4000), budget(0)],
    async () => {
      throw rateLimited();
    },
    true,
  );
  assert.equal(sweep.status, 1);
  assert.deepEqual(sweep.errors, [
    'GitHub GraphQL request failed: RATE_LIMITED.',
  ]);
  for (const failure of [
    new GitHubError('GitHub GraphQL request failed: HTTP 502.', {
      kind: 'other',
    }),
    new Error('Issue hierarchy cycle'),
    Object.assign(new Error('rate limit text'), { kind: 'rate-limit' }),
  ]) {
    const result = await boardTask(
      [budget(4000), budget(4000)],
      async () => {
        throw failure;
      },
      false,
    );
    assert.equal(result.status, 1, failure.message);
    assert.equal(result.errors.length, 1, failure.message);
  }
});

test('an unreadable budget warns and the run continues without a floor', async () => {
  const result = await boardTask(
    [new Error('no budget'), new Error('no budget')],
    async () => {},
    true,
  );
  assert.equal(result.status, 0);
  assert.equal(result.ran, true);
  assert.deepEqual(result.logs, []);
  assert.deepEqual(result.warnings, [
    'Could not read the GraphQL budget: no budget',
    'Could not read the GraphQL budget: no budget',
  ]);
});

test('a run redacts the Projects token', async (t) => {
  const secret = 'widgets-project-token-value';
  const saved = process.env.AGENTICOOL_PROJECT_TOKEN;
  process.env.AGENTICOOL_PROJECT_TOKEN = secret;
  t.after(() => {
    if (saved === undefined) delete process.env.AGENTICOOL_PROJECT_TOKEN;
    else process.env.AGENTICOOL_PROJECT_TOKEN = saved;
  });
  const result = await boardTask(
    [new Error(`budget read with ${secret}`), budget(4000)],
    async () => {
      throw new Error(`task failed with ${secret}`);
    },
    false,
  );
  assert.equal(result.status, 1);
  assert.deepEqual(result.errors, ['task failed with ***']);
  assert.deepEqual(result.warnings, [
    'Could not read the GraphQL budget: budget read with ***',
  ]);
});

test('the board warns and succeeds when its issue no longer exists', async () => {
  for (const sweep of [false, true]) {
    const result = await boardTask(
      [budget(4000), budget(4000)],
      async () => {
        throw new MissingIssueError(5);
      },
      sweep,
    );
    assert.equal(result.status, 0);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, [
      'Issue #5 no longer exists in the repository; skipping',
    ]);
  }
});

test('warnings use the GitHub Actions annotation', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  warning('careful');
  assert.deepEqual(log.mock.calls[0].arguments, ['::warning::careful']);
});

test('pagination keeps every page, skips deleted nodes, and rejects broken cursors', async () => {
  /** @type {(string | null)[]} */
  const cursors = [];
  assert.deepEqual(
    await paginate(async (cursor) => {
      cursors.push(cursor);
      return cursor === null
        ? {
            nodes: [1, null],
            pageInfo: { hasNextPage: true, endCursor: 'next' },
          }
        : { nodes: [2], pageInfo: { hasNextPage: false } };
    }),
    [1, 2],
  );
  assert.deepEqual(cursors, [null, 'next']);
  await assert.rejects(
    paginate(async () => ({
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: 'stuck' },
    })),
    /did not advance/,
  );
  await assert.rejects(
    paginate(async () => null),
    /Missing GraphQL connection/,
  );
});

test('pagination continues from a nested first page', async () => {
  /** @type {(string | null)[]} */
  const cursors = [];
  assert.deepEqual(
    await paginate(
      async (cursor) => {
        cursors.push(cursor);
        return { nodes: [3], pageInfo: { hasNextPage: false } };
      },
      { nodes: [1, 2], pageInfo: { hasNextPage: true, endCursor: 'two' } },
    ),
    [1, 2, 3],
  );
  assert.deepEqual(cursors, ['two']);
  assert.deepEqual(
    await paginate(
      () => assert.fail('a complete nested page needs no request'),
      { nodes: [1], pageInfo: { hasNextPage: false } },
    ),
    [1],
  );
});

test('discovery and item reads take nested pages first, then read only overflowing connections', async () => {
  for (const policy of POLICIES) {
    const { api, state } = mockApi({ multipleSeverity: true, policy });
    const context = await discover(api, policy);
    assert.equal(context.fields.Size.id, 'field-Size');
    const item = await readItem(api, 'item', context);
    assert.equal(item.fields.Size, 'L');
    assert.equal(item.fields.Status, 'Inbox');
    assert.deepEqual(item.labels, ['severity: none', 'severity: high']);
    assert.equal(item.content.labels, undefined);
    assert.equal(eligible(item, policy), false);
    assert.deepEqual(state.queries, [
      'definitions-0',
      'definitions-1',
      'read-item',
      'values-item',
      'labels-issue',
    ]);
  }
});

test('discovery reads a user project through user and an organization project through organization', async () => {
  for (const [
    policy,
    root,
    other,
  ] of /** @type {[Record<string, any>, string, string][]} */ ([
    [userPolicy, 'user', 'organization'],
    [orgPolicy, 'organization', 'user'],
  ])) {
    /** @type {{ query: string, variables: Record<string, any> }[]} */
    const calls = [];
    /** @type {import('../src/core.mjs').Api} */
    const api = async (query, variables) => {
      calls.push({ query, variables });
      return {
        [root]: {
          projectV2: {
            id: `project-${root}`,
            fields: {
              nodes: [
                {
                  id: 'field-Status',
                  name: 'Status',
                  options: [{ id: 'option-Done', name: 'Done' }],
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    };
    const context = await discover(api, policy, { Status: ['Done'] });
    assert.equal(context.projectId, `project-${root}`);
    assert.match(calls[0].query, new RegExp(`\\b${root}\\(login: \\$owner\\)`));
    assert.doesNotMatch(calls[0].query, new RegExp(`\\b${other}\\(`));
    assert.deepEqual(calls[0].variables, {
      owner: policy.binding.project.owner,
      number: policy.binding.project.number,
      cursor: null,
    });
  }
});

test('an unavailable project names the configured project', async () => {
  for (const policy of POLICIES) {
    const name = policy.binding.project.name;
    await assert.rejects(
      discover(async () => ({}), policy),
      { message: `${name} project is unavailable` },
    );
    await assert.rejects(
      listItems(async () => ({ node: null }), policy, 'project', 'is:issue'),
      { message: `${name} project is unavailable` },
    );
  }
});

test('single-issue reads ask for the configured repository', async () => {
  for (const policy of POLICIES) {
    /** @type {Record<string, any>[]} */
    const seen = [];
    assert.deepEqual(
      await issueItems(
        async (_query, variables) => {
          seen.push(variables);
          return { repository: null };
        },
        policy,
        5,
      ),
      [],
    );
    const [owner, name] = policy.repository.split('/');
    assert.deepEqual(seen, [{ owner, name, number: 5, cursor: null }]);
  }
});

test('deleted project items and moved project membership cannot mutate', async () => {
  for (const node of [
    null,
    { id: 'item', type: 'ISSUE', project: { id: 'other-project' } },
  ]) {
    assert.equal(
      await readItem(async () => ({ node }), 'item', {
        projectId: 'project',
        fields: {},
      }),
      null,
    );
  }
});

test('items that are not issues keep their content and carry no labels', async () => {
  const context = { projectId: 'project', fields: {} };
  const item = await completeItem(
    async () => assert.fail('a complete item needs no request'),
    {
      id: 'pr',
      type: 'PULL_REQUEST',
      project: { id: 'project' },
      fieldValues: { nodes: [], pageInfo: { hasNextPage: false } },
      content: { __typename: 'PullRequest' },
    },
    context,
  );
  assert.deepEqual(item.labels, []);
  assert.deepEqual(item.content, { __typename: 'PullRequest' });
});

test('discovery fails closed for missing or ambiguous field options', async () => {
  const { api, definitions } = mockApi();
  definitions[0].options = definitions[0].options.filter(
    (option) => option.name !== 'Ready',
  );
  await assert.rejects(discover(api, userPolicy), /Status option Ready/);
  definitions[1].name = 'Status';
  await assert.rejects(discover(api, userPolicy), /Expected one Status/);
});

test('a status write fails closed for a missing Status option', async () => {
  const { api } = mockApi();
  const context = await discover(api, userPolicy);
  await assert.rejects(
    updateProjectStatus(api, context, 'item', 'Done'),
    /Missing or ambiguous Status option Done/,
  );
});

test('the board client reads a missing issue as null and fails on every other error', () => {
  const query = 'query { repository { issue(number: 5) { id } } }';
  for (const [data, path] of [
    [{ repository: { issue: null } }, ['repository', 'issue']],
    [{ node: null }, ['node']],
    [{ node: { content: null } }, ['node', 'content']],
  ])
    assert.deepEqual(boardGraphql(query, {}, notFound(data, path)), data);
  for (const [data, path, extra, kind] of [
    [{ repository: null }, ['repository'], [], 'not-found'],
    [{ user: { projectV2: null } }, ['user', 'projectV2'], [], 'not-found'],
    [
      { organization: { projectV2: null } },
      ['organization', 'projectV2'],
      [],
      'not-found',
    ],
    [
      { repository: { issue: { id: 'I' } } },
      ['repository', 'issue'],
      [],
      'not-found',
    ],
    [{ repository: { issue: null } }, undefined, [], 'not-found'],
    [
      { repository: { issue: null } },
      ['repository', 'issue'],
      [{ type: 'FORBIDDEN', message: 'Resource not accessible' }],
      'access',
    ],
  ])
    assert.throws(
      () =>
        boardGraphql(
          query,
          {},
          notFound(data, path, /** @type {unknown[]} */ (extra)),
        ),
      {
        name: 'GitHubError',
        kind,
      },
    );
  assert.throws(
    () =>
      boardGraphql(
        query,
        {},
        ghFails(
          httpResponse(200, exhausted, {
            data: { repository: { issue: null } },
            errors: [{ type: 'RATE_LIMITED', message: 'API rate limit' }],
          }),
        ),
      ),
    { kind: 'rate-limit' },
  );
});

test('a write to a deleted target raises MissingIssueError; a query does not', async () => {
  const mutation =
    'mutation($id: ID!) { closeIssue(input: { issueId: $id }) { issue { id } } }';
  assert.throws(
    () =>
      boardGraphql(
        mutation,
        {},
        notFound({ closeIssue: null }, ['closeIssue']),
      ),
    {
      name: 'MissingIssueError',
      message: /deleted or transferred during the run/,
    },
  );
  // A query with the same error shape is not a write and still fails.
  assert.throws(
    () =>
      boardGraphql(
        'query { viewer { login } }',
        {},
        notFound({ viewer: null }, ['viewer']),
      ),
    { name: 'GitHubError', kind: 'not-found' },
  );
  /** @type {string[]} */
  const warnings = [];
  const status = await runBoard({
    sweep: true,
    budget: () => null,
    warn: (message) => warnings.push(message),
    task: () =>
      boardGraphql(
        mutation,
        {},
        notFound({ closeIssue: null }, ['closeIssue']),
      ),
  });
  assert.equal(status, 0);
  assert.match(warnings.join('\n'), /deleted or transferred during the run/);
});
