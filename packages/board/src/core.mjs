// The shared GraphQL client, project discovery, item reads and writes, and the
// run wrapper every board task uses. Repository and project facts come from
// the consumer's `.agents/policy.json`.
import { execFileSync } from 'node:child_process';
import {
  failureMessage,
  GitHubError,
  ghGraphql,
  graphqlBudget,
  project,
  repository,
} from '@agenticool/core';

/**
 * @typedef {Record<string, any>} Policy
 * @typedef {(query: string, variables: Record<string, unknown>) => any} Api
 * @typedef {{ id: string, name: string, options: { id: string, name: string }[] }} Field
 * @typedef {{ projectId: string, fields: Record<string, Field> }} Context
 * @typedef {{ nodes: any[], pageInfo: { hasNextPage: boolean, endCursor?: string | null } }} Connection
 */

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const SIZES = ['XS', 'S', 'M', 'L'];
export const PAGE = 'pageInfo { hasNextPage endCursor }';
export const EMPTY = { nodes: [], pageInfo: { hasNextPage: false } };
const VALUES = `nodes {
  ... on ProjectV2ItemFieldSingleSelectValue { optionId field {
    ... on ProjectV2SingleSelectField { id }
  } }
} ${PAGE}`;
// One project item with the first page of its field values and issue labels,
// so reading an item costs one request unless a connection overflows.
const ITEM = `id type project { id } fieldValues(first: 50) { ${VALUES} } content {
  __typename ... on Issue { id number state repository { nameWithOwner }
    labels(first: 50) { nodes { name } ${PAGE} } }
}`;

// `first` is a first page that arrived nested in another query; fetchPage then
// runs only for the pages after it.
/**
 * @param {(cursor: string | null) => Promise<Connection | null | undefined>} fetchPage
 * @param {Connection} [first]
 * @returns {Promise<any[]>}
 */
export async function paginate(fetchPage, first) {
  const nodes = [];
  /** @type {string | null | undefined} */
  let cursor = null;
  const seen = new Set();
  let connection = first ?? (await fetchPage(cursor));
  while (true) {
    if (!connection) throw new Error('Missing GraphQL connection');
    nodes.push(...connection.nodes.filter(Boolean));
    if (!connection.pageInfo.hasNextPage) return nodes;
    cursor = connection.pageInfo.endCursor;
    if (!cursor || seen.has(cursor))
      throw new Error('Pagination cursor did not advance');
    seen.add(cursor);
    connection = await fetchPage(cursor);
  }
}

// GitHub answers a lookup of an issue that was deleted or transferred out of
// the repository with a null `issue`, `node`, or `content` field and a
// NOT_FOUND error at that field's path. Any other error, including a missing
// repository or project, still fails.
const ISSUE_FIELDS = new Set(['issue', 'node', 'content']);
/** @param {any} result */
function missingIssueOnly(result) {
  return result.errors.every((/** @type {any} */ error) => {
    const path = error?.path;
    if (
      error?.type !== 'NOT_FOUND' ||
      !Array.isArray(path) ||
      !ISSUE_FIELDS.has(path.at(-1))
    )
      return false;
    return path.reduce((value, key) => value?.[key], result.data) === null;
  });
}

// A write to an issue or project item deleted after its re-read fails with
// NOT_FOUND at the top-level mutation field, whose value is null.
/** @param {any} result */
function missingWriteTarget(result) {
  return result.errors.every(
    (/** @type {any} */ error) =>
      error?.type === 'NOT_FOUND' &&
      Array.isArray(error.path) &&
      error.path.length === 1 &&
      result.data?.[error.path[0]] === null,
  );
}

// The GraphQL client of the board tasks: a missing issue reads as null,
// and a write to a target deleted mid-run raises MissingIssueError, which
// each per-item write loop reports as a warning before it moves to the next
// item.
/**
 * @param {string} query
 * @param {Record<string, unknown>} variables
 * @param {import('@agenticool/core').Run} [run]
 */
export function boardGraphql(query, variables, run = execFileSync) {
  let missingTarget = false;
  const data = ghGraphql(query, variables, {
    run,
    allowErrors: (result) =>
      missingIssueOnly(result) ||
      (missingTarget =
        /^\s*mutation\b/.test(query) && missingWriteTarget(result)),
  });
  if (missingTarget)
    throw new MissingIssueError(
      undefined,
      'A write target was deleted or transferred during the run; skipping it',
    );
  return data;
}

