import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderTemplate, TEMPLATES } from '@agenticool/tracker';
import {
  AGENT_LOCAL_FILES,
  AGENTS_SECTIONS,
  generate,
  main,
  PULL_REQUEST_TARGET,
  render,
  renderSync,
  replaceBlock,
  SOURCES,
  sync,
  syncCheck,
} from '@agenticool/agents';
import { consumer, other, policy, PREFIX, section } from './helpers.mjs';

/** @typedef {Record<string, any>} Policy */

const BIN = fileURLToPath(
  new URL('../bin/agenticool-agents.mjs', import.meta.url),
);

/**
 * The fixture policy with the keys sync needs, plus `features` overrides.
 * @param {Policy} value
 * @param {Record<string, boolean>} [features]
 * @returns {Policy}
 */
const bound = (value, features = {}) => ({
  ...value,
  binding: {
    ...value.binding,
    tokenEnv: 'PROJECT_TOKEN',
    features: { ...value.binding.features, ...features },
  },
});

/**
 * @param {string} base
 * @param {string} path
 */
const read = (base, path) => readFileSync(join(base, path), 'utf8');

const SYNCED = [
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/container.yml',
  '.github/ISSUE_TEMPLATE/epic.yml',
  '.github/ISSUE_TEMPLATE/task.yml',
  '.github/labels.json',
  '.github/pull_request_template.md',
  '.github/workflows/tracker-issue-states.yml',
  '.github/workflows/tracker-pr-issue-status.yml',
  '.github/workflows/tracker-pr-metadata.yml',
  '.github/workflows/tracker-project-membership.yml',
  '.gitignore',
  'AGENTS.md',
];

const gitignoreBlock = [
  '# agenticool-agents sync: begin agent-local',
  ...AGENT_LOCAL_FILES,
  '# agenticool-agents sync: end agent-local',
].join('\n');

// Runs `main` in this process and returns its exit code and printed lines.
/**
 * @param {string[]} args
 * @param {string} base
 */
function capture(args, base) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const log = mock.method(console, 'log', (/** @type {string} */ line) => {
    out.push(line);
  });
  const error = mock.method(console, 'error', (/** @type {string} */ line) => {
    err.push(line);
  });
  try {
    return {
      status: main(args, base),
      stdout: out.join('\n'),
      stderr: err.join('\n'),
    };
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
}

