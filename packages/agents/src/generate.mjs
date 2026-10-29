// Agent definition generation. `generate` writes the Claude Code and Codex
// definitions into a consumer repository from the shared sources in this
// package plus the consumer's own local sources; `check` fails when a
// generated file is stale so the two tools cannot drift apart.
//
// The sources name no repository. The consumer's `policy.json` carries a
// `binding` (project, board documents, and feature flags), the origin remote
// names the repository, and every `{{placeholder}}` and
// `{{#feature}}...{{/feature}}` section in a source resolves against them.
// Shared roles and workflows carry the fixed `ac-` prefix in their names, so
// they never collide with a tool's built-in commands or a repository's own
// agents and skills; local sources keep the names the repository gives them.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  binding,
  loadPolicy,
  placeholders,
  POLICY_PATH,
  resolve,
  TOOLS,
} from '@agenticool/core';
import { parse, stringify } from 'yaml';

/** @typedef {Record<string, any>} Policy */

// Matches the Prettier style consumers use so generated YAML passes a format check.
const YAML_STYLE = { singleQuote: true, lineWidth: 0 };
export const SOURCES = fileURLToPath(new URL('../sources/', import.meta.url));
const SHARED = {
  roles: join(SOURCES, 'roles'),
  workflows: join(SOURCES, 'workflows'),
  includes: join(SOURCES, 'includes'),
};
const SHARED_PREFIX = 'ac-';
// How a generated header names a shared source.
const SHARED_LABEL = '@agenticool/agents/sources';
const OUTPUTS = {
  claude: { agents: '.claude/agents', skills: '.claude/skills' },
  codex: { agents: '.codex/agents', skills: '.agents/skills' },
};
// Repository-only sources, which may add a role or workflow.
const LOCAL = {
  roles: '.agents/local/roles',
  workflows: '.agents/local/workflows',
};

/** @param {string} base */
function load(base) {
  const policy = loadPolicy(base, { sections: ['binding.project'] });
  binding(policy);
  return policy;
}

// `{{#feature}}...{{/feature}}` keeps its content only when the binding
// enables that feature, and `{{#name}}...{{/name}}` on a placeholder only when
// its value is not empty, as for an empty list; sections may nest.
// `{{name}}` becomes the bound value; `\{{` is a literal `{{` for text that
// documents the placeholders themselves.
/**
 * @param {string} text
 * @param {Policy} policy
 */
