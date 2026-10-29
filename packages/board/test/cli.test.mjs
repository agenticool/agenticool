import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configuration, main, USAGE } from '../src/index.mjs';
import {
  exhausted,
  ghFails,
  httpResponse,
  orgPolicy,
  RESET,
  RESET_AT,
  userPolicy,
} from './helpers.mjs';

// A clone of acme/widgets with the user fixture's policy.
const USER = mkdtempSync(join(tmpdir(), 'board-cli-'));
execFileSync('git', ['init', '-q', USER]);
execFileSync('git', [
  '-C',
  USER,
  'remote',
  'add',
  'origin',
  'https://github.com/acme/widgets.git',
]);
cpSync(
  fileURLToPath(new URL('fixtures/user/.agents', import.meta.url)),
  join(USER, '.agents'),
  { recursive: true },
);
const TOKEN = 'AGENTICOOL_PROJECT_TOKEN';
const ACTIONS = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'acme/widgets',
  [TOKEN]: 'widgets-project-token-value',
};

const BUDGET = httpResponse(
  200,
  {},
  {
    resources: {
      graphql: { limit: 5000, remaining: 4000, used: 1000, reset: RESET },
    },
  },
);

// Runs the command against a stand-in for gh: the REST rate_limit endpoint
// reports a healthy budget, and every GraphQL call gets `graphql`, a failing
// gh call when it is a function. gh's stderr carries the token.
/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, graphql?: string | (() => never), cwd?: string }} [settings]
 */
async function cli(argv, { env = {}, graphql, cwd = USER } = {}) {
  const out = {
    /** @type {string[]} */ logs: [],
    /** @type {string[]} */ warnings: [],
    /** @type {string[]} */ errors: [],
    /** @type {string[][]} */ calls: [],
    /** @type {string[]} */ inputs: [],
  };
  /** @type {import('@agenticool/core').Run} */
  const run = (_command, args, options) => {
    out.calls.push(args);
    if (options?.input) out.inputs.push(String(options.input));
    if (args.includes('rate_limit')) return BUDGET;
    if (typeof graphql === 'string') return graphql;
    if (graphql) return graphql();
    return assert.fail(`Unexpected gh call ${args.join(' ')}`);
  };
  const status = await main(argv, {
    env,
    cwd,
    run,
    log: (line) => out.logs.push(line),
    warn: (line) => out.warnings.push(line),
    error: (line) => out.errors.push(line),
  });
  return { ...out, status };
}

const RATE_LIMITED = ghFails(
  httpResponse(200, exhausted, {
    errors: [
      {
        type: 'RATE_LIMITED',
        message: 'API rate limit already exceeded for user ID 1.',
      },
    ],
  }),
  { stderr: `gh: stderr-marker ${ACTIONS[TOKEN]}` },
);
const RATE_LIMIT_MESSAGE = `GitHub GraphQL request failed: RATE_LIMITED: API rate limit already exceeded for user ID 1. Rate limit reached; the limit resets at ${RESET_AT}.`;

test('workflow requires its own project token and local defaults remain read-only', () => {
  assert.throws(
    () =>
      configuration(
        { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'repository-only' },
        [],
        userPolicy,
      ),
    /^Error: AGENTICOOL_PROJECT_TOKEN is required for Projects access; GITHUB_TOKEN cannot access Projects\.$/,
  );
  assert.throws(
    () => configuration({ GITHUB_ACTIONS: 'true' }, [], orgPolicy),
    /AGENTICOOL_PROJECT_TOKEN is required/,
  );
  assert.deepEqual(configuration({}, [], userPolicy), { dryRun: true });
  assert.deepEqual(
    configuration({ DRY_RUN: 'false' }, ['--dry-run'], userPolicy),
    { dryRun: true },
  );
  assert.deepEqual(configuration({ DRY_RUN: 'false' }, [], userPolicy), {
    dryRun: false,
  });
  assert.deepEqual(configuration({}, ['--apply'], userPolicy), {
    dryRun: false,
  });
  assert.deepEqual(
    configuration({ GITHUB_ACTIONS: 'true', [TOKEN]: 'set' }, [], userPolicy),
    { dryRun: true },
  );
  assert.throws(
    () => configuration({ DRY_RUN: 'yes' }, [], userPolicy),
    /must be true or false/,
  );
  assert.throws(
    () => configuration({}, ['--apply', '--dry-run'], userPolicy),
    /Use --dry-run or --apply/,
  );
});

