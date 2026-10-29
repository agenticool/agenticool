// Policy fixtures and mocked GitHub answers shared by the board tests.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPolicy, project, repository } from '@agenticool/core';
import { DONE_FILTERS } from '../src/index.mjs';

/**
 * A fixture policy for `repository`, as if read from its origin remote.
 * @param {string} name
 * @param {string} repository
 */
const load = (name, repository) =>
  Object.assign(
    loadPolicy(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), {
      sections: ['binding.project'],
    }),
    { repository },
  );

// A user-owned project and an organization-owned one.
export const userPolicy = load('user', 'acme/widgets');
export const orgPolicy = load('organization', 'example-org/gadgets');
export const POLICIES = [userPolicy, orgPolicy];
export const REPOSITORY = repository(userPolicy);

// `gh api --include` output: a status line, CRLF headers, a blank line, the body.
/**
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {unknown} body
 */
export function httpResponse(status, headers, body) {
  const lines = Object.entries(headers).map(
    ([name, value]) => `${name}: ${value}\r\n`,
  );
  return `HTTP/2.0 ${status} Status\n${lines.join('')}\r\n${
    typeof body === 'string' ? body : JSON.stringify(body)
  }`;
}

// gh exits non-zero on an HTTP or GraphQL error and writes the response to stdout.
/**
 * @param {string} stdout
 * @param {Record<string, unknown>} [overrides]
 * @returns {() => never}
 */
export function ghFails(stdout, overrides = {}) {
  return () => {
    throw Object.assign(new Error('Command failed: gh api'), {
      status: 1,
      stderr: 'gh: stderr-marker',
      stdout,
      ...overrides,
    });
  };
}

export const RESET = 1792126278;
export const RESET_AT = new Date(RESET * 1000).toISOString();
export const exhausted = {
  'X-Ratelimit-Limit': '5000',
  'X-Ratelimit-Remaining': '0',
  'X-Ratelimit-Reset': String(RESET),
};

// GitHub's answer for an issue that was deleted or transferred out of the
// repository: a null field and a NOT_FOUND error at its path.
/**
 * @param {unknown} data
 * @param {unknown} path
 * @param {unknown[]} [extra]
 */
export function notFound(data, path, extra = []) {
  return ghFails(
    httpResponse(
      200,
      {},
      {
        data,
        errors: [
          {
            type: 'NOT_FOUND',
            path,
            message: 'Could not resolve to an Issue with the number of 5.',
          },
          ...extra,
        ],
      },
    ),
  );
}

// Answers a project field query for `policy`, checking that it asks for the
// project's owner type, owner, and number.
/**
 * @param {string} query
 * @param {Record<string, any>} variables
 * @param {Record<string, any>} policy
 * @param {unknown} fields
 */
export function projectAnswer(query, variables, policy, fields) {
  const board = project(policy);
  assert.ok(query.includes(`${board.ownerType}(login: $owner)`), query);
  assert.equal(variables.owner, board.owner);
  assert.equal(variables.number, board.number);
  return { [board.ownerType]: { projectV2: { id: 'project', fields } } };
}

/** @param {string} query */
export const isProjectQuery = (query) =>
  query.includes('projectV2(number: $number)');

/**
 * @param {any[]} nodes
 * @param {boolean} [next]
 */
const connection = (nodes, next = false) => ({
  nodes,
  pageInfo: { hasNextPage: next, endCursor: next ? 'next' : null },
});
const EMPTY = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };

// A mocked delivery project. Listing and single-issue reads return each item
// with the first page of its field values and labels nested; issue #1's item
// overflows both, so its remaining pages come from follow-up reads.
/**
 * @param {{
 *   race?: (fields: Record<string, any>, state: any) => void,
 *   multipleSeverity?: boolean,
 *   additionalIssue?: boolean,
 *   policy?: Record<string, any>,
 * }} [options]
 */
