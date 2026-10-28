import assert from 'node:assert/strict';
import test from 'node:test';
import { project, repository } from '@agenticool/policy';
import { addToProject, sweep } from '../src/index.mjs';
import { POLICIES, projectAnswer, userPolicy } from './helpers.mjs';

/**
 * @typedef {Record<string, any>} Policy
 * @typedef {(query: string, variables: Record<string, any>) => Promise<any>} MockApi
 */

/** @param {any[]} nodes */
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false } });

// The project as the policy's owner field returns it.
/**
 * @param {Policy} policy
 * @param {unknown} value
 */
const owned = (policy, value) => ({ [project(policy).ownerType]: value });

// Checks that a project lookup names the policy's owner type, owner, and number.
/**
 * @param {string} query
 * @param {Record<string, any>} variables
 * @param {Policy} policy
 * @param {string} owner
 * @param {string} number
 */
function assertProject(query, variables, policy, owner, number) {
  const board = project(policy);
  assert.ok(
    query.includes(
      `${board.ownerType}(login: $${owner}) { projectV2(number: $${number})`,
    ),
    query,
  );
  assert.equal(variables[owner], board.owner);
  assert.equal(variables[number], board.number);
}

// Answers the Status field discovery, project item reads, and Status writes.
// `statuses` maps project item node IDs to their Status.
/**
 * @param {Map<string, string>} statuses
 * @param {Policy} policy
 * @param {string} [projectId]
 */
function board(statuses, policy, projectId = 'P_1') {
  /** @type {Record<string, any>[]} */
  const statusWrites = [];
  /**
   * @param {string} query
   * @param {Record<string, any>} variables
   */
  const answer = (query, variables) => {
    if (query.includes('fields(first: 100')) {
      const data = projectAnswer(
        query,
        variables,
        policy,
        page([
          {
            id: 'F_status',
            name: 'Status',
            options: ['Inbox', 'Ready', 'In progress'].map((name) => ({
              id: `O_${name}`,
              name,
            })),
          },
        ]),
      );
      Object.values(data)[0].projectV2.id = projectId;
      return data;
    }
    if (query.includes('updateProjectV2ItemFieldValue')) {
      statusWrites.push(variables);
      statuses.set(variables.item, variables.option.slice('O_'.length));
      return {};
    }
    if (query.includes('... on ProjectV2Item {')) {
      const status = statuses.get(variables.id);
      return {
        node: {
          id: variables.id,
          type: 'ISSUE',
          project: { id: projectId },
          fieldValues: page(
            status
              ? [{ field: { id: 'F_status' }, optionId: `O_${status}` }]
              : [],
          ),
          content: {
            __typename: 'Issue',
            id: 'I',
            number: 1,
            state: 'OPEN',
            repository: { nameWithOwner: repository(policy) },
            labels: page([]),
          },
        },
      };
    }
    return undefined;
  };
  return { answer, statusWrites };
}

// A mocked GitHub that keeps one project item per content node, as
// addProjectV2ItemById does.
/**
 * @param {{
 *   issues?: Record<number, string>,
 *   project?: { id: string, closed: boolean } | null,
 *   items?: Map<string, string>,
 *   statuses?: Map<string, string>,
 *   policy?: Policy,
 * }} [options]
 */
function github({
  issues = { 7: 'I_7' },
  project = { id: 'P_1', closed: false },
  items = new Map(),
  statuses = new Map(),
  policy = userPolicy,
} = {}) {
  /** @type {{ query: string, variables: Record<string, any> }[]} */
  const reads = [];
  /** @type {Record<string, any>[]} */
  const writes = [];
  const { answer, statusWrites } = board(statuses, policy, project?.id);
  const [owner, name] = repository(policy).split('/');
  /** @type {MockApi} */
  const api = async (query, variables) => {
    const answered = answer(query, variables);
    if (answered) return answered;
    if (query.startsWith('mutation')) {
      assert.match(query, /addProjectV2ItemById/);
      writes.push(variables);
      assert.equal(variables.project, project?.id);
      assert.match(query, /item \{ id fullDatabaseId \}/);
      if (!items.has(variables.content))
        items.set(variables.content, String(100 + items.size + 1));
      const item = items.get(variables.content);
      return {
        addProjectV2ItemById: {
          item: { id: `PVTI_${item}`, fullDatabaseId: item },
        },
      };
    }
    reads.push({ query, variables });
    assert.equal(variables.owner, owner);
    assert.equal(variables.name, name);
    assertProject(query, variables, policy, 'projectOwner', 'projectNumber');
    assert.match(query, /issue\(number: \$number\)/);
    assert.doesNotMatch(query, /pullRequest/);
    const id = issues[variables.number];
    const item = id && items.get(id);
    return {
      repository: {
        issue: id
          ? {
              id,
              projectItems: {
                nodes: item ? [{ id: `PVTI_${item}`, project }] : [],
              },
            }
          : null,
      },
      ...owned(policy, { projectV2: project }),
    };
  };
  return {
    api,
    policy,
    reads,
    writes,
    items,
    statuses,
    statusWrites,
    log: (/** @type {string} */ line) => void line,
  };
}

