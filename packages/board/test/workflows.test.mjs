// The caller workflow templates, rendered for the user fixture, keep the
// triggers and filters of the board workflows, and the reusable workflows
// they call run the agenticool-board commands.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { renderTemplate } from '../src/index.mjs';
import { userPolicy } from './helpers.mjs';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const TOKEN = 'AGENTICOOL_PROJECT_TOKEN';
const REPOSITORY = 'acme/widgets';
const PROJECT = 'Widgets delivery';

/** @param {string} name */
const caller = (name) =>
  parse(renderTemplate(`workflows/${name}.yml`, userPolicy));
/** @param {string} name */
const reusable = (name) =>
  parse(
    readFileSync(
      new URL(`../../../.github/workflows/_${name}.yml`, import.meta.url),
      'utf8',
    ),
  );
/** @param {string} name */
const uses = (name) =>
  `agenticool/agenticool/.github/workflows/_${name}.yml@board-v${version}`;

// Evaluate a GitHub Actions expression as JavaScript. Job IDs such as
// `detect-changes` are valid property names in Actions but not in JavaScript,
// so a hyphenated property outside a string literal becomes an index access.
/**
 * @param {string} expression
 * @param {Record<string, unknown>} values
 */
const evaluate = (expression, values) =>
  Function(
    ...Object.keys(values),
    `return (${expression.replace(
      /('(?:[^']|'')*')|\.([A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+)/g,
      (match, literal, name) => literal ?? `['${name}']`,
    )});`,
  )(...Object.values(values));

/**
 * @param {string} text
 * @param {...unknown} args
 */
const format = (text, ...args) =>
  text.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)]));

// Evaluate a workflow expression such as `${{ a && format('x{0}', b) }}`.
/**
 * @param {string} value
 * @param {Record<string, unknown>} context
 */
const expression = (value, context) =>
  evaluate(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), { format, ...context });

const DEFAULT_BRANCH = { repository: { default_branch: 'main' } };

/**
 * @param {Record<string, any>} job
 * @param {string} name
 */
function callsReusable(job, name) {
  assert.equal(job.uses, uses(name));
  assert.equal(job.with.board_version, version);
  assert.deepEqual(job.secrets, { project_token: `\${{ secrets.${TOKEN} }}` });
}

/** @param {Record<string, any>} job */
function checksOutDefaultBranch(job) {
  const checkout = job.steps.find((/** @type {any} */ step) =>
    step.uses?.startsWith('actions/checkout@'),
  );
  const { 'sparse-checkout': sparse, ...rest } = checkout.with;
  assert.deepEqual(rest, {
    ref: '${{ github.event.repository.default_branch }}',
    'persist-credentials': false,
  });
  // Cone mode keeps the root files, .tool-versions among them, and the
  // workspace install adds the packages.
  /** @param {string} board_version */
  const paths = (board_version) =>
    sparse
      .replace(/\$\{\{(.*?)\}\}/g, (/** @type {string} */ match) =>
        expression(match, { inputs: { board_version } }),
      )
      .split('\n')
      .filter(Boolean);
  assert.deepEqual(paths(version), ['.agents']);
  assert.deepEqual(paths('workspace'), ['.agents', 'packages']);
}

/** @param {Record<string, any>} job */
const commandSteps = (job) =>
  job.steps.filter((/** @type {any} */ step) =>
    /^agenticool-board /m.test(step.run ?? ''),
  );

/** @param {Record<string, any>} step */
function getsToken(step) {
  assert.equal(step.env[TOKEN], '${{ secrets.project_token }}');
}