test('a first sync writes the tracker templates, the AGENTS.md sections, and the .gitignore block', () => {
  const value = bound(other);
  value.labels = {
    extra: [
      { name: 'area: web', color: '1d76db', description: 'The web app' },
      { name: 'bug', color: '000000', description: 'Repository wording' },
    ],
  };
  const base = consumer(value);
  assert.deepEqual(sync(base), [...SYNCED, 'TRIAGE.md'].sort());
  for (const name of ['bug', 'config', 'container', 'epic', 'task'])
    assert.equal(
      read(base, `.github/ISSUE_TEMPLATE/${name}.yml`),
      renderTemplate(`ISSUE_TEMPLATE/${name}.yml`, value),
    );
  for (const name of PULL_REQUEST_TARGET)
    assert.equal(
      read(base, `.github/workflows/${name}`),
      renderTemplate(`workflows/${name}`, value),
    );
  assert.match(
    read(base, '.github/workflows/tracker-pr-metadata.yml'),
    /token_env: 'PROJECT_TOKEN'/,
  );
  assert.equal(
    read(base, '.github/pull_request_template.md'),
    renderTemplate('pull_request_template.md', value),
  );
  assert.equal(
    read(base, 'TRIAGE.md'),
    renderTemplate('ISSUE_TRIAGE.md', value),
  );
  // The base catalog plus labels.extra, sorted, with an extra label replacing
  // the base label of the same name.
  const catalog = JSON.parse(read(base, '.github/labels.json'));
  const base_ = JSON.parse(renderTemplate('labels.json', value));
  assert.equal(catalog.repository, 'example/other');
  const names = catalog.labels.map((/** @type {any} */ label) => label.name);
  assert.deepEqual(names, [...names].sort());
  assert.equal(names.length, base_.labels.length + 1);
  assert.deepEqual(
    catalog.labels.find((/** @type {any} */ label) => label.name === 'bug'),
    value.labels.extra[1],
  );
  assert.ok(names.includes('area: web'));

  const agents = read(base, 'AGENTS.md');
  assert.ok(agents.startsWith('# Agent rules\n\n<!-- agenticool-agents'));
  assert.doesNotMatch(agents, /\{\{/);
  const order = AGENTS_SECTIONS.map((name) =>
    agents.indexOf(`<!-- agenticool-agents sync: begin ${name} -->\n\n## `),
  );
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  for (const heading of [
    'Checks',
    'Autonomous delivery',
    'Code and comments',
    'Repository agent workflows',
    'Delivery binding',
    'Branch names',
  ])
    section(agents, heading);
  assert.match(agents, /`\/other-implement` \| `\$other-implement` \|/);
  assert.match(
    agents,
    /^Repo `example\/other`, trunk `main`, project \[Other delivery\]\(https:\/\/github\.com\/users\/example\/projects\/7\)\.$/m,
  );
  assert.match(agents, /as `TRIAGE\.md` defines/);
  assert.match(agents, /`npx agenticool-delivery branch-name <issue>`/);
  // The infrastructure feature section follows the binding.
  assert.doesNotMatch(agents, /infrastructure applies/);
  const infra = consumer(bound(other, { infrastructure: true }));
  sync(infra);
  assert.match(
    read(infra, 'AGENTS.md'),
    /Merges, deployments, infrastructure applies, destructive operations/,
  );

  assert.equal(read(base, '.gitignore'), `${gitignoreBlock}\n`);
  assert.deepEqual(syncCheck(base), []);
});

test('the repository that hosts the reusable workflows calls them locally', () => {
  const value = bound(other);
  value.binding.repository = 'agenticool/agenticool';
  const base = consumer(value);
  sync(base);
  for (const name of [
    'tracker-issue-states.yml',
    'tracker-pr-issue-status.yml',
    'tracker-pr-metadata.yml',
    'tracker-project-membership.yml',
  ]) {
    const text = read(base, `.github/workflows/${name}`);
    const calls = [...text.matchAll(/^\s*uses: (.+)$/gm)].map(
      ([, uses]) => uses,
    );
    assert.ok(calls.length > 0, name);
    for (const uses of calls)
      assert.match(
        uses,
        /^\.\/\.github\/workflows\/_tracker-[a-z-]+\.yml$/,
        name,
      );
    assert.equal(
      text.replaceAll(/uses: \.\/(\S+)/g, 'uses: agenticool/agenticool/$1@X'),
      renderTemplate(`workflows/${name}`, value).replaceAll(
        /@tracker-v\S+/g,
        '@X',
      ),
    );
  }
  assert.deepEqual(syncCheck(base), []);
  // Any other repository keeps the release pin.
  const pinned = consumer(bound(other));
  sync(pinned);
  assert.match(
    read(pinned, '.github/workflows/tracker-pr-metadata.yml'),
    /uses: agenticool\/agenticool\/\.github\/workflows\/_tracker-pr-metadata\.yml@tracker-v/,
  );
});

test('with features.browserMcp, the .gitignore block also ignores .playwright-mcp/', () => {
  const base = consumer(bound(policy, { browserMcp: true }));
  sync(base);
  assert.equal(
    read(base, '.gitignore'),
    `${gitignoreBlock.replace('\n# agenticool-agents sync: end', '\n.playwright-mcp/\n# agenticool-agents sync: end')}\n`,
  );
  const plain = consumer(bound(policy));
  sync(plain);
  assert.doesNotMatch(read(plain, '.gitignore'), /playwright/);
});

test('a second sync changes nothing', () => {
  const base = consumer(bound(policy, { browserMcp: true }), {
    'AGENTS.md': '# Rules\n\nOwn text.\n',
    '.gitignore': 'node_modules/\n',
    '.codex/config.toml': 'model = "x"\n',
    '.mcp.json': '{"mcpServers": {"other": {"command": "x"}}}\n',
  });
  const paths = sync(base);
  const first = new Map(paths.map((path) => [path, read(base, path)]));
  assert.deepEqual(sync(base), paths);
  for (const [path, content] of first)
    assert.equal(read(base, path), content, path);
  assert.deepEqual(syncCheck(base), []);
});

test('check reports every missing, edited, or outdated synced file', () => {
  const value = bound(policy);
  const base = consumer(value);
  assert.deepEqual(syncCheck(base), [...SYNCED, 'ISSUE_TRIAGE.md'].sort());
  sync(base);
  rmSync(join(base, '.github/workflows/tracker-pr-metadata.yml'));
  writeFileSync(
    join(base, 'AGENTS.md'),
    read(base, 'AGENTS.md').replace('## Branch names', '## Branches'),
  );
  writeFileSync(
    join(base, '.gitignore'),
    read(base, '.gitignore').replace('CLAUDE.local.md\n', ''),
  );
  // A policy change makes the labels catalog stale too.
  writeFileSync(
    join(base, '.agents/policy.json'),
    JSON.stringify({
      ...value,
      labels: { extra: [{ name: 'new', color: 'aaaaaa', description: '' }] },
    }),
  );
  const stale = [
    '.github/labels.json',
    '.github/workflows/tracker-pr-metadata.yml',
    '.gitignore',
    'AGENTS.md',
  ];
  assert.deepEqual(syncCheck(base), stale);

  generate(base);
  const result = capture(['check'], base);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    `Synced repository files are out of date. Run \`npx agenticool-agents sync\` and commit:\n${stale.map((path) => `  ${path}`).join('\n')}`,
  );
  sync(base);
  assert.deepEqual(capture(['check'], base), {
    status: 0,
    stdout: '',
    stderr: '',
  });
  // Generated and synced staleness are reported together.
  rmSync(join(base, `.claude/agents/${PREFIX}implementer.md`));
  rmSync(join(base, '.github/pull_request_template.md'));
  const both = capture(['check'], base);
  assert.equal(both.status, 1);
  assert.match(
    both.stderr,
    /^Generated agent definitions are out of date\. Run `npx agenticool-agents generate` and commit:\n {2}\.claude\/agents\/prism-implementer\.md\nSynced repository files are out of date\. Run `npx agenticool-agents sync` and commit:\n {2}\.github\/pull_request_template\.md$/,
  );
});

test('lines outside the marked blocks are never changed', () => {
  const head = '# Rules\n\nRepository intro.\n\n## Checks\n\n';
  const table = '\n| Changed | Run |\n| --- | --- |\n| Docs | `lint` |\n';
  const tail = '\n## Hard rules\n\n- Keep evidence immutable.\n';
  const agents = `${head}<!-- agenticool-agents sync: begin delivery -->\nstale\n<!-- agenticool-agents sync: end delivery -->\n${table}${tail}`;
  const gitignore = 'node_modules/\n.env\n';
  const base = consumer(bound(policy), {
    'AGENTS.md': agents,
    '.gitignore': gitignore,
  });
  sync(base);
  const text = read(base, 'AGENTS.md');
  // The existing block is replaced where it stands; the missing ones follow
  // the repository's own text.
  assert.ok(
    text.startsWith(
      `${head}<!-- agenticool-agents sync: begin delivery -->\n\n## Autonomous delivery\n`,
    ),
  );
  assert.ok(
    text.includes(
      `- Before creating or using a worktree, read and follow [Agent worktree isolation](.agents/worktree-isolation.md).`,
    ),
  );
  assert.ok(
    text.includes(
      `\n<!-- agenticool-agents sync: end delivery -->\n${table}${tail}\n<!-- agenticool-agents sync: begin checks -->\n`,
    ),
  );
  assert.doesNotMatch(text, /^stale$/m);
  assert.equal(read(base, '.gitignore'), `${gitignore}\n${gitignoreBlock}\n`);

  // Moving a block keeps it where the repository put it.
  const moved = text
    .replace(
      /<!-- agenticool-agents sync: begin code -->[\s\S]*?end code -->/,
      '',
    )
    .replace(
      '## Hard rules\n',
      `## Hard rules\n\n<!-- agenticool-agents sync: begin code -->\nold\n<!-- agenticool-agents sync: end code -->\n`,
    );
  writeFileSync(join(base, 'AGENTS.md'), moved);
  sync(base);
  const resynced = read(base, 'AGENTS.md');
  assert.ok(
    resynced.indexOf('## Code and comments') >
      resynced.indexOf('## Hard rules'),
  );
  assert.equal(
    resynced.replace(
      /<!-- agenticool-agents sync: begin code -->[\s\S]*?end code -->/,
      '',
    ),
    moved.replace(
      /<!-- agenticool-agents sync: begin code -->[\s\S]*?end code -->/,
      '',
    ),
  );
});

test('unbalanced markers fail instead of rewriting the file', () => {
  const comment = (/** @type {string} */ text) => `# ${text}`;
  for (const text of [
    '# agenticool-agents sync: begin x\nkept\n',
    'kept\n# agenticool-agents sync: end x\n',
    '# agenticool-agents sync: end x\n# agenticool-agents sync: begin x\n',
  ])
    assert.throws(
      () => replaceBlock(text, 'x', 'new', comment, 'file'),
      /^Error: file: unbalanced sync markers for x$/,
    );
  assert.equal(
    replaceBlock('', 'x', 'new', comment, 'file'),
    '# agenticool-agents sync: begin x\nnew\n# agenticool-agents sync: end x\n',
  );
  const base = consumer(bound(policy), {
    '.gitignore': '# agenticool-agents sync: begin agent-local\n',
  });
  assert.throws(
    () => renderSync(base),
    /\.gitignore: unbalanced sync markers for agent-local/,
  );
});

const browserBlock = `# agenticool-agents sync: begin browser-mcp
[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest", "--headless"]

[mcp_servers.playwriter]
command = "npx"
args = ["-y", "playwriter@latest"]
# agenticool-agents sync: end browser-mcp
`;

test('with features.browserMcp, sync writes .mcp.json and merges the Codex MCP entries', () => {
  const config = `model = "gpt"\n\n[mcp_servers.playwright]\ncommand = "old"\n\n[mcp_servers.playwright.env]\nA = "1"\n\n[mcp_servers.docs]\ncommand = "docs"\n`;
  const base = consumer(bound(policy, { browserMcp: true }), {
    '.mcp.json': JSON.stringify({
      mcpServers: { docs: { command: 'docs', args: ['a, b', 'c'] } },
    }),
    '.codex/config.toml': config,
  });
  const paths = sync(base);
  assert.ok(paths.includes('.mcp.json'));
  assert.ok(paths.includes('.codex/config.toml'));
  assert.equal(
    read(base, '.mcp.json'),
    `{
  "mcpServers": {
    "docs": {
      "command": "docs",
      "args": ["a, b", "c"]
    },
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--headless"]
    },
    "playwriter": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "playwriter@latest"]
    }
  }
}
`,
  );
  // The repository's own entries stay; its earlier playwright table moves
  // into the block so the file never defines it twice.
  assert.equal(
    read(base, '.codex/config.toml'),
    `model = "gpt"\n\n[mcp_servers.docs]\ncommand = "docs"\n\n${browserBlock}`,
  );
  // Once the block exists, sync rewrites only the block.
  writeFileSync(
    join(base, '.codex/config.toml'),
    `[mcp_servers.playwright.env]\nA = "1"\n\n${browserBlock.replace('--headless', '--headed')}\n[after]\nb = 2\n`,
  );
  sync(base);
  assert.equal(
    read(base, '.codex/config.toml'),
    `[mcp_servers.playwright.env]\nA = "1"\n\n${browserBlock}\n[after]\nb = 2\n`,
  );
  // A repository without either file gets both.
  const fresh = consumer(bound(policy, { browserMcp: true }));
  sync(fresh);
  assert.equal(read(fresh, '.codex/config.toml'), browserBlock);
  assert.deepEqual(
    Object.keys(JSON.parse(read(fresh, '.mcp.json')).mcpServers),
    ['playwright', 'playwriter'],
  );
});

test('without features.browserMcp, sync writes neither MCP file', () => {
  const base = consumer(bound(policy), {
    '.codex/config.toml': 'model = "gpt"\n',
  });
  const paths = sync(base);
  assert.ok(!paths.includes('.mcp.json'));
  assert.ok(!paths.includes('.codex/config.toml'));
  assert.equal(read(base, '.codex/config.toml'), 'model = "gpt"\n');
  assert.throws(() => read(base, '.mcp.json'), /ENOENT/);
  assert.deepEqual(syncCheck(base), []);
});

// A consumer repository after `generate` and `sync`, as a git repository so
// `git check-ignore` reads its .gitignore.
function synced() {
  const base = consumer(bound(policy, { browserMcp: true }));
  generate(base);
  sync(base);
  const init = spawnSync('git', ['init', '-q'], { cwd: base });
  assert.equal(init.status, 0);
  return base;
}

/**
 * The paths `git check-ignore` reports as ignored.
 * @param {string} base
 * @param {string[]} paths
 */
function ignored(base, paths) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: base,
    input: `${paths.join('\n')}\n`,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n');
}