test('adds a new issue to the project and prints its REST item ID', async () => {
  for (const policy of POLICIES) {
    const f = github({ policy });
    /** @type {string[]} */
    const logs = [];
    assert.equal(
      await addToProject({
        ...f,
        kind: 'issue',
        number: 7,
        dryRun: false,
        log: (line) => logs.push(line),
      }),
      '101',
    );
    assert.deepEqual(f.writes, [{ project: 'P_1', content: 'I_7' }]);
    assert.deepEqual(f.statusWrites, [
      {
        project: 'P_1',
        item: 'PVTI_101',
        field: 'F_status',
        option: 'O_Inbox',
      },
    ]);
    const name = project(policy).name;
    assert.deepEqual(logs, [
      `Issue #7: in ${name} as item 101.`,
      'Issue #7: set its Status to Inbox.',
    ]);
  }
});

test('an existing Status never changes', async () => {
  const f = github({
    items: new Map([['I_7', '276979720']]),
    statuses: new Map([['PVTI_276979720', 'In progress']]),
  });
  /** @type {string[]} */
  const logs = [];
  assert.equal(
    await addToProject({
      ...f,
      kind: 'issue',
      number: 7,
      dryRun: false,
      log: (line) => logs.push(line),
    }),
    '276979720',
  );
  assert.deepEqual(f.statusWrites, []);
  assert.equal(f.statuses.get('PVTI_276979720'), 'In progress');
  assert.deepEqual(logs, [
    'Issue #7: in Widgets delivery as item 276979720.',
    'Issue #7: kept its Status In progress.',
  ]);
});

test('a missing Status field or Inbox option fails before adding', async () => {
  for (const options of [[], ['Inbox', 'Inbox']]) {
    const f = github();
    /** @type {MockApi} */
    const api = async (query, variables) => {
      const data = await f.api(query, variables);
      if (query.includes('fields(first: 100'))
        data.user.projectV2.fields.nodes[0].options = options.map((name) => ({
          id: `O_${name}`,
          name,
        }));
      return data;
    };
    await assert.rejects(
      addToProject({ ...f, api, kind: 'issue', number: 7, dryRun: false }),
      /Status option Inbox/,
    );
    assert.deepEqual(f.writes, []);
  }
});

test('a project that changed between the issue read and discovery fails before adding', async () => {
  const f = github();
  /** @type {MockApi} */
  const api = async (query, variables) => {
    const data = await f.api(query, variables);
    if (query.includes('fields(first: 100')) data.user.projectV2.id = 'P_2';
    return data;
  };
  await assert.rejects(
    addToProject({ ...f, api, kind: 'issue', number: 7, dryRun: false }),
    /Widgets delivery project changed during the run/,
  );
  assert.deepEqual(f.writes, []);
});

test('pull request input fails before any API call, including dry runs', async () => {
  for (const dryRun of [true, false]) {
    const f = github();
    await assert.rejects(
      addToProject({ ...f, kind: 'pull_request', number: 9, dryRun }),
      /CONTENT_TYPE must be issue/,
    );
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.writes, []);
  }
});

test('an item already in the project is returned without a duplicate', async () => {
  const f = github({ items: new Map([['I_7', '276979720']]) });
  for (let run = 0; run < 2; run++)
    assert.equal(
      await addToProject({ ...f, kind: 'issue', number: 7, dryRun: false }),
      '276979720',
    );
  assert.equal(f.items.size, 1);
});