test('issue events reconcile one issue; the hourly schedule and manual runs sweep', (t) => {
  const definition = caller('board-issue-states');
  assert.deepEqual(definition.on.issues.types, [
    'reopened',
    'closed',
    'labeled',
    'unlabeled',
  ]);
  assert.equal(definition.on.schedule.length, 1);
  const [minute, hour, ...rest] = definition.on.schedule[0].cron.split(' ');
  assert.match(minute, /^\d+$/);
  assert.deepEqual([hour, ...rest], ['*', '*', '*', '*']);
  // The membership sweep runs only inside this hourly job.
  assert.equal(caller('board-project-membership').on.schedule, undefined);
  const issue = { event_name: 'issues', event: { issue: { number: 7 } } };
  assert.equal(
    expression(definition.concurrency.group, { github: issue }),
    'issue-states-issue-7',
  );
  for (const event_name of ['schedule', 'workflow_dispatch'])
    assert.equal(
      expression(definition.concurrency.group, {
        github: { event_name, event: {} },
      }),
      'issue-states-sweep',
    );
  assert.equal(definition.concurrency['cancel-in-progress'], false);
  const call = definition.jobs['reconcile-issues'];
  callsReusable(call, 'board-issue-states');
  assert.equal(expression(call.with.issue, { github: issue }), 7);
  // Actions reads a missing property as null; a schedule event has no issue.
  assert.equal(
    expression(call.with.issue, {
      github: { event_name: 'schedule', event: { issue: {} } },
    }),
    0,
  );
  /**
   * @param {string} event_name
   * @param {Record<string, unknown>} [inputs]
   */
  const dryRun = (event_name, inputs = {}) =>
    expression(call.with.dry_run, { github: { event_name }, inputs });
  assert.equal(dryRun('issues'), false);
  assert.equal(dryRun('schedule'), false);
  assert.equal(dryRun('workflow_dispatch', { dry_run: true }), true);
  assert.equal(dryRun('workflow_dispatch', { dry_run: false }), false);

  const workflow = reusable('board-issue-states');
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
  assert.deepEqual(workflow.on.workflow_call.inputs.issue, {
    description: 'Issue to reconcile with its hierarchy; 0 sweeps the project',
    type: 'number',
    default: 0,
  });
  assert.equal(workflow.on.workflow_call.inputs.dry_run.default, false);
  const job = workflow.jobs['reconcile-issues'];
  checksOutDefaultBranch(job);
  // Only the steps that run the commands get the project token.
  assert.equal(job.env[TOKEN], undefined);
  assert.equal(job.env.DRY_RUN, '${{ inputs.dry_run }}');
  assert.equal(job.env.ISSUE_NUMBER, '${{ inputs.issue }}');
  const steps = commandSteps(job);
  assert.deepEqual(
    steps.map((/** @type {any} */ step) => step.name),
    [
      'Add missing open issues to the project',
      'Triage issues',
      'Close finished containers',
    ],
  );
  assert.equal(steps[0].env.SWEEP, 'true');
  for (const step of steps) getsToken(step);
  // Run the steps with a stand-in for the installed agenticool-board that
  // records its arguments and the exported token, and fails for the command
  // named in FAIL.
  const directory = mkdtempSync(join(tmpdir(), 'board-fake-bin-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'agenticool-board'),
    `#!/bin/sh\necho "$* $${TOKEN}" >> "$BOARD_LOG"\n[ "$1" != "$FAIL" ]\n`,
  );
  chmodSync(join(directory, 'agenticool-board'), 0o755);
  let runs = 0;
  // `failed` reports the command steps only; a failed setup step fails the
  // job on its own.
  /**
   * @param {number} issueNumber
   * @param {{ fail?: string, setup?: string }} [options]
   */
  const run = (issueNumber, { fail = '', setup = 'success' } = {}) => {
    const log = join(directory, `log-${runs++}`);
    writeFileSync(log, '');
    let failed = false;
    for (const step of steps) {
      const runsStep = expression(step.if, {
        inputs: { issue: issueNumber },
        cancelled: () => false,
        steps: { install: { outcome: setup } },
      });
      if (!runsStep) continue;
      const result = spawnSync('bash', ['-e', '-c', step.run], {
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          BOARD_LOG: log,
          FAIL: fail,
          ISSUE_NUMBER: String(issueNumber),
          [TOKEN]: 'secret',
        },
      });
      if (result.status !== 0) failed = true;
    }
    return { log: readFileSync(log, 'utf8'), failed };
  };
  const single = 'triage --issue 7 secret\ncontainers --issue 7 secret\n';
  assert.deepEqual(run(7), { log: single, failed: false });
  const sweep = 'membership secret\ntriage secret\ncontainers secret\n';
  assert.deepEqual(run(0), { log: sweep, failed: false });
  // A failed sweep still lets the later sweeps run, and the job fails.
  for (const fail of ['membership', 'triage', 'containers'])
    assert.deepEqual(run(0, { fail }), { log: sweep, failed: true }, fail);
  assert.deepEqual(run(7, { fail: 'triage' }), { log: single, failed: true });
  assert.deepEqual(run(0, { setup: 'failure' }), { log: '', failed: false });
});

