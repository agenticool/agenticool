// Moves the open issues a pull request closes to In review once the pull
// request is open and ready.
import { project, repository } from '@agenticool/core';
import { discover, paginate, readItem, updateProjectStatus } from './core.mjs';
import { linkedIssues, referenceText } from './pr-metadata.mjs';

/**
 * @typedef {import('./core.mjs').Api} Api
 * @typedef {import('./core.mjs').Policy} Policy
 */

/**
 * @param {string | null | undefined} body
 * @param {string} repository `owner/name` whose issues count
 * @returns {number[]}
 */
export function closingIssues(body, repository) {
  const references = referenceText(body).matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*\b|[\w.-]+\/[\w.-]+#[1-9]\d*\b|#[1-9]\d*\b)/gi,
  );
  return [
    ...new Set(
      [...references].flatMap((match) => linkedIssues(match[1], repository)),
    ),
  ];
}

// Only collaborators can move unclaimed Ready work, so a drive-by pull
// request cannot make an open issue look taken.
export const TRUSTED_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** @param {string} authorAssociation */
export function sourceStatuses(authorAssociation) {
  return TRUSTED_AUTHORS.has(authorAssociation)
    ? ['Ready', 'In progress']
    : ['In progress'];
}

/**
 * @param {any} item
 * @param {string} authorAssociation
 * @param {string} home
 */
function skipReason(item, authorAssociation, home) {
  if (
    item?.type !== 'ISSUE' ||
    item.content?.__typename !== 'Issue' ||
    item.content.repository?.nameWithOwner !== home
  )
    return `not an issue of ${home}`;
  if (item.content.state !== 'OPEN') return 'closed';
  const status = item.fields.Status;
  if (sourceStatuses(authorAssociation).includes(status)) return null;
  if (status === 'Ready')
    return `Ready, and ${authorAssociation} authors move only In progress issues`;
  return `status is ${status ?? 'unset'}`;
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
export async function moveIssuesToReview({
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
  const readPr = async () =>
    (
      await api(
        `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { body state isDraft authorAssociation }
    } }`,
        { owner, name, number },
      )
    ).repository?.pullRequest;
  const pr = await readPr();
  if (!pr) throw new Error('Pull request not found');
  if (pr.state !== 'OPEN' || pr.isDraft) {
    log(`Pull request #${number} is ${pr.isDraft ? 'a draft' : 'not open'}.`);
    return;
  }
  const numbers = closingIssues(pr.body, home);
  if (!numbers.length) {
    log(`Pull request #${number} closes no issues.`);
    return;
  }
  const statuses = { Status: ['Ready', 'In progress', 'In review'] };
  const context = await discover(api, policy, statuses);
  const board = project(policy).name;
  for (const issueNumber of numbers) {
    const items = await paginate(async (cursor) => {
      const data = await api(
        `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
            ... on Issue { projectItems(first: 100, after: $cursor, includeArchived: false) {
              nodes { id project { id } } pageInfo { hasNextPage endCursor }
            } }
          } }
        }`,
        { owner, name, number: issueNumber, cursor },
      );
      return (
        data.repository?.issueOrPullRequest?.projectItems ?? {
          nodes: [],
          pageInfo: { hasNextPage: false },
        }
      );
    });
    const item = items.find((item) => item.project?.id === context.projectId);
    if (!item) {
      log(`Issue #${issueNumber}: skipped, not in ${board}.`);
      continue;
    }
    const current = await readItem(api, item.id, context);
    const reason = skipReason(current, pr.authorAssociation, home);
    if (reason) {
      log(`Issue #${issueNumber}: skipped, ${reason}.`);
      continue;
    }
    const from = current.fields.Status;
    if (dryRun) {
      log(`Issue #${issueNumber}: ${from} -> In review (dry run).`);
      continue;
    }
    const freshPr = await readPr();
    if (
      !freshPr ||
      freshPr.body !== pr.body ||
      freshPr.authorAssociation !== pr.authorAssociation ||
      freshPr.state !== 'OPEN' ||
      freshPr.isDraft
    )
      throw new Error(
        'Pull request changed during discovery; rerun reconciliation',
      );
    const fresh = await readItem(api, item.id, context);
    const freshReason =
      fresh?.content?.number === issueNumber
        ? skipReason(fresh, pr.authorAssociation, home)
        : 'project item changed';
    if (freshReason) {
      log(`Issue #${issueNumber}: skipped after re-read, ${freshReason}.`);
      continue;
    }
    await updateProjectStatus(api, context, fresh.id, 'In review');
    log(`Issue #${issueNumber}: ${fresh.fields.Status} -> In review.`);
  }
}
