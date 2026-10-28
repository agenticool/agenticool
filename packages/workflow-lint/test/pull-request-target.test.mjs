import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG, lint, W } from './helpers.mjs';

const FILE = `${W}tracker-pr-metadata.yml`;

/**
 * @param {string} steps
 * @param {string} [extra] Workflow-level keys, such as `env`.
 * @param {string} [on]
 */
const target = (steps, extra = '', on = 'pull_request_target') => ({
  [FILE]: `on: ${on}\n${extra}jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`,
});
/** @param {string} inputs */
const checkout = (inputs) =>
  `      - name: Check out\n        uses: actions/checkout@0000000000000000000000000000000000000000 # v4\n        with:\n${inputs}`;
/**
 * @param {Record<string, string | null>} changes
 * @param {string} [repository]
 */
const problems = (changes, repository) =>
  lint('pull-request-target', changes, { repository });

test('pull_request_target workflows in the clean fixture never check out or fetch pull request code', () => {
  assert.deepEqual(lint('pull-request-target'), []);
});

test('pull_request_target is found in string, list, and map triggers', () => {
  for (const on of [
    'pull_request_target',
    '[push, pull_request_target]',
    '\n  pull_request_target:\n    types: [opened]',
  ])
    assert.deepEqual(problems(target('', '', on)), [], on);
  assert.deepEqual(problems(target('', '', '[push, pull_request]')), [
    'is listed in pullRequestTarget but does not run on it',
  ]);
});

test('listed workflows must exist, and unlisted workflows may not use the trigger', () => {
  assert.deepEqual(
    lint(
      'pull-request-target',
      { [`${W}tracker-extra.yml`]: 'on: pull_request_target\njobs: {}\n' },
      {
        config: {
          ...CONFIG,
          pullRequestTarget: ['tracker-pr-metadata.yml', 'tracker-gone.yml'],
        },
      },
    ),
    [
      'is listed in pullRequestTarget but does not run on it',
      'runs on pull_request_target but pullRequestTarget does not list it',
    ],
  );
});

test('a checkout of the pull request head fails', () => {
  for (const ref of [
    '${{ github.event.pull_request.head.sha }}',
    '${{ github.event.pull_request.head.ref }}',
    '${{ github.head_ref }}',
    '${{ github.event.pull_request.merge_commit_sha }}',
    'refs/pull/${{ github.event.pull_request.number }}/merge',
  ]) {
    assert.deepEqual(
      problems(target(checkout(`          ref: ${ref}\n`))),
      [`build step 1 (Check out) checks out the pull request head: ${ref}`],
      ref,
    );
  }
});

test('a checkout ref read from env that names the pull request head fails', () => {
  const ref = '${{ env.PR_SHA }}';
  assert.deepEqual(
    problems(
      target(
        checkout(`          ref: ${ref}\n`),
        'env:\n  PR_SHA: ${{ github.event.pull_request.head.sha }}\n',
      ),
    ),
    [`build step 1 (Check out) checks out the pull request head: ${ref}`],
  );
  assert.deepEqual(
    problems(
      target(
        checkout(`          ref: ${ref}\n`),
        'env:\n  PR_SHA: ${{ github.sha }}\n',
      ),
    ),
    [],
  );
});

test('a checkout of another repository fails', () => {
  const repository = '${{ github.event.pull_request.head.repo.full_name }}';
  assert.deepEqual(
    problems(target(checkout(`          repository: ${repository}\n`))),
    [
      `build step 1 (Check out) checks out a repository other than the base repository: ${repository}`,
    ],
  );
  assert.equal(
    problems(target(checkout('          repository: someone/fork\n'))).length,
    1,
  );
});

test('a checkout of the default branch in the base repository passes', () => {
  for (const repository of [
    '${{ github.repository }}',
    '${{github.event.repository.full_name}}',
    'octo/widgets',
  ]) {
    assert.deepEqual(
      problems(
        target(
          checkout(
            `          ref: \${{ github.event.repository.default_branch }}\n          repository: ${repository}\n          persist-credentials: false\n`,
          ),
        ),
      ),
      [],
      repository,
    );
  }
});

test('the base repository literal comes from binding.repository', () => {
  const steps = target(checkout('          repository: octo/widgets\n'));
  assert.deepEqual(problems(steps, 'octo/other'), [
    'build step 1 (Check out) checks out a repository other than the base repository: octo/widgets',
  ]);
});

test('a run step that fetches the pull request head fails', () => {
  /**
   * @param {string} script
   * @param {string} [env]
   */
  const run = (script, env = '') =>
    `      - name: Fetch\n${env}        run: ${script}\n`;
  for (const steps of [
    run('git fetch origin pull/${{ github.event.pull_request.number }}/head'),
    run('git fetch origin ${{ github.event.pull_request.head.sha }}'),
    run('git -C repo fetch origin refs/pull/1/head'),
    run('git -c protocol.version=2 fetch origin pull/1/head'),
    run('git -C "$DIR" fetch origin ${{ github.event.pull_request.head.sha }}'),
    run('|\n          git \\\n            fetch origin pull/1/head'),
    run('git fetch origin "$GITHUB_HEAD_REF"'),
    run(
      'git fetch origin "$HEAD_SHA"',
      '        env:\n          HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n',
    ),
  ]) {
    assert.deepEqual(
      problems(target(steps)),
      ['build step 1 (Fetch) fetches the pull request head'],
      steps,
    );
  }
  assert.deepEqual(problems(target(run('git fetch origin main'))), []);
  assert.deepEqual(
    problems(target(run('git -C "$DIR" fetch origin main'))),
    [],
  );
  assert.deepEqual(
    problems(target('      - run: git fetch origin pull/1/head\n')),
    ['build step 1 (run) fetches the pull request head'],
  );
});

test('a run step that checks out the pull request with gh fails', () => {
  for (const script of [
    'gh pr checkout ${{ github.event.pull_request.number }}',
    'gh pr checkout "$PR"',
  ]) {
    assert.deepEqual(
      problems(target(`      - name: Check out PR\n        run: ${script}\n`)),
      ['build step 1 (Check out PR) checks out the pull request with gh'],
      script,
    );
  }
});

test('a job that calls a reusable workflow fails', () => {
  assert.deepEqual(
    problems({
      [FILE]:
        'on: pull_request_target\njobs:\n  call:\n    uses: ./.github/workflows/build.yml\n',
    }),
    ['call calls a reusable workflow: ./.github/workflows/build.yml'],
  );
});

test('the same steps pass outside pull_request_target', () => {
  assert.deepEqual(
    lint(
      'pull-request-target',
      target(
        checkout('          ref: ${{ github.event.pull_request.head.sha }}\n'),
        '',
        'pull_request',
      ),
      { config: { ...CONFIG, pullRequestTarget: [] } },
    ),
    [],
  );
});