test('parser accepts an optional positive issue number in either flag order and preserves dry-run defaults', () => {
  /** @param {string[]} args @param {Record<string, string>} [env] */
  const parse = (args, env = {}) => configuration(env, args, userPolicy);
  assert.deepEqual(parse(['--issue', '42']), { dryRun: true, issueNumber: 42 });
  assert.deepEqual(parse(['--issue', '42', '--dry-run']), {
    dryRun: true,
    issueNumber: 42,
  });
  assert.deepEqual(
    parse(['--dry-run', '--issue', '42'], { DRY_RUN: 'false' }),
    {
      dryRun: true,
      issueNumber: 42,
    },
  );
  assert.deepEqual(parse(['--apply', '--issue', '42']), {
    dryRun: false,
    issueNumber: 42,
  });
  assert.deepEqual(parse(['--issue', '42', '--apply']), {
    dryRun: false,
    issueNumber: 42,
  });
  assert.deepEqual(parse(['--issue', String(Number.MAX_SAFE_INTEGER)]), {
    dryRun: true,
    issueNumber: Number.MAX_SAFE_INTEGER,
  });
});

test('parser rejects malformed, missing, unsafe, repeated, or conflicting arguments', () => {
  for (const args of [
    ['--issue'],
    ['--issue', '--apply'],
    ['--issue', '0'],
    ['--issue', '-1'],
    ['--issue', '1.5'],
    ['--issue', '1e2'],
    ['--issue', ' 1'],
    ['--issue', '01'],
    ['--issue', 'NaN'],
    ['--issue', 'Infinity'],
    ['--issue', '9007199254740992'],
    ['--issue', '1', '--issue', '2'],
    ['--unknown'],
    ['1'],
    ['--apply', '--apply'],
    ['--dry-run', '--dry-run'],
    ['--apply', '--dry-run', '--issue', '1'],
    ['--issue', '1', '2'],
  ])
    assert.throws(
      () => configuration({}, args, userPolicy),
      /Use --dry-run or --apply|--issue requires|Unknown option|given more than once/,
      args.join(' '),
    );
});

test('sweeps and PR commands exit non-zero with the shared rate-limit message', async () => {
  for (const [
    command,
    args,
    env,
  ] of /** @type {[string, string[], Record<string, string>][]} */ ([
    ['triage', ['--dry-run'], {}],
    ['containers', ['--dry-run'], {}],
    ['membership', [], { SWEEP: 'true' }],
    ['membership', ['--sweep'], {}],
    ['pr-metadata', [], { PR_NUMBER: '5' }],
    ['pr-status', [], { PR_NUMBER: '5' }],
  ])) {
    const result = await cli([command, ...args], {
      env,
      graphql: RATE_LIMITED,
    });
    assert.equal(result.status, 1, command);
    assert.ok(
      result.logs.every((line) => line.startsWith('GraphQL budget ')),
      `${command}: ${result.logs.join('\n')}`,
    );
    assert.deepEqual(result.errors, [RATE_LIMIT_MESSAGE], command);
  }
});

test('single-issue board runs warn and succeed when rate-limited', async (t) => {
  process.env[TOKEN] = ACTIONS[TOKEN];
  t.after(() => delete process.env[TOKEN]);
  for (const [
    command,
    args,
    env,
  ] of /** @type {[string, string[], Record<string, string>][]} */ ([
    ['triage', ['--dry-run', '--issue', '5'], {}],
    ['containers', ['--dry-run', '--issue', '5'], {}],
    ['membership', [], { CONTENT_TYPE: 'issue', CONTENT_NUMBER: '5' }],
    ['membership', ['--issue', '5'], {}],
  ])) {
    const result = await cli([command, ...args], {
      env,
      graphql: RATE_LIMITED,
    });
    assert.equal(result.status, 0, `${command}: ${result.errors}`);
    assert.deepEqual(result.errors, [], command);
    assert.deepEqual(
      result.warnings,
      [`${RATE_LIMIT_MESSAGE} The next scheduled sweep reconciles this issue.`],
      command,
    );
    assert.match(result.logs[0], /^GraphQL budget before: 4000 of 5000/);
    assert.ok(!JSON.stringify(result).includes(ACTIONS[TOKEN]), command);
  }
});

