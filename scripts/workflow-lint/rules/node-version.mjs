// `.tool-versions` is the one place the Node version is pinned. Every
// `actions/setup-node` step reads it, so no workflow or composite action may
// set `node-version` or point `node-version-file` anywhere else.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseYaml, stepLabel } from '../workflows.mjs';

export const rule = 'node-version';

/** @param {Record<string, any>} step */
const isSetupNode = (step) =>
  typeof step?.uses === 'string' && step.uses.startsWith('actions/setup-node@');
/** @param {Record<string, any>} step */
const isRootCheckout = (step) =>
  typeof step?.uses === 'string' &&
  step.uses.startsWith('actions/checkout@') &&
  step.with?.path === undefined &&
  step.with?.['sparse-checkout-cone-mode'] !== false;

/**
 * @param {import('../workflows.mjs').Context} context
 * @returns {import('../workflows.mjs').Problem[]}
 */
export function check({ workflows, dir, root }) {
  const actions = join(dir, '../actions');
  const definitions = [
    ...workflows,
    ...(existsSync(actions)
      ? readdirSync(actions)
          .sort()
          .flatMap((name) =>
            ['action.yml', 'action.yaml']
              .map((file) => join(actions, name, file))
              .filter((file) => existsSync(file)),
          )
          .map((file) => {
            const path = relative(root, file);
            const source = readFileSync(file, 'utf8');
            return { path, source, definition: parseYaml(source, path).toJS() };
          })
      : []),
  ];
  /** @type {import('../workflows.mjs').Problem[]} */
  const problems = [];
  const versions = join(root, '.tool-versions');
  if (
    !existsSync(versions) ||
    !/^nodejs \d+\.\d+\.\d+$/m.test(readFileSync(versions, 'utf8'))
  )
    problems.push({
      file: '.tool-versions',
      message: 'does not pin nodejs <major>.<minor>.<patch>',
    });
  let count = 0;
  for (const { path, source, definition } of definitions) {
    /** @type {[string | undefined, Record<string, any>[]][]} */
    const jobs = definition?.jobs
      ? Object.entries(definition.jobs).map(([id, job]) => [
          id,
          job?.steps ?? [],
        ])
      : [[undefined, definition?.runs?.steps ?? []]];
    for (const [job, steps] of jobs)
      steps.forEach((step, index) => {
        if (!isSetupNode(step)) return;
        count += 1;
        /** @param {string} message */
        const fail = (message) =>
          problems.push({
            file: path,
            job,
            message: `${stepLabel(index, step)} ${message}`,
          });
        if (
          step.with?.['node-version'] !== undefined ||
          step.with?.['node-version-file'] !== '.tool-versions'
        )
          fail('must read node-version-file: .tool-versions, not node-version');
        // setup-node reads the file from the workspace, so a checkout of the
        // repository root (sparse checkouts in cone mode keep root files) must
        // come first.
        if (!steps.slice(0, index).some(isRootCheckout))
          fail('runs before the repository root is checked out');
      });
    if (/^\s*node-version\s*:/m.test(source))
      problems.push({ file: path, message: 'sets node-version' });
  }
  if (count === 0)
    problems.push({
      file: relative(root, dir),
      message: 'has no setup-node step',
    });
  return problems;
}
