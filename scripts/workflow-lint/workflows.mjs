// Reading a workflow directory, plus the trigger and step helpers the rules
// share.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';

/**
 * @typedef {{
 *   areas?: Record<string, string>,
 *   exclude?: string[],
 *   pullRequestTarget?: string[],
 *   requiredChecks?: { file: string, job: string, name: string }[],
 * }} Config Workflow area prefixes, vendor workflow files the naming rules
 *   skip, the workflows that run on `pull_request_target`, and the jobs a
 *   branch ruleset requires as status checks.
 * @typedef {{
 *   file: string,
 *   path: string,
 *   source: string,
 *   document: import('yaml').Document,
 *   definition: Record<string, any>,
 * }} Workflow `file` is the name inside the workflow directory; `path` is
 *   relative to the repository root.
 * @typedef {{
 *   dir: string,
 *   root: string,
 *   workflows: Workflow[],
 *   config: Config,
 *   repository?: string,
 * }} Context
 * @typedef {{ file: string, job?: string, message: string }} Problem
 */

/**
 * Parses YAML and fails with the file path on a syntax error.
 * @param {string} source
 * @param {string} path
 */
export function parseYaml(source, path) {
  const document = parseDocument(source);
  if (document.errors.length > 0)
    throw new Error(`${path}: ${document.errors[0].message}`);
  return document;
}

/**
 * A workflow directory is `<root>/.github/workflows`, so the repository root
 * is two levels up.
 * @param {string} dir
 * @param {{ config?: Config, repository?: string }} [options]
 * @returns {Context}
 */
export function readWorkflows(dir, { config = {}, repository } = {}) {
  dir = resolve(dir);
  const root = resolve(dir, '../..');
  const workflows = readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => {
      const path = relative(root, join(dir, file));
      const source = readFileSync(join(dir, file), 'utf8');
      const document = parseYaml(source, path);
      return {
        file,
        path,
        source,
        document,
        definition: document.toJS() ?? {},
      };
    });
  if (workflows.length === 0)
    throw new Error(`No workflow files in ${relative(process.cwd(), dir)}`);
  return { dir, root, workflows, config, repository };
}

/**
 * @param {Context} context
 * @param {string} file
 */
export const workflowPath = ({ dir, root }, file) =>
  relative(root, join(dir, file));

/** @param {Record<string, any>} definition */
export function triggers(definition) {
  const on = definition?.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  return on && typeof on === 'object' ? Object.keys(on) : [];
}

/** @param {Record<string, any>} step */
export const isCheckout = (step) =>
  typeof step?.uses === 'string' && step.uses.startsWith('actions/checkout@');

/**
 * @param {number} index
 * @param {Record<string, any>} step
 * @param {string} [fallback]
 */
export const stepLabel = (index, step, fallback) =>
  `step ${index + 1} (${step?.name ?? step?.uses ?? fallback})`;
