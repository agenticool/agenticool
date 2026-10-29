// Loading and validating `.agents/policy.json`, plus the binding helpers that
// read repository facts from it and from the origin remote. Every package
// declares the sections it uses, so a repository configures only what its
// installed packages read.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_TOKEN } from './github.mjs';

/**
 * @typedef {{
 *   type?: string,
 *   enum?: unknown[],
 *   pattern?: string,
 *   minLength?: number,
 *   minimum?: number,
 *   minItems?: number,
 *   items?: Schema,
 *   required?: string[],
 *   properties?: Record<string, Schema>,
 *   additionalProperties?: Schema | false,
 *   default?: unknown,
 *   $ref?: string,
 *   $defs?: Record<string, Schema>,
 * }} Schema
 * @typedef {Record<string, any>} Policy
 */

export const POLICY_PATH = '.agents/policy.json';

// Keys earlier policies carried, with what replaced each one.
const REMOVED = {
  'binding.namespace':
    'generated agents and skills have no repository prefix; delete it',
  'binding.repository':
    'the repository comes from the origin remote; delete it',
  'binding.tokenEnv': `the Projects token is always the ${PROJECT_TOKEN} secret and environment variable; delete it`,
  local:
    'repository-only sources always live in .agents/local/roles and .agents/local/workflows; delete it',
};

/** @type {Schema} */
export const schema = JSON.parse(
  readFileSync(new URL('./policy.schema.json', import.meta.url), 'utf8'),
);

// The model, effort, role, and rubric defaults every repository gets.
/** @type {Policy} */
export const DEFAULTS = JSON.parse(
  readFileSync(new URL('./defaults.json', import.meta.url), 'utf8'),
);

