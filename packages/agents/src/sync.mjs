// Repository-file sync. `sync` writes the tracker templates, the shared
// AGENTS.md sections, the agent-local `.gitignore` entries, and optionally
// the browser MCP configuration into a consumer repository; `syncCheck` lists
// the files that differ from what `sync` would write.
//
// Whole files are rewritten. In AGENTS.md, `.gitignore`, and
// `.codex/config.toml`, sync owns only the lines between its markers, and
// every other line stays the repository's own.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { binding, loadPolicy } from '@agenticool/policy';
import { renderTemplate, TEMPLATES } from '@agenticool/tracker';
import { include, substitute } from './generate.mjs';

/** @typedef {Record<string, any>} Policy */

// The shared AGENTS.md sections, in the order a first sync appends them.
export const AGENTS_SECTIONS = [
  'checks',
  'delivery',
  'code',
  'workflows',
  'binding',
  'branches',
  'workflow-names',
];
export const AGENT_LOCAL_FILES = [
  '.claude/worktrees/',
  '.codex/worktrees/',
  'CLAUDE.local.md',
  '.claude/settings.local.json',
  '.claude/scheduled_tasks.lock',
];
// Both tools start the same stdio servers through `npx -y`.
export const BROWSER_MCP = {
  playwright: ['-y', '@playwright/mcp@latest', '--headless'],
  playwriter: ['-y', 'playwriter@latest'],
};

const AGENTS_TEMPLATES = new URL('../templates/agents-md/', import.meta.url);

/**
 * The begin and end lines of one marked block.
 * @param {string} name
 * @param {(text: string) => string} comment
 */
const markers = (name, comment) => [
  comment(`agenticool-agents sync: begin ${name}`),
  comment(`agenticool-agents sync: end ${name}`),
];
/** @param {string} text */
const html = (text) => `<!-- ${text} -->`;
/** @param {string} text */
const hash = (text) => `# ${text}`;

/**
 * Replaces the marked block `name` in `text` with `content`, or appends the
 * block at the end when the file has no such block yet.
 * @param {string} text
 * @param {string} name
 * @param {string} content without a trailing newline
 * @param {(text: string) => string} comment
 * @param {string} path for error messages
 */
export function replaceBlock(text, name, content, comment, path) {
  const [begin, end] = markers(name, comment);
  const block = `${begin}\n${content}\n${end}`;
  const lines = text.split('\n');
  const start = lines.indexOf(begin);
  const stop = lines.indexOf(end);
  if (start === -1 && stop === -1) {
    const kept = text.replace(/\n*$/, '');
    return kept ? `${kept}\n\n${block}\n` : `${block}\n`;
  }
  if (start === -1 || stop < start)
    throw new Error(`${path}: unbalanced sync markers for ${name}`);
  return [...lines.slice(0, start), block, ...lines.slice(stop + 1)].join('\n');
}

// Prettier keeps an array of short strings on one line, so the JSON sync
// writes passes a consumer's format check.
/** @param {unknown} value */
function json(value) {
  return `${JSON.stringify(value, null, 2).replace(
    /\[\n\s*((?:"(?:[^"\\\n]|\\.)*",?\s*)+)\]/g,
    (_, items) =>
      `[${JSON.parse(`[${items}]`)
        .map((/** @type {string} */ item) => JSON.stringify(item))
        .join(', ')}]`,
  )}\n`;
}

/**
 * @param {string} base
 * @param {string} path
 */
function read(base, path) {
  const target = join(base, path);
  return existsSync(target) ? readFileSync(target, 'utf8') : undefined;
}

/** @param {Policy} policy */
function labels(policy) {
  const catalog = JSON.parse(renderTemplate('labels.json', policy));
  /** @type {Map<string, { name: string }>} */
  const byName = new Map();
  for (const label of [...catalog.labels, ...(policy.labels?.extra ?? [])])
    byName.set(label.name, label);
  // Code point order, so the catalog does not depend on the locale.
  catalog.labels = [...byName.values()].sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  return json(catalog);
}

/** @param {string} directory under the tracker templates */
const templates = (directory) =>
  readdirSync(new URL(`${directory}/`, TEMPLATES))
    .filter((name) => name.endsWith('.yml'))
    .sort();

// The caller workflows that run on pull_request_target, which a workflow-lint
// policy has to list.
export const PULL_REQUEST_TARGET = templates('workflows').filter((name) =>
  readFileSync(new URL(`workflows/${name}`, TEMPLATES), 'utf8').includes(
    'pull_request_target:',
  ),
);

