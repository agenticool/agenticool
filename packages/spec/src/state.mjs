// The state directory: the plan digest a person confirms, and the atomic
// writes state-file.md requires.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { printTree } from './tree.mjs';

/**
 * @typedef {ReturnType<typeof import('./parse.mjs').parse>} Plan
 * @typedef {Record<string, string[][]>} Groups
 * @typedef {{
 *   spec: string, specSha256: string, planSha256: string, groups: Groups,
 *   assignee: string | null, digest: string, confirmed: string | null,
 * }} PlanRecord
 */

/** @param {string} text */
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * `planSha256`: the `bodies/` files, each body and a newline, concatenated in
 * creation order, before any independence record is appended.
 * @param {Plan} plan
 * @param {Record<string, string>} bodies
 */
export const planDigest = (plan, bodies) =>
  sha256(plan.items.map((item) => `${bodies[item.key]}\n`).join(''));

/**
 * Writes JSON through a temporary file and a rename, so an interruption never
 * leaves half a file.
 * @param {string} path
 * @param {unknown} value
 */
export function writeJson(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * The absolute state directory, created when missing. State holds issue
 * numbers and IDs and never lands in a git checkout.
 * @param {string} directory
 */
export function stateDirectory(directory) {
  const absolute = resolve(directory);
  for (let path = absolute; ; path = dirname(path)) {
    if (existsSync(join(path, '.git')))
      throw new Error(
        `The state directory ${absolute} is inside a git checkout; choose one outside every checkout`,
      );
    if (dirname(path) === path) break;
  }
  mkdirSync(absolute, { recursive: true });
  return absolute;
}

/**
 * Validates a groups file: each key is the root container `Plan` or an epic,
 * each group a non-empty list of leaves, and no leaf appears twice under one
 * key. `Plan` groups name any leaf of the plan; an epic's name its direct
 * leaf children.
 * @param {Plan} plan
 * @param {unknown} groups
 * @returns {Groups}
 */
export function checkGroups(plan, groups) {
  if (!groups || typeof groups !== 'object' || Array.isArray(groups))
    throw new Error(
      'The groups file must be a JSON object keyed by epic, such as { "Phase 0": [["P0.1"]] }',
    );
  for (const [key, list] of Object.entries(groups)) {
    if (
      key !== 'Plan' &&
      !plan.items.some((item) => item.key === key && item.kind === 'epic')
    )
      throw new Error(
        `Groups name ${key}, which is neither Plan nor an epic of the plan`,
      );
    if (
      !Array.isArray(list) ||
      !list.length ||
      !list.every(
        (group) =>
          Array.isArray(group) &&
          group.length &&
          group.every((id) => typeof id === 'string'),
      )
    )
      throw new Error(
        `Groups for ${key} must be a list of non-empty lists of Plan IDs`,
      );
    const seen = new Set();
    for (const id of list.flat()) {
      if (
        !plan.items.some(
          (item) =>
            item.key === id &&
            item.kind === 'leaf' &&
            (key === 'Plan' || item.parent === key),
        )
      )
        throw new Error(`Groups for ${key} name ${id}, which is not its leaf`);
      if (seen.has(id)) throw new Error(`Groups for ${key} name ${id} twice`);
      seen.add(id);
    }
  }
  return /** @type {Groups} */ (groups);
}

/**
 * The digest a person confirms: the plan, the independence groups with epics
 * in sorted order, and the assignee.
 * @param {Pick<PlanRecord, 'planSha256' | 'groups' | 'assignee'>} record
 */
export const confirmationDigest = ({ planSha256, groups, assignee }) =>
  sha256(
    `${planSha256}\n${JSON.stringify(
      Object.keys(groups)
        .sort()
        .map((key) => [key, groups[key]]),
    )}\n${assignee ?? ''}`,
  );

/**
 * Records a clean plan, its groups, and its assignee in `<directory>/plan.json`,
 * unconfirmed, and returns the confirmation digest with the text to print:
 * the tree, the plan-wide and each epic's groups, the totals, the assignee, the state
 * directory, and the digest.
 * @param {string} directory
 * @param {{
 *   spec: string, text: string, plan: Plan, bodies: Record<string, string>,
 *   groups?: unknown, assignee?: string | null,
 * }} built
 */
export function recordPlan(
  directory,
  { spec, text, plan, bodies, groups = {}, assignee = null },
) {
  const checked = checkGroups(plan, groups);
  const planSha256 = planDigest(plan, bodies);
  const digest = confirmationDigest({
    planSha256,
    groups: checked,
    assignee,
  });
  /** @type {PlanRecord} */
  const record = {
    spec: resolve(spec),
    specSha256: sha256(text),
    planSha256,
    groups: checked,
    assignee,
    digest,
    confirmed: null,
  };
  const absolute = stateDirectory(directory);
  writeJson(join(absolute, 'plan.json'), record);
  const tree = printTree(plan);
  const totals = tree.lastIndexOf('\n\nTotals: ');
  const epics = plan.items
    .filter((item) => item.key === 'Plan' || item.kind === 'epic')
    .map(
      (item) =>
        `  ${item.key}: ${
          checked[item.key]
            ?.map((group, index) => `g${index + 1} ${group.join(' ')}`)
            .join('; ') ?? 'none'
        }`,
    );
  const output = [
    tree.slice(0, totals),
    '',
    'Independence groups:',
    ...epics,
    tree.slice(totals + 2),
    `Assignee: ${assignee ?? 'none'}`,
    `State: ${absolute}`,
    `Plan digest: ${digest}`,
  ].join('\n');
  return { digest, output };
}

/**
 * The plan record in a state directory, or null when none exists.
 * @param {string} directory
 * @returns {PlanRecord | null}
 */
export function readPlan(directory) {
  const path = join(resolve(directory), 'plan.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/**
 * Marks the recorded plan confirmed when `digest` is its confirmation digest.
 * @param {string} directory
 * @param {string} digest
 */
export function confirmPlan(directory, digest) {
  const record = readPlan(directory);
  if (!record)
    throw new Error(
      `No plan is recorded in ${directory}; run agenticool-spec plan <spec> --state ${directory} first`,
    );
  if (confirmationDigest(record) !== digest)
    throw new Error(
      `${digest} is not the recorded plan digest ${record.digest}; print and confirm the current plan`,
    );
  writeJson(join(resolve(directory), 'plan.json'), {
    ...record,
    confirmed: digest,
  });
}