test('label events run only for labels that can change triage or containers', () => {
  const job = caller('board-issue-states').jobs['reconcile-issues'];
  // Actions maps `labels.*.name` to the label names and compares strings
  // without regard to case.
  const condition = job.if.replace(
    /labels\.\*\.name/g,
    'labels.map((label) => label.name)',
  );
  /**
   * @param {string} event_name
   * @param {Record<string, unknown>} [event]
   * @param {Record<string, unknown>} [overrides]
   */
  const runs = (event_name, event = {}, overrides = {}) =>
    expression(condition, {
      startsWith: (
        /** @type {unknown} */ value,
        /** @type {string} */ prefix,
      ) =>
        String(value ?? '')
          .toLowerCase()
          .startsWith(prefix.toLowerCase()),
      contains: (/** @type {string[]} */ list, /** @type {string} */ value) =>
        list.some((item) => item.toLowerCase() === value.toLowerCase()),
      github: {
        event_name,
        repository: REPOSITORY,
        ref: 'refs/heads/main',
        event: {
          ...DEFAULT_BRANCH,
          issue: { number: 7, labels: [] },
          ...event,
        },
        ...overrides,
      },
    });
  /**
   * @param {string} action
   * @param {string} name
   * @param {string[]} [labels]
   */
  const label = (action, name, labels = []) =>
    runs('issues', {
      action,
      label: { name },
      issue: { number: 7, labels: labels.map((name) => ({ name })) },
    });
  for (const action of ['labeled', 'unlabeled']) {
    for (const name of [
      'severity: high',
      'severity: none',
      'epic',
      'automation: container-closed',
    ])
      assert.equal(label(action, name), true, `${action} ${name}`);
    for (const name of ['bug', 'area: repository', 'type: task'])
      assert.equal(label(action, name), false, `${action} ${name}`);
    // Triage removes conflicting labels from epics, so any epic label counts.
    assert.equal(label(action, 'bug', ['epic', 'bug']), true, action);
  }
  for (const action of ['reopened', 'closed'])
    assert.equal(runs('issues', { action }), true, action);
  for (const event_name of ['schedule', 'workflow_dispatch'])
    assert.equal(runs(event_name), true, event_name);
  assert.equal(
    runs('workflow_dispatch', {}, { ref: 'refs/heads/feature' }),
    false,
  );
  assert.equal(
    runs('issues', { action: 'closed' }, { repository: 'someone/fork' }),
    false,
  );
});

// The hourly membership sweep runs in board-issue-states.yml.
test('the workflow adds opened issues and sweeps by hand', () => {
  const definition = caller('board-project-membership');
  const { issues, workflow_dispatch: dispatch } = definition.on;
  assert.deepEqual(Object.keys(definition.on).sort(), [
    'issues',
    'workflow_dispatch',
  ]);
  assert.deepEqual(issues, { types: ['opened'] });
  assert.equal(dispatch.inputs.dry_run.type, 'boolean');
  assert.equal(dispatch.inputs.dry_run.default, true);
  assert.equal(definition.name, 'Board: add issues to the project');
  assert.deepEqual(definition.permissions, { contents: 'read' });
  const opened = {
    event_name: 'issues',
    event: { issue: { number: 7 }, ...DEFAULT_BRANCH },
  };
  assert.equal(
    expression(definition['run-name'], { github: opened }),
    `Add issue #7 to ${PROJECT}`,
  );
  assert.equal(
    expression(definition.concurrency.group, { github: opened }),
    'project-membership-issue-7',
  );
  {
    const event_name = 'workflow_dispatch';
    const github = { event_name, event: DEFAULT_BRANCH };
    assert.equal(
      expression(definition['run-name'], { github }),
      `Add missing issues to ${PROJECT} (${event_name})`,
    );
    assert.equal(
      expression(definition.concurrency.group, { github }),
      'project-membership-sweep',
    );
  }
  assert.equal(definition.concurrency['cancel-in-progress'], false);
  assert.deepEqual(Object.keys(definition.jobs), [
    'add-to-project',
    'add-missing-issues',
  ]);
  for (const call of Object.values(definition.jobs))
    callsReusable(call, 'board-project-membership');
  const { jobs } = definition;
  assert.equal(
    expression(jobs['add-to-project'].with.issue, { github: opened }),
    7,
  );
  assert.equal(jobs['add-to-project'].with.dry_run, undefined);
  assert.equal(jobs['add-missing-issues'].with.issue, undefined);

  const workflow = reusable('board-project-membership');
  assert.deepEqual(Object.keys(workflow.jobs), [
    'add-to-project',
    'add-missing-issues',
  ]);
  for (const job of Object.values(workflow.jobs)) {
    checksOutDefaultBranch(job);
    const steps = commandSteps(job);
    assert.match(steps[0].run, /^agenticool-board membership\n$/);
    for (const step of steps) getsToken(step);
  }
  assert.equal(commandSteps(workflow.jobs['add-missing-issues']).length, 1);
  // The caller's inputs pick one job: an issue, or 0 for the sweep.
  for (const [issue, id] of [
    [7, 'add-to-project'],
    [0, 'add-missing-issues'],
  ])
    assert.deepEqual(
      Object.entries(workflow.jobs)
        .filter(([, job]) => expression(job.if, { inputs: { issue } }))
        .map(([id]) => id),
      [id],
    );
});