export function substitute(text, policy) {
  const values = placeholders(policy);
  const features = binding(policy).features;
  const literal = '\u0000';
  /**
   * @param {string} content
   * @returns {string}
   */
  const resolveSections = (content) =>
    content.replace(
      /\{\{#([a-zA-Z.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
      (_, name, inner) => {
        if (!(name in features) && !(name in values))
          throw new Error(`Unknown feature section: ${name}`);
        const kept = name in features ? features[name] : values[name] !== '';
        return kept ? resolveSections(inner) : '';
      },
    );
  const sections = resolveSections(text.replaceAll('\\{{', literal));
  if (/\{\{[#/]/.test(sections))
    throw new Error('Unbalanced feature section in source');
  return sections
    .replace(/\{\{([a-zA-Z.]+)\}\}/g, (_, name) => {
      if (!(name in values)) throw new Error(`Unknown placeholder: ${name}`);
      return values[name];
    })
    .replaceAll(literal, '{{');
}

// Includes share text across sources, cannot nest, and stay literal when escaped.
/**
 * @param {string} text
 * @param {string} [directory]
 */
export function include(text, directory = SHARED.includes) {
  const expanded = text.replace(/(?<!\\)\{\{>([^}]*)\}\}/g, (tag, name) => {
    const path = join(directory, `${name.trim()}.md`);
    if (!/^ [a-z-]+$/.test(name) || !existsSync(path))
      throw new Error(`Unknown include: ${tag}`);
    const content = readFileSync(path, 'utf8').trimEnd();
    if (/(?<!\\)\{\{>/.test(content))
      throw new Error(`Nested include in includes/${name.trim()}.md`);
    return content;
  });
  if (/(?<!\\)\{\{>/.test(expanded))
    throw new Error('Malformed include in source');
  return expanded;
}

// Shared Markdown sources carry YAML frontmatter plus optional blocks that
// belong to one tool: <!-- claude-only --> ... <!-- /claude-only -->.
/** @param {string} text */
export function parseSource(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error('Source is missing frontmatter');
  // A plain (unquoted) scalar ends at ` #`, which YAML reads as a comment, so
  // `Use for "implement #N"` would lose everything after `implement` in both
  // tools without any error. Refuse the source instead of generating it.
  const truncated = match[1]
    .split('\n')
    .find((line) => /^\s*[\w-]+:\s+[^"'|>\s].*\s#/.test(line));
  if (truncated)
    throw new Error(
      `Quote the frontmatter value of ${truncated.trim().split(':')[0]}: a plain value ends at " #"`,
    );
  return {
    /** @type {Record<string, any>} */
    meta: parse(match[1]),
    body: text.slice(match[0].length),
  };
}

/**
 * @param {string} body
 * @param {string} tool
 */
export function renderBody(body, tool) {
  const other = TOOLS.find((name) => name !== tool);
  return body
    .replace(
      new RegExp(
        `<!-- ${other}-only -->\\n[\\s\\S]*?<!-- /${other}-only -->\\n?`,
        'g',
      ),
      '',
    )
    .replace(new RegExp(`<!-- /?${tool}-only -->\\n`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .concat('\n');
}

// Every generated file carries this text, which is how generate and check
// tell their own output from the repository's other agents and skills.
const GENERATED = 'by agenticool-agents. Edit the source and run';

/** @param {string} sourcePath */
function generated(sourcePath) {
  return `Generated from ${sourcePath} ${GENERATED} \`npx agenticool-agents generate\`.`;
}

/** @param {string} value */
function tomlString(value) {
  if (value.includes("'''"))
    throw new Error('Developer instructions cannot contain three quotes');
  return `'''\n${value}'''`;
}

/** @param {unknown} value */
function tomlValue(value) {
  return JSON.stringify(value);
}

/**
 * @param {Policy} policy
 * @param {string} name
 * @param {string} source
 * @param {string} tool
 * @param {string} [sourcePath] how the generated header names the source
 */
export function renderRole(
  policy,
  name,
  source,
  tool,
  sourcePath = `${SHARED_LABEL}/roles/${name}.md`,
) {
  const { meta, body } = parseSource(substitute(source, policy));
  if (meta.name !== name)
    throw new Error(`Role ${name} declares name ${meta.name}`);
  const settings = resolve(policy, { tool, role: name });
  const text = renderBody(body, tool);
  if (tool === 'claude') {
    // Claude resolves a per-invocation model or effort above frontmatter, so
    // pinning the policy here keeps the repository default without blocking
    // a prompt override.
    const frontmatter = {
      name,
      description: meta.description,
      ...(meta.claude ?? {}),
      model: settings.model,
      effort: settings.effort,
    };
    return `---\n${stringify(frontmatter, YAML_STYLE).trimEnd()}\n---\n<!-- ${generated(sourcePath)} -->\n\n${text}`;
  }
  // A Codex agent file that sets model or model_reasoning_effort beats every
  // spawn-time value, which would defeat prompt overrides. The dispatcher
  // passes the resolved policy to spawn_agent instead.
  const lines = [
    `# ${generated(sourcePath)}`,
    '# Model and reasoning effort are intentionally absent: the skills pass the',
    `# repository policy (${settings.model}, ${settings.effort}) or a prompt override to spawn_agent.`,
    `name = ${tomlValue(name)}`,
    `description = ${tomlValue(meta.description)}`,
  ];
  for (const [key, value] of Object.entries(meta.codex ?? {}))
    lines.push(`${key} = ${tomlValue(value)}`);
  lines.push(`developer_instructions = ${tomlString(text)}`);
  return lines.join('\n') + '\n';
}

/**
 * @param {Policy} policy
 * @param {string} name
 * @param {string} source
 * @param {string} tool
 * @param {string} [sourcePath] how the generated header names the source
 * @returns {Record<string, string>}
 */
export function renderWorkflow(
  policy,
  name,
  source,
  tool,
  sourcePath = `${SHARED_LABEL}/workflows/${name}.md`,
) {
  const { meta, body } = parseSource(substitute(source, policy));
  if (meta.name !== name)
    throw new Error(`Workflow ${name} declares name ${meta.name}`);
  const text = renderBody(body, tool);
  /** @type {Record<string, string>} */
  const files = {};
  if (tool === 'claude') {
    /** @type {Record<string, unknown>} */
    const frontmatter = {
      name,
      description: meta.description,
      ...(meta['argument-hint']
        ? { 'argument-hint': meta['argument-hint'] }
        : {}),
      ...(meta.claude ?? {}),
    };
    if (meta.capability) {
      // A skill runs in the main thread; Claude lets its frontmatter pin the
      // model and effort for that turn, so the policy applies here directly.
      const settings = resolve(policy, { tool, capability: meta.capability });
      frontmatter.model = settings.model;
      frontmatter.effort = settings.effort;
    }
    files['SKILL.md'] =
      `---\n${stringify(frontmatter, YAML_STYLE).trimEnd()}\n---\n<!-- ${generated(sourcePath)} -->\n\n${text}`;
    return files;
  }
  const codex = meta.codex ?? {};
  files['SKILL.md'] =
    `---\nname: ${name}\ndescription: ${JSON.stringify(meta.description)}\n---\n<!-- ${generated(sourcePath)} -->\n\n${text}`;
  const manifest = {
    interface: {
      display_name: codex.display_name ?? `${binding(policy).label}: ${name}`,
      short_description: codex.short_description ?? meta.description,
      default_prompt: codex.default_prompt ?? `Use $${name} for this request.`,
    },
    policy: {
      allow_implicit_invocation: codex.allow_implicit_invocation ?? true,
    },
  };
  files['agents/openai.yaml'] =
    `# ${generated(sourcePath)}\n${stringify(manifest, YAML_STYLE)}`;
  return files;
}

/** @param {string} directory */
function listSources(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => entry.slice(0, -3))
    .sort();
}

/**
 * @param {string} directory
 * @returns {string[]}
 */
function listFiles(directory) {
  if (!existsSync(directory)) return [];
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files.sort();
}

// Shared sources plus the consumer's local ones of one kind. A local source
// may add a role or workflow but never take the prefix reserved for shared
// ones, so it can never replace one.
/**
 * @param {string} base
 * @param {'roles' | 'workflows'} kind
 * @param {string} local consumer-relative directory
 */
function sources(base, kind, local) {
  /** @type {Map<string, { directory: string, label: string }>} */
  const found = new Map();
  for (const name of listSources(SHARED[kind]))
    found.set(name, {
      directory: SHARED[kind],
      label: `${SHARED_LABEL}/${kind}`,
    });
  for (const name of listSources(join(base, local))) {
    if (name.startsWith(SHARED_PREFIX))
      throw new Error(
        `Local ${kind.slice(0, -1)} ${name} in ${local} uses the ${SHARED_PREFIX} prefix reserved for shared ones; rename it`,
      );
    found.set(name, { directory: join(base, local), label: local });
  }
  return found;
}

// Everything the generator owns, keyed by consumer-relative path.
export function render(base = process.cwd()) {
  const policy = load(base);
  for (const [name, capability] of Object.entries(policy.roles))
    for (const tool of TOOLS) resolve(policy, { tool, role: name, capability });
  for (const name of Object.keys(policy.capabilities))
    for (const tool of TOOLS) resolve(policy, { tool, capability: name });
  /** @type {Map<string, string>} */
  const files = new Map();
  const roles = sources(base, 'roles', LOCAL.roles);
  for (const [name, { directory, label }] of roles) {
    if (!policy.roles[name])
      throw new Error(`Role ${name} has no entry in ${POLICY_PATH}`);
    const source = include(readFileSync(join(directory, `${name}.md`), 'utf8'));
    const sourcePath = `${label}/${name}.md`;
    files.set(
      `${OUTPUTS.claude.agents}/${name}.md`,
      renderRole(policy, name, source, 'claude', sourcePath),
    );
    files.set(
      `${OUTPUTS.codex.agents}/${name}.toml`,
      renderRole(policy, name, source, 'codex', sourcePath),
    );
  }
  for (const name of Object.keys(policy.roles))
    if (!roles.has(name))
      throw new Error(
        `Role ${name} has no source in ${SHARED_LABEL}/roles or ${LOCAL.roles}`,
      );
  const workflows = sources(base, 'workflows', LOCAL.workflows);
  for (const [name, { directory, label }] of workflows) {
    const source = include(readFileSync(join(directory, `${name}.md`), 'utf8'));
    const shared = join(directory, name);
    for (const tool of /** @type {('claude' | 'codex')[]} */ (TOOLS)) {
      const target = `${OUTPUTS[tool].skills}/${name}`;
      for (const [file, content] of Object.entries(
        renderWorkflow(policy, name, source, tool, `${label}/${name}.md`),
      ))
        files.set(`${target}/${file}`, content);
      // Supporting references are copied into both skills with the same
      // includes and placeholders resolved. Markdown references keep only this
      // tool's tool-only blocks, so one reference can carry both tools' steps.
      for (const file of listFiles(shared)) {
        const text = substitute(include(readFileSync(file, 'utf8')), policy);
        files.set(
          `${target}/${relative(shared, file)}`,
          file.endsWith('.md') ? renderBody(text, tool) : text,
        );
      }
    }
  }
  // The shared rules that roles and skills name by path, such as
  // `.agents/review.md`, land where those paths point.
  for (const name of listSources(SOURCES))
    files.set(
      `.agents/${name}.md`,
      substitute(
        include(readFileSync(join(SOURCES, `${name}.md`), 'utf8')),
        policy,
      ),
    );
  return files;
}

/** @param {string} path */
const isGenerated = (path) =>
  existsSync(path) && readFileSync(path, 'utf8').includes(GENERATED);

// Generated agents, and every file of a skill whose SKILL.md is generated.
/** @param {string} base */
function ownedFiles(base) {
  /** @type {string[]} */
  const owned = [];
  for (const tool of /** @type {('claude' | 'codex')[]} */ (TOOLS)) {
    for (const file of listFiles(join(base, OUTPUTS[tool].agents)))
      if (isGenerated(file)) owned.push(relative(base, file));
    const skills = join(base, OUTPUTS[tool].skills);
    if (existsSync(skills))
      for (const entry of readdirSync(skills))
        if (isGenerated(join(skills, entry, 'SKILL.md')))
          for (const file of listFiles(join(skills, entry)))
            owned.push(relative(base, file));
  }
  return owned.sort();
}

export function generate(base = process.cwd()) {
  const files = render(base);
  // With generic names, a contributor's own agent or skill can sit at a
  // generated path; refuse to overwrite it.
  const targets = new Set();
  for (const path of files.keys()) {
    const skill = path.match(/^\.(?:claude|agents)\/skills\/[^/]+/);
    if (skill) targets.add(skill[0]);
    else if (/^\.(?:claude|codex)\/agents\//.test(path)) targets.add(path);
  }
  for (const target of targets) {
    const full = join(base, target);
    const owned = /\.(?:md|toml)$/.test(target) ? full : join(full, 'SKILL.md');
    if (existsSync(full) && !isGenerated(owned))
      throw new Error(
        `${target} exists and was not generated by agenticool-agents; rename it, or move its source into .agents/local/ so generate owns it`,
      );
  }
  for (const path of ownedFiles(base))
    if (!files.has(path)) rmSync(join(base, path));
  for (const [path, content] of files) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
  return [...files.keys()].sort();
}

export function check(base = process.cwd()) {
  const files = render(base);
  const stale = [];
  for (const [path, content] of files) {
    const target = join(base, path);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== content)
      stale.push(path);
  }
  for (const path of ownedFiles(base)) if (!files.has(path)) stale.push(path);
  return stale.sort();
}
