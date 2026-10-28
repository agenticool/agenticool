#!/usr/bin/env node
import { CliHelp } from '@agenticool/cli';
import { failureMessage } from '@agenticool/github';
import { runBranchName, runQueue } from '../src/index.mjs';

const USAGE = `Usage: agenticool-delivery <command> [options]

Commands:
  queue <issue> [--next] [--resume <issue>] [--actor <delivery-agent>]
      Print the delivery ledger for an issue tree
  branch-name <issue> [--layer <n>] [--actor <login>]
      Print the canonical branch name for an issue

Run agenticool-delivery <command> --help for its options.`;

const [command, ...argv] = process.argv.slice(2);
try {
  if (command === 'queue') {
    const { lines, errors } = runQueue(argv);
    for (const line of lines) console.log(line);
    for (const error of errors) console.error(error);
    if (errors.length) process.exitCode = 1;
  } else if (command === 'branch-name') console.log(runBranchName(argv));
  else if (command === '--help' || command === '-h') console.log(USAGE);
  else {
    console.error(
      `${command === undefined ? 'Give a command' : `Unknown command ${command}`}\n\n${USAGE}`,
    );
    process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof CliHelp) console.log(error.message);
  else {
    console.error(
      command === 'queue'
        ? /** @type {Error} */ (error).message
        : failureMessage(error),
    );
    process.exitCode = 1;
  }
}