test('opened issues are added to the project, then triaged once', () => {
  const job = reusable('board-project-membership').jobs['add-to-project'];
  assert.equal(job.name, 'Add the issue to the project');
  assert.equal(job.env.DRY_RUN, '${{ inputs.dry_run }}');
  const [run, triage, ...rest] = commandSteps(job);
  assert.deepEqual(rest, []);
  assert.equal(triage.name, 'Triage the new issue');
  assert.match(
    triage.run,
    /^agenticool-board triage --issue "\$ISSUE_NUMBER"\n$/,
  );
  assert.deepEqual(Object.keys(triage.env).sort(), [TOKEN, 'ISSUE_NUMBER']);
  assert.equal(
    expression(triage.env.ISSUE_NUMBER, { inputs: { issue: 7 } }),
    7,
  );
  assert.deepEqual(Object.keys(run.env).sort(), [
    TOKEN,
    'CONTENT_NUMBER',
    'CONTENT_TYPE',
  ]);
  assert.equal(run.env.CONTENT_TYPE, 'issue');
  assert.equal(expression(run.env.CONTENT_NUMBER, { inputs: { issue: 7 } }), 7);
});

test('each event runs one job, and the sweep runs only from the default branch', () => {
  const { jobs } = caller('board-project-membership');
  /** @param {Record<string, unknown>} github */
  const runs = (github) =>
    Object.entries(jobs)
      .filter(([, job]) => expression(job.if, { github }))
      .map(([id]) => id);
  /**
   * @param {string} event_name
   * @param {Record<string, unknown>} [overrides]
   */
  const github = (event_name, overrides = {}) => ({
    event_name,
    repository: REPOSITORY,
    ref: 'refs/heads/main',
    event: { issue: { number: 7 }, ...DEFAULT_BRANCH },
    ...overrides,
  });
  assert.deepEqual(runs(github('issues')), ['add-to-project']);
  assert.deepEqual(runs(github('issues', { ref: 'refs/heads/feature' })), [
    'add-to-project',
  ]);
  assert.deepEqual(runs(github('workflow_dispatch')), ['add-missing-issues']);
  assert.deepEqual(
    runs(github('workflow_dispatch', { ref: 'refs/heads/feature' })),
    [],
  );
  for (const event_name of ['issues', 'workflow_dispatch'])
    assert.deepEqual(
      runs(github(event_name, { repository: 'someone/fork' })),
      [],
    );
});

test('a manual sweep follows its dry_run input', () => {
  const call = caller('board-project-membership').jobs['add-missing-issues'];
  assert.equal(call.name, `Add missing open issues to ${PROJECT}`);
  /**
   * @param {string} event_name
   * @param {Record<string, unknown>} [inputs]
   */
  const dryRun = (event_name, inputs = {}) =>
    expression(call.with.dry_run, { github: { event_name }, inputs });
  assert.equal(dryRun('workflow_dispatch', { dry_run: true }), true);
  assert.equal(dryRun('workflow_dispatch', { dry_run: false }), false);
  const job = reusable('board-project-membership').jobs['add-missing-issues'];
  assert.equal(job.env.DRY_RUN, '${{ inputs.dry_run }}');
  const [run] = commandSteps(job);
  assert.deepEqual(Object.keys(run.env).sort(), [TOKEN, 'SWEEP']);
  assert.equal(run.env.SWEEP, 'true');
});

