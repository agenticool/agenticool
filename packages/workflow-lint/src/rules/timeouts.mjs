// A job that only calls a reusable workflow cannot set `timeout-minutes`, so
// the called workflow's jobs carry it. Every other job needs a positive whole
// number of minutes.
export const rule = 'timeouts';

/**
 * @param {import('../workflows.mjs').Context} context
 * @returns {import('../workflows.mjs').Problem[]}
 */
export function check({ workflows }) {
  return workflows.flatMap(({ path, definition }) =>
    Object.entries(definition.jobs ?? {})
      .filter(
        ([, job]) =>
          job?.uses === undefined &&
          !(
            Number.isInteger(job?.['timeout-minutes']) &&
            job['timeout-minutes'] > 0
          ),
      )
      .map(([job]) => ({
        file: path,
        job,
        message: 'needs timeout-minutes, a positive whole number',
      })),
  );
}
