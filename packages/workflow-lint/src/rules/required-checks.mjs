// A branch ruleset requires status checks by job name, so renaming one of
// these jobs, or turning it into a matrix, needs a matching ruleset change at
// merge.
import { workflowPath } from '../workflows.mjs';

export const rule = 'required-checks';

/**
 * @param {import('../workflows.mjs').Context} context
 * @returns {import('../workflows.mjs').Problem[]}
 */
export function check(context) {
  /** @type {import('../workflows.mjs').Problem[]} */
  const problems = [];
  for (const { file, job: id, name } of context.config.requiredChecks ?? []) {
    /** @param {string} message */
    const fail = (message) =>
      problems.push({ file: workflowPath(context, file), job: id, message });
    const job = context.workflows.find((workflow) => workflow.file === file)
      ?.definition.jobs?.[id];
    if (!job) {
      fail(`required check "${name}" does not exist`);
      continue;
    }
    if (job.name !== name)
      fail(`required check is named "${job.name}", not "${name}"`);
    if (job.strategy !== undefined) fail('required check must not be a matrix');
  }
  return problems;
}