test('status events are limited and run default-branch code', () => {
  const status = renderTemplate(
    'workflows/board-pr-issue-status.yml',
    userPolicy,
  );
  assert.match(status, /types: \[opened, edited, reopened, ready_for_review\]/);
  const call = parse(status).jobs['mark-issues-in-review'];
  callsReusable(call, 'board-pr-issue-status');
  const github = {
    event: { action: 'edited', pull_request: { number: 10 } },
  };
  assert.equal(expression(call.with.pull_request, { github }), 10);
  assert.equal(expression(call.with.action, { github }), 'edited');
  assert.equal(call.with.dry_run, undefined);
  const job = reusable('board-pr-issue-status').jobs['mark-issues-in-review'];
  checksOutDefaultBranch(job);
  const [run] = commandSteps(job);
  getsToken(run);
  assert.match(run.run, /^agenticool-board pr-status\n$/);
  assert.equal(run.env.PR_NUMBER, '${{ inputs.pull_request }}');
  assert.equal(run.env.PR_ACTION, '${{ inputs.action }}');
  assert.equal(run.env.DRY_RUN, '${{ inputs.dry_run }}');
});

test('metadata runs for pull requests and by hand with a dry-run default', () => {
  const definition = caller('board-pr-metadata');
  assert.deepEqual(definition.on.pull_request_target.types, [
    'opened',
    'edited',
    'reopened',
    'ready_for_review',
  ]);
  assert.equal(definition.on.workflow_dispatch.inputs.dry_run.default, true);
  const call = definition.jobs['copy-issue-metadata'];
  callsReusable(call, 'board-pr-metadata');
  const fromJSON = (/** @type {unknown} */ value) => JSON.parse(String(value));
  assert.equal(
    expression(call.with.pull_request, {
      fromJSON,
      github: { event: { pull_request: { number: 10 } } },
    }),
    10,
  );
  assert.equal(
    expression(call.with.pull_request, {
      fromJSON,
      github: { event: { pull_request: {} } },
      inputs: { pull_request: '12' },
    }),
    12,
  );
  /**
   * @param {string} event_name
   * @param {Record<string, unknown>} [inputs]
   */
  const dryRun = (event_name, inputs = {}) =>
    expression(call.with.dry_run, { github: { event_name }, inputs });
  assert.equal(dryRun('pull_request_target'), false);
  assert.equal(dryRun('workflow_dispatch', { dry_run: true }), true);
  const job = reusable('board-pr-metadata').jobs['copy-issue-metadata'];
  checksOutDefaultBranch(job);
  const [run] = commandSteps(job);
  getsToken(run);
  assert.match(run.run, /^agenticool-board pr-metadata\n$/);
  assert.equal(run.env.PR_NUMBER, '${{ inputs.pull_request }}');
});

test('both PR board workflows skip edits that leave the body unchanged', () => {
  const jobs = {
    'board-pr-metadata': 'copy-issue-metadata',
    'board-pr-issue-status': 'mark-issues-in-review',
  };
  for (const [name, id] of Object.entries(jobs)) {
    const condition = caller(name).jobs[id].if;
    /** @param {Record<string, unknown>} event */
    const runs = (event) =>
      evaluate(condition, {
        format,
        github: {
          event_name: 'pull_request_target',
          repository: REPOSITORY,
          ref: 'refs/heads/main',
          event: {
            ...DEFAULT_BRANCH,
            pull_request: { number: 10, draft: false },
            ...event,
          },
        },
      });
    for (const action of ['opened', 'reopened', 'ready_for_review'])
      assert.equal(runs({ action }), true, `${name} ${action}`);
    assert.ok(
      runs({ action: 'edited', changes: { body: { from: 'Closes #1' } } }),
      `${name} body edit`,
    );
    for (const changes of [
      { title: { from: 'old title' } },
      { base: { ref: { from: 'other' } } },
      {},
    ])
      assert.ok(
        !runs({ action: 'edited', changes }),
        `${name} ${JSON.stringify(changes)}`,
      );
  }
});

// A caller passes only the Projects token, never every repository secret.
test('callers pass only the project token, the one secret each reusable workflow declares', () => {
  for (const name of [
    'board-issue-states',
    'board-pr-issue-status',
    'board-pr-metadata',
    'board-project-membership',
  ]) {
    assert.doesNotMatch(
      readFileSync(
        new URL(`../templates/workflows/${name}.yml`, import.meta.url),
        'utf8',
      ),
      /secrets:\s*inherit/,
      name,
    );
    for (const job of Object.values(caller(name).jobs))
      assert.deepEqual(Object.keys(job.secrets), ['project_token'], name);
    assert.deepEqual(reusable(name).on.workflow_call.secrets, {
      project_token: {
        description: 'Projects token, from the AGENTICOOL_PROJECT_TOKEN secret',
        required: false,
      },
    });
  }
});