/** @param {number | undefined} number */
export function missingIssue(number) {
  return `Issue #${number} no longer exists in the repository; skipping`;
}

// A single-issue run whose issue was deleted or transferred out of the
// repository after the run was queued warns and succeeds.
export class MissingIssueError extends Error {
  /**
   * @param {number | undefined} number
   * @param {string} [message]
   */
  constructor(number, message = missingIssue(number)) {
    super(message);
    this.name = 'MissingIssueError';
  }
}

/** @param {string} message */
export const warning = (message) => console.log(`::warning::${message}`);

// Runs one item's write and returns whether it happened. A target deleted
// mid-run is skipped with a warning so the run goes on with the next item.
/**
 * @param {(message: string) => void} warn
 * @param {() => unknown} write
 */
export async function skipWrite(warn, write) {
  try {
    await write();
    return true;
  } catch (error) {
    if (!(error instanceof MissingIssueError)) throw error;
    warn(error.message);
    return false;
  }
}

// `ownerType` is `user` or `organization`, the GraphQL field that owns the
// project.
/**
 * @param {Api} api
 * @param {Policy} policy
 * @param {Record<string, string[]>} [required]
 * @returns {Promise<Context>}
 */
export async function discover(
  api,
  policy,
  required = { Status: ['Inbox', 'Ready'], Priority: PRIORITIES, Size: SIZES },
) {
  const board = project(policy);
  /** @type {string | undefined} */
  let projectId;
  /** @type {Field[]} */
  const fields = await paginate(async (cursor) => {
    const data = await api(
      `query($owner: String!, $number: Int!, $cursor: String) {
        ${board.ownerType}(login: $owner) { projectV2(number: $number) {
          id fields(first: 100, after: $cursor) { nodes {
            ... on ProjectV2SingleSelectField { id name options { id name } }
          } ${PAGE} }
        } }
      }`,
      { owner: board.owner, number: board.number, cursor },
    );
    const found = data[board.ownerType]?.projectV2;
    if (!found) throw new Error(`${board.name} project is unavailable`);
    projectId = found.id;
    return found.fields;
  });
  /** @type {Record<string, Field>} */
  const selected = {};
  for (const [name, options] of Object.entries(required)) {
    const matches = fields.filter((field) => field.name === name);
    if (matches.length !== 1)
      throw new Error(`Expected one ${name} single-select field`);
    const field = matches[0];
    for (const option of options) {
      if (field.options.filter((value) => value.name === option).length !== 1)
        throw new Error(`Missing or ambiguous ${name} option ${option}`);
    }
    selected[name] = field;
  }
  return { projectId: /** @type {string} */ (projectId), fields: selected };
}

// The project items that match `filter`, each with the first page of its
// field values and labels.
/**
 * @param {Api} api
 * @param {Policy} policy
 * @param {string} projectId
 * @param {string} filter
 */
