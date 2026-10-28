import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintWorkflows } from '@agenticool/workflow-lint';

// A repository whose workflows pass every rule. Each test copies it and
// changes only the files the case needs.
export const CLEAN = fileURLToPath(new URL('fixtures/clean', import.meta.url));
export const CONFIG = JSON.parse(
  readFileSync(join(CLEAN, '.agents/policy.json'), 'utf8'),
).workflowLint;
export const W = '.github/workflows/';

/**
 * Copies the clean repository and writes `changes` over it, by path from the
 * root; `null` deletes a file.
 * @param {Record<string, string | null>} [changes]
 */
export function repo(changes = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-lint-'));
  cpSync(CLEAN, root, { recursive: true });
  for (const [path, text] of Object.entries(changes)) {
    const file = join(root, path);
    if (text === null) rmSync(file, { recursive: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  }
  return root;
}

/**
 * Lints a changed copy of the clean repository and returns `<job> <message>`
 * (or the message alone) for each violation of `rule`.
 * @param {string} rule
 * @param {Record<string, string | null>} [changes]
 * @param {{ config?: import('../src/workflows.mjs').Config, repository?: string }} [options]
 */
export function lint(
  rule,
  changes,
  { config = CONFIG, repository = 'octo/widgets' } = {},
) {
  return lintWorkflows(join(repo(changes), W), { config, repository })
    .filter((violation) => violation.rule === rule)
    .map(({ job, message }) => (job ? `${job} ${message}` : message));
}
