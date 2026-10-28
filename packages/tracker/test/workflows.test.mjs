// The caller workflow templates, rendered for the user fixture, keep the
// triggers and filters of the tracker workflows, and the reusable workflows
// they call run the agenticool-tracker commands.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lintWorkflows } from '@agenticool/workflow-lint';
import { parse } from 'yaml';
import { renderTemplate } from '../src/index.mjs';
import { userPolicy } from './helpers.mjs';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const TOKEN = 'WIDGETS_PROJECT_TOKEN';
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
  `agenticool/agenticool/.github/workflows/_${name}.yml@tracker-v${version}`;

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
  assert.equal(job.with.token_env, TOKEN);
  assert.equal(job.secrets, 'inherit');
}

/** @param {Record<string, any>} job */
function checksOutDefaultBranch(job) {
  const checkout = job.steps.find((/** @type {any} */ step) =>
    step.uses?.startsWith('actions/checkout@'),
  );
  assert.deepEqual(checkout.with, {
    ref: '${{ github.event.repository.default_branch }}',
    'persist-credentials': false,
  });
}

/** @param {Record<string, any>} job */
const commandSteps = (job) =>
  job.steps.filter((/** @type {any} */ step) => step.run?.includes('npx'));

/** @param {Record<string, any>} step */
function getsToken(step) {
  assert.equal(step.env.PROJECT_TOKEN, '${{ secrets[inputs.token_env] }}');
  assert.match(step.run, /^export "\$TOKEN_ENV=\$PROJECT_TOKEN"\n/);
}

test('issue events reconcile one issue; the hourly schedule and manual runs sweep', (t) => {
  const definition = caller('tracker-issue-states');
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
  assert.equal(caller('tracker-project-membership').on.schedule, undefined);
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
  callsReusable(call, 'tracker-issue-states');
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

  const workflow = reusable('tracker-issue-states');
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
  assert.equal(job.env.PROJECT_TOKEN, undefined);
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
  // Run the steps with a stand-in for npx that records its arguments and the
  // exported token, and fails for the command named in FAIL.
  const directory = mkdtempSync(join(tmpdir(), 'tracker-fake-npx-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'npx'),
    `#!/bin/sh\necho "$* $${TOKEN}" >> "$NPX_LOG"\n[ "$3" != "$FAIL" ]\n`,
  );
  chmodSync(join(directory, 'npx'), 0o755);
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
          NPX_LOG: log,
          FAIL: fail,
          ISSUE_NUMBER: String(issueNumber),
          TOKEN_ENV: TOKEN,
          PROJECT_TOKEN: 'secret',
        },
      });
      if (result.status !== 0) failed = true;
    }
    return { log: readFileSync(log, 'utf8'), failed };
  };
  const single =
    '--no agenticool-tracker triage --issue 7 secret\n--no agenticool-tracker containers --issue 7 secret\n';
  assert.deepEqual(run(7), { log: single, failed: false });
  const sweep =
    '--no agenticool-tracker membership secret\n--no agenticool-tracker triage secret\n--no agenticool-tracker containers secret\n';
  assert.deepEqual(run(0), { log: sweep, failed: false });
  // A failed sweep still lets the later sweeps run, and the job fails.
  for (const fail of ['membership', 'triage', 'containers'])
    assert.deepEqual(run(0, { fail }), { log: sweep, failed: true }, fail);
  assert.deepEqual(run(7, { fail: 'triage' }), { log: single, failed: true });
  assert.deepEqual(run(0, { setup: 'failure' }), { log: '', failed: false });
});

