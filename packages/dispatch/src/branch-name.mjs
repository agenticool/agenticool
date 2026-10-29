import {
  cliError,
  defineCli,
  parseCli,
  ghRest,
  originRepository,
} from '@agenticool/core';

const MAX_SLUG = 40;
// Titles with no ASCII letters or digits still need a usable slug.
const FALLBACK_SLUG = 'issue';
const NUMBER = '[1-9][0-9]*';
const POSITIVE_INTEGER = new RegExp(`^${NUMBER}$`);
const ACTOR = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const CANONICAL = new RegExp(
  `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/${NUMBER}-(?!part-[0-9]+(?:-|$))[a-z0-9]+(?:-(?!part-[0-9]+(?:-|$))[a-z0-9]+)*(?:-part-(?:[2-9]|[1-9][0-9]+))?$`,
);
const USAGE =
  'Usage: agenticool-dispatch branch-name <issue> [--layer <n>] [--actor <login>]';

/** @param {unknown} title */
export function slugify(title) {
  const words = String(title)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // Join "part N" into "partN" so a title never reads as a stack layer suffix.
  const joined = [];
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] === 'part' && /^[0-9]+$/.test(words[index + 1] ?? ''))
      joined.push(`part${words[++index]}`);
    else joined.push(words[index]);
  }
  let slug = '';
  for (const word of joined) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_SLUG) {
      // Never split a word, unless the first word alone is too long.
      if (!slug) slug = word.slice(0, MAX_SLUG);
      break;
    }
    slug = next;
  }
  return slug || FALLBACK_SLUG;
}

/** @param {unknown} name */
export function isCanonicalBranch(name) {
  return typeof name === 'string' && CANONICAL.test(name);
}

/**
 * @param {{ issue: number | string, title: string, actor?: string, layer?: number }} options
 */
export function branchName({ issue, title, actor = 'agent', layer = 1 }) {
  if (!POSITIVE_INTEGER.test(String(issue)))
    throw new Error('Issue must be a positive number');
  if (!ACTOR.test(actor)) throw new Error('Actor must be a GitHub login');
  if (!Number.isInteger(layer) || layer < 1)
    throw new Error('Layer must be a positive integer');
  const suffix = layer > 1 ? `-part-${layer}` : '';
  const name = `${actor.toLowerCase()}/${issue}-${slugify(title)}${suffix}`;
  if (!isCanonicalBranch(name)) throw new Error(`Not a valid branch: ${name}`);
  return name;
}

const CLI = defineCli(USAGE, {
  layer: {
    type: 'string',
    description: 'Stack layer; 2 and up add a -part-<n> suffix (default 1)',
  },
  actor: {
    type: 'string',
    description: 'GitHub login that prefixes the branch (default agent)',
  },
});

/** @param {string[]} argv */
export function parseArguments(argv) {
  const { options, positionals } = parseCli(argv, CLI);
  if (positionals.length > 1) throw cliError(CLI, 'Too many arguments');
  const layer = /** @type {string | undefined} */ (options.layer);
  if (layer !== undefined && !POSITIVE_INTEGER.test(layer))
    throw cliError(CLI, '--layer requires a positive integer');
  return {
    actor: /** @type {string} */ (options.actor ?? 'agent'),
    layer: Number(layer ?? 1),
    value: positionals[0],
  };
}

// Returns an issue with a title, or throws a readable error.
/**
 * @param {(args: string[]) => string} api
 * @param {string} repo
 * @param {string} number
 */
function lookupIssue(api, repo, number) {
  let found;
  try {
    found = JSON.parse(api([`repos/${repo}/issues/${number}`]));
  } catch (/** @type {any} */ error) {
    if (error?.httpStatus === 404)
      throw new Error(`Issue #${number} was not found`, { cause: error });
    throw error;
  }
  if (!found || typeof found !== 'object')
    throw new Error(`Issue #${number} was not found`);
  if (found.pull_request)
    throw new Error(`#${number} is a pull request, not an issue`);
  if (typeof found.title !== 'string' || !found.title.trim())
    throw new Error(`Issue #${number} has no title`);
  return found;
}

/**
 * Prints the branch name for `<issue>`; the repository comes from the origin
 * remote of `base`.
 * @param {string[]} argv
 * @param {{ api?: (args: string[]) => string, base?: string }} [options]
 */
export function run(argv, { api = ghRest, base } = {}) {
  const options = parseArguments(argv);
  if (!options.value) throw new Error(USAGE);
  if (!POSITIVE_INTEGER.test(options.value))
    throw new Error('Issue must be a positive number');
  const repo = originRepository(base);
  const { title } = lookupIssue(api, repo, options.value);
  return branchName({
    issue: options.value,
    title,
    actor: options.actor,
    layer: options.layer,
  });
}
