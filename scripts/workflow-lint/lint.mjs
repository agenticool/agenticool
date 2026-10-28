import * as checkoutCredentials from './rules/checkout-credentials.mjs';
import * as names from './rules/names.mjs';
import * as nodeVersion from './rules/node-version.mjs';
import * as pullRequestTarget from './rules/pull-request-target.mjs';
import * as requiredChecks from './rules/required-checks.mjs';
import * as timeouts from './rules/timeouts.mjs';
import { readWorkflows } from './workflows.mjs';

/**
 * @typedef {import('./workflows.mjs').Config} Config
 * @typedef {import('./workflows.mjs').Problem & { rule: string }} Violation
 */

export const rules = [
  names,
  requiredChecks,
  timeouts,
  checkoutCredentials,
  nodeVersion,
  pullRequestTarget,
];

/**
 * Runs every rule over a workflow directory, `<root>/.github/workflows`.
 * @param {string} dir
 * @param {{ config?: Config, repository?: string }} [options] `repository`
 *   is the `owner/name` the workflows run in.
 * @returns {Violation[]}
 */
export function lintWorkflows(dir, options) {
  const context = readWorkflows(dir, options);
  return rules.flatMap(({ rule, check }) =>
    check(context).map((problem) => ({ ...problem, rule })),
  );
}