test('label events run only for labels that can change triage or containers', () => {
  const job = caller('tracker-issue-states').jobs['reconcile-issues'];
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

// The hourly membership sweep runs in tracker-issue-states.yml.
test('the workflow adds opened issues and sweeps by hand', () => {
  const definition = caller('tracker-project-membership');
  const { issues, workflow_dispatch: dispatch } = definition.on;
  assert.deepEqual(Object.keys(definition.on).sort(), [
    'issues',
    'workflow_dispatch',
  ]);
  assert.deepEqual(issues, { types: ['opened'] });
  assert.equal(dispatch.inputs.dry_run.type, 'boolean');
  assert.equal(dispatch.inputs.dry_run.default, true);
  assert.equal(definition.name, 'Tracker: add issues to the project');
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
    callsReusable(call, 'tracker-project-membership');
  const { jobs } = definition;
  assert.equal(
    expression(jobs['add-to-project'].with.issue, { github: opened }),
    7,
  );
  assert.equal(jobs['add-to-project'].with.dry_run, undefined);
  assert.equal(jobs['add-missing-issues'].with.issue, undefined);

  const workflow = reusable('tracker-project-membership');
  assert.deepEqual(Object.keys(workflow.jobs), [
    'add-to-project',
    'add-missing-issues',
  ]);
  for (const job of Object.values(workflow.jobs)) {
    checksOutDefaultBranch(job);
    const steps = commandSteps(job);
    assert.match(steps[0].run, /\nnpx --no agenticool-tracker membership\n$/);
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
  const job = reusable('tracker-project-membership').jobs['add-to-project'];
  assert.equal(job.name, 'Add the issue to the project');
  assert.equal(job.env.DRY_RUN, '${{ inputs.dry_run }}');
  const [run, triage, ...rest] = commandSteps(job);
  assert.deepEqual(rest, []);
  assert.equal(triage.name, 'Triage the new issue');
  assert.match(
    triage.run,
    /\nnpx --no agenticool-tracker triage --issue "\$ISSUE_NUMBER"\n$/,
  );
  assert.deepEqual(Object.keys(triage.env).sort(), [
    'ISSUE_NUMBER',
    'PROJECT_TOKEN',
  ]);
  assert.equal(
    expression(triage.env.ISSUE_NUMBER, { inputs: { issue: 7 } }),
    7,
  );
  assert.deepEqual(Object.keys(run.env).sort(), [
    'CONTENT_NUMBER',
    'CONTENT_TYPE',
    'PROJECT_TOKEN',
  ]);
  assert.equal(run.env.CONTENT_TYPE, 'issue');
  assert.equal(expression(run.env.CONTENT_NUMBER, { inputs: { issue: 7 } }), 7);
});

test('each event runs one job, and the sweep runs only from the default branch', () => {
  const { jobs } = caller('tracker-project-membership');
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
  const call = caller('tracker-project-membership').jobs['add-missing-issues'];
  assert.equal(call.name, `Add missing open issues to ${PROJECT}`);
  /**
   * @param {string} event_name
   * @param {Record<string, unknown>} [inputs]
   */
  const dryRun = (event_name, inputs = {}) =>
    expression(call.with.dry_run, { github: { event_name }, inputs });
  assert.equal(dryRun('workflow_dispatch', { dry_run: true }), true);
  assert.equal(dryRun('workflow_dispatch', { dry_run: false }), false);
  const job = reusable('tracker-project-membership').jobs['add-missing-issues'];
  assert.equal(job.env.DRY_RUN, '${{ inputs.dry_run }}');
  const [run] = commandSteps(job);
  assert.deepEqual(Object.keys(run.env).sort(), ['PROJECT_TOKEN', 'SWEEP']);
  assert.equal(run.env.SWEEP, 'true');
});

test('status events are limited and run default-branch code', () => {
  const status = renderTemplate(
    'workflows/tracker-pr-issue-status.yml',
    userPolicy,
  );
  assert.match(status, /types: \[opened, edited, reopened, ready_for_review\]/);
  const call = parse(status).jobs['mark-issues-in-review'];
  callsReusable(call, 'tracker-pr-issue-status');
  const github = {
    event: { action: 'edited', pull_request: { number: 10 } },
  };
  assert.equal(expression(call.with.pull_request, { github }), 10);
  assert.equal(expression(call.with.action, { github }), 'edited');
  assert.equal(call.with.dry_run, undefined);
  const job = reusable('tracker-pr-issue-status').jobs['mark-issues-in-review'];
  checksOutDefaultBranch(job);
  const [run] = commandSteps(job);
  getsToken(run);
  assert.match(run.run, /\nnpx --no agenticool-tracker pr-status\n$/);
  assert.equal(run.env.PR_NUMBER, '${{ inputs.pull_request }}');
  assert.equal(run.env.PR_ACTION, '${{ inputs.action }}');
  assert.equal(run.env.DRY_RUN, '${{ inputs.dry_run }}');
});

test('metadata runs for pull requests and by hand with a dry-run default', () => {
  const definition = caller('tracker-pr-metadata');
  assert.deepEqual(definition.on.pull_request_target.types, [
    'opened',
    'edited',
    'reopened',
    'ready_for_review',
  ]);
  assert.equal(definition.on.workflow_dispatch.inputs.dry_run.default, true);
  const call = definition.jobs['copy-issue-metadata'];
  callsReusable(call, 'tracker-pr-metadata');
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
  const job = reusable('tracker-pr-metadata').jobs['copy-issue-metadata'];
  checksOutDefaultBranch(job);
  const [run] = commandSteps(job);
  getsToken(run);
  assert.match(run.run, /\nnpx --no agenticool-tracker pr-metadata\n$/);
  assert.equal(run.env.PR_NUMBER, '${{ inputs.pull_request }}');
});

test('both PR tracker workflows skip edits that leave the body unchanged', () => {
  const jobs = {
    'tracker-pr-metadata': 'copy-issue-metadata',
    'tracker-pr-issue-status': 'mark-issues-in-review',
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

test('rendered caller workflows follow the workflow naming and timeout rules', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tracker-callers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.github', 'workflows');
  mkdirSync(directory, { recursive: true });
  for (const name of [
    'tracker-issue-states',
    'tracker-pr-issue-status',
    'tracker-pr-metadata',
    'tracker-project-membership',
  ])
    writeFileSync(
      join(directory, `${name}.yml`),
      renderTemplate(`workflows/${name}.yml`, userPolicy),
    );
  const problems = lintWorkflows(directory, {
    config: {
      areas: { tracker: 'Tracker' },
      pullRequestTarget: [
        'tracker-pr-issue-status.yml',
        'tracker-pr-metadata.yml',
      ],
    },
    repository: REPOSITORY,
  }).filter(({ rule }) => rule !== 'node-version');
  // The pull_request_target callers run only the reusable workflows'
  // default-branch code, which the rule cannot see through `uses`.
  assert.deepEqual(
    problems.map(({ file, rule, message }) => `${file} ${rule} ${message}`),
    [
      `.github/workflows/tracker-pr-issue-status.yml pull-request-target calls a reusable workflow: ${uses('tracker-pr-issue-status')}`,
      `.github/workflows/tracker-pr-metadata.yml pull-request-target calls a reusable workflow: ${uses('tracker-pr-metadata')}`,
    ],
  );
});
