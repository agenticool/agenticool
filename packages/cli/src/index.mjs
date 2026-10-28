// Command-line parsing on Node's built-in parser; no runtime dependency.
import { parseArgs } from 'node:util';

/**
 * @typedef {object} OptionDefinition
 * @property {'string' | 'boolean'} type
 * @property {string} [alias] Exact short spelling, without the leading dash.
 * @property {string} description Help text.
 */

/**
 * @typedef {object} Cli
 * @property {Record<string, OptionDefinition>} options
 * @property {Map<string, string>} aliases Option name for every accepted spelling.
 * @property {string} help
 * @property {boolean} passthrough
 */

/**
 * @typedef {object} ParsedCli
 * @property {Record<string, string | boolean>} options
 * @property {string[]} positionals
 * @property {string[]} passthrough Unrecognized tokens, in order, in passthrough mode.
 */

export class CliError extends Error {}
export class CliHelp extends Error {}

/** @type {OptionDefinition} */
const help = { type: 'boolean', alias: 'h', description: 'Show help' };

/**
 * @param {string} usage
 * @param {Record<string, OptionDefinition>} [definitions]
 * @param {{ passthrough?: boolean }} [settings] In passthrough mode, unknown
 *   tokens and everything from `--` on are returned in order instead of
 *   rejected, so a wrapper can forward them to another command.
 * @returns {Cli}
 */
export function defineCli(
  usage,
  definitions = {},
  { passthrough = false } = {},
) {
  /** @type {[string, OptionDefinition][]} */
  const entries = [['help', help], ...Object.entries(definitions)];
  /** @type {Map<string, string>} */
  const aliases = new Map();
  for (const [name, option] of entries) {
    for (const spelling of [
      `--${name}`,
      ...(option.alias ? [`-${option.alias}`] : []),
    ]) {
      if (aliases.has(spelling))
        throw new Error(`Duplicate CLI spelling ${spelling}`);
      aliases.set(spelling, name);
    }
  }
  const options = Object.fromEntries(entries);
  const text = `${usage}\n\nOptions:\n${entries
    .map(
      ([name, option]) =>
        `  --${name}${option.alias ? `, -${option.alias}` : ''}${option.type === 'string' ? ' <value>' : ''}  ${option.description}`,
    )
    .join(
      '\n',
    )}\n\nString options accept OPTION=value or OPTION value. Use = for values beginning with a dash.\nUse -- to end wrapper options. Short options are exact; they cannot be grouped.`;
  return { options, aliases, help: text, passthrough };
}

/**
 * @param {Cli} cli
 * @param {string} message
 */
export function cliError(cli, message) {
  return new CliError(`${message}\n\n${cli.help}`);
}

/**
 * @param {string[]} argv
 * @param {Cli} cli
 * @returns {ParsedCli}
 */
export function parseCli(argv, cli) {
  /** @type {string[]} */
  const normalized = [];
  /** @type {string[]} */
  const positionals = [];
  /** @type {string[]} */
  const passthrough = [];
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') {
      if (cli.passthrough) passthrough.push(...argv.slice(index));
      else positionals.push(...argv.slice(index + 1));
      break;
    }
    const equals = token.indexOf('=');
    const spelling = equals < 0 ? token : token.slice(0, equals);
    const name = cli.aliases.get(spelling);
    if (!name) {
      if (cli.passthrough) passthrough.push(token);
      else if (token.startsWith('-') && token !== '-')
        throw cliError(cli, `Unknown option ${spelling}`);
      else positionals.push(token);
      continue;
    }
    if (seen.has(name))
      throw cliError(cli, `--${name} is given more than once`);
    seen.add(name);
    const option = cli.options[name];
    if (option.type === 'string' && equals < 0) {
      const value = argv[index + 1];
      if (
        value === undefined ||
        value === '--' ||
        value.startsWith('--') ||
        cli.aliases.has(value.split('=')[0])
      )
        throw cliError(
          cli,
          `${spelling} requires a value; use ${spelling}=<value> for a value beginning with a dash`,
        );
      normalized.push(`--${name}=${value}`);
      index++;
    } else normalized.push(`--${name}${equals < 0 ? '' : token.slice(equals)}`);
  }
  /** @type {Record<string, string | boolean | undefined>} */
  let values;
  try {
    ({ values } = parseArgs({
      args: normalized,
      options: Object.fromEntries(
        Object.entries(cli.options).map(([name, option]) => [
          name,
          { type: option.type },
        ]),
      ),
      strict: true,
    }));
  } catch (error) {
    throw cliError(cli, /** @type {Error} */ (error).message);
  }
  for (const [name, value] of Object.entries(values)) {
    if (cli.options[name].type === 'string' && value === '')
      throw cliError(cli, `--${name} requires a value`);
  }
  if (values.help) throw new CliHelp(cli.help);
  return {
    options: /** @type {Record<string, string | boolean>} */ ({ ...values }),
    positionals,
    passthrough,
  };
}
