#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CliHelp, cliError, defineCli, parseCli } from '@agenticool/cli';
import { loadPolicy, POLICY_PATH, prefix } from '@agenticool/policy';
import {
  checkBodies,
  loadIssueForms,
  parse,
  preflight,
  printTree,
  render,
} from '@agenticool/spec-parser';

const LABELS_PATH = '.github/labels.json';
const cli = defineCli(
  'Usage: agenticool-spec plan <spec> [--bodies <dir>] [--json <file>]',
  {
    bodies: {
      type: 'string',
      description:
        'Also write each rendered body to <dir>/<KEY>.md, outside any git checkout',
    },
    json: {
      type: 'string',
      description: 'Also write the plan as JSON to this file',
    },
  },
);

/** @param {string} directory */
const inCheckout = (directory) => {
  for (let path = directory; ; path = dirname(path)) {
    if (existsSync(join(path, '.git'))) return true;
    if (dirname(path) === path) return false;
  }
};

try {
  const { options, positionals } = parseCli(process.argv.slice(2), cli);
  if (positionals[0] !== 'plan' || positionals.length !== 2)
    throw cliError(cli, 'Expected plan <spec>');
  // Rendered bodies are drafts and never land in tracked paths.
  const bodiesDir =
    typeof options.bodies === 'string' ? resolve(options.bodies) : null;
  if (bodiesDir && inCheckout(bodiesDir))
    throw cliError(
      cli,
      '--bodies must name a directory outside any git checkout',
    );
  const text = readFileSync(positionals[1], 'utf8');
  const plan = parse(text);
  const policy = existsSync(POLICY_PATH) ? loadPolicy(process.cwd(), {}) : null;
  // The offline half of label-exists reads the repository's catalog plus the
  // policy's extra labels; without a catalog it is left to filing.
  let labels;
  if (existsSync(LABELS_PATH))
    labels = [
      ...JSON.parse(readFileSync(LABELS_PATH, 'utf8')).labels,
      ...(policy?.labels?.extra ?? []),
    ].map((label) => label.name);
  else process.stderr.write(`label-exists skipped: no ${LABELS_PATH}\n`);
  let violations = preflight(plan, { labels });
  /** @type {Record<string, string>} */
  let bodies = {};
  if (!violations.length) {
    // The agent prefix names the implement skill and the independence record.
    const agentPrefix = policy?.binding?.namespace ? prefix(policy) : '';
    bodies = render(plan, text, { prefix: agentPrefix });
    violations = checkBodies(plan, bodies, {
      forms: loadIssueForms(),
      prefix: agentPrefix,
    });
  }
  if (violations.length) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    if (typeof options.json === 'string')
      writeFileSync(options.json, `${JSON.stringify(plan, null, 2)}\n`);
    if (bodiesDir) {
      mkdirSync(bodiesDir, { recursive: true });
      for (const [key, body] of Object.entries(bodies))
        writeFileSync(join(bodiesDir, `${key}.md`), `${body}\n`);
    }
    process.stdout.write(`${printTree(plan)}\n`);
  }
} catch (error) {
  const { message } = /** @type {Error} */ (error);
  if (error instanceof CliHelp) process.stdout.write(`${message}\n`);
  else {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
