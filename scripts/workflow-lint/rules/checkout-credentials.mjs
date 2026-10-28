// A checkout keeps its token in the local Git config unless it sets
// `persist-credentials: false`. A checkout that must keep it for a later
// step in the same job carries a comment directly above it:
//   # persist-credentials: kept for "<later step name>"
import { isMap, isSeq } from 'yaml';
import { isCheckout, stepLabel } from '../workflows.mjs';

export const rule = 'checkout-credentials';

const KEEP = /persist-credentials: kept for "([^"]+)"/;
export const MISSING =
  'persists credentials: add `persist-credentials: false`, or put `# persist-credentials: kept for "<later step name>"` directly above it';

/**
 * @param {import('../workflows.mjs').Context} context
 * @returns {import('../workflows.mjs').Problem[]}
 */
export function check({ workflows }) {
  /** @type {import('../workflows.mjs').Problem[]} */
  const problems = [];
  for (const { path, document } of workflows) {
    const jobs = document.get('jobs');
    if (!isMap(jobs)) continue;
    for (const { key, value: job } of jobs.items) {
      const id = String(/** @type {{ value: unknown }} */ (key).value);
      const steps = isMap(job) ? job.get('steps') : undefined;
      if (!isSeq(steps)) continue;
      steps.items.forEach((node, index) => {
        const item = /** @type {import('yaml').YAMLMap} */ (node);
        const step = item.toJSON();
        if (!isCheckout(step) || step.with?.['persist-credentials'] === false)
          return;
        const label = stepLabel(index, step);
        // The parser attaches a comment above the first step to the list.
        const comments = [item.commentBefore, item.comment];
        if (index === 0) comments.push(steps.commentBefore);
        const kept = KEEP.exec(comments.filter(Boolean).join('\n'))?.[1];
        /** @param {string} message */
        const fail = (message) =>
          problems.push({ file: path, job: id, message });
        if (!kept) fail(`${label} ${MISSING}`);
        else if (
          !steps.items
            .slice(index + 1)
            .some(
              (later) =>
                /** @type {import('yaml').YAMLMap} */ (later).get('name') ===
                kept,
            )
        )
          fail(`${label} names "${kept}", which is not a later step`);
      });
    }
  }
  return problems;
}