test('every job installs only the board at the caller version, outside the checkout', (t) => {
  // The real path, since bash reports $PWD without macOS's /var symlink.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'board-install-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  const checkout = join(directory, 'checkout');
  const temp = join(directory, 'temp');
  mkdirSync(bin);
  mkdirSync(checkout);
  // A stand-in for npm that records its arguments.
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "$*" >> "$NPM_LOG"\n');
  chmodSync(join(bin, 'npm'), 0o755);
  let runs = 0;
  /**
   * @param {Record<string, any>} step
   * @param {string} boardVersion
   */
  const install = (step, boardVersion) => {
    const log = join(directory, `npm-${runs}`);
    const path = join(directory, `path-${runs++}`);
    writeFileSync(log, '');
    writeFileSync(path, '');
    const result = spawnSync('bash', ['-e', '-c', step.run], {
      cwd: checkout,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        NPM_LOG: log,
        GITHUB_PATH: path,
        RUNNER_TEMP: temp,
        BOARD_VERSION: boardVersion,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return { npm: readFileSync(log, 'utf8'), path: readFileSync(path, 'utf8') };
  };
  for (const name of [
    'board-issue-states',
    'board-pr-issue-status',
    'board-pr-metadata',
    'board-project-membership',
  ]) {
    const workflow = reusable(name);
    assert.deepEqual(workflow.on.workflow_call.inputs.board_version, {
      description:
        "Version of @agenticool/board to install; `workspace` installs the checkout's workspace packages instead",
      type: 'string',
      required: true,
    });
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const label = `${name} ${id}`;
      const steps = job.steps.filter((/** @type {any} */ step) =>
        step.run?.includes('npm '),
      );
      assert.deepEqual(
        steps.map((/** @type {any} */ step) => step.name),
        ['Install the board'],
        label,
      );
      const [step] = steps;
      // The install step never sees the project token.
      assert.deepEqual(
        step.env,
        { BOARD_VERSION: '${{ inputs.board_version }}' },
        label,
      );
      assert.deepEqual(install(step, '1.2.3'), {
        npm: `install --prefix ${temp}/agenticool --no-save --no-audit --no-fund @agenticool/board@1.2.3\n`,
        path: `${temp}/agenticool/node_modules/.bin\n`,
      });
      // Only the hosting repository's workspace path installs the checkout.
      assert.deepEqual(install(step, 'workspace'), {
        npm: 'ci\n',
        path: `${checkout}/node_modules/.bin\n`,
      });
    }
  }
});

test('without the token secret every job warns and skips the rest of its steps', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'board-token-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let runs = 0;
  /**
   * @param {Record<string, any>} step
   * @param {string} token
   */
  const guard = (step, token) => {
    const output = join(directory, `output-${runs++}`);
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-e', '-c', step.run], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        PROJECT_TOKEN: token,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return { stdout: result.stdout, output: readFileSync(output, 'utf8') };
  };
  for (const name of [
    'board-issue-states',
    'board-pr-issue-status',
    'board-pr-metadata',
    'board-project-membership',
  ])
    for (const [id, job] of Object.entries(reusable(name).jobs)) {
      const [first, ...rest] = job.steps;
      const label = `${name} ${id}`;
      assert.equal(first.id, 'token', label);
      assert.equal(first.env.PROJECT_TOKEN, '${{ secrets.project_token }}');
      assert.deepEqual(guard(first, ''), {
        stdout: `::warning::${TOKEN} secret is not set; skipping\n`,
        output: '',
      });
      assert.deepEqual(guard(first, 'secret'), {
        stdout: '',
        output: 'set=true\n',
      });
      // Actions reads a missing step output as an empty string, and a
      // skipped install step has the outcome `skipped`.
      /**
       * @param {string} set
       * @param {string} outcome
       */
      const runsStep = (set, outcome) =>
        rest.map((/** @type {any} */ step) =>
          Boolean(
            expression(step.if, {
              inputs: { issue: 0 },
              cancelled: () => false,
              steps: { token: { outputs: { set } }, install: { outcome } },
            }),
          ),
        );
      assert.ok(rest.length > 0, label);
      assert.deepEqual(
        runsStep('', 'skipped'),
        rest.map(() => false),
        label,
      );
      assert.deepEqual(
        runsStep('true', 'success'),
        rest.map(() => true),
        label,
      );
    }
});