test('board entry points skip a missing issue and still fail on other not-found errors', async () => {
  for (const command of ['triage', 'containers']) {
    const missing = await cli([command, '--apply', '--issue', '5'], {
      graphql: httpResponse(
        200,
        {},
        {
          data: { repository: { issue: null } },
          errors: [
            {
              type: 'NOT_FOUND',
              path: ['repository', 'issue'],
              message: 'Could not resolve to an Issue with the number of 5.',
            },
          ],
        },
      ),
    });
    assert.equal(missing.status, 0, `${command}: ${missing.errors}`);
    assert.deepEqual(missing.errors, [], command);
    assert.deepEqual(
      missing.warnings,
      ['Issue #5 no longer exists in the repository; skipping'],
      command,
    );
    const failed = await cli([command, '--apply', '--issue', '5'], {
      graphql: httpResponse(
        200,
        {},
        {
          data: { repository: null },
          errors: [
            {
              type: 'NOT_FOUND',
              path: ['repository'],
              message: 'Could not resolve to a Repository.',
            },
          ],
        },
      ),
    });
    assert.equal(failed.status, 1, command);
    assert.deepEqual(
      failed.errors,
      [
        'GitHub GraphQL request failed: NOT_FOUND: Could not resolve to a Repository.',
      ],
      command,
    );
  }
});

test('in GitHub Actions each command requires the project token, with its own message', async () => {
  for (const [command, message] of [
    [
      'triage',
      `${TOKEN} is required for Projects access; GITHUB_TOKEN cannot access Projects.`,
    ],
    [
      'containers',
      `${TOKEN} is required for Projects access; GITHUB_TOKEN cannot access Projects.`,
    ],
    ['membership', `${TOKEN} is required for Projects access.`],
    ['pr-status', `${TOKEN} is required for Projects access.`],
    ['pr-metadata', `${TOKEN} is required.`],
  ]) {
    const result = await cli([command], {
      env: { ...ACTIONS, [TOKEN]: undefined, GITHUB_TOKEN: 'repository-only' },
    });
    assert.equal(result.status, 1, command);
    assert.deepEqual(result.errors, [message], command);
    assert.deepEqual(result.calls, [], command);
  }
});

test('membership and PR commands run only for their own repository and PR actions', async () => {
  for (const command of ['membership', 'pr-status', 'pr-metadata']) {
    const result = await cli([command], {
      env: {
        ...ACTIONS,
        GITHUB_REPOSITORY: 'someone/fork',
        PR_ACTION: 'opened',
      },
    });
    assert.deepEqual(result.errors, ['Unexpected repository'], command);
    assert.equal(result.status, 1);
  }
  for (const action of [undefined, 'closed', 'synchronize']) {
    const result = await cli(['pr-status'], {
      env: { ...ACTIONS, PR_ACTION: action, PR_NUMBER: '5' },
    });
    assert.deepEqual(result.errors, ['Unexpected pull request action']);
    assert.deepEqual(result.calls, []);
  }
  // Outside Actions the action and repository are not checked.
  const local = await cli(['pr-status'], {
    env: { PR_NUMBER: '5', GITHUB_REPOSITORY: 'someone/fork' },
    graphql: httpResponse(
      200,
      {},
      { data: { repository: { pullRequest: { state: 'CLOSED' } } } },
    ),
  });
  assert.equal(local.status, 0, local.errors.join('\n'));
  assert.deepEqual(local.logs, ['Pull request #5 is not open.']);
});