export function mockApi({
  race,
  multipleSeverity = false,
  additionalIssue = false,
  policy = userPolicy,
} = {}) {
  const home = repository(policy);
  /** @type {any} */
  const state = {
    mutations: [],
    queries: [],
    readItems: [],
    itemFilters: [],
    status: 'Inbox',
    otherStatus: 'Inbox',
    lastFields: {},
  };
  const definitions = Object.entries({
    Status: ['Inbox', 'Ready', 'In progress'],
    Priority: ['P0', 'P1', 'P2', 'P3'],
    Size: ['XS', 'S', 'M', 'L'],
  }).map(([name, options]) => ({
    id: `field-${name}`,
    name,
    options: options.map((name) => ({ id: `option-${name}`, name })),
  }));
  /** @param {Record<string, any>} fields */
  const values = (fields) =>
    Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({
        field: { id: `field-${name}` },
        optionId: `option-${value}`,
      }));
  const extraLabels = () =>
    multipleSeverity || state.extraSeverity ? [{ name: 'severity: high' }] : [];
  /**
   * @param {string} id
   * @param {Record<string, any>} [fields]
   */
  const node = (id, fields) => {
    const second = id === 'item-2';
    fields ??= {
      Status: second ? state.otherStatus : state.status,
      Priority: 'P2',
      Size: 'L',
    };
    state.lastFields[id] = fields;
    const content = {
      __typename: 'Issue',
      id: second ? 'issue-2' : 'issue',
      number: second || state.renumbered ? 2 : 1,
      state: state.closed ? 'CLOSED' : 'OPEN',
      repository: {
        nameWithOwner:
          state.foreign || state.transferred?.includes(id)
            ? 'other/repo'
            : home,
      },
      labels: second
        ? connection([{ name: 'severity: none' }])
        : connection([{ name: 'severity: none' }], true),
    };
    return {
      id,
      type: 'ISSUE',
      project: { id: 'project' },
      fieldValues: second
        ? connection(values(fields))
        : connection(values(fields).slice(0, 1), true),
      content,
    };
  };
  const listed = () => (additionalIssue ? ['item', 'item-2'] : ['item']);
  /**
   * @param {string} query
   * @param {Record<string, any>} variables
   * @returns {Promise<any>}
   */
  const api = async (query, variables) => {
    const page = variables.cursor ? 1 : 0;
    if (query.startsWith('mutation')) {
      assert.match(query, /updateProjectV2ItemFieldValue/);
      state.mutations.push(variables);
      if (variables.item === 'item-2') state.otherStatus = 'Ready';
      else state.status = 'Ready';
      return {
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: variables.item },
        },
      };
    }
    if (isProjectQuery(query)) {
      state.queries.push(`definitions-${page}`);
      return projectAnswer(
        query,
        variables,
        policy,
        page
          ? connection(definitions.slice(1))
          : connection(definitions.slice(0, 1), true),
      );
    }
    if (query.includes('items(first: 100')) {
      state.queries.push(`items-${page}`);
      state.itemFilters.push(variables.filter);
      return {
        node: {
          items: page
            ? connection(listed().map((id) => node(id)))
            : connection(
                [
                  { id: 'pr', type: 'PULL_REQUEST', content: {} },
                  { id: 'draft', type: 'DRAFT_ISSUE', content: null },
                  {
                    ...node('other'),
                    content: {
                      __typename: 'Issue',
                      repository: { nameWithOwner: 'other/repo' },
                    },
                  },
                ],
                true,
              ),
        },
      };
    }
    if (query.includes('projectItems(first: 20')) {
      assert.equal(`${variables.owner}/${variables.name}`, home);
      state.queries.push(`issue-items-${variables.number}`);
      const id = /** @type {Record<number, string>} */ ({
        1: 'item',
        2: 'item-2',
      })[variables.number];
      // Issue 404 was deleted; any other unknown issue is outside the project.
      if (!id || !listed().includes(id))
        return {
          repository: {
            issue: variables.number === 404 ? null : { projectItems: EMPTY },
          },
        };
      // The same issue in another project is never read or written.
      const own = node(id);
      const elsewhere = { ...own, id: 'elsewhere', project: { id: 'x' } };
      // An archived item is listed only to a read that includes archived items.
      const hidden =
        state.archived?.includes(id) &&
        query.includes('includeArchived: false');
      return {
        repository: {
          issue: {
            projectItems: connection(hidden ? [elsewhere] : [elsewhere, own]),
          },
        },
      };
    }
    if (query.includes('fieldValues(first: 100, after: $cursor)')) {
      state.queries.push(`values-${variables.id}`);
      return {
        node: {
          fieldValues: connection(
            values(state.lastFields[variables.id]).slice(1),
          ),
        },
      };
    }
    if (query.includes('labels(first: 100, after: $cursor)')) {
      state.queries.push(`labels-${variables.id}`);
      return { node: { labels: connection(extraLabels()) } };
    }
    if (query.includes('... on ProjectV2Item {')) {
      state.queries.push(`read-${variables.id}`);
      state.readItems.push(variables.id);
      if (state.deleted?.includes(variables.id)) return { node: null };
      const fields = {
        Status: variables.id === 'item-2' ? state.otherStatus : state.status,
        Priority: 'P2',
        Size: 'L',
      };
      if (race) race(fields, state);
      return { node: node(variables.id, fields) };
    }
    throw new Error(`Unexpected mock query ${query}`);
  };
  return { api, state, definitions };
}

// A mocked project for Done reconciliation. Each entry is one item with its
// issue number, state, Status, and repository. Listing applies the two Done
// filters; `onRead` runs before each write-boundary re-read and may change the
// entry or return null to remove the item from the project.
/**
 * @param {Record<string, any>[]} entries
 * @param {{ onRead?: (entry: any, id: string) => unknown, policy?: Record<string, any> }} [options]
 */