test('worktree ignores preserve tracked agent definitions and configuration', () => {
  const base = synced();
  const gitignore = read(base, '.gitignore').split(/\r?\n/);
  const worktrees = ['.claude/worktrees/', '.codex/worktrees/'];
  for (const path of worktrees)
    assert.ok(gitignore.includes(path), `missing .gitignore entry: ${path}`);

  const probes = worktrees.map((path) => `${path}ignore-probe`);
  const definitions = [...render(base).keys()].filter((path) =>
    /^\.(claude|codex)\//.test(path),
  );
  assert.deepEqual(
    ignored(base, [...probes, ...definitions, '.codex/config.toml']),
    probes,
  );
});

test('local agent files are ignored while tracked agent files stay tracked', () => {
  const base = synced();
  const local = [
    'CLAUDE.local.md',
    '.claude/scheduled_tasks.lock',
    '.claude/settings.local.json',
  ];
  const tracked = [
    'CLAUDE.md',
    'AGENTS.md',
    '.agents/policy.json',
    '.codex/config.toml',
    '.mcp.json',
    ...[...render(base).keys()].filter((path) =>
      /^\.(claude|codex|agents)\//.test(path),
    ),
  ];
  assert.deepEqual(ignored(base, [...local, ...tracked]), local);
});

test('AGENTS.md names the review packet that leaf delivery carries', () => {
  const base = synced();
  const agents = read(base, 'AGENTS.md');
  assert.match(
    agents,
    /A review handoff after the final push sends the review packet that leaf delivery defines, taking the base SHA from `git merge-base <base> HEAD`/,
  );
  const target = `.agents/skills/${PREFIX}implement/references/delivery.md`;
  assert.ok(agents.includes(`[Leaf delivery](${target})`));
  const packet = readFileSync(
    join(SOURCES, 'includes/review-packet.md'),
    'utf8',
  ).trimEnd();
  assert.ok(read(base, target).includes(packet));
});

