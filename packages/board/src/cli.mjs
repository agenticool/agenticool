// The agenticool-board command. Each subcommand is one board entry point
// with the environment contract the board workflows set: DRY_RUN, SWEEP,
// CONTENT_TYPE and CONTENT_NUMBER, PR_NUMBER, and PR_ACTION.
import { execFileSync } from 'node:child_process';
import {
  CliHelp,
  cliError,
  defineCli,
  parseCli,
  failureMessage,
  graphqlBudget,
  loadPolicy,
  PROJECT_TOKEN,
  repository,
} from '@agenticool/core';
import { reconcileContainers } from './containers.mjs';
import { runBoard, boardGraphql, warning } from './core.mjs';
import { addToProject, sweep } from './membership.mjs';
import { copyMetadata, metadataGraphql } from './pr-metadata.mjs';
import { moveIssuesToReview } from './pr-status.mjs';
import { reconcile, reconcileDone, reconcileEpicLabels } from './triage.mjs';

/**
 * @typedef {import('./core.mjs').Policy} Policy
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {Record<string, string | boolean>} Options
 * @typedef {import('@agenticool/core').Cli} Cli
 * @typedef {{
 *   policy: Policy,
 *   config: Record<string, any>,
 *   run: import('@agenticool/core').Run,
 *   log: (message: string) => void,
 *   warn: (message: string) => void,
 *   error: (message: string) => void,
 * }} Context
 */

export const SECTIONS = ['binding.project'];

export const USAGE = `Usage: agenticool-board <command> [options]

Commands:
  triage [--dry-run | --apply] [--issue <number>]
      Remove conflicting epic labels, move eligible issues to Ready, and
      reconcile Done
  containers [--dry-run | --apply] [--issue <number>]
      Close finished containers and reopen the ones this automation closed
  membership [--dry-run | --apply] [--issue <number> | --sweep]
      Add one issue (CONTENT_TYPE, CONTENT_NUMBER) or every open issue missing
      from the project (SWEEP=true)
  pr-status [--dry-run | --apply]
      Move the issues pull request PR_NUMBER closes to In review
  pr-metadata [--dry-run | --apply]
      Copy linked issue labels, assignees, and milestone to pull request
      PR_NUMBER

Without --apply, DRY_RUN (default true) decides whether a command writes.
Run agenticool-board <command> --help for its options.`;

const MODE = {
  'dry-run': {
    type: /** @type {const} */ ('boolean'),
    description: 'Preview without writes',
  },
  apply: {
    type: /** @type {const} */ ('boolean'),
    description: 'Write changes, unless --dry-run is given',
  },
};

const RECONCILE = defineCli(
  'Usage: agenticool-board triage|containers [--dry-run | --apply] [--issue <number>]',
  {
    ...MODE,
    issue: {
      type: 'string',
      description: 'Reconcile one issue instead of sweeping',
    },
  },
);

const MEMBERSHIP = defineCli(
  'Usage: agenticool-board membership [--dry-run | --apply] [--issue <number> | --sweep]',
  {
    ...MODE,
    issue: {
      type: 'string',
      description: 'Add one issue (default CONTENT_TYPE and CONTENT_NUMBER)',
    },
    sweep: {
      type: 'boolean',
      description: 'Add every open issue missing from the project',
    },
  },
);

const PULL_REQUEST = defineCli(
  'Usage: agenticool-board pr-status|pr-metadata [--dry-run | --apply]',
  MODE,
);

/**
 * @param {Env} env
 * @param {string} name
 * @param {string} fallback
 */
function flag(env, name, fallback) {
  const value = env[name] ?? fallback;
  if (!['true', 'false'].includes(value))
    throw new Error(`${name} must be true or false`);
  return value === 'true';
}

// --dry-run wins over --apply's absence and DRY_RUN; DRY_RUN is checked even
// when a flag decides.
/**
 * @param {Options} options
 * @param {Env} env
 */
function dryRun(options, env) {
  const setting = flag(env, 'DRY_RUN', 'true');
  return options['dry-run'] === true || (!options.apply && setting);
}

