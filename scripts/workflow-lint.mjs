// Lints this repository's GitHub Actions workflows: names, timeouts, checkout
// credentials, Node version source, and pull_request_target safety.
// `npm run workflows:lint` runs it.
import { resolve } from 'node:path';
import { lintWorkflows } from './workflow-lint/lint.mjs';

export const REPOSITORY = 'agenticool/agenticool';

/** @type {import('./workflow-lint/workflows.mjs').Config} */
export const CONFIG = {
  areas: { ci: 'CI', release: 'Release', board: 'Board' },
  pullRequestTarget: ['board-pr-issue-status.yml', 'board-pr-metadata.yml'],
  // The branch ruleset requires these jobs as status checks.
  requiredChecks: [
    {
      file: 'ci-checks.yml',
      job: 'run-checks',
      name: 'Run format, lint, typecheck, and tests',
    },
    {
      file: 'ci-pr-title.yml',
      job: 'check-pr-title',
      name: 'Check PR title follows Conventional Commits',
    },
    {
      file: 'ci-secret-scan.yml',
      job: 'scan-secrets',
      name: 'Scan commits for secrets',
    },
  ],
};

/**
 * Lints `<cwd>/.github/workflows` and prints one line per violation. Returns
 * the exit code: 1 on any violation or error.
 * @param {{ cwd?: string, stdout?: (text: string) => void, stderr?: (text: string) => void }} [io]
 */
export function main({
  cwd = process.cwd(),
  stdout = process.stdout.write.bind(process.stdout),
  stderr = process.stderr.write.bind(process.stderr),
} = {}) {
  try {
    const violations = lintWorkflows(resolve(cwd, '.github/workflows'), {
      config: CONFIG,
      repository: REPOSITORY,
    });
    for (const { file, job, rule, message } of violations)
      stdout(`${file}${job ? ` ${job}` : ''} [${rule}] ${message}\n`);
    return violations.length > 0 ? 1 : 0;
  } catch (error) {
    stderr(`${/** @type {Error} */ (error).message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main();