test('the Projects token becomes GH_TOKEN in GitHub Actions only', async () => {
  const closed = httpResponse(
    200,
    {},
    {
      data: {
        repository: { pullRequest: { state: 'CLOSED', isDraft: false } },
      },
    },
  );
  for (const [
    command,
    extra,
  ] of /** @type {[string, Record<string, string>][]} */ ([
    ['pr-status', { PR_ACTION: 'ready_for_review' }],
    ['pr-metadata', {}],
  ])) {
    /** @type {Record<string, string | undefined>} */
    const env = { ...ACTIONS, ...extra, PR_NUMBER: '7', DRY_RUN: 'false' };
    const result = await cli([command], { env, graphql: closed });
    assert.equal(result.status, 0, `${command}: ${result.errors}`);
    assert.equal(env.GH_TOKEN, ACTIONS[TOKEN]);
    assert.equal(JSON.parse(result.inputs[0]).variables.number, 7);
  }
  /** @type {Record<string, string | undefined>} */
  const local = { [TOKEN]: 'value', PR_NUMBER: '7' };
  await cli(['pr-metadata'], { env: local, graphql: closed });
  assert.equal(local.GH_TOKEN, undefined);
});

test('DRY_RUN and SWEEP must be true or false, and flags win over them', async () => {
  for (const [
    command,
    env,
    message,
  ] of /** @type {[string, Record<string, string>, string][]} */ ([
    ['membership', { DRY_RUN: 'yes' }, 'DRY_RUN must be true or false'],
    ['membership', { SWEEP: 'yes' }, 'SWEEP must be true or false'],
    ['pr-status', { DRY_RUN: '1' }, 'DRY_RUN must be true or false'],
    ['pr-metadata', { DRY_RUN: '' }, 'DRY_RUN must be true or false'],
  ])) {
    const result = await cli([command], { env });
    assert.deepEqual(result.errors, [message], command);
  }
  // A missing or wrong content type fails before any write.
  for (const env of [{}, { CONTENT_TYPE: 'pull_request', CONTENT_NUMBER: '5' }])
    assert.deepEqual(
      (await cli(['membership', '--apply'], { env, graphql: RATE_LIMITED }))
        .errors,
      ['CONTENT_TYPE must be issue'],
    );
});

test('usage errors print the command help and fail', async () => {
  for (const [argv, pattern] of /** @type {[string[], RegExp][]} */ ([
    [['membership', '--issue', '5', '--sweep'], /Use --issue or --sweep/],
    [['membership', '--issue', 'x'], /--issue requires one positive/],
    [['membership', 'extra'], /membership takes no arguments/],
    [['membership', '--apply', '--dry-run'], /Use --dry-run or --apply once/],
    [['pr-status', '5'], /Use --dry-run or --apply/],
    [['pr-metadata', '--apply', '--dry-run'], /Use --dry-run or --apply once/],
    [['triage', '--sweep'], /Unknown option --sweep/],
  ])) {
    const result = await cli(argv);
    assert.equal(result.status, 1, argv.join(' '));
    assert.match(result.errors.join('\n'), pattern);
    assert.match(result.errors.join('\n'), /Usage: agenticool-board /);
  }
  const unknown = await cli(['sync']);
  assert.equal(unknown.status, 1);
  assert.deepEqual(unknown.errors, [`Unknown command sync\n\n${USAGE}`]);
  const none = await cli([]);
  assert.deepEqual(none.errors, [`Give a command\n\n${USAGE}`]);
  const inherited = await cli(['toString']);
  assert.match(inherited.errors[0], /^Unknown command toString/);
});

test('help prints usage and succeeds without a policy', async () => {
  for (const argv of [['--help'], ['-h']]) {
    const result = await cli(argv, { cwd: '/' });
    assert.equal(result.status, 0);
    assert.deepEqual(result.logs, [USAGE]);
  }
  const help = await cli(['membership', '--help'], { cwd: '/' });
  assert.equal(help.status, 0);
  assert.match(help.logs[0], /--sweep/);
  const missing = await cli(['triage'], { cwd: '/' });
  assert.equal(missing.status, 1);
  assert.match(missing.errors[0], /ENOENT.*policy\.json/);
});

test('the bin runs the command and sets the exit code', () => {
  const bin = fileURLToPath(
    new URL('../bin/agenticool-board.mjs', import.meta.url),
  );
  const help = spawnSync(process.execPath, [bin, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.equal(help.stdout, `${USAGE}\n`);
  const unknown = spawnSync(process.execPath, [bin, 'nope'], {
    encoding: 'utf8',
  });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^Unknown command nope/);
});