/**
 * @param {Cli} cli
 * @param {Options} options
 */
function checkMode(cli, options) {
  if (options['dry-run'] && options.apply)
    throw cliError(cli, 'Use --dry-run or --apply once');
}

/**
 * @param {Cli} cli
 * @param {string | boolean} value
 */
function issueNumber(cli, value) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw cliError(cli, '--issue requires one positive safe integer');
  return Number(value);
}

// In GitHub Actions only the Projects token can reach the project, and
// membership and the pull request commands run only for their own repository.
/**
 * @param {Env} env
 * @param {Policy} policy
 * @param {string} required
 * @param {boolean} checkRepository
 */
function checkActions(env, policy, required, checkRepository) {
  if (env.GITHUB_ACTIONS !== 'true') return;
  if (!env[PROJECT_TOKEN]) throw new Error(`${PROJECT_TOKEN} ${required}`);
  if (checkRepository && env.GITHUB_REPOSITORY !== repository(policy))
    throw new Error('Unexpected repository');
}

/**
 * @param {{ options: Options, positionals: string[] }} parsed
 * @param {Env} env
 * @param {Policy} policy
 */
function reconcileOptions({ options, positionals }, env, policy) {
  if (positionals.length)
    throw cliError(
      RECONCILE,
      'Use --dry-run or --apply with optional --issue <positive number>',
    );
  checkMode(RECONCILE, options);
  const issue =
    options.issue === undefined
      ? undefined
      : issueNumber(RECONCILE, options.issue);
  checkActions(
    env,
    policy,
    'is required for Projects access; GITHUB_TOKEN cannot access Projects.',
    false,
  );
  return {
    dryRun: dryRun(options, env),
    ...(issue === undefined ? {} : { issueNumber: issue }),
  };
}

// The triage and containers options: `{ dryRun, issueNumber? }`.
/**
 * @param {Env} env
 * @param {string[]} args
 * @param {Policy} policy
 */
export function configuration(env, args, policy) {
  return reconcileOptions(parseCli(args, RECONCILE), env, policy);
}

/**
 * @param {Context} context
 * @param {boolean} sweep
 * @param {(options: any) => Promise<unknown>} task
 */
function boardTask({ policy, config, run, log, warn, error }, sweep, task) {
  return runBoard({
    sweep,
    task: () =>
      task({
        api: (
          /** @type {string} */ query,
          /** @type {Record<string, unknown>} */ variables,
        ) => boardGraphql(query, variables, run),
        policy,
        ...config,
        log,
        warn,
      }),
    budget: () => graphqlBudget(run),
    log,
    warn,
    error,
  });
}

/**
 * @param {string} required
 * @param {(env: Env) => void} [check]
 */
const pullRequestOptions =
  (required, check = () => {}) =>
  (
    /** @type {{ options: Options, positionals: string[] }} */ {
      options,
      positionals,
    },
    /** @type {Env} */ env,
    /** @type {Policy} */ policy,
  ) => {
    if (positionals.length)
      throw cliError(PULL_REQUEST, 'Use --dry-run or --apply');
    checkMode(PULL_REQUEST, options);
    checkActions(env, policy, required, true);
    if (env.GITHUB_ACTIONS === 'true') check(env);
    return { dryRun: dryRun(options, env), number: Number(env.PR_NUMBER) };
  };

/**
 * @param {Context} context
 * @param {(options: any) => Promise<unknown>} task
 */
async function pullRequest({ policy, config, run, log }, task) {
  await task({
    api: (
      /** @type {string} */ query,
      /** @type {Record<string, unknown>} */ variables,
    ) => metadataGraphql(query, variables, run),
    policy,
    ...config,
    log,
  });
  return 0;
}

/**
 * @type {Record<string, {
 *   cli: Cli,
 *   configure: (parsed: { options: Options, positionals: string[] }, env: Env, policy: Policy) => Record<string, any>,
 *   run: (context: Context) => Promise<number>,
 * }>}
 */
