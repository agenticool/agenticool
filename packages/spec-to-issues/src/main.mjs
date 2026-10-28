// The `confirm`, `file`, and `resume` commands of `agenticool-spec`, which
// the spec-parser bin dispatches here.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CliHelp, cliError, defineCli, parseCli } from '@agenticool/cli';
import { GitHubError, redact } from '@agenticool/github';
import { loadPolicy, tokenEnv } from '@agenticool/policy';
import { fileSpec } from './file.mjs';
import { confirmPlan } from './state.mjs';

const cli = defineCli(
  `Usage: agenticool-spec confirm <digest> --state <dir>
       agenticool-spec file <spec> --state <dir> [--assignee <login>] [--groups <file>]
       agenticool-spec resume <spec> --state <dir>`,
  {
    state: {
      type: 'string',
      description: 'The state directory, outside every git checkout',
    },
    assignee: {
      type: 'string',
      description: 'file: assign every created issue to this login',
    },
    groups: {
      type: 'string',
      description:
        'file: JSON independence groups per epic, such as { "Phase 0": [["P0.1", "P0.3"], ["P0.2"]] }',
    },
  },
);

/**
 * Runs one command and returns the exit code.
 * @param {string[]} argv
 * @param {{
 *   cwd?: string,
 *   run?: import('@agenticool/github').Run,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   log?: (message: string) => void,
 *   error?: (message: string) => void,
 * }} [options]
 */
export async function main(
  argv,
  {
    cwd = process.cwd(),
    run = execFileSync,
    sleep,
    now,
    log = console.log,
    error = console.error,
  } = {},
) {
  /** @type {string | undefined} */
  let token;
  // Set once a filing starts, so a failure can name the resume command.
  /** @type {string | undefined} */
  let resumable;
  /** @type {string | undefined} */
  let statePath;
  try {
    const { options, positionals } = parseCli(argv, cli);
    const [command, target] = positionals;
    if (
      positionals.length !== 2 ||
      !['confirm', 'file', 'resume'].includes(command)
    )
      throw cliError(
        cli,
        'Expected confirm <digest>, file <spec>, or resume <spec>',
      );
    if (typeof options.state !== 'string')
      throw cliError(cli, '--state <dir> is required');
    const state = resolve(cwd, options.state);
    if (command !== 'file' && (options.assignee || options.groups))
      throw cliError(cli, '--assignee and --groups apply only to file');
    if (command === 'confirm') {
      confirmPlan(state, target);
      log(`Confirmed plan ${target}.`);
      return 0;
    }
    const policy = loadPolicy(cwd, {
      sections: ['binding.repository', 'binding.project'],
    });
    token = tokenEnv(policy);
    const spec = resolve(cwd, target);
    resumable = `agenticool-spec resume ${spec} --state ${state}`;
    statePath = join(state, 'state.json');
    const filed = await fileSpec({
      spec,
      state,
      policy,
      resume: command === 'resume',
      assignee: /** @type {string | undefined} */ (options.assignee),
      groups:
        typeof options.groups === 'string'
          ? JSON.parse(readFileSync(resolve(cwd, options.groups), 'utf8'))
          : undefined,
      run,
      sleep,
      now,
      log,
    });
    for (const item of filed.items)
      log(
        `${item.key}: #${item.number} ${item.title} https://github.com/${filed.repository}/issues/${item.number}`,
      );
    log(`Filing complete. State: ${state}`);
    return 0;
  } catch (cause) {
    if (cause instanceof CliHelp) {
      log(cause.message);
      return 0;
    }
    const message =
      cause instanceof GitHubError
        ? cause.message
        : redact(/** @type {Error} */ (cause).message, token);
    error(
      statePath && existsSync(statePath)
        ? `${message}\nRun ${resumable} to continue.`
        : message,
    );
    return 1;
  }
}
