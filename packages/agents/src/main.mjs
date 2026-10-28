// The agenticool-agents command. It runs in the consumer repository root and
// reads that repository's `.agents/policy.json`.
import { readFileSync } from 'node:fs';
import { CliHelp, cliError, defineCli, parseCli } from '@agenticool/cli';
import { loadPolicy, POLICY_PATH, resolve } from '@agenticool/policy';
import { check, generate } from './generate.mjs';
import { publishReview, ReviewNotPosted } from './review.mjs';

/** @typedef {import('@agenticool/cli').OptionDefinition} OptionDefinition */

/** @type {Record<string, OptionDefinition>} */
const OPTIONS = {
  tool: { type: 'string', description: 'claude or codex (resolve)' },
  role: { type: 'string', description: 'Role to resolve' },
  capability: { type: 'string', description: 'Capability to resolve' },
  model: { type: 'string', description: 'Model override (resolve)' },
  effort: { type: 'string', description: 'Effort override (resolve)' },
  pr: { type: 'string', description: 'Pull request number (publish-review)' },
  base: { type: 'string', description: 'Reviewed base SHA (publish-review)' },
  head: { type: 'string', description: 'Reviewed head SHA (publish-review)' },
  report: {
    type: 'string',
    description: 'Review report file (publish-review)',
  },
};
/** @type {Record<string, string[]>} */
const COMMAND_OPTIONS = {
  resolve: ['tool', 'role', 'capability', 'model', 'effort'],
  generate: [],
  check: [],
  'publish-review': ['pr', 'base', 'head', 'report'],
};
const USAGE =
  'Usage: agenticool-agents <resolve|generate|check|publish-review> [options]';

/** @param {string[]} names */
const optionsFor = (names) =>
  Object.fromEntries(names.map((name) => [name, OPTIONS[name]]));

/**
 * Runs one command and returns its exit code. Usage errors throw CliError,
 * help throws CliHelp, and every other failure throws its own error.
 * @param {string[]} args
 * @param {string} [base] the consumer repository root
 */
export function main(args, base = process.cwd()) {
  const [command, ...rest] = args;
  const commandHelp = defineCli(USAGE, OPTIONS);
  if (command === '--help' || command === '-h')
    throw new CliHelp(commandHelp.help);
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    console.error(
      cliError(
        commandHelp,
        command ? `Unknown command ${command}` : 'Name a command',
      ).message,
    );
    return 2;
  }
  const cli = defineCli(USAGE, optionsFor(COMMAND_OPTIONS[command]));
  const { options, positionals } = parseCli(rest, cli);
  /** @param {string} name */
  const option = (name) => /** @type {string | undefined} */ (options[name]);
  if (positionals.length) throw cliError(cli, 'Unexpected positional argument');
  if (command === 'resolve') {
    if (options.role && options.capability)
      throw cliError(cli, 'Use --role or --capability, not both');
    const policy = loadPolicy(base, {
      sections: ['binding', 'capabilities', 'roles', 'supported'],
    });
    const resolved = resolve(policy, {
      tool: option('tool'),
      role: option('role'),
      capability: option('capability'),
      model: option('model'),
      effort: option('effort'),
    });
    console.log(JSON.stringify(resolved, null, 2));
    return 0;
  }
  if (command === 'generate') {
    for (const path of generate(base)) console.log(path);
    return 0;
  }
  if (command === 'publish-review') {
    const reportPath = option('report');
    if (!reportPath) throw new ReviewNotPosted('--report <file> is required');
    let report;
    try {
      report = readFileSync(reportPath, 'utf8');
    } catch (error) {
      throw new ReviewNotPosted(
        `cannot read ${reportPath}: ${/** @type {Error} */ (error).message}`,
      );
    }
    let policy;
    try {
      policy = loadPolicy(base, { sections: ['binding'] });
    } catch (error) {
      throw new ReviewNotPosted(
        `cannot load ${POLICY_PATH}: ${/** @type {Error} */ (error).message}`,
      );
    }
    const result = publishReview(policy, {
      pr: option('pr'),
      base: option('base'),
      head: option('head'),
      report,
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const stale = check(base);
  if (!stale.length) return 0;
  console.error(
    `Generated agent definitions are out of date. Run \`npx agenticool-agents generate\` and commit:\n${stale.map((path) => `  ${path}`).join('\n')}`,
  );
  return 1;
}

/**
 * The bin entry point: prints help to stdout, every failure to stderr, and
 * sets the exit code.
 * @param {string[]} args
 */
export function run(args) {
  try {
    process.exitCode = main(args);
  } catch (error) {
    if (error instanceof CliHelp) console.log(error.message);
    else {
      console.error(/** @type {Error} */ (error).message);
      process.exitCode = 1;
    }
  }
}
