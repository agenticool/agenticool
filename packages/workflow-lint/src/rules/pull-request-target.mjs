// A `pull_request_target` workflow runs with the base repository's token and
// secrets, so it must only run trusted default-branch code. No checkout may
// select the pull request's head or another repository, and no `run` step may
// fetch the head. `pullRequestTarget` lists exactly the workflows that run on
// the trigger.
import {
  isCheckout,
  stepLabel,
  triggers,
  workflowPath,
} from '../workflows.mjs';

export const rule = 'pull-request-target';

// Expressions that name the pull request's head or merge commit, branch, or ref.
const PR_HEAD =
  /github\.event\.pull_request\.(?:head\.|merge_commit_sha)|github\.head_ref|GITHUB_HEAD_REF|refs\/pull\/|pull\/[^/\n]*\/(?:head|merge)\b/;
// An agenticool reusable workflow at a full commit SHA or a release tag.
const AGENTICOOL_REUSABLE =
  /^agenticool\/agenticool\/\.github\/workflows\/_[a-z0-9-]+\.ya?ml@(?:[0-9a-f]{40}|[a-z0-9-]+-v\d+\.\d+\.\d+)$/;
// Expressions that name the base repository.
const BASE_REPOSITORY = new Set([
  'github.repository',
  'github.event.repository.full_name',
  'github.event.pull_request.base.repo.full_name',
]);
// A `git` command with `fetch` among its arguments, after joining
// backslash-continued lines.
const FETCH = /\bgit\b[^\n;&|]*?\sfetch\b/;
// `gh pr checkout` always checks out a pull request head.
const PR_CHECKOUT = /\bgh\s+pr\s+checkout\b/;

/** @param {unknown} value */
const expression = (value) =>
  /^\$\{\{\s*([^}]*?)\s*\}\}$/.exec(String(value).trim())?.[1];

/** @param {...Record<string, unknown> | undefined} scopes */
const envText = (...scopes) =>
  scopes.flatMap((env) => Object.values(env ?? {}).map(String)).join('\n');

/** @param {Record<string, any>} definition */
const isPullRequestTarget = (definition) =>
  triggers(definition).includes('pull_request_target');

/**
 * @param {Record<string, any>} definition
 * @param {string | undefined} repository
 * @returns {{ job: string, message: string }[]}
 */
function untrustedCode(definition, repository) {
  /** @param {unknown} value */
  const isBaseRepository = (value) =>
    value === repository || BASE_REPOSITORY.has(String(expression(value)));
  /** @type {{ job: string, message: string }[]} */
  const problems = [];
  for (const [job, body] of Object.entries(definition.jobs ?? {})) {
    /** @param {string} message */
    const fail = (message) => problems.push({ job, message });
    // A called workflow runs with this event's token and secrets, but its
    // own trigger is `workflow_call`, so its steps are not checked here.
    // agenticool's own reusable workflows, pinned at a commit or release tag,
    // check out only the caller's default branch, which the tracker tests
    // enforce, so calling them is safe.
    if (typeof body?.uses === 'string' && !AGENTICOOL_REUSABLE.test(body.uses))
      fail(`calls a reusable workflow: ${body.uses}`);
    /** @type {Record<string, any>[]} */ (body?.steps ?? []).forEach(
      (step, index) => {
        const label = stepLabel(index, step, 'run');
        const env = envText(definition.env, body.env, step.env);
        if (isCheckout(step)) {
          const { ref, repository: target } = step.with ?? {};
          // A ref read from `env` is checked against the env values in scope.
          const refText = /\benv\./.test(String(ref)) ? `${ref}\n${env}` : ref;
          if (ref !== undefined && PR_HEAD.test(String(refText)))
            fail(`${label} checks out the pull request head: ${ref}`);
          if (target !== undefined && !isBaseRepository(target))
            fail(
              `${label} checks out a repository other than the base repository: ${target}`,
            );
        }
        if (typeof step.run === 'string') {
          const script = step.run.replace(/\\\r?\n/g, ' ');
          if (PR_CHECKOUT.test(script))
            fail(`${label} checks out the pull request with gh`);
          else if (FETCH.test(script) && PR_HEAD.test(`${script}\n${env}`))
            fail(`${label} fetches the pull request head`);
        }
      },
    );
  }
  return problems;
}

/**
 * @param {import('../workflows.mjs').Context} context
 * @returns {import('../workflows.mjs').Problem[]}
 */
export function check(context) {
  const listed = context.config.pullRequestTarget ?? [];
  /** @type {import('../workflows.mjs').Problem[]} */
  const problems = [];
  for (const file of listed) {
    const workflow = context.workflows.find((item) => item.file === file);
    if (!workflow || !isPullRequestTarget(workflow.definition))
      problems.push({
        file: workflowPath(context, file),
        message: 'is listed in pullRequestTarget but does not run on it',
      });
  }
  for (const { file, path, definition } of context.workflows) {
    if (!isPullRequestTarget(definition)) continue;
    if (!listed.includes(file))
      problems.push({
        file: path,
        message:
          'runs on pull_request_target but pullRequestTarget does not list it',
      });
    for (const problem of untrustedCode(definition, context.repository))
      problems.push({ file: path, ...problem });
  }
  return problems;
}
