// The `confirm`, `file`, and `resume` commands of `agenticool-spec`, which
// the bin dispatches here.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CliHelp,
  cliError,
  defineCli,
  parseCli,
  GitHubError,
  redact,
  loadPolicy,
} from '@agenticool/core';
import { fileSpec } from './file.mjs';
import { confirmPlan } from './state.mjs';

const cli = defineCli(
  `Usage: agenticool-spec confirm <digest> --state <dir>
       agenticool-spec file <spec> --state <dir>
       agenticool-spec resume <spec> --state <dir>

file uses the groups and assignee that plan --state recorded and confirm confirmed.`,
  {
    state: {
      type: 'string',
      description: 'The state directory, outside every git checkout',
    },
  },
);

/**
 * Runs one command and returns the exit code.
 * @param {string[]} argv
 * @param {{
 *   cwd?: string,
 *   run?: import('@agenticool/core').Run,
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
    if (command === 'confirm') {
      confirmPlan(state, target);
      log(`Confirmed plan ${target}.`);
      return 0;
    }
    const policy = loadPolicy(cwd, { sections: ['binding.project'] });
    const spec = resolve(cwd, target);
    resumable = `agenticool-spec resume ${spec} --state ${state}`;
    statePath = join(state, 'state.json');
    const filed = await fileSpec({
      spec,
      state,
      policy,
      resume: command === 'resume',
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
        : redact(/** @type {Error} */ (cause).message);
    error(
      statePath && existsSync(statePath)
        ? `${message}\nRun ${resumable} to continue.`
        : message,
    );
    return 1;
  }
}
