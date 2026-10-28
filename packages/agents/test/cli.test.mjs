import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliError, CliHelp } from '@agenticool/cli';
import { main } from '@agenticool/agents';
import { consumer, FIXTURE, policy, PREFIX } from './helpers.mjs';

const BIN = fileURLToPath(
  new URL('../bin/agenticool-agents.mjs', import.meta.url),
);
/** @param {...string} args */
const run = (...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: FIXTURE,
    encoding: 'utf8',
  });

// Runs `main` in this process and returns its exit code and printed lines.
/**
 * @param {string[]} args
 * @param {string} [base]
 */
function capture(args, base = FIXTURE) {
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

test('missing and unknown commands show an actionable error and combined help', () => {
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  for (const option of [
    '--tool',
    '--role',
    '--pr',
    '--base',
    '--head',
    '--report',
  ])
    assert.ok(help.stdout.includes(option), option);
  for (const [args, message] of [
    [[], 'Name a command'],
    [['unknown'], 'Unknown command unknown'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${message}\n\n${help.stdout}`);
  }
  // Any other usage error exits 1, with the command's usage.
  const option = run('resolve', '--bogus');
  assert.equal(option.status, 1);
  assert.equal(option.stdout, '');
  assert.match(option.stderr, /^Unknown option --bogus\n\nUsage: /);
});

test('usage errors and help throw for the bin to print', () => {
  assert.throws(() => main(['-h']), CliHelp);
  assert.throws(() => main(['check', '--help']), CliHelp);
  assert.throws(
    () =>
      main(['resolve', '--tool', 'claude', '--role', 'x', '--capability', 'y']),
    (/** @type {Error} */ error) =>
      error instanceof CliError &&
      error.message.startsWith('Use --role or --capability, not both'),
  );
  assert.throws(
    () => main(['generate', 'extra']),
    /Unexpected positional argument/,
  );
});

test('resolve prints the role policy as JSON', () => {
  const result = capture([
    'resolve',
    '--tool',
    'codex',
    '--role',
    'code-reviewer',
    '--effort',
    'xhigh',
  ]);
  assert.equal(result.status, 0);
  const resolved = JSON.parse(result.stdout);
  assert.equal(resolved.model, policy.capabilities['code-review'].codex.model);
  assert.equal(resolved.effort, 'xhigh');
  assert.deepEqual(resolved.source, { model: 'policy', effort: 'override' });
  assert.equal(resolved.spawn.agent_type, `${PREFIX}code-reviewer`);
  const capability = JSON.parse(
    capture(['resolve', '--tool', 'claude', '--capability', 'issue-creation'])
      .stdout,
  );
  assert.equal(capability.spawn.subagent_type, null);
});

test('generate and check work in the consumer repository', () => {
  const base = consumer(policy);
  const stale = capture(['check'], base);
  assert.equal(stale.status, 1);
  assert.match(
    stale.stderr,
    /^Generated agent definitions are out of date\. Run `npx agenticool-agents generate` and commit:\n {2}\.agents\//,
  );
  const generated = capture(['generate'], base);
  assert.equal(generated.status, 0);
  assert.ok(
    generated.stdout
      .split('\n')
      .includes(`.claude/agents/${PREFIX}implementer.md`),
  );
  assert.deepEqual(capture(['check'], base), {
    status: 0,
    stdout: '',
    stderr: '',
  });
  assert.equal(run('check').status, 0);
});

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

test('the publish-review command reports every failure as not posted', () => {
  const empty = mkdtempSync(join(tmpdir(), 'agenticool-agents-'));
  const reportPath = join(empty, 'review.md');
  writeFileSync(reportPath, `Verdict: APPROVE\nBase/Head: ${BASE}..${HEAD}\n`);
  const args = ['publish-review', '--pr', '7', '--base', BASE, '--head', HEAD];
  // The bin prints a failure to stderr and exits 1.
  const noPolicy = spawnSync(
    process.execPath,
    [BIN, ...args, '--report', reportPath],
    { cwd: empty, encoding: 'utf8' },
  );
  assert.equal(noPolicy.status, 1);
  assert.match(
    noPolicy.stderr,
    /^Review not posted: cannot load \.agents\/policy\.json: /,
  );
  assert.equal(noPolicy.stdout, '');
  const missing = join(empty, 'missing.md');
  assert.throws(
    () => main([...args, '--report', missing], FIXTURE),
    (/** @type {Error} */ error) =>
      error.name === 'ReviewNotPosted' &&
      error.message.startsWith(`Review not posted: cannot read ${missing}: `),
  );
  assert.throws(
    () => main(['publish-review', '--pr', '7'], FIXTURE),
    /^ReviewNotPosted: Review not posted: --report <file> is required/,
  );
  // A report for other commits is refused before any GitHub call.
  assert.throws(
    () =>
      main(
        [
          'publish-review',
          '--pr',
          '7',
          '--base',
          BASE,
          '--head',
          'c'.repeat(40),
          '--report',
          reportPath,
        ],
        FIXTURE,
      ),
    /Review not posted: the report reviewed/,
  );
});
