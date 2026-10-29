import assert from 'node:assert/strict';
import test from 'node:test';
import { repository } from '@agenticool/core';
import {
  MARKER,
  MissingIssueError,
  reconcileContainers,
} from '../src/index.mjs';
import {
  isProjectQuery,
  orgPolicy,
  POLICIES,
  projectAnswer,
  userPolicy,
} from './helpers.mjs';

/**
 * @typedef {Record<string, any>} Definition
 * @typedef {(query: string, variables: Record<string, any>) => Promise<any>} MockApi
 */

// A mocked repository and delivery project. Each issue is
// { number, state, parent, repo, marked, status, archived }; sub-issue
// summaries come from the parent links, and mutations change the model. An
// archived project item is listed only to a read that includes archived items.
/**
 * @param {Definition[]} definitions
 * @param {{ pageSize?: number, markerExists?: boolean, policy?: Record<string, any> }} [options]
 */
function github(
  definitions,
  { pageSize = 100, markerExists = true, policy = userPolicy } = {},
) {
  const home = repository(policy);
  /** @type {Map<string, Definition>} */
  const issues = new Map(
    definitions.map((issue) => [
      `I_${issue.number}`,
      {
        state: 'OPEN',
        repo: home,
        marked: false,
        status: 'Ready',
        ...issue,
      },
    ]),
  );
  /** @type {{ query: string, variables: Record<string, any> }[]} */
  const calls = [];
  /** @type {{ query: string, variables: Record<string, any> }[]} */
  const writes = [];
  /** @param {number} number */
  const id = (number) => `I_${number}`;
  /** @param {number} number */
  const get = (number) => /** @type {Definition} */ (issues.get(id(number)));
  /**
   * @param {any[]} nodes
   * @param {boolean} [next]
   * @param {string | null} [end]
   */
  const connection = (nodes, next = false, end = null) => ({
    nodes,
    pageInfo: { hasNextPage: next, endCursor: end },
  });
  /** @param {Definition} issue */
  const children = (issue) =>
    [...issues.values()].filter((child) => child.parent === issue.number);
  /** @param {Definition} issue */
  const record = (issue) => ({
    id: id(issue.number),
    number: issue.number,
    state: issue.state,
    repository: { nameWithOwner: issue.repo },
    parent: issue.parent
      ? {
          id: id(issue.parent),
          repository: { nameWithOwner: get(issue.parent).repo },
        }
      : null,
    subIssuesSummary: {
      total: children(issue).length,
      completed: children(issue).filter((child) => child.state === 'CLOSED')
        .length,
    },
  });
  /**
   * @param {Definition} issue
   * @param {string} query
   */
  const items = (issue, query) =>
    connection([
      { id: `other-${issue.number}`, project: { id: 'other' } },
      ...(issue.archived && query.includes('includeArchived: false')
        ? []
        : [
            {
              id: `item-${issue.number}`,
              project: { id: 'project' },
              fieldValueByName: { name: issue.status },
            },
          ]),
    ]);
  /** @param {Record<string, any>} variables */
  const ownRepository = (variables) =>
    assert.equal(`${variables.owner}/${variables.name}`, home);
  const statusOptions = ['Inbox', 'Ready', 'In progress', 'In review', 'Done'];
  /** @type {MockApi} */
  const api = async (query, variables) => {
    if (query.startsWith('mutation')) {
      writes.push({ query, variables });
      const issue = /** @type {Definition} */ (issues.get(variables.id));
      if (query.includes('addLabelsToLabelable')) issue.marked = true;
      else if (query.includes('removeLabelsFromLabelable'))
        issue.marked = false;
      else if (query.includes('closeIssue')) issue.state = 'CLOSED';
      else if (query.includes('reopenIssue')) issue.state = 'OPEN';
      else {
        assert.match(query, /updateProjectV2ItemFieldValue/);
        assert.equal(variables.project, 'project');
        assert.equal(variables.field, 'status');
        const number = Number(variables.item.replace('item-', ''));
        get(number).status = variables.option;
      }
      return {};
    }
    calls.push({ query, variables });
    if (isProjectQuery(query))
      return projectAnswer(
        query,
        variables,
        policy,
        connection([
          {
            id: 'status',
            name: 'Status',
            options: statusOptions.map((name) => ({ id: name, name })),
          },
          ...['Priority', 'Size'].map((name) => ({
            id: name,
            name,
            options: ['P0', 'P1', 'P2', 'P3', 'XS', 'S', 'M', 'L'].map(
              (option) => ({ id: option, name: option }),
            ),
          })),
        ]),
      );
    if (query.includes(`label(name: "${MARKER}")`)) {
      ownRepository(variables);
      if (!markerExists) return { repository: { label: null } };
      if (!query.includes('issues('))
        return { repository: { label: { id: 'L_marker' } } };
      return {
        repository: {
          label: {
            id: 'L_marker',
            issues: connection(
              [...issues.values()]
                .filter((issue) => issue.marked)
                .map((issue) => ({
                  id: id(issue.number),
                  projectItems: items(issue, query),
                })),
            ),
          },
        },
      };
    }
    if (query.includes('issues(first: 100')) {
      ownRepository(variables);
      const listed = [...issues.values()].filter(
        (issue) => issue.repo === home,
      );
      const start = Number(variables.cursor ?? 0);
      const end = start + pageSize;
      return {
        repository: {
          issues: connection(
            listed.slice(start, end).map(record),
            end < listed.length,
            String(end),
          ),
        },
      };
    }
    if (query.includes('issue(number: $number)')) {
      ownRepository(variables);
      const issue = issues.get(id(variables.number));
      return { repository: { issue: issue ? record(issue) : null } };
    }
    if (query.includes('subIssues(first: 100')) {
      const parent = /** @type {Definition} */ (issues.get(variables.id));
      return {
        node: { subIssues: connection(children(parent).map(record)) },
      };
    }
    const issue = issues.get(variables.id);
    if (query.includes('projectItems(first: 100, includeArchived: false)'))
      return {
        node: issue && {
          ...record(issue),
          labels: connection(
            issue.marked ? [{ name: 'epic' }, { name: MARKER }] : [],
          ),
          projectItems: items(issue, query),
        },
      };
    assert.match(query, /node\(id: \$id\) \{ \.\.\. on Issue/);
    return { node: issue ? record(issue) : null };
  };
  const kinds = () =>
    calls.map(({ query }) =>
      isProjectQuery(query)
        ? 'discover'
        : query.includes('label(name:')
          ? 'marker'
          : query.includes('issues(first: 100')
            ? 'list'
            : query.includes('issue(number: $number)')
              ? 'issue'
              : query.includes('subIssues(')
                ? 'children'
                : query.includes(
                      'projectItems(first: 100, includeArchived: false)',
                    )
                  ? 'snapshot'
                  : 'ancestor',
    );
  const mutations = () =>
    writes.map(({ query, variables }) => {
      const name = /** @type {RegExpExecArray} */ (
        /\{\s*(\w+)\(input/.exec(query)
      )[1];
      return name === 'updateProjectV2ItemFieldValue'
        ? `${name} ${variables.item} ${variables.option}`
        : `${name} ${variables.id}`;
    });
  return { api, policy, issues, calls, kinds, mutations };
}

/** @param {string} line */
const ignore = (line) => void line;
const quiet = { log: ignore };

test('a sweep closes finished containers bottom-up in one run and marks them', async () => {
  for (const policy of POLICIES) {
    const mock = github(
      [
        { number: 1 },
        { number: 2, parent: 1 },
        { number: 3, parent: 2, state: 'CLOSED' },
        { number: 4, parent: 2, state: 'CLOSED' },
        { number: 5, parent: 1, state: 'CLOSED' },
      ],
      { policy },
    );
    /** @type {string[]} */
    const logs = [];
    assert.deepEqual(
      await reconcileContainers({
        api: mock.api,
        policy,
        dryRun: false,
        log: (line) => logs.push(line),
      }),
      { updated: 2 },
    );
    assert.deepEqual(mock.mutations(), [
      'addLabelsToLabelable I_2',
      'closeIssue I_2',
      'updateProjectV2ItemFieldValue item-2 Done',
      'addLabelsToLabelable I_1',
      'closeIssue I_1',
      'updateProjectV2ItemFieldValue item-1 Done',
    ]);
    assert.deepEqual(logs, [
      'Will close container #2',
      'Will close container #1',
      'Container reconciliation: 2 state changes; DRY_RUN=false',
    ]);
    for (const number of [1, 2]) {
      assert.equal(mock.issues.get(`I_${number}`)?.state, 'CLOSED');
      assert.equal(mock.issues.get(`I_${number}`)?.marked, true);
    }
    // #2 is read before its first write and again after marking; the parent
    // decides from a fresh read once its child closed this run.
    assert.deepEqual(mock.kinds(), [
      'list',
      'marker',
      'snapshot',
      'snapshot',
      'discover',
      'snapshot',
      'snapshot',
    ]);
  }
});

test('a sweep with nothing to change makes no per-container reads', async () => {
  /** @type {Definition[]} */
  const definitions = [];
  for (let number = 1; number <= 317; number++)
    definitions.push(
      number % 10 === 1
        ? { number }
        : { number, parent: number - (number % 10) + 1 },
    );
  // Containers #1, #11, ... stay open with open children; one finished
  // container is already closed and marked with status Done.
  definitions[0] = { number: 1, state: 'CLOSED', marked: true, status: 'Done' };
  for (let number = 2; number <= 10; number++)
    definitions[number - 1] = { number, parent: 1, state: 'CLOSED' };
  const mock = github(definitions);
  assert.deepEqual(
    await reconcileContainers({
      api: mock.api,
      policy: mock.policy,
      dryRun: false,
      ...quiet,
    }),
    { updated: 0 },
  );
  assert.deepEqual(mock.mutations(), []);
  // Discovery finds the project item whose status the closed container keeps.
  assert.deepEqual(mock.kinds(), [
    'list',
    'list',
    'list',
    'list',
    'marker',
    'discover',
  ]);
});

test('reopening a marked container sets Ready and removes the marker', async () => {
  const mock = github([
    { number: 1, state: 'CLOSED', marked: true, status: 'Done' },
    { number: 2, parent: 1, state: 'CLOSED' },
    { number: 3, parent: 1 },
  ]);
  assert.deepEqual(
    await reconcileContainers({
      api: mock.api,
      policy: mock.policy,
      dryRun: false,
      ...quiet,
    }),
    { updated: 1 },
  );
  assert.deepEqual(mock.mutations(), [
    'reopenIssue I_1',
    'updateProjectV2ItemFieldValue item-1 Ready',
    'removeLabelsFromLabelable I_1',
  ]);
  assert.equal(mock.issues.get('I_1')?.state, 'OPEN');
  assert.equal(mock.issues.get('I_1')?.marked, false);
});

test('manually closed containers and empty issues are left alone', async () => {
  const mock = github([
    { number: 1, state: 'CLOSED' },
    { number: 2, parent: 1 },
    { number: 3 },
  ]);
  assert.deepEqual(
    await reconcileContainers({
      api: mock.api,
      policy: mock.policy,
      dryRun: false,
      ...quiet,
    }),
    { updated: 0 },
  );
  assert.deepEqual(mock.mutations(), []);
  assert.equal(mock.issues.get('I_3')?.state, 'OPEN');
});

test('dry runs log every change and never write', async () => {
  const mock = github([
    { number: 1 },
    { number: 2, parent: 1, state: 'CLOSED' },
    { number: 3, state: 'CLOSED', marked: true, status: 'In review' },
    { number: 4, parent: 3 },
  ]);
  /** @type {string[]} */
  const logs = [];
  assert.deepEqual(
    await reconcileContainers({
      api: mock.api,
      policy: mock.policy,
      log: (line) => logs.push(line),
    }),
    { updated: 0 },
  );
  assert.deepEqual(mock.mutations(), []);
  assert.deepEqual(logs, [
    'DRY_RUN would close container #1',
    'DRY_RUN would reopen container #3',
    'Container reconciliation: 0 state changes; DRY_RUN=true',
  ]);
});

test('a marked container whose status update was lost is repaired once', async () => {
  const mock = github([
    { number: 1, state: 'CLOSED', marked: true, status: 'In review' },
    { number: 2, parent: 1, state: 'CLOSED' },
    // Open and marked: a person reopened it after the automation closed it.
    { number: 3, marked: true, status: 'In progress' },
    { number: 4, parent: 3 },
  ]);
  const options = {
    api: mock.api,
    policy: mock.policy,
    dryRun: false,
    ...quiet,
  };
  assert.deepEqual(await reconcileContainers(options), { updated: 0 });
  assert.deepEqual(mock.mutations(), [
    'updateProjectV2ItemFieldValue item-1 Done',
    'updateProjectV2ItemFieldValue item-3 Ready',
    'removeLabelsFromLabelable I_3',
  ]);
  const again = mock.calls.length;
  await reconcileContainers(options);
  assert.equal(mock.mutations().length, 3);
  assert.deepEqual(mock.kinds().slice(again), ['list', 'marker', 'discover']);
});

test('a marked container that is complete again keeps its marker', async () => {
  // Another run marked #1 when it finished and is about to close it. #3
  // reopens, this run reads #1 as open, marked, and unfinished, and #3 closes
  // again before this run would remove the marker.
  for (const policy of POLICIES) {
    const mock = github(
      [
        { number: 1, marked: true },
        { number: 2, parent: 1, state: 'CLOSED' },
        { number: 3, parent: 1 },
      ],
      { policy },
    );
    let reads = 0;
    /** @type {MockApi} */
    const api = async (query, variables) => {
      if (
        query.includes('projectItems(first: 100, includeArchived: false)') &&
        !query.includes('label(name:') &&
        variables.id === 'I_1' &&
        ++reads === 2
      )
        /** @type {Definition} */ (mock.issues.get('I_3')).state = 'CLOSED';
      return mock.api(query, variables);
    };
    assert.deepEqual(
      await reconcileContainers({
        api,
        policy,
        dryRun: false,
        issueNumber: 3,
        ...quiet,
      }),
      { updated: 0 },
    );
    assert.equal(reads, 2);
    assert.deepEqual(mock.mutations(), []);
    assert.equal(mock.issues.get('I_1')?.marked, true);
    assert.deepEqual(mock.kinds(), [
      'issue',
      'ancestor',
      'marker',
      'snapshot',
      'discover',
      'snapshot',
    ]);
  }
});

test('a marked container closed again before the final read keeps its marker', async () => {
  // #1 is open, marked, and unfinished, so this run would remove the marker,
  // but a person closes #1 before the read that decides it.
  const mock = github([
    { number: 1, marked: true },
    { number: 2, parent: 1, state: 'CLOSED' },
    { number: 3, parent: 1 },
  ]);
  let reads = 0;
  /** @type {MockApi} */
  const api = async (query, variables) => {
    if (
      query.includes('projectItems(first: 100, includeArchived: false)') &&
      !query.includes('label(name:') &&
      variables.id === 'I_1' &&
      ++reads === 2
    )
      /** @type {Definition} */ (mock.issues.get('I_1')).state = 'CLOSED';
    return mock.api(query, variables);
  };
  assert.deepEqual(
    await reconcileContainers({
      api,
      policy: mock.policy,
      dryRun: false,
      issueNumber: 3,
      ...quiet,
    }),
    { updated: 0 },
  );
  assert.equal(reads, 2);
  assert.deepEqual(mock.mutations(), []);
  assert.equal(mock.issues.get('I_1')?.marked, true);
});

test('an archived project item is neither read nor written', async () => {
  for (const issueNumber of [undefined, 2]) {
    const mock = github([
      { number: 1, archived: true },
      { number: 2, parent: 1, state: 'CLOSED' },
      { number: 3, state: 'CLOSED', marked: true, status: 'In review' },
      { number: 4, parent: 3, state: 'CLOSED' },
    ]);
    assert.deepEqual(
      await reconcileContainers({
        api: mock.api,
        policy: mock.policy,
        dryRun: false,
        issueNumber,
        ...quiet,
      }),
      { updated: 1 },
    );
    assert.equal(mock.issues.get('I_1')?.state, 'CLOSED');
    assert.deepEqual(
      mock.mutations().filter((line) => line.includes('item-1')),
      [],
    );
    assert.equal(mock.issues.get('I_1')?.status, 'Ready');
    for (const { query } of mock.calls)
      if (query.includes('projectItems('))
        assert.match(
          query,
          /projectItems\(first: 100, includeArchived: false\)/,
        );
  }
});

test('a closed child reconciles only its ancestors, never unrelated containers', async () => {
  for (const policy of POLICIES) {
    const mock = github(
      [
        { number: 1 },
        { number: 2, parent: 1 },
        { number: 3, parent: 2, state: 'CLOSED' },
        { number: 4, parent: 2, state: 'CLOSED' },
        // Finished, but outside #4's hierarchy.
        { number: 10 },
        { number: 11, parent: 10, state: 'CLOSED' },
      ],
      { policy },
    );
    assert.deepEqual(
      await reconcileContainers({
        api: mock.api,
        policy,
        dryRun: false,
        issueNumber: 4,
        ...quiet,
      }),
      { updated: 2 },
    );
    assert.equal(mock.issues.get('I_2')?.state, 'CLOSED');
    assert.equal(mock.issues.get('I_1')?.state, 'CLOSED');
    assert.equal(mock.issues.get('I_10')?.state, 'OPEN');
    assert.deepEqual(mock.kinds(), [
      'issue',
      'ancestor',
      'ancestor',
      'marker',
      'snapshot',
      'snapshot',
      'discover',
      'snapshot',
      'snapshot',
    ]);
  }
});

test('a container reconciles its subtree and ancestors', async () => {
  const mock = github([
    { number: 1 },
    { number: 2, parent: 1 },
    { number: 3, parent: 2 },
    { number: 4, parent: 3, state: 'CLOSED' },
    { number: 5, parent: 1 },
    { number: 6, parent: 1, repo: 'other/repo' },
    { number: 10 },
    { number: 11, parent: 10, state: 'CLOSED' },
  ]);
  /** @type {string[]} */
  const logs = [];
  await reconcileContainers({
    api: mock.api,
    policy: mock.policy,
    issueNumber: 2,
    log: (line) => logs.push(line),
  });
  assert.deepEqual(logs, [
    'DRY_RUN would close container #3',
    'Container reconciliation: 0 state changes; DRY_RUN=true',
  ]);
  // #2 and #3 are read for their children, #1 as #2's parent; the leaf #4 and
  // the unrelated #10 are never expanded.
  assert.deepEqual(
    mock.calls
      .filter(({ query }) => query.includes('subIssues('))
      .map(({ variables }) => variables.id)
      .sort(),
    ['I_2', 'I_3'],
  );
  assert.deepEqual(mock.kinds(), [
    'issue',
    'children',
    'children',
    'ancestor',
    'marker',
    'snapshot',
    'snapshot',
    'snapshot',
  ]);
});

test('a hierarchy cycle and a missing marker label fail', async () => {
  const cycle = github([
    { number: 1, parent: 2 },
    { number: 2, parent: 1 },
  ]);
  await assert.rejects(
    reconcileContainers({ api: cycle.api, policy: cycle.policy, ...quiet }),
    /Issue hierarchy cycle/,
  );
  await assert.rejects(
    reconcileContainers({
      api: cycle.api,
      policy: cycle.policy,
      issueNumber: 1,
      ...quiet,
    }),
    /Issue hierarchy cycle/,
  );
  for (const policy of POLICIES)
    for (const issueNumber of [undefined, 1]) {
      const missing = github([{ number: 1 }], { markerExists: false, policy });
      await assert.rejects(
        reconcileContainers({
          api: missing.api,
          policy,
          issueNumber,
          ...quiet,
        }),
        new RegExp(`Missing managed label ${MARKER}`),
      );
    }
  await assert.rejects(
    reconcileContainers({
      api: github([]).api,
      policy: userPolicy,
      issueNumber: 9,
      ...quiet,
    }),
    (/** @type {any} */ error) =>
      error instanceof MissingIssueError &&
      error.message === 'Issue #9 no longer exists in the repository; skipping',
  );
  // A missing repository is a configuration error, not a deleted issue.
  await assert.rejects(
    reconcileContainers({
      api: async () => ({ repository: null }),
      policy: orgPolicy,
      issueNumber: 9,
      ...quiet,
    }),
    /Requested issue is unavailable/,
  );
});

// Wraps a mocked repository so issues in `gone` read as deleted, as GitHub's
// board client returns them: a null node.
/**
 * @param {ReturnType<typeof github>} model
 * @param {Set<string>} gone
 * @returns {MockApi}
 */
function withDeleted(model, gone) {
  return async (query, variables) =>
    gone.has(variables.id) && /node\(id: \$id\)/.test(query)
      ? { node: null }
      : model.api(query, variables);
}

test('a container deleted or transferred during a run is skipped with a warning', async () => {
  // A single-issue run for #3 reads containers #2 and #1 fresh; #2 is gone
  // by then, and #1 still closes once #2's subtree is done.
  for (const remove of [
    (/** @type {any} */ model, /** @type {Set<string>} */ gone) =>
      gone.add('I_2'),
    (/** @type {any} */ model) => (model.issues.get('I_2').repo = 'other/repo'),
  ]) {
    const model = github([
      { number: 1 },
      { number: 2, parent: 1, state: 'CLOSED' },
      { number: 3, parent: 2, state: 'CLOSED' },
      { number: 4, parent: 1, state: 'CLOSED' },
    ]);
    /** @type {Set<string>} */
    const gone = new Set();
    /** @type {string[]} */
    const warnings = [];
    /** @type {MockApi} */
    const api = async (query, variables) => {
      if (isProjectQuery(query) || query.includes('label('))
        remove(model, gone);
      return withDeleted(model, gone)(query, variables);
    };
    await reconcileContainers({
      api,
      policy: model.policy,
      dryRun: false,
      issueNumber: 3,
      warn: (line) => warnings.push(line),
      ...quiet,
    });
    assert.deepEqual(warnings, [
      'Issue #2 no longer exists in the repository; skipping',
    ]);
    assert.equal(model.issues.get('I_1')?.state, 'CLOSED');
  }
});

test('a container deleted between its read and its sub-issue read is skipped', async () => {
  const model = github([
    { number: 1 },
    { number: 2, parent: 1, state: 'CLOSED' },
  ]);
  /** @type {Set<string>} */
  const gone = new Set();
  /** @type {string[]} */
  const warnings = [];
  /** @type {MockApi} */
  const api = async (query, variables) => {
    if (query.includes('issue(number: $number)')) gone.add('I_1');
    return withDeleted(model, gone)(query, variables);
  };
  await reconcileContainers({
    api,
    policy: model.policy,
    dryRun: false,
    issueNumber: 1,
    warn: (line) => warnings.push(line),
    ...quiet,
  });
  assert.deepEqual(warnings, [
    'Issue #1 no longer exists in the repository; skipping',
  ]);
  assert.deepEqual(model.mutations(), []);
});

test('a sweep skips a container deleted after the listing and finishes the rest', async () => {
  // Closing #2 makes #1 stale, so the sweep reads #1 fresh and finds it gone.
  const model = github([
    { number: 1 },
    { number: 2, parent: 1 },
    { number: 3, parent: 2, state: 'CLOSED' },
    { number: 5 },
    { number: 6, parent: 5, state: 'CLOSED' },
  ]);
  /** @type {Set<string>} */
  const gone = new Set();
  /** @type {string[]} */
  const warnings = [];
  /** @type {MockApi} */
  const api = async (query, variables) => {
    if (query.includes('closeIssue') && variables.id === 'I_2') gone.add('I_1');
    return withDeleted(model, gone)(query, variables);
  };
  await reconcileContainers({
    api,
    policy: model.policy,
    dryRun: false,
    warn: (line) => warnings.push(line),
    ...quiet,
  });
  assert.deepEqual(warnings, [
    'Issue #1 no longer exists in the repository; skipping',
  ]);
  assert.equal(model.issues.get('I_2')?.state, 'CLOSED');
  assert.equal(model.issues.get('I_5')?.state, 'CLOSED');
  assert.equal(model.issues.get('I_1')?.state, 'OPEN');
});

test('a sweep re-reads a container decided from its listing before the first write', async () => {
  // #1 would be marked and closed, and #3 is closed and marked with a stale
  // Ready status; both are deleted after the listing. #5 still closes.
  const model = github([
    { number: 1 },
    { number: 2, parent: 1, state: 'CLOSED' },
    { number: 3, state: 'CLOSED', marked: true, status: 'Ready' },
    { number: 4, parent: 3, state: 'CLOSED' },
    { number: 5 },
    { number: 6, parent: 5, state: 'CLOSED' },
  ]);
  /** @type {Set<string>} */
  const gone = new Set();
  /** @type {string[]} */
  const warnings = [];
  /** @type {MockApi} */
  const api = async (query, variables) => {
    if (query.includes('label(')) gone.add('I_1').add('I_3');
    return withDeleted(model, gone)(query, variables);
  };
  await reconcileContainers({
    api,
    policy: model.policy,
    dryRun: false,
    warn: (line) => warnings.push(line),
    ...quiet,
  });
  assert.deepEqual(warnings.toSorted(), [
    'Issue #1 no longer exists in the repository; skipping',
    'Issue #3 no longer exists in the repository; skipping',
  ]);
  assert.deepEqual(model.mutations(), [
    'addLabelsToLabelable I_5',
    'closeIssue I_5',
    'updateProjectV2ItemFieldValue item-5 Done',
  ]);
});

test('a sweep marks no container closed or no longer complete since the listing', async () => {
  // After the listing, #1 is closed by hand or its child #2 reopens. #1 takes
  // no write; #5 still closes.
  for (const change of [
    (/** @type {any} */ model) => (model.issues.get('I_1').state = 'CLOSED'),
    (/** @type {any} */ model) => (model.issues.get('I_2').state = 'OPEN'),
  ]) {
    const model = github([
      { number: 1 },
      { number: 2, parent: 1, state: 'CLOSED' },
      { number: 5 },
      { number: 6, parent: 5, state: 'CLOSED' },
    ]);
    /** @type {MockApi} */
    const api = async (query, variables) => {
      if (query.includes('label(')) change(model);
      return model.api(query, variables);
    };
    await reconcileContainers({
      api,
      policy: model.policy,
      dryRun: false,
      ...quiet,
    });
    assert.deepEqual(model.mutations(), [
      'addLabelsToLabelable I_5',
      'closeIssue I_5',
      'updateProjectV2ItemFieldValue item-5 Done',
    ]);
    assert.equal(model.issues.get('I_1')?.marked, false);
  }
});

test('a sweep skips a container whose write target was deleted and writes the rest', async () => {
  const message =
    'A write target was deleted or transferred during the run; skipping it';
  // Each case fails one of #1's writes; the writes before it stand.
  for (const [failing, before] of /** @type {[string, string[]][]} */ ([
    ['addLabelsToLabelable I_1', []],
    ['closeIssue I_1', ['addLabelsToLabelable I_1']],
    [
      'updateProjectV2ItemFieldValue item-1 Done',
      ['addLabelsToLabelable I_1', 'closeIssue I_1'],
    ],
  ])) {
    const model = github([
      { number: 1 },
      { number: 2, parent: 1, state: 'CLOSED' },
      { number: 5 },
      { number: 6, parent: 5, state: 'CLOSED' },
    ]);
    /** @type {string[]} */
    const warnings = [];
    /** @type {MockApi} */
    const api = async (query, variables) => {
      if (
        query.startsWith('mutation') &&
        model.mutations().length === before.length &&
        failing.includes(variables.id ?? variables.item)
      )
        throw new MissingIssueError(undefined, message);
      return model.api(query, variables);
    };
    await reconcileContainers({
      api,
      policy: model.policy,
      dryRun: false,
      warn: (line) => warnings.push(line),
      ...quiet,
    });
    assert.deepEqual(warnings, [message], failing);
    assert.deepEqual(
      model.mutations(),
      [
        ...before,
        'addLabelsToLabelable I_5',
        'closeIssue I_5',
        'updateProjectV2ItemFieldValue item-5 Done',
      ],
      failing,
    );
  }
});

test('invalid programmatic issue filters fail before any API access', async () => {
  for (const issueNumber of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(
      reconcileContainers({
        api: () => assert.fail('API access with invalid issue filter'),
        policy: userPolicy,
        issueNumber: /** @type {number} */ (issueNumber),
      }),
      /positive safe integer/,
    );
});