export async function listItems(api, policy, projectId, filter) {
  return paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String, $filter: String!) { node(id: $id) { ... on ProjectV2 {
        items(first: 100, after: $cursor, query: $filter) { nodes { ${ITEM} } ${PAGE} }
      } } }`,
      { id: projectId, cursor, filter },
    );
    if (!data.node)
      throw new Error(`${project(policy).name} project is unavailable`);
    return data.node.items;
  });
}

// The unarchived project items of one issue, in the same shape as listItems.
/**
 * @param {Api} api
 * @param {Policy} policy
 * @param {number} number
 */
export async function issueItems(api, policy, number) {
  const [owner, name] = repository(policy).split('/');
  return paginate(async (cursor) => {
    const data = await api(
      `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) { issue(number: $number) {
          projectItems(first: 20, after: $cursor, includeArchived: false) {
            nodes { ${ITEM} } ${PAGE}
          }
        } }
      }`,
      { owner, name, number, cursor },
    );
    if (data.repository && data.repository.issue === null)
      throw new MissingIssueError(number);
    return data.repository?.issue?.projectItems ?? EMPTY;
  });
}

// Turns an item node from listItems, issueItems, or readItem into an item
// with named field values and label names, reading any remaining pages.
/**
 * @param {Api} api
 * @param {any} node
 * @param {Context} context
 * @returns {Promise<any>}
 */
export async function completeItem(api, node, context) {
  if (!node?.id || node.project?.id !== context.projectId) return null;
  const values = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2Item {
        fieldValues(first: 100, after: $cursor) { ${VALUES} }
      } } }`,
      { id: node.id, cursor },
    );
    return data.node?.fieldValues ?? EMPTY;
  }, node.fieldValues);
  /** @type {Record<string, string | undefined>} */
  const fields = {};
  for (const [name, field] of Object.entries(context.fields)) {
    const value = values.find((value) => value.field?.id === field.id);
    fields[name] = field.options.find(
      (option) => option.id === value?.optionId,
    )?.name;
  }
  const item = { id: node.id, type: node.type, project: node.project, fields };
  if (node.type !== 'ISSUE' || node.content?.__typename !== 'Issue')
    return { ...item, content: node.content, labels: [] };
  const { labels: first, ...content } = node.content;
  const labels = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue {
        labels(first: 100, after: $cursor) { nodes { name } ${PAGE} }
      } } }`,
      { id: content.id, cursor },
    );
    return data.node?.labels ?? EMPTY;
  }, first);
  return { ...item, content, labels: labels.map((label) => label.name) };
}

/**
 * @param {Api} api
 * @param {string} id
 * @param {Context} context
 */
export async function readItem(api, id, context) {
  const data = await api(
    `query($id: ID!) { node(id: $id) { ... on ProjectV2Item { ${ITEM} } } }`,
    { id },
  );
  return completeItem(api, data.node, context);
}

/**
 * @param {Api} api
 * @param {Context} context
 * @param {string} itemId
 * @param {string} status
 */
export async function updateProjectStatus(api, context, itemId, status) {
  const field = context.fields.Status;
  const options = field.options.filter((option) => option.name === status);
  if (options.length !== 1)
    throw new Error(`Missing or ambiguous Status option ${status}`);
  await api(
    `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item,
        fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
    }`,
    {
      project: context.projectId,
      item: itemId,
      field: field.id,
      option: options[0].id,
    },
  );
}

// A sweep skips when fewer GraphQL points than this remain, leaving the rest
// of the hourly budget to people and agents that share the token's account.
export const SWEEP_FLOOR = 1000;

// Runs one board task between two readings of the GraphQL budget and
// returns the exit code. A sweep skips below SWEEP_FLOOR. A single-issue run
// that hits the rate limit warns and succeeds, because the next scheduled
// sweep repeats its work. A run whose issue no longer exists in the
// repository warns and succeeds. Every other failure fails the run.
/**
 * @param {{
 *   sweep: boolean,
 *   task: () => unknown,
 *   budget?: () => ReturnType<typeof graphqlBudget> | null,
 *   log?: (message: string) => void,
 *   warn?: (message: string) => void,
 *   error?: (message: string) => void,
 * }} options
 */
export async function runBoard({
  sweep,
  task,
  budget = graphqlBudget,
  log = console.log,
  warn = warning,
  error = console.error,
}) {
  const read = () => {
    try {
      return budget();
    } catch (cause) {
      warn(`Could not read the GraphQL budget: ${failureMessage(cause)}`);
      return null;
    }
  };
  const before = read();
  if (before)
    log(
      `GraphQL budget before: ${before.remaining} of ${before.limit} points remain; the window resets at ${new Date(before.reset * 1000).toISOString()}.`,
    );
  if (sweep && before && before.remaining < SWEEP_FLOOR) {
    warn(
      `Skipped the sweep: ${before.remaining} GraphQL points remain, below the floor of ${SWEEP_FLOOR}. The next scheduled sweep reconciles.`,
    );
    return 0;
  }
  let status = 0;
  try {
    await task();
  } catch (cause) {
    if (cause instanceof MissingIssueError) warn(cause.message);
    else if (
      !sweep &&
      cause instanceof GitHubError &&
      cause.kind === 'rate-limit'
    )
      warn(
        `${failureMessage(cause)} The next scheduled sweep reconciles this issue.`,
      );
    else {
      error(failureMessage(cause));
      status = 1;
    }
  }
  const after = read();
  if (before && after)
    log(
      after.reset === before.reset
        ? `GraphQL budget after: ${after.remaining} points remain; ${after.used - before.used} were used during the run, counting every client of this account.`
        : `GraphQL budget after: ${after.remaining} points remain; the window reset during the run.`,
    );
  return status;
}
