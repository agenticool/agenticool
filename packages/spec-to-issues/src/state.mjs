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

/**
 * @typedef {ReturnType<typeof import('@agenticool/spec-parser').parse>} Plan
 * @typedef {{ spec: string, specSha256: string, planSha256: string, confirmed: boolean }} PlanRecord
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
 * Records the digest of a clean plan in `<directory>/plan.json`, unconfirmed,
 * and returns it.
 * @param {string} directory
 * @param {{ spec: string, text: string, plan: Plan, bodies: Record<string, string> }} built
 */
export function recordPlan(directory, { spec, text, plan, bodies }) {
  const planSha256 = planDigest(plan, bodies);
  /** @type {PlanRecord} */
  const record = {
    spec: resolve(spec),
    specSha256: sha256(text),
    planSha256,
    confirmed: false,
  };
  writeJson(join(stateDirectory(directory), 'plan.json'), record);
  return planSha256;
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
 * Marks the recorded plan confirmed when `digest` is its digest.
 * @param {string} directory
 * @param {string} digest
 */
export function confirmPlan(directory, digest) {
  const record = readPlan(directory);
  if (!record)
    throw new Error(
      `No plan is recorded in ${directory}; run agenticool-spec plan <spec> --state ${directory} first`,
    );
  if (record.planSha256 !== digest)
    throw new Error(
      `${digest} is not the recorded plan digest ${record.planSha256}; print and confirm the current plan`,
    );
  writeJson(join(resolve(directory), 'plan.json'), {
    ...record,
    confirmed: true,
  });
}
