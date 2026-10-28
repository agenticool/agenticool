// Loading and validating `.agents/policy.json`, plus the binding helpers that
// read repository facts from it. Every package declares the sections it uses,
// so a repository configures only what its installed packages read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** @type {Schema} */
export const schema = JSON.parse(
  readFileSync(new URL('./policy.schema.json', import.meta.url), 'utf8'),
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
 * Reads `<base>/.agents/policy.json` and validates it for `sections`.
 * @param {string} [base]
 * @param {{ sections?: string[] }} [options]
 * @returns {Policy}
 */
export function loadPolicy(base = process.cwd(), options = {}) {
  const policy = JSON.parse(readFileSync(join(base, POLICY_PATH), 'utf8'));
  return validatePolicy(policy, options);
}

/** @param {string} path */
const missing = (path) => new Error(`policy.json binding is missing ${path}`);

/** @param {Policy} policy */
export function prefix(policy) {
  const namespace = policy.binding?.namespace;
  if (typeof namespace !== 'string' || !namespace)
    throw missing(policy.binding ? 'namespace' : 'binding');
  if (!/^[a-z][a-z0-9]*$/.test(namespace))
    throw new Error(
      `policy.json binding.namespace must be lowercase letters and digits, got "${namespace}"`,
    );
  return `${namespace}-`;
}

/** @param {Policy} policy */
export function repository(policy) {
  const value = policy.binding?.repository;
  if (typeof value !== 'string' || !value) throw missing('repository');
  return value;
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

/** @param {Policy} policy */
export function tokenEnv(policy) {
  const value = policy.binding?.tokenEnv;
  if (typeof value !== 'string' || !value) throw missing('tokenEnv');
  return value;
}

// The full binding the agent sources need: a missing key would otherwise
// surface as a literal placeholder inside an agent prompt.
/** @param {Policy} policy */
export function binding(policy) {
  const value = policy.binding;
  if (!value) throw missing('binding');
  prefix(policy);
  if (typeof value.label !== 'string' || !value.label) throw missing('label');
  repository(policy);
  project(policy);
  const docs = value.docs ?? {};
  for (const key of ['triage', 'workflow'])
    if (typeof docs[key] !== 'string' || !docs[key])
      throw missing(`docs.${key}`);
  if (!Array.isArray(docs.guides) || docs.guides.length === 0)
    throw missing('docs.guides');
  if (typeof value.features?.infrastructure !== 'boolean')
    throw missing('features.infrastructure');
  return value;
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
    prefix: prefix(policy),
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