/** @type {Record<string, (value: unknown) => boolean>} */
const TYPES = {
  object: (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
  array: Array.isArray,
  string: (value) => typeof value === 'string',
  integer: Number.isInteger,
  boolean: (value) => typeof value === 'boolean',
};

// Covers only the keywords the shipped schema uses, so validation needs no
// third-party dependency. Missing properties with a default are filled in.
/**
 * @param {Schema} node
 * @param {any} value
 * @param {string} path
 */
function check(node, value, path) {
  if (node.$ref)
    return check(
      /** @type {Schema} */ (
        schema.$defs?.[node.$ref.slice('#/$defs/'.length)]
      ),
      value,
      path,
    );
  /** @param {string} problem */
  const fail = (problem) => {
    throw new Error(`policy.json ${path || 'root'} ${problem}`);
  };
  if (node.type && !TYPES[node.type](value)) fail(`must be ${node.type}`);
  if (node.enum && !node.enum.includes(value))
    fail(`must be one of ${node.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (value.length < (node.minLength ?? 0)) fail('must not be empty');
    if (node.pattern && !new RegExp(node.pattern).test(value))
      fail(`must match ${node.pattern}`);
  }
  if (node.minimum !== undefined && value < node.minimum)
    fail(`must be at least ${node.minimum}`);
  if (Array.isArray(value)) {
    if (value.length < (node.minItems ?? 0))
      fail(`needs at least ${node.minItems} item`);
    if (node.items)
      for (const [index, item] of value.entries())
        check(node.items, item, `${path}[${index}]`);
  }
  if (!TYPES.object(value)) return;
  for (const key of node.required ?? [])
    if (!(key in value)) fail(`is missing ${key}`);
  for (const [key, property] of Object.entries(node.properties ?? {}))
    if (!(key in value) && 'default' in property)
      value[key] = structuredClone(property.default);
  for (const [key, item] of Object.entries(value)) {
    const property = node.properties?.[key] ?? node.additionalProperties;
    if (property === false) fail(`has unknown key ${key}`);
    if (property) check(property, item, path ? `${path}.${key}` : key);
  }
}

/**
 * Validates a parsed policy against the schema, fills in defaults, and
 * requires each dotted `sections` path, such as `binding.project`.
 * @param {Policy} policy
 * @param {{ sections?: string[] }} [options]
 */
export function validatePolicy(policy, { sections = [] } = {}) {
  for (const [path, replacement] of Object.entries(REMOVED)) {
    const [first, second] = path.split('.');
    if (second ? policy.binding?.[second] !== undefined : first in policy)
      throw new Error(`policy.json ${path} is no longer read: ${replacement}`);
  }
  check(schema, policy, '');
  for (const section of sections) {
    let node = schema;
    let value = policy;
    for (const key of section.split('.')) {
      const next = node.properties?.[key];
      if (!next) throw new Error(`Unknown policy section: ${section}`);
      node = next;
      value = value?.[key];
    }
    if (value === undefined)
      throw new Error(`policy.json is missing ${section}`);
  }
  return policy;
}

/**
 * Fills a policy's model and effort sections from DEFAULTS. A repository's
 * own capabilities and roles override by name, supported models by tool, and
 * its rubric replaces the default as a whole.
 * @param {Policy} policy
 */
export function withDefaults(policy) {
  const defaults = structuredClone(DEFAULTS);
  for (const key of ['capabilities', 'roles', 'supported'])
    policy[key] = { ...defaults[key], ...policy[key] };
  policy.implementationEffort ??= defaults.implementationEffort;
  return policy;
}

/**
 * Reads `<base>/.agents/policy.json`, validates it for `sections`, and fills
 * in DEFAULTS. The policy remembers `base`, whose origin remote names the
 * repository.
 * @param {string} [base]
 * @param {{ sections?: string[] }} [options]
 * @returns {Policy}
 */
export function loadPolicy(base = process.cwd(), options = {}) {
  const policy = JSON.parse(readFileSync(join(base, POLICY_PATH), 'utf8'));
  return Object.defineProperty(
    withDefaults(validatePolicy(policy, options)),
    'base',
    { value: base },
  );
}

/**
 * `owner/name` of the GitHub repository that `base`'s origin remote points at.
 * @param {string} [base]
 */
export function originRepository(base = process.cwd()) {
  let url;
  try {
    url = execFileSync('git', ['-C', base, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(
      `Cannot read the origin remote in ${base}; run from a clone of the GitHub repository`,
    );
  }
  const match = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if (!match)
    throw new Error(`The origin remote in ${base} is not a GitHub repository`);
  return match[1];
}

/** @param {string} path */
const missing = (path) => new Error(`policy.json binding is missing ${path}`);

// Read once from the origin remote of the directory the policy came from;
// a caller that already knows the repository sets `policy.repository`.
/** @param {Policy} policy */
export function repository(policy) {
  policy.repository ??= originRepository(policy.base);
  return /** @type {string} */ (policy.repository);
}

/**
 * @param {Policy} policy
 * @returns {{ owner: string, ownerType: 'user' | 'organization', number: number, name: string }}
 */
export function project(policy) {
  const value = policy.binding?.project ?? {};
  if (typeof value.owner !== 'string' || !value.owner)
    throw missing('project.owner');
  if (!Number.isInteger(value.number) || value.number < 1)
    throw missing('project.number');
  if (typeof value.name !== 'string' || !value.name)
    throw missing('project.name');
  return { ...value, ownerType: value.ownerType ?? 'user' };
}

// The full binding the agent sources need, with the label and repository
// filled in: a missing key would otherwise surface as a literal placeholder
// inside an agent prompt.
/** @param {Policy} policy */
export function binding(policy) {
  const value = policy.binding;
  if (!value) throw missing('binding');
  project(policy);
  const repo = repository(policy);
  return {
    ...value,
    label: value.label ?? repo.split('/')[1],
    repository: repo,
  };
}

/**
 * @param {string[]} items
 * @param {string} [conjunction]
 */
function listPhrase(items, conjunction = 'or') {
  const quoted = items.map((item) => `\`${item}\``);
  if (quoted.length <= 2) return quoted.join(` ${conjunction} `);
  return `${quoted.slice(0, -1).join(', ')}, ${conjunction} ${quoted.at(-1)}`;
}

// Placeholders a source may use. Anything else is an error, so a typo never
// reaches a generated prompt. A list placeholder is empty when its list is.
/**
 * @param {Policy} policy
 * @returns {Record<string, string>}
 */
export function placeholders(policy) {
  const value = binding(policy);
  const board = project(policy);
  const owners = board.ownerType === 'organization' ? 'orgs' : 'users';
  return {
    label: value.label,
    repository: value.repository,
    'project.owner': board.owner,
    'project.number': String(board.number),
    'project.name': board.name,
    'project.url': `https://github.com/${owners}/${board.owner}/projects/${board.number}`,
    'project.restPath': `${owners}/${board.owner}/projectsV2/${board.number}`,
    'docs.triage': value.docs.triage,
    'docs.workflow': value.docs.workflow,
    'docs.guides': listPhrase(value.docs.guides),
    'infrastructure.accountChecks': listPhrase(
      value.infrastructure?.accountChecks ?? [],
      'and',
    ),
  };
}
