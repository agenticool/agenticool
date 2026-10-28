// The naming convention: `<area>-<purpose>.yml` files whose names start with
// the area's prefix, `_` and `(reusable)` only on workflows other workflows
// call, sentence-case job and step names, kebab-case job IDs, a run name that
// names the subject, and `workflow_run` triggers that name real workflows.
// Vendor workflows listed in `exclude` keep the vendor's names.
import { triggers } from '../workflows.mjs';

export const rule = 'names';

// A name may be an expression, such as a matrix or input value, but the
// literal text must start with a capital letter.
const SENTENCE = /^(?:\$\{\{.*\}\}|[A-Z])/;

/**
 * @param {import('../workflows.mjs').Context} context
 * @returns {import('../workflows.mjs').Problem[]}
 */
export function check({ workflows, config }) {
  const areas = config.areas ?? {};
  const exclude = new Set(config.exclude ?? []);
  const names = new Set(workflows.map(({ definition }) => definition.name));
  /** @type {import('../workflows.mjs').Problem[]} */
  const problems = [];
  for (const { file, path, definition } of workflows) {
    if (exclude.has(file)) continue;
    /**
     * @param {string} message
     * @param {string} [job]
     */
    const fail = (message, job) => problems.push({ file: path, job, message });
    const events = triggers(definition);
    const { name } = definition;
    if (typeof name !== 'string') fail('has no name');
    const match = file.match(/^(_?)([a-z]+)-[a-z0-9]+(?:-[a-z0-9]+)*\.yml$/);
    if (!match) fail('is not <area>-<purpose>.yml');
    else {
      const [, reusable, area] = match;
      if (!areas[area]) fail(`has unknown area ${area}`);
      else if (typeof name === 'string' && !name.startsWith(`${areas[area]}: `))
        fail(`name must start with ${areas[area]}:`);
      // A workflow that also runs on its own events keeps a plain name.
      if (reusable && !events.includes('workflow_call'))
        fail('only reusable workflows start with _');
      if (!reusable && events.length === 1 && events[0] === 'workflow_call')
        fail('runs only on workflow_call, so its file name starts with _');
      if (
        typeof name === 'string' &&
        name.endsWith(' (reusable)') !== Boolean(reusable)
      )
        fail(
          'only reusable workflow names, in files starting with _, end with (reusable)',
        );
    }
    for (const [id, job] of Object.entries(definition.jobs ?? {})) {
      if (!/^[a-z]+(?:-[a-z]+)*$/.test(id)) fail('ID is not kebab-case', id);
      if (typeof job?.name !== 'string') fail('has no name', id);
      else if (!SENTENCE.test(job.name))
        fail(`name "${job.name}" does not start with a capital letter`, id);
      for (const [index, step] of (job?.steps ?? []).entries()) {
        if (typeof step?.name !== 'string')
          fail(
            `step ${index + 1} (${step?.uses ?? step?.run}) has no name`,
            id,
          );
        else if (!/^[A-Z]/.test(step.name))
          fail(`step ${step.name} does not start with a capital letter`, id);
      }
    }
    if (
      !['workflow_call', 'pull_request', 'push'].some((event) =>
        events.includes(event),
      ) &&
      !(
        typeof definition['run-name'] === 'string' &&
        /\$\{\{/.test(definition['run-name'])
      )
    )
      fail('needs a run-name with an expression that names its subject');
    for (const target of definition.on?.workflow_run?.workflows ?? [])
      if (!names.has(target)) fail(`waits for unknown workflow ${target}`);
  }
  return problems;
}
