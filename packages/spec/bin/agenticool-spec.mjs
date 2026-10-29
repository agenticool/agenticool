#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CliHelp,
  cliError,
  defineCli,
  parseCli,
  loadPolicy,
  POLICY_PATH,
} from '@agenticool/core';
import {
  checkBodies,
  loadIssueForms,
  main,
  parse,
  preflight,
  printTree,
  recordPlan,
  render,
} from '@agenticool/spec';

const LABELS_PATH = '.github/labels.json';
const FILING = ['confirm', 'file', 'resume'];
const cli = defineCli(
  `Usage: agenticool-spec plan <spec> [--bodies <dir>] [--json <file>] [--state <dir> [--groups <file>] [--assignee <login>]]
       agenticool-spec confirm <digest> --state <dir>
       agenticool-spec file <spec> --state <dir>
       agenticool-spec resume <spec> --state <dir>`,
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
    state: {
      type: 'string',
      description:
        'Also record the plan, groups, and assignee in this state directory for confirm and file',
    },
    groups: {
      type: 'string',
      description:
        'With --state: JSON independence groups per epic, such as { "Phase 0": [["P0.1", "P0.3"], ["P0.2"]] }',
    },
    assignee: {
      type: 'string',
      description: 'With --state: assign every filed issue to this login',
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
  if (FILING.includes(process.argv[2]))
    process.exitCode = await main(process.argv.slice(2));
  else await planCommand();
} catch (error) {
  const { message } = /** @type {Error} */ (error);
  if (error instanceof CliHelp) process.stdout.write(`${message}\n`);
  else {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

async function planCommand() {
  const { options, positionals } = parseCli(process.argv.slice(2), cli);
  if (positionals[0] !== 'plan' || positionals.length !== 2)
    throw cliError(cli, 'Expected plan <spec>');
  if (
    typeof options.state !== 'string' &&
    (options.groups !== undefined || options.assignee !== undefined)
  )
    throw cliError(cli, '--groups and --assignee need --state');
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
    bodies = render(plan, text);
    violations = checkBodies(plan, bodies, { forms: loadIssueForms() });
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
    process.stdout.write(
      `${
        typeof options.state === 'string'
          ? recordPlan(options.state, {
              spec: positionals[1],
              text,
              plan,
              bodies,
              groups:
                typeof options.groups === 'string'
                  ? JSON.parse(readFileSync(options.groups, 'utf8'))
                  : {},
              assignee:
                typeof options.assignee === 'string' ? options.assignee : null,
            }).output
          : printTree(plan)
      }\n`,
    );
  }
}
