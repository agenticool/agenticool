// Triage (Inbox to Ready), Done reconciliation, and epic label cleanup.
import { repository } from '@agenticool/core';
import {
  completeItem,
  discover,
  EMPTY,
  issueItems,
  listItems,
  MissingIssueError,
  missingIssue,
  PAGE,
  paginate,
  PRIORITIES,
  readItem,
  SIZES,
  skipWrite,
  updateProjectStatus,
  warning,
} from './core.mjs';

/**
 * @typedef {import('./core.mjs').Api} Api
 * @typedef {import('./core.mjs').Policy} Policy
 * @typedef {{
 *   api: Api,
 *   policy: Policy,
 *   dryRun?: boolean,
 *   issueNumber?: number,
 *   log?: (message: string) => void,
 *   warn?: (message: string) => void,
 * }} Options
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'none'].map(
  (value) => `severity: ${value}`,
);

/**
 * @param {any} item
 * @param {Policy} policy
 */
export function eligible(item, policy) {
  const severity = item.labels.filter((/** @type {string} */ label) =>
    label.startsWith('severity:'),
  );
  return (
    item.type === 'ISSUE' &&
    item.content?.__typename === 'Issue' &&
    item.content.repository.nameWithOwner === repository(policy) &&
    item.content.state === 'OPEN' &&
    (item.fields.Status === undefined || item.fields.Status === 'Inbox') &&
    PRIORITIES.includes(item.fields.Priority) &&
    severity.length === 1 &&
    SEVERITIES.includes(severity[0]) &&
    SIZES.includes(item.fields.Size)
  );
}

// Statuses that eligible() never moves. The sweep filter excludes them by
// name, so an empty Status, Inbox, and any status added later still reach
// eligible(), which checks every condition again.
export const SETTLED_STATUSES = ['Ready', 'In progress', 'In review', 'Done'];
export const SWEEP_FILTER = `is:issue is:open -status:${SETTLED_STATUSES.map(
  (status) => (status.includes(' ') ? `"${status}"` : status),
).join(',')}`;

/** @param {unknown} issueNumber */
function checkIssueNumber(issueNumber) {
  if (
    issueNumber !== undefined &&
    (!Number.isSafeInteger(issueNumber) ||
      /** @type {number} */ (issueNumber) <= 0)
  )
    throw new Error('--issue requires a positive safe integer');
}

/** @param {Options} options */
export async function reconcile({
  api,
  policy,
  dryRun = true,
  issueNumber,
  log = console.log,
  warn = warning,
}) {
  checkIssueNumber(issueNumber);
  const nameWithOwner = repository(policy);
  const context = await discover(api, policy);
  // One issue reads only its own project items; a sweep lists the project.
  const items =
    issueNumber === undefined
      ? await listItems(api, policy, context.projectId, SWEEP_FILTER)
      : await issueItems(api, policy, issueNumber);
  let candidates = 0;
  let updated = 0;
  for (const listed of items) {
    if (listed.type === 'ISSUE' && !listed.content) {
      warn(`Project item ${listed.id} has no readable issue; skipping`);
      continue;
    }
    if (
      listed.type !== 'ISSUE' ||
      listed.content?.repository?.nameWithOwner !== nameWithOwner ||
      (issueNumber !== undefined && listed.content.number !== issueNumber)
    )
      continue;
    const item = await completeItem(api, listed, context);
    if (
      !item ||
      !eligible(item, policy) ||
      (issueNumber !== undefined && item.content.number !== issueNumber)
    )
      continue;
    // Re-read the item's project fields and issue metadata at the write boundary.
    const fresh = await readItem(api, listed.id, context);
    if (!fresh) {
      warn(`Issue #${listed.content.number} left the project; skipping`);
      continue;
    }
    if (fresh.content?.repository?.nameWithOwner !== nameWithOwner) {
      warn(missingIssue(listed.content.number));
      continue;
    }
    if (
      !eligible(fresh, policy) ||
      (issueNumber !== undefined && fresh.content.number !== issueNumber)
    )
      continue;
    candidates++;
    log(
      `${dryRun ? 'DRY_RUN would move' : 'Moving'} issue #${fresh.content.number} ${fresh.fields.Status ?? 'empty Status'} -> Ready`,
    );
    if (dryRun) continue;
    if (
      await skipWrite(warn, () =>
        updateProjectStatus(api, context, fresh.id, 'Ready'),
      )
    )
      updated++;
  }
  log(
    `Triage reconciliation: ${candidates} eligible, ${updated} updated; DRY_RUN=${dryRun}`,
  );
  return { candidates, updated };
}

// The Status an issue's state requires: Done when closed, Ready when reopened
// out of Done, otherwise none.
/**
 * @param {string} state
 * @param {string | undefined} status
 */
function doneTarget(state, status) {
  if (state === 'CLOSED' && status !== 'Done') return 'Done';
  if (state === 'OPEN' && status === 'Done') return 'Ready';
  return undefined;
}