test('the sync command prints every synced path and a note for unlisted pull_request_target workflows', () => {
  assert.deepEqual(PULL_REQUEST_TARGET, [
    'tracker-pr-issue-status.yml',
    'tracker-pr-metadata.yml',
  ]);
  const base = consumer(bound(policy));
  const result = spawnSync(process.execPath, [BIN, 'sync'], {
    cwd: base,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.deepEqual(
    result.stdout.trim().split('\n'),
    [...SYNCED, 'ISSUE_TRIAGE.md'].sort(),
  );
  assert.equal(
    result.stderr,
    'Note: add tracker-pr-issue-status.yml and tracker-pr-metadata.yml to workflowLint.pullRequestTarget in .agents/policy.json. agenticool-workflow-lint accepts a workflow that runs on pull_request_target only when that list names it.\n',
  );
  const partly = consumer({
    ...bound(policy),
    workflowLint: { pullRequestTarget: ['tracker-pr-metadata.yml'] },
  });
  assert.match(
    capture(['sync'], partly).stderr,
    /^Note: add tracker-pr-issue-status\.yml to workflowLint/,
  );
  const listed = consumer({
    ...bound(policy),
    workflowLint: { pullRequestTarget: PULL_REQUEST_TARGET },
  });
  assert.equal(capture(['sync'], listed).stderr, '');
  // The note never edits the policy.
  assert.equal(
    read(base, '.agents/policy.json'),
    JSON.stringify(bound(policy)),
  );
});

// CONTRIBUTING.md is a guide for people; agents load only the files below and
// what `binding.docs.guides` names.
test('no shared source, AGENTS.md section, tracker template, or generated file names CONTRIBUTING.md', () => {
  const roots = [
    SOURCES,
    fileURLToPath(new URL('../templates/agents-md/', import.meta.url)),
    fileURLToPath(TEMPLATES),
  ];
  const files = roots.flatMap((root) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name)),
  );
  assert.ok(files.some((path) => path.endsWith('ISSUE_TRIAGE.md')));
  for (const path of files)
    assert.doesNotMatch(readFileSync(path, 'utf8'), /CONTRIBUTING/, path);
  const base = synced();
  for (const [path, content] of [...render(base), ...renderSync(base)])
    assert.doesNotMatch(content, /CONTRIBUTING/, path);
});

