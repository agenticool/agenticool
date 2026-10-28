#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CliHelp, cliError, defineCli, parseCli } from '@agenticool/cli';
import { loadPolicy, POLICY_PATH } from '@agenticool/policy';
import { parse, preflight, printTree } from '@agenticool/spec-parser';

const LABELS_PATH = '.github/labels.json';
const cli = defineCli('Usage: agenticool-spec plan <spec> [--json <file>]', {
  json: {
    type: 'string',
    description: 'Also write the plan as JSON to this file',
  },
});

try {
  const { options, positionals } = parseCli(process.argv.slice(2), cli);
  if (positionals[0] !== 'plan' || positionals.length !== 2)
    throw cliError(cli, 'Expected plan <spec>');
  const plan = parse(readFileSync(positionals[1], 'utf8'));
  // The offline half of label-exists reads the repository's catalog plus the
  // policy's extra labels; without a catalog it is left to filing.
  let labels;
  if (existsSync(LABELS_PATH)) {
    const extra = existsSync(POLICY_PATH)
      ? (loadPolicy(process.cwd(), {}).labels?.extra ?? [])
      : [];
    labels = [
      ...JSON.parse(readFileSync(LABELS_PATH, 'utf8')).labels,
      ...extra,
    ].map((label) => label.name);
  } else process.stderr.write(`label-exists skipped: no ${LABELS_PATH}\n`);
  const violations = preflight(plan, { labels });
  if (violations.length) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    if (typeof options.json === 'string')
      writeFileSync(options.json, `${JSON.stringify(plan, null, 2)}\n`);
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