// A sweep lists only the issues whose Status disagrees with their state.
export const DONE_FILTERS = [
  'is:issue is:closed -status:Done',
  'is:issue is:open status:Done',
];

// Keeps Done equal to closed: moves every closed issue on the board to Done,
// whatever its Status, and every reopened issue still in Done back to Ready.
/** @param {Options} options */
export async function reconcileDone({
  api,
  policy,
  dryRun = true,
  issueNumber,
  log = console.log,
  warn = warning,
}) {
  checkIssueNumber(issueNumber);
  const nameWithOwner = repository(policy);
  const context = await discover(api, policy, { Status: ['Ready', 'Done'] });
  const items = [];
  if (issueNumber === undefined)
    for (const filter of DONE_FILTERS)
      items.push(...(await listItems(api, policy, context.projectId, filter)));
  else items.push(...(await issueItems(api, policy, issueNumber)));
  let candidates = 0;
  let updated = 0;
  for (const listed of items) {
    if (listed.type === 'ISSUE' && !listed.content) {
      warn(`Project item ${listed.id} has no readable issue; skipping`);
      continue;
    }
    if (
      listed.type !== 'ISSUE' ||
      listed.content?.repository?.nameWithOwner !== nameWithOwner ||
      (issueNumber !== undefined && listed.content.number !== issueNumber)
    )
      continue;
    const item = await completeItem(api, listed, context);
    if (!item || !doneTarget(item.content.state, item.fields.Status)) continue;
    // Re-read the issue state and Status at the write boundary.
    const fresh = await readItem(api, listed.id, context);
    if (!fresh) {
      warn(`Issue #${listed.content.number} left the project; skipping`);
      continue;
    }
    if (fresh.content?.repository?.nameWithOwner !== nameWithOwner) {
      warn(missingIssue(listed.content.number));
      continue;
    }
    const target = doneTarget(fresh.content.state, fresh.fields.Status);
    if (
      !target ||
      (issueNumber !== undefined && fresh.content.number !== issueNumber)
    )
      continue;
    candidates++;
    log(
      `${dryRun ? 'DRY_RUN would move' : 'Moving'} ${target === 'Done' ? 'closed' : 'reopened'} issue #${fresh.content.number} ${fresh.fields.Status ?? 'without Status'} -> ${target}`,
    );
    if (dryRun) continue;
    if (
      await skipWrite(warn, () =>
        updateProjectStatus(api, context, fresh.id, target),
      )
    )
      updated++;
  }
  log(
    `Done reconciliation: ${candidates} eligible, ${updated} updated; DRY_RUN=${dryRun}`,
  );
  return { candidates, updated };
}

/** @param {Options} options */
export async function reconcileEpicLabels({
  api,
  policy,
  dryRun = true,
  issueNumber,
  log = console.log,
  warn = warning,
}) {
  const forbidden = new Set([
    'bug',
    'enhancement',
    'documentation',
    'question',
    'good first issue',
    'help wanted',
    'duplicate',
    'invalid',
    'wontfix',
  ]);
  const [owner, name] = repository(policy).split('/');
  const LABELS = `labels(first: 50) { nodes { id name } ${PAGE} }`;
  /** @type {any[]} */
  let epics;
  if (issueNumber === undefined)
    epics = await paginate(async (cursor) => {
      const data = await api(
        `query($owner: String!, $name: String!, $cursor: String) {
        repository(owner: $owner, name: $name) {
        issues(first: 100, after: $cursor, states: [OPEN, CLOSED], labels: ["epic"]) {
          nodes { id number ${LABELS} } ${PAGE}
        }
      } }`,
        { owner, name, cursor },
      );
      return data.repository?.issues;
    });
  else {
    const data = await api(
      `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
      issue(number: $number) { id number ${LABELS} }
    } }`,
      { owner, name, number: issueNumber },
    );
    if (data.repository && data.repository.issue === null)
      throw new MissingIssueError(issueNumber);
    epics = data.repository?.issue ? [data.repository.issue] : [];
  }
  for (const epic of epics) {
    if (issueNumber !== undefined && epic.number !== issueNumber) continue;
    const labels = await paginate(async (cursor) => {
      const data = await api(
        `query($id: ID!, $cursor: String) { node(id: $id) { ... on Issue {
        labels(first: 100, after: $cursor) { nodes { id name } ${PAGE} }
      } } }`,
        { id: epic.id, cursor },
      );
      return data.node?.labels ?? EMPTY;
    }, epic.labels);
    if (!labels.some((label) => label.name === 'epic')) continue;
    const remove = labels.filter(
      (label) => forbidden.has(label.name) || label.name.startsWith('type:'),
    );
    if (!remove.length) continue;
    log(
      `${dryRun ? 'DRY_RUN would remove' : 'Removing'} ${remove.length} conflicting category labels from epic #${epic.number}`,
    );
    if (!dryRun)
      await skipWrite(warn, () =>
        api(
          `mutation($id: ID!, $labels: [ID!]!) {
      removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId }
    }`,
          { id: epic.id, labels: remove.map((label) => label.id) },
        ),
      );
  }
}
