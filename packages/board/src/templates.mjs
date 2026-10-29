// Repository templates: the label catalog, issue forms, the pull request
// template, ISSUE_TRIAGE.md, and the board caller workflows.
import { readFileSync } from 'node:fs';
import { placeholders } from '@agenticool/core';

export const TEMPLATES = new URL('../templates/', import.meta.url);

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

// `{{name}}` becomes a policy value, and `{{version}}` this package's version,
// which pins the reusable workflows a caller workflow uses. `${{ … }}` stays a
// GitHub Actions expression.
/**
 * @param {string} name Path under templates/, such as `workflows/board-pr-metadata.yml`
 * @param {import('./core.mjs').Policy} policy
 */
export function renderTemplate(name, policy) {
  /** @type {Record<string, string>} */
  const values = { ...placeholders(policy), version };
  return readFileSync(new URL(name, TEMPLATES), 'utf8').replace(
    /(?<!\$)\{\{([a-zA-Z.]+)\}\}/g,
    (_, key) => {
      if (!Object.hasOwn(values, key))
        throw new Error(`Unknown placeholder {{${key}}} in ${name}`);
      return values[key];
    },
  );
}
