// Shared fixtures for the generator tests. The fixture consumer carries the
// prismatic binding and its committed generated output.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, prefix } from '@agenticool/policy';

/** @typedef {Record<string, any>} Policy */

export const FIXTURE = fileURLToPath(
  new URL('fixtures/prismatic', import.meta.url),
);
export const policy = loadPolicy(FIXTURE);
export const PREFIX = prefix(policy);
// The same policy bound to another repository with no CI-applied infrastructure.
/** @type {Policy} */
export const other = {
  ...policy,
  binding: {
    namespace: 'other',
    label: 'Other',
    repository: 'example/other',
    project: { owner: 'example', number: 7, name: 'Other delivery' },
    docs: { triage: 'TRIAGE.md', workflow: 'AGENTS.md', guides: ['AGENTS.md'] },
    features: { infrastructure: false },
  },
};

/**
 * A temporary consumer repository with this policy and these files.
 * @param {Policy} value
 * @param {Record<string, string>} [files] consumer-relative path to content
 */
export function consumer(value, files = {}) {
  const base = mkdtempSync(join(tmpdir(), 'agenticool-agents-'));
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
  return [`.claude/skills/${PREFIX}${file}`, `.agents/skills/${PREFIX}${file}`];
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
      [
        `.claude/agents/${PREFIX}${role}.md`,
        `.codex/agents/${PREFIX}${role}.toml`,
      ],
    ]);
  for (const path of files.keys()) {
    const match = path.match(
      new RegExp(`^\\.claude/skills/${PREFIX}([^/]+)/(.+\\.md)$`),
    );
    if (!match) continue;
    const [, skill, file] = match;
    pairs.push([
      file === 'SKILL.md'
        ? `workflows/${skill}.md`
        : `workflows/${skill}/${file}`,
      [path, `.agents/skills/${PREFIX}${skill}/${file}`],
    ]);
  }
  return pairs;
}
