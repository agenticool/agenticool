// Copies the labels, assignees, and milestone of the issues a pull request
// references onto the pull request. With `binding.features.releasePlease`, the
// release pull request gets package labels instead.
import { execFileSync } from 'node:child_process';
import { ghGraphql } from '@agenticool/github';
import { repository } from '@agenticool/policy';
import { PAGE, paginate } from './core.mjs';
import { isReleasePullRequest, releaseLabels } from './release-please.mjs';

/**
 * @typedef {import('./core.mjs').Api} Api
 * @typedef {import('./core.mjs').Policy} Policy
 */

// A referenced number that is not an issue or PR returns NOT_FOUND with null
// data; that response is expected and every other error still fails.
/**
 * @param {string} query
 * @param {Record<string, unknown>} variables
 * @param {import('@agenticool/github').Run} [run]
 */
export function metadataGraphql(query, variables, run = execFileSync) {
  return ghGraphql(query, variables, {
    run,
    allowErrors: (result) =>
      query.includes('issueOrPullRequest(number:') &&
      result.errors.every(
        (/** @type {any} */ error) =>
          error?.type === 'NOT_FOUND' &&
          error.path?.join('.') === 'repository.issueOrPullRequest',
      ) &&
      result.data?.repository?.issueOrPullRequest === null,
  });
}

// The description without comments, code, and parent lines, which never name
// the issues a pull request delivers.
/** @param {string | null | undefined} body */
export function referenceText(body) {
  return (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/(`+)[\s\S]*?\1(?!`)/g, '')
    .replace(/^(?: {4}|\t).*$/gm, '')
    .replace(/^.*\bparent\s+(?:issue|epic)\b.*$/gim, '');
}

/**
 * @param {string | null | undefined} body
 * @param {string} repository `owner/name` whose issues count
 * @returns {number[]}
 */
export function linkedIssues(body, repository) {
  const text = referenceText(body);
  const numbers = new Set();
  const references =
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\b|([\w.-]+\/[\w.-]+)#([1-9]\d*)\b|(?<![\w/#])#([1-9]\d*)\b/g;
  for (const match of text.matchAll(references)) {
    const target = match[1] ?? match[3] ?? repository;
    const number = Number(match[2] ?? match[4] ?? match[5]);
    if (
      target.toLowerCase() === repository.toLowerCase() &&
      Number.isSafeInteger(number)
    )
      numbers.add(number);
  }
  return [...numbers];
}

/**
 * @param {Api} api
 * @param {string} id issue or pull request node ID
 * @returns {Promise<{ labels: string[], assignees: string[] }>}
 */
export async function readMetadata(api, id) {
  const labels = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) {
        ... on Issue { labels(first: 100, after: $cursor) { nodes { id } ${PAGE} } }
        ... on PullRequest { labels(first: 100, after: $cursor) { nodes { id } ${PAGE} } }
      } }`,
      { id, cursor },
    );
    return data.node?.labels;
  });
  const assignees = await paginate(async (cursor) => {
    const data = await api(
      `query($id: ID!, $cursor: String) { node(id: $id) {
        ... on Issue { assignees(first: 100, after: $cursor) { nodes { id } ${PAGE} } }
        ... on PullRequest { assignees(first: 100, after: $cursor) { nodes { id } ${PAGE} } }
      } }`,
      { id, cursor },
    );
    return data.node?.assignees;
  });
  return {
    labels: labels.map((label) => label.id),
    assignees: assignees.map((assignee) => assignee.id),
  };
}

/**
 * @param {{
 *   api: Api,
 *   policy: Policy,
 *   number: number,
 *   dryRun?: boolean,
 *   log?: (message: string) => void,
 * }} options
 */
export async function copyMetadata({
  api,
  policy,
  number,
  dryRun = true,
  log = console.log,
}) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('A positive pull request number is required');
  const home = repository(policy);
  const [owner, name] = home.split('/');
  const data = await api(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        id body state milestone { id }
        headRefName headRefOid baseRefOid isCrossRepository
      } }
    }`,
    { owner, name, number },
  );
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error('Pull request not found');
  if (pr.state !== 'OPEN') return;
  const release =
    policy.binding?.features?.releasePlease === true &&
    isReleasePullRequest(pr);
  const numbers = linkedIssues(pr.body, home);
  if (!numbers.length && !release) return;
  const issues = [];
  for (const issueNumber of numbers) {
    const result = await api(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
          __typename ... on Issue { id milestone { id } }
        } }
      }`,
      { owner, name, number: issueNumber },
    );
    const linked = result.repository?.issueOrPullRequest;
    const issue = linked?.__typename === 'Issue' ? linked : null;
    // References to PRs or missing issues do not supply metadata.
    if (issue)
      issues.push({ ...issue, ...(await readMetadata(api, issue.id)) });
  }
  if (!issues.length && !release) return;
  const current = await readMetadata(api, pr.id);
  // The release PR body links every changelog entry, so its labels come from
  // the packages it releases instead of the issues it references.
  const sourceLabels = release
    ? await releaseLabels(api, policy, pr, log)
    : issues.flatMap((issue) => issue.labels);
  const labels = [...new Set(sourceLabels)].filter(
    (id) => !current.labels.includes(id),
  );
  // The PR inherits whoever owns the issues it closes; nobody is assigned
  // to an issue here, and assignees already on the PR stay.
  const assignees = [
    ...new Set(issues.flatMap((issue) => issue.assignees)),
  ].filter((id) => !current.assignees.includes(id));
  const milestones = [
    ...new Set(issues.map((issue) => issue.milestone?.id).filter(Boolean)),
  ];
  if (milestones.length > 1)
    log(
      'Linked issues have conflicting milestones; leaving the PR milestone unchanged.',
    );
  const milestone =
    !pr.milestone && milestones.length === 1 ? milestones[0] : null;
  log(
    `PR #${number}: ${labels.length} labels, ${assignees.length} assignees, ${milestone ? 1 : 0} milestone to copy${dryRun ? ' (dry run)' : ''}.`,
  );
  if (dryRun) return;
  // A description edit during discovery must not apply stale issue metadata,
  // and a release PR push must not apply stale package labels.
  const fresh = await api(
    `query($id: ID!) { node(id: $id) { ... on PullRequest { body state milestone { id } headRefOid } } }`,
    { id: pr.id },
  );
  if (
    fresh.node?.body !== pr.body ||
    fresh.node.state !== 'OPEN' ||
    (release && fresh.node.headRefOid !== pr.headRefOid)
  )
    throw new Error(
      'Pull request changed during discovery; rerun reconciliation',
    );
  if (labels.length)
    await api(
      `mutation($id: ID!, $labels: [ID!]!) { addLabelsToLabelable(input: {labelableId: $id, labelIds: $labels}) { clientMutationId } }`,
      { id: pr.id, labels },
    );
  if (assignees.length)
    await api(
      `mutation($id: ID!, $assignees: [ID!]!) { addAssigneesToAssignable(input: {assignableId: $id, assigneeIds: $assignees}) { clientMutationId } }`,
      { id: pr.id, assignees },
    );
  if (milestone && !fresh.node.milestone)
    await api(
      `mutation($id: ID!, $milestone: ID!) { updatePullRequest(input: {pullRequestId: $id, milestoneId: $milestone}) { clientMutationId } }`,
      { id: pr.id, milestone },
    );
}
