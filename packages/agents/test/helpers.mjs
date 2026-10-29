// Shared fixtures for the generator tests. The fixture consumer carries the
// prismatic binding and its committed generated output.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDefaults } from '@agenticool/agents';
import { loadPolicy } from '@agenticool/core';

/** @typedef {Record<string, any>} Policy */

/**
 * A git repository whose origin remote is GitHub's `repository`.
 * @param {string} repository
 */
export function clone(repository) {
  const base = mkdtempSync(join(tmpdir(), 'agenticool-agents-'));
  execFileSync('git', ['init', '-q', base]);
  execFileSync('git', [
    '-C',
    base,
    'remote',
    'add',
    'origin',
    `https://github.com/${repository}.git`,
  ]);
  return base;
}

export const COMMITTED = fileURLToPath(
  new URL('fixtures/prismatic', import.meta.url),
);
// The committed fixture consumer in a clone of samlevin/prismatic, so its
// origin remote names the repository.
export const FIXTURE = clone('samlevin/prismatic');
cpSync(COMMITTED, FIXTURE, { recursive: true });
export const policy = withDefaults(
  Object.assign(loadPolicy(FIXTURE), { repository: 'samlevin/prismatic' }),
);
// The same policy bound to another repository with no CI-applied infrastructure.
/** @type {Policy} */
export const other = {
  ...policy,
  repository: 'example/other',
  binding: {
    label: 'Other',
    project: { owner: 'example', number: 7, name: 'Other delivery' },
    docs: { triage: 'TRIAGE.md', workflow: 'AGENTS.md', guides: ['AGENTS.md'] },
    features: { infrastructure: false },
  },
};

/**
 * A temporary clone of the policy's repository with this policy and these
 * files.
 * @param {Policy} value
 * @param {Record<string, string>} [files] consumer-relative path to content
 */
export function consumer({ repository, ...value }, files = {}) {
  const base = clone(repository);
  for (const [path, content] of Object.entries({
    '.agents/policy.json': JSON.stringify(value),
    ...files,
  })) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
  return base;
}

// Report and relay wording that callers depend on. Each check matches a short
// phrase on one rendered line, so rewording elsewhere does not break it.
/**
 * @param {string | undefined} content
 * @param {...(string | RegExp)} phrases
 */
export const lineWith = (content, ...phrases) =>
  String(content)
    .split('\n')
    .find((line) =>
      phrases.every((phrase) =>
        typeof phrase === 'string' ? line.includes(phrase) : phrase.test(line),
      ),
    );

// The text under one `## ` heading of a rendered Markdown file.
/**
 * @param {string | undefined} text
 * @param {string} heading
 */
export function section(text, heading) {
  const content = String(text);
  const start = content.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const end = content.indexOf('\n## ', start + 1);
  return content.slice(start, end === -1 ? undefined : end);
}

// A file of a generated skill, in the Claude Code and the Codex skill.
/** @param {string} file */
export function inBoth(file) {
  return [`.claude/skills/${file}`, `.agents/skills/${file}`];
}

// Each shared source, relative to the package sources, with its Claude Code
// and Codex renderings.
/** @param {{ keys(): Iterable<string> }} files */
export function sourcePairs(files) {
  /** @type {[string, string[]][]} */
  const pairs = [];
  for (const role of Object.keys(policy.roles))
    pairs.push([
      `roles/${role}.md`,
      [`.claude/agents/${role}.md`, `.codex/agents/${role}.toml`],
    ]);
  for (const path of files.keys()) {
    const match = path.match(/^\.claude\/skills\/([^/]+)\/(.+\.md)$/);
    if (!match) continue;
    const [, skill, file] = match;
    pairs.push([
      file === 'SKILL.md'
        ? `workflows/${skill}.md`
        : `workflows/${skill}/${file}`,
      [path, `.agents/skills/${skill}/${file}`],
    ]);
  }
  return pairs;
}
