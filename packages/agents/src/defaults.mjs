// The model, effort, role, and rubric defaults every repository gets. A
// repository's policy.json may override them: capabilities and roles by
// name, supported models by tool, and the rubric as a whole.
import { readFileSync } from 'node:fs';

/** @typedef {Record<string, any>} Policy */

/** @type {Policy} */
export const DEFAULTS = JSON.parse(
  readFileSync(new URL('../defaults.json', import.meta.url), 'utf8'),
);

/**
 * Fills a loaded policy's model and effort sections from DEFAULTS.
 * @param {Policy} policy
 */
export function withDefaults(policy) {
  const defaults = structuredClone(DEFAULTS);
  for (const key of ['capabilities', 'roles', 'supported'])
    policy[key] = { ...defaults[key], ...policy[key] };
  policy.implementationEffort ??= defaults.implementationEffort;
  return policy;
}