test('dry runs read but never write, and say what they would do', async () => {
  for (const [
    items,
    statuses,
    line,
  ] of /** @type {[Map<string, string>, Map<string, string>, string][]} */ ([
    [
      new Map(),
      new Map(),
      'Issue #7: would add to Widgets delivery and set its Status to Inbox (dry run).',
    ],
    [
      new Map([['I_7', '5']]),
      new Map(),
      'Issue #7: would keep in Widgets delivery and set its Status to Inbox (dry run).',
    ],
    [
      new Map([['I_7', '5']]),
      new Map([['PVTI_5', 'Ready']]),
      'Issue #7: would keep its Status Ready (dry run).',
    ],
  ])) {
    const f = github({ items, statuses });
    /** @type {string[]} */
    const logs = [];
    assert.equal(
      await addToProject({
        ...f,
        kind: 'issue',
        number: 7,
        log: (text) => logs.push(text),
      }),
      null,
    );
    assert.equal(f.reads.length, 1);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.statusWrites, []);
    assert.deepEqual(logs, [line]);
  }
});

test('invalid input, missing content, and an unavailable project fail before writing', async () => {
  const cases = /** @type {[Record<string, any>, any][]} */ ([
    [{ kind: 'discussion', number: 7 }, /CONTENT_TYPE/],
    [{ kind: 'constructor', number: 7 }, /CONTENT_TYPE/],
    [{ kind: undefined, number: 7 }, /CONTENT_TYPE/],
    [{ kind: 'issue', number: 0 }, /positive/],
    [{ kind: 'issue', number: Number.NaN }, /positive/],
    [
      { kind: 'issue', number: 8 },
      { name: 'MissingIssueError', message: /Issue #8 no longer exists/ },
    ],
  ]);
  for (const [options, error] of cases) {
    const f = github();
    await assert.rejects(
      addToProject({
        ...f,
        kind: options.kind,
        number: options.number,
        dryRun: false,
      }),
      error,
    );
    assert.deepEqual(f.writes, []);
  }
  for (const policy of POLICIES)
    for (const unavailable of [null, { id: 'P_1', closed: true }]) {
      const f = github({ project: unavailable, policy });
      await assert.rejects(
        addToProject({ ...f, kind: 'issue', number: 7, dryRun: false }),
        new RegExp(`${project(policy).name} project is unavailable`),
      );
      assert.deepEqual(f.writes, []);
    }
});

test('a mutation without a REST item ID fails', async () => {
  for (const response of [
    { addProjectV2ItemById: null },
    { addProjectV2ItemById: { item: { id: 'PVTI_1' } } },
    { addProjectV2ItemById: { item: { id: 'PVTI_1', fullDatabaseId: 'x1' } } },
  ]) {
    const f = github();
    /** @type {MockApi} */
    const api = async (query, variables) =>
      query.startsWith('mutation') ? response : f.api(query, variables);
    await assert.rejects(
      addToProject({ ...f, api, kind: 'issue', number: 7, dryRun: false }),
      /no project item/,
      JSON.stringify(response),
    );
  }
});

test('an added item that cannot be read back fails', async () => {
  const f = github();
  /** @type {MockApi} */
  const api = async (query, variables) =>
    query.includes('... on ProjectV2Item {')
      ? { node: null }
      : f.api(query, variables);
  await assert.rejects(
    addToProject({ ...f, api, kind: 'issue', number: 7, dryRun: false }),
    /Could not read project item 101/,
  );
});

// A mocked GitHub for sweeps: `open` lists open issues as [number, projects],
// served `pageSize` per page, and `failing` holds issue numbers whose add
// fails.
/**
 * @param {{
 *   open?: [number, string[]][],
 *   project?: { id: string, closed: boolean } | null,
 *   pageSize?: number,
 *   failing?: Set<number>,
 *   deleted?: Set<number>,
 *   policy?: Policy,
 * }} [options]
 */
function mockRepository({
  open = [],
  project = { id: 'P_1', closed: false },
  pageSize = 2,
  failing = new Set(),
  deleted = new Set(),
  policy = userPolicy,
} = {}) {
  /** @type {any[][]} */
  const calls = [];
  /** @type {number[]} */
  const writes = [];
  /** @type {string[]} */
  const logs = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const { answer } = board(new Map(), policy, project?.id);
  const [owner, name] = repository(policy).split('/');
  /** @type {MockApi} */
  const api = async (query, variables) => {
    const answered = answer(query, variables);
    if (answered) return answered;
    if (query.startsWith('mutation')) {
      const number = Number(variables.content.slice(2));
      if (failing.has(number))
        throw new Error(`Issue #${number} could not be added`);
      writes.push(number);
      return {
        addProjectV2ItemById: {
          item: { id: `PVTI_${number}`, fullDatabaseId: String(number) },
        },
      };
    }
    if (query.includes('issue(number: $number)')) {
      calls.push(['read', variables.number]);
      return {
        repository: {
          issue: deleted.has(variables.number)
            ? null
            : { id: `I_${variables.number}`, projectItems: { nodes: [] } },
        },
        ...owned(policy, { projectV2: project }),
      };
    }
    if (query.includes('issues(first: 100')) {
      assert.match(query, /states: \[OPEN\]/);
      assert.doesNotMatch(query, /pullRequest/);
      assert.equal(variables.owner, owner);
      assert.equal(variables.name, name);
      const start = variables.cursor ? Number(variables.cursor) : 0;
      calls.push(['list', start]);
      const end = start + pageSize;
      return {
        repository: {
          issues: {
            nodes: open.slice(start, end).map(([number, projects]) => ({
              number,
              projectItems: {
                nodes: projects.map((id) => ({ project: { id } })),
              },
            })),
            pageInfo: {
              hasNextPage: end < open.length,
              endCursor: String(end),
            },
          },
        },
      };
    }
    assertProject(query, variables, policy, 'owner', 'number');
    calls.push(['project']);
    return owned(policy, { projectV2: project });
  };
  return {
    api,
    policy,
    calls,
    writes,
    logs,
    errors,
    warnings,
    log: (/** @type {string} */ line) => logs.push(line),
    logError: (/** @type {string} */ line) => errors.push(line),
    warn: (/** @type {string} */ line) => warnings.push(line),
  };
}

test('a sweep adds only the open issues missing from the project', async () => {
  for (const policy of POLICIES) {
    const f = mockRepository({
      open: [
        [4, ['P_1']],
        [9, []],
        [5, ['P_other']],
        [6, ['P_other', 'P_1']],
        [3, []],
      ],
      policy,
    });
    assert.deepEqual(await sweep({ ...f, dryRun: false }), {
      missing: [3, 5, 9],
      failed: [],
    });
    assert.deepEqual(f.writes, [3, 5, 9]);
    assert.deepEqual(
      f.calls.filter(([kind]) => kind === 'list'),
      [
        ['list', 0],
        ['list', 2],
        ['list', 4],
      ],
    );
    assert.deepEqual(f.errors, []);
  }
});

test('a sweep with nothing missing makes no write and no per-issue read', async () => {
  const f = mockRepository({
    open: [
      [1, ['P_1']],
      [2, ['P_1']],
      [3, ['P_1']],
    ],
  });
  assert.deepEqual(await sweep({ ...f, dryRun: false }), {
    missing: [],
    failed: [],
  });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(
    f.calls.filter(([kind]) => kind === 'read'),
    [],
  );
  assert.deepEqual(f.logs, ['All 3 open issues are in Widgets delivery.']);
});

test('a dry-run sweep reports missing issues without writing', async () => {
  for (const options of [{}, { dryRun: true }]) {
    const f = mockRepository({
      open: [
        [8, []],
        [2, ['P_1']],
      ],
    });
    assert.deepEqual(await sweep({ ...f, ...options }), {
      missing: [8],
      failed: [],
    });
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.logs, [
      'Open issues missing from Widgets delivery: #8.',
      'Issue #8: would add to Widgets delivery and set its Status to Inbox (dry run).',
    ]);
  }
});