export function board(entries, { onRead, policy = userPolicy } = {}) {
  /** @type {Map<string, any>} */
  const items = new Map(
    entries.map((entry) => [
      `item-${entry.number}`,
      {
        type: 'ISSUE',
        state: 'OPEN',
        repository: repository(policy),
        ...entry,
      },
    ]),
  );
  /** @type {string[]} */
  const filters = [];
  /** @type {string[]} */
  const reads = [];
  /** @type {any[]} */
  const mutations = [];
  /** @param {any[]} nodes */
  const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false } });
  /** @param {string} id */
  const node = (id) => {
    const entry = items.get(id);
    return {
      id,
      type: entry.type,
      project: { id: 'project' },
      fieldValues: page(
        entry.status
          ? [
              {
                field: { id: 'field-Status' },
                optionId: `option-${entry.status}`,
              },
            ]
          : [],
      ),
      content: {
        __typename: entry.type === 'ISSUE' ? 'Issue' : 'PullRequest',
        id: `issue-${entry.number}`,
        number: entry.number,
        state: entry.state,
        repository: { nameWithOwner: entry.repository },
        labels: page([]),
      },
    };
  };
  /**
   * @param {any} entry
   * @param {string} filter
   */
  const matches = (entry, filter) =>
    entry.type === 'ISSUE' &&
    (filter === DONE_FILTERS[0]
      ? entry.state === 'CLOSED' && entry.status !== 'Done'
      : entry.state === 'OPEN' && entry.status === 'Done');
  /**
   * @param {string} query
   * @param {Record<string, any>} variables
   * @returns {Promise<any>}
   */
  const api = async (query, variables) => {
    if (isProjectQuery(query))
      return projectAnswer(
        query,
        variables,
        policy,
        page([
          {
            id: 'field-Status',
            name: 'Status',
            options: ['Inbox', 'Ready', 'In review', 'Done'].map((name) => ({
              id: `option-${name}`,
              name,
            })),
          },
        ]),
      );
    if (query.startsWith('mutation')) {
      mutations.push(variables);
      items.get(variables.item).status = variables.option.slice(
        'option-'.length,
      );
      return {};
    }
    if (query.includes('items(first: 100')) {
      filters.push(variables.filter);
      return {
        node: {
          items: page(
            [...items.keys()]
              .filter((id) => matches(items.get(id), variables.filter))
              .map(node),
          ),
        },
      };
    }
    if (query.includes('projectItems(first: 20')) {
      const id = `item-${variables.number}`;
      return {
        repository: {
          issue: { projectItems: page(items.has(id) ? [node(id)] : []) },
        },
      };
    }
    if (query.includes('... on ProjectV2Item {')) {
      reads.push(variables.id);
      if (onRead?.(items.get(variables.id), variables.id) === null)
        return { node: null };
      return { node: node(variables.id) };
    }
    throw new Error(`Unexpected mock query ${query}`);
  };
  return { api, filters, reads, mutations };
}

// Epics with their nested first label page. Epic #7 carries standard and type
// labels; #9 overflows its first page, and its conflicting label comes later.
/** @param {Record<string, any>} [policy] */
export function epicApi(policy = userPolicy) {
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const writes = [];
  /** @type {Record<string, any>} */
  const labels = {
    E7: connection([
      { id: 'L_epic', name: 'epic' },
      { id: 'L_bug', name: 'bug' },
      { id: 'L_type', name: 'type: feature' },
      { id: 'L_severity', name: 'severity: none' },
    ]),
    E8: connection([
      { id: 'L_epic', name: 'epic' },
      { id: 'L_area', name: 'area: repository' },
    ]),
    E9: connection([{ id: 'L_epic', name: 'epic' }], true),
  };
  const epics = [
    { id: 'E7', number: 7 },
    { id: 'E8', number: 8 },
    { id: 'E9', number: 9 },
  ];
  /**
   * @param {string} query
   * @param {Record<string, any>} variables
   * @returns {Promise<any>}
   */
  const api = async (query, variables) => {
    calls.push(query);
    if (query.startsWith('mutation')) {
      assert.match(query, /removeLabelsFromLabelable/);
      writes.push(variables);
      return {};
    }
    if (query.includes('repository(owner: $owner, name: $name)'))
      assert.equal(`${variables.owner}/${variables.name}`, repository(policy));
    if (query.includes('labels: ["epic"]'))
      return {
        repository: {
          issues: connection(
            epics.map((epic) => ({ ...epic, labels: labels[epic.id] })),
          ),
        },
      };
    if (query.includes('issue(number: $number)')) {
      const epic = epics.find((epic) => epic.number === variables.number);
      return {
        repository: {
          issue: epic
            ? { ...epic, labels: labels[epic.id] }
            : {
                id: 'I_1',
                number: 1,
                labels: connection([{ id: 'L_bug', name: 'bug' }]),
              },
        },
      };
    }
    assert.match(query, /labels\(first: 100, after: \$cursor\)/);
    assert.equal(variables.id, 'E9');
    return {
      node: {
        labels: connection([{ id: 'L_docs', name: 'documentation' }]),
      },
    };
  };
  return { api, calls, writes };
}