const COMMANDS = {
  triage: {
    cli: RECONCILE,
    configure: reconcileOptions,
    run: (context) =>
      boardTask(
        context,
        context.config.issueNumber === undefined,
        async (options) => {
          await reconcileEpicLabels(options);
          await reconcile(options);
          await reconcileDone(options);
        },
      ),
  },
  containers: {
    cli: RECONCILE,
    configure: reconcileOptions,
    run: (context) =>
      boardTask(
        context,
        context.config.issueNumber === undefined,
        reconcileContainers,
      ),
  },
  membership: {
    cli: MEMBERSHIP,
    configure: ({ options, positionals }, env, policy) => {
      if (positionals.length)
        throw cliError(MEMBERSHIP, 'membership takes no arguments');
      checkMode(MEMBERSHIP, options);
      if (options.issue !== undefined && options.sweep)
        throw cliError(MEMBERSHIP, 'Use --issue or --sweep, not both');
      const issue =
        options.issue === undefined
          ? undefined
          : issueNumber(MEMBERSHIP, options.issue);
      checkActions(env, policy, 'is required for Projects access.', true);
      const mode = dryRun(options, env);
      const sweeping = flag(env, 'SWEEP', 'false');
      if (options.sweep || (issue === undefined && sweeping))
        return { dryRun: mode };
      return {
        dryRun: mode,
        kind: issue === undefined ? env.CONTENT_TYPE : 'issue',
        number: issue ?? Number(env.CONTENT_NUMBER),
      };
    },
    run: (context) => {
      const sweeping = context.config.number === undefined;
      return boardTask(context, sweeping, (options) =>
        sweeping
          ? sweep({ ...options, logError: context.error })
          : addToProject(/** @type {any} */ (options)),
      );
    },
  },
  'pr-status': {
    cli: PULL_REQUEST,
    configure: pullRequestOptions('is required for Projects access.', (env) => {
      if (
        !['opened', 'edited', 'reopened', 'ready_for_review'].includes(
          String(env.PR_ACTION),
        )
      )
        throw new Error('Unexpected pull request action');
    }),
    run: (context) => pullRequest(context, moveIssuesToReview),
  },
  'pr-metadata': {
    cli: PULL_REQUEST,
    configure: pullRequestOptions('is required.'),
    run: (context) => pullRequest(context, copyMetadata),
  },
};

// Runs one command and returns its exit code. In GitHub Actions the Projects
// token in AGENTICOOL_PROJECT_TOKEN becomes GH_TOKEN for every gh call.
/**
 * @param {string[]} argv
 * @param {{
 *   env?: Env,
 *   cwd?: string,
 *   run?: import('@agenticool/core').Run,
 *   log?: (message: string) => void,
 *   warn?: (message: string) => void,
 *   error?: (message: string) => void,
 * }} [settings]
 */
export async function main(
  argv,
  {
    env = process.env,
    cwd = process.cwd(),
    run = execFileSync,
    log = console.log,
    warn = warning,
    error = console.error,
  } = {},
) {
  const [name, ...args] = argv;
  if (name === '--help' || name === '-h') {
    log(USAGE);
    return 0;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    error(
      `${name === undefined ? 'Give a command' : `Unknown command ${name}`}\n\n${USAGE}`,
    );
    return 1;
  }
  let loaded = false;
  try {
    const parsed = parseCli(args, command.cli);
    const policy = loadPolicy(cwd, { sections: SECTIONS });
    loaded = true;
    const config = command.configure(parsed, env, policy);
    if (env.GITHUB_ACTIONS === 'true') env.GH_TOKEN = env[PROJECT_TOKEN];
    return await command.run({ policy, config, run, log, warn, error });
  } catch (cause) {
    if (cause instanceof CliHelp) {
      log(cause.message);
      return 0;
    }
    // Until the policy loads, no GitHub call has run, so the error is a usage
    // or policy problem whose own message says what to fix.
    error(
      loaded ? failureMessage(cause) : /** @type {Error} */ (cause).message,
    );
    return 1;
  }
}
