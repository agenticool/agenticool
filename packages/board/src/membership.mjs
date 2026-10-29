// Adds issues in the repository to the delivery project, one issue when it
// opens or every open issue missing from the project in a sweep. An added item
// without a Status gets Inbox, so triage picks it up; an existing Status never
// changes. A sweep warns about an issue deleted or transferred between listing
// and adding, and still succeeds.
import { failureMessage, project, repository } from '@agenticool/core';
import {
  discover,
  MissingIssueError,
  PAGE,
  paginate,
  readItem,
  updateProjectStatus,
  warning,
} from './core.mjs';

/**
 * @typedef {import('./core.mjs').Api} Api
 * @typedef {import('./core.mjs').Policy} Policy
 */

export const INITIAL_STATUS = 'Inbox';

/**
 * @param {{
 *   api: Api,
 *   policy: Policy,
 *   kind: string | undefined,
 *   number: number,
 *   dryRun?: boolean,
 *   log?: (message: string) => void,
 * }} options
 * @returns {Promise<string | null>} the item's REST ID, or null on a dry run
 */
export async function addToProject({
  api,
  policy,
  kind,
  number,
  dryRun = true,
  log = console.log,
}) {
  if (kind !== 'issue') throw new Error('CONTENT_TYPE must be issue');
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('A positive issue number is required');
  const board = project(policy);
  const [owner, name] = repository(policy).split('/');
  const data = await api(
    `query($owner: String!, $name: String!, $number: Int!, $projectOwner: String!, $projectNumber: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) {
        id projectItems(first: 100) { nodes { id project { id } } }
      } }
      ${board.ownerType}(login: $projectOwner) { projectV2(number: $projectNumber) { id closed } }
    }`,
    {
      owner,
      name,
      number,
      projectOwner: board.owner,
      projectNumber: board.number,
    },
  );
  const content = data.repository?.issue;
  // An issue deleted or transferred before the run reads as null.
  if (!content?.id) throw new MissingIssueError(number);
  const found = data[board.ownerType]?.projectV2;
  if (!found?.id || found.closed)
    throw new Error(`${board.name} project is unavailable`);
  // Resolve the Status field and its Inbox option before any write, so a
  // renamed field or option fails the run before it adds anything.
  const context = await discover(api, policy, { Status: [INITIAL_STATUS] });
  if (context.projectId !== found.id)
    throw new Error(`${board.name} project changed during the run`);
  if (dryRun) {
    const existing = content.projectItems?.nodes.find(
      (/** @type {any} */ node) => node?.project?.id === found.id,
    );
    const status =
      existing && (await readItem(api, existing.id, context))?.fields.Status;
    log(
      status
        ? `Issue #${number}: would keep its Status ${status} (dry run).`
        : `Issue #${number}: would ${existing ? 'keep in' : 'add to'} ${board.name} and set its Status to ${INITIAL_STATUS} (dry run).`,
    );
    return null;
  }
  // GitHub returns the existing item when the content is already in the
  // project, so reruns and earlier adds neither fail nor duplicate. The item's
  // full database ID is the ID that the REST `projectsV2/<n>/items/<id>`
  // endpoints take, which issue filers use.
  const result = await api(
    `mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id fullDatabaseId } }
    }`,
    { project: found.id, content: content.id },
  );
  const added = result.addProjectV2ItemById?.item;
  const item = added?.fullDatabaseId;
  if (!item || !/^[1-9]\d*$/.test(item))
    throw new Error('GitHub returned no project item');
  log(`Issue #${number}: in ${board.name} as item ${item}.`);
  const current = await readItem(api, added.id, context);
  if (!current) throw new Error(`Could not read project item ${item}`);
  if (current.fields.Status) {
    log(`Issue #${number}: kept its Status ${current.fields.Status}.`);
    return item;
  }
  await updateProjectStatus(api, context, added.id, INITIAL_STATUS);
  log(`Issue #${number}: set its Status to ${INITIAL_STATUS}.`);
  return item;
}

// Adds every open issue that is not in the project. Archived project items
// count as present. An issue in more than 100 projects may be listed as
// missing; addToProject then returns its existing item.
/**
 * @param {{
 *   api: Api,
 *   policy: Policy,
 *   dryRun?: boolean,
 *   log?: (message: string) => void,
 *   logError?: (message: string) => void,
 *   warn?: (message: string) => void,
 * }} options
 */
export async function sweep({
  api,
  policy,
  dryRun = true,
  log = console.log,
  logError = console.error,
  warn = warning,
}) {
  const board = project(policy);
  const [owner, name] = repository(policy).split('/');
  const data = await api(
    `query($owner: String!, $number: Int!) { ${board.ownerType}(login: $owner) { projectV2(number: $number) { id closed } } }`,
    { owner: board.owner, number: board.number },
  );
  const found = data[board.ownerType]?.projectV2;
  if (!found?.id || found.closed)
    throw new Error(`${board.name} project is unavailable`);
  const issues = await paginate(async (cursor) => {
    const page = await api(
      `query($owner: String!, $name: String!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          issues(first: 100, after: $cursor, states: [OPEN]) {
            nodes { number projectItems(first: 100) { nodes { project { id } } } }
            ${PAGE}
          }
        }
      }`,
      { owner, name, cursor },
    );
    return page.repository?.issues;
  });
  /** @type {number[]} */
  const missing = issues
    .filter(
      (issue) =>
        !issue.projectItems?.nodes.some(
          (/** @type {any} */ item) => item?.project?.id === found.id,
        ),
    )
    .map((issue) => issue.number)
    .sort((a, b) => a - b);
  if (!missing.length) {
    log(`All ${issues.length} open issues are in ${board.name}.`);
    return { missing, failed: [] };
  }
  log(
    `Open issues missing from ${board.name}: ${missing.map((number) => `#${number}`).join(', ')}.`,
  );
  /** @type {number[]} */
  const failed = [];
  for (const number of missing) {
    try {
      await addToProject({ api, policy, kind: 'issue', number, dryRun, log });
    } catch (error) {
      if (error instanceof MissingIssueError) {
        warn(error.message);
        continue;
      }
      failed.push(number);
      logError(`Issue #${number}: ${failureMessage(error)}`);
    }
  }
  if (failed.length)
    throw new Error(
      `Could not add ${failed.length} of ${missing.length} missing issues: ${failed.map((number) => `#${number}`).join(', ')}`,
    );
  return { missing, failed };
}