test('a failing issue is logged, the rest are added, and the sweep fails', async () => {
  const f = mockRepository({
    open: [
      [1, []],
      [2, []],
      [3, []],
    ],
    failing: new Set([2]),
  });
  await assert.rejects(
    sweep({ ...f, dryRun: false }),
    /Could not add 1 of 3 missing issues: #2$/,
  );
  assert.deepEqual(f.writes, [1, 3]);
  assert.deepEqual(f.errors, ['Issue #2: Issue #2 could not be added']);
});

test('a sweep warns about an issue deleted or transferred before its add and still succeeds', async () => {
  const f = mockRepository({
    open: [
      [1, []],
      [2, []],
      [3, []],
    ],
    deleted: new Set([2]),
  });
  assert.deepEqual(await sweep({ ...f, dryRun: false }), {
    missing: [1, 2, 3],
    failed: [],
  });
  assert.deepEqual(f.writes, [1, 3]);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.warnings, [
    'Issue #2 no longer exists in the repository; skipping',
  ]);
});

test('a sweep against an unavailable project fails before listing issues', async () => {
  for (const policy of POLICIES)
    for (const unavailable of [null, { id: 'P_1', closed: true }]) {
      const f = mockRepository({
        open: [[1, []]],
        project: unavailable,
        policy,
      });
      await assert.rejects(
        sweep({ ...f, dryRun: false }),
        /project is unavailable/,
      );
      assert.deepEqual(f.calls, [['project']]);
      assert.deepEqual(f.writes, []);
    }
});