test('the synced files carry the workflow naming, Status, and dependency rules', () => {
  const base = synced();
  const naming = section(
    read(base, 'AGENTS.md'),
    'GitHub Actions workflow names',
  );
  for (const rule of [
    '`<area>-<purpose>.yml`',
    '`workflowLint.areas`',
    'starts with `_` and a `name` that ends in ` (reusable)`',
    'Job IDs are kebab-case',
    'Every job and every step has a name',
    '`run-name` with an expression',
    '`workflowLint.exclude`',
    '`npx agenticool-workflow-lint`',
  ])
    assert.ok(naming.includes(rule), rule);
  const triage = read(base, 'ISSUE_TRIAGE.md');
  const status = section(triage, 'Status');
  for (const name of ['Inbox', 'Ready', 'In progress', 'In review', 'Done'])
    assert.match(status, new RegExp(`^\\| ${name}\\b`, 'm'), name);
  assert.match(status, /Automation, whenever the issue closes/);
  assert.match(status, /when an issue in Done reopens/);
  assert.match(status, /An agent sets only In progress/);
  const dependencies = section(triage, 'Dependencies');
  assert.match(dependencies, /blocked-by relationship on the issue that waits/);
  assert.ok(
    dependencies.includes(
      `.agents/skills/${PREFIX}implement/references/delivery.md`,
    ),
  );
});