/**
 * Removes the `[mcp_servers.<name>]` tables sync is about to own, with their
 * subtables, so the file never defines one twice.
 * @param {string} text
 */
function withoutBrowserTables(text) {
  const owned = Object.keys(BROWSER_MCP);
  let skipping = false;
  return text
    .split('\n')
    .filter((line) => {
      const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?/);
      if (header)
        skipping = owned.some(
          (name) =>
            header[1] === `mcp_servers.${name}` ||
            header[1].startsWith(`mcp_servers.${name}.`),
        );
      return !skipping;
    })
    .join('\n');
}

/**
 * @param {Policy} policy
 * @param {string} base
 */
function agentsMd(policy, base) {
  let text = read(base, 'AGENTS.md') ?? '# Agent rules\n';
  for (const name of AGENTS_SECTIONS) {
    const source = readFileSync(
      new URL(`${name}.md`, AGENTS_TEMPLATES),
      'utf8',
    );
    text = replaceBlock(
      text,
      name,
      // Blank lines keep each heading apart from the HTML comment markers.
      `\n${substitute(include(source), policy).trimEnd()}\n`,
      html,
      'AGENTS.md',
    );
  }
  return text;
}

/**
 * Every synced file with the content `sync` writes, keyed by consumer-relative
 * path.
 * @param {string} [base] the consumer repository root
 */
export function renderSync(base = process.cwd()) {
  const policy = loadPolicy(base, { sections: ['binding'] });
  const { docs, features } = binding(policy);
  /** @type {Map<string, string>} */
  const files = new Map();
  files.set('.github/labels.json', labels(policy));
  for (const name of templates('ISSUE_TEMPLATE'))
    files.set(
      `.github/ISSUE_TEMPLATE/${name}`,
      renderTemplate(`ISSUE_TEMPLATE/${name}`, policy),
    );
  files.set(
    '.github/pull_request_template.md',
    renderTemplate('pull_request_template.md', policy),
  );
  files.set(docs.triage, renderTemplate('ISSUE_TRIAGE.md', policy));
  for (const name of templates('workflows'))
    files.set(
      `.github/workflows/${name}`,
      renderTemplate(`workflows/${name}`, policy),
    );
  files.set('AGENTS.md', agentsMd(policy, base));
  files.set(
    '.gitignore',
    replaceBlock(
      read(base, '.gitignore') ?? '',
      'agent-local',
      AGENT_LOCAL_FILES.join('\n'),
      hash,
      '.gitignore',
    ),
  );
  if (features.browserMcp) {
    const mcp = JSON.parse(read(base, '.mcp.json') ?? '{}');
    mcp.mcpServers = { ...mcp.mcpServers };
    for (const [name, args] of Object.entries(BROWSER_MCP))
      mcp.mcpServers[name] = { type: 'stdio', command: 'npx', args };
    files.set('.mcp.json', json(mcp));
    const config = read(base, '.codex/config.toml') ?? '';
    const [begin] = markers('browser-mcp', hash);
    files.set(
      '.codex/config.toml',
      replaceBlock(
        config.split('\n').includes(begin)
          ? config
          : withoutBrowserTables(config),
        'browser-mcp',
        Object.entries(BROWSER_MCP)
          .map(
            ([name, args]) =>
              `[mcp_servers.${name}]\ncommand = "npx"\nargs = ${JSON.stringify(args).replaceAll('","', '", "')}`,
          )
          .join('\n\n'),
        hash,
        '.codex/config.toml',
      ),
    );
  }
  return files;
}

/**
 * The `pull_request_target` caller workflows the policy's
 * `workflowLint.pullRequestTarget` does not list yet.
 * @param {string} [base]
 */
export function unlistedPullRequestTarget(base = process.cwd()) {
  const listed =
    loadPolicy(base).workflowLint?.pullRequestTarget ??
    /** @type {string[]} */ ([]);
  return PULL_REQUEST_TARGET.filter((name) => !listed.includes(name));
}

/**
 * Writes every synced file whose content differs and returns the sorted
 * paths of every synced file.
 * @param {string} [base]
 */
export function sync(base = process.cwd()) {
  const files = renderSync(base);
  for (const [path, content] of files) {
    if (read(base, path) === content) continue;
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
  return [...files.keys()].sort();
}

/**
 * The sorted paths of synced files that are missing or differ from what
 * `sync` would write.
 * @param {string} [base]
 */
export function syncCheck(base = process.cwd()) {
  return [...renderSync(base)]
    .filter(([path, content]) => read(base, path) !== content)
    .map(([path]) => path)
    .sort();
}
