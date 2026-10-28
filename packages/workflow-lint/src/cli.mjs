import { CliHelp, defineCli, parseCli } from '@agenticool/cli';
import { loadPolicy } from '@agenticool/policy';
import { resolve } from 'node:path';
import { lintWorkflows } from './lint.mjs';

const cli = defineCli('Usage: agenticool-workflow-lint [--dir <path>]', {
  dir: {
    type: 'string',
    description: 'Workflow directory (default .github/workflows)',
  },
});

/**
 * Lints the workflow directory with the `workflowLint` config and repository
 * from `<cwd>/.agents/policy.json`. Returns the exit code: 1 on any violation
 * or error.
 * @param {string[]} argv
 * @param {{ cwd?: string, stdout?: (text: string) => void, stderr?: (text: string) => void }} [io]
 */
export function main(
  argv,
  {
    cwd = process.cwd(),
    stdout = process.stdout.write.bind(process.stdout),
    stderr = process.stderr.write.bind(process.stderr),
  } = {},
) {
  try {
    const { options } = parseCli(argv, cli);
    const policy = loadPolicy(cwd, {
      sections: ['workflowLint', 'binding.repository'],
    });
    const violations = lintWorkflows(
      resolve(cwd, String(options.dir ?? '.github/workflows')),
      { config: policy.workflowLint, repository: policy.binding.repository },
    );
    for (const { file, job, rule, message } of violations)
      stdout(`${file}${job ? ` ${job}` : ''} [${rule}] ${message}\n`);
    return violations.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof CliHelp) {
      stdout(`${error.message}\n`);
      return 0;
    }
    stderr(`${/** @type {Error} */ (error).message}\n`);
    return 1;
  }
}
