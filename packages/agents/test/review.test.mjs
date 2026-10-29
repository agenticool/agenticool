import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseReviewReport,
  publishReview,
  reviewEvent,
  REVIEW_VERDICTS,
} from '@agenticool/agents';
import { policy } from './helpers.mjs';

// Manual review publication against mocked `gh api` calls. Nothing here
// reaches GitHub. `run` stands in for execFileSync and records every call.
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
// The base branch tip, which moves on after the reviewed merge base.
const TIP = 'd'.repeat(40);
/**
 * @param {string} verdict
 * @param {string} [pair]
 */
const report = (verdict, pair = `${BASE}..${HEAD}`) =>
  [
    `Verdict: ${verdict}`,
    `Base/Head: ${pair}`,
    'Acceptance: criterion one met',
    'Findings: high | scripts/x.mjs:1 | problem | fix',
    'Limits: tests read, not run.',
    'Requested settings: Policy: tool=claude role=ac-code-reviewer model=opus effort=high (model: policy, effort: policy)',
  ].join('\n');

// A `gh api --include` failure: the status line and GitHub's JSON body on
// stdout, the HTTP summary on stderr.
/**
 * @param {number} status
 * @param {{ message: string, errors?: string[] }} body
 */
function ghFailure(status, body) {
  return Object.assign(new Error('gh failed'), {
    status: 1,
    stdout: `HTTP/2.0 ${status} Status\r\n\r\n${JSON.stringify(body)}`,
    stderr: `gh: ${body.message} (HTTP ${status})\n`,
  });
}

/**
 * @typedef {{ viewer?: string | null, author?: string | null, tip?: string, mergeBase?: string, head?: string, user?: Error, review?: Error, state?: string, merged?: boolean }} MockOptions
 * @typedef {import('@agenticool/core').Run} MockRun
 * @param {MockOptions} [options]
 */
function mockGitHub({
  viewer = 'reviewer',
  author = 'author',
  tip = TIP,
  mergeBase = BASE,
  head = HEAD,
  user,
  review,
  state = 'open',
  merged = false,
} = {}) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {any[]} */
  const posts = [];
  /** @type {MockRun} */
  const run = (command, args, options) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 2), ['api', '--include']);
    calls.push(args);
    const path = args[2];
    if (path === `repos/${policy.repository}/pulls/7`)
      return JSON.stringify({
        number: 7,
        state,
        merged,
        merged_at: merged ? '2026-10-01T00:00:00Z' : null,
        user: author === null ? null : { login: author },
        base: { sha: tip, ref: 'main' },
        head: { sha: head },
      });
    if (
      path === `repos/${policy.repository}/compare/${tip}...${HEAD}?per_page=1`
    ) {
      // gh filters the compare response so its file patches never reach the buffer.
      assert.deepEqual(args.slice(3), [
        '--jq',
        '{sha: .merge_base_commit.sha}',
      ]);
      return JSON.stringify({ sha: mergeBase });
    }
    if (path === 'user') {
      if (user) throw user;
      return JSON.stringify(viewer === null ? {} : { login: viewer });
    }
    if (path === `repos/${policy.repository}/pulls/7/reviews`) {
      assert.deepEqual(args.slice(3), ['--method', 'POST', '--input', '-']);
      const payload = JSON.parse(String(options.input));
      posts.push(payload);
      if (review) throw review;
      return JSON.stringify({
        id: 1,
        html_url: 'https://github.com/example/pull/7#pullrequestreview-1',
      });
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { run, calls, posts };
}

/**
 * @param {string} verdict
 * @param {{ run: MockRun }} github
 * @param {Record<string, string | undefined>} [options]
 */
const publish = (verdict, github, options = {}) =>
  publishReview(
    policy,
    {
      pr: '7',
      base: BASE,
      head: HEAD,
      report: report(verdict),
      ...options,
    },
    github.run,
  );

test('a review report yields its verdict and reviewed SHAs', () => {
  assert.deepEqual(parseReviewReport(report('REQUEST CHANGES')), {
    verdict: 'REQUEST CHANGES',
    base: BASE,
    head: HEAD,
  });
  assert.deepEqual(
    parseReviewReport('**Verdict:** APPROVE\n- Base/Head: `abc1234..def5678`'),
    { verdict: 'APPROVE', base: 'abc1234', head: 'def5678' },
  );
  assert.deepEqual(
    parseReviewReport('Verdict: BLOCKED\nBase/Head: abc1234 .. def5678'),
    { verdict: 'BLOCKED', base: 'abc1234', head: 'def5678' },
  );
  for (const text of [
    'Verdict: BLOCKED',
    'Verdict: BLOCKED\nBase/Head: unknown',
    'Verdict: BLOCKED\nBase/Head: abc1234',
  ])
    assert.throws(
      () => parseReviewReport(text),
      /Review not posted: the report has no Base\/Head: <sha>\.\.<sha> line/,
    );
  assert.throws(
    () => parseReviewReport('Findings: none'),
    /Review not posted: the report has no Verdict: line/,
  );
  assert.throws(
    () => parseReviewReport('Verdict: APPROVE\nVerdict: REQUEST CHANGES'),
    /conflicting verdicts/,
  );
});

test('only a change request from another account requests changes, and nothing approves', () => {
  for (const verdict of REVIEW_VERDICTS) {
    const other = reviewEvent({ verdict, viewer: 'bob', author: 'alice' });
    assert.equal(
      other.event,
      verdict === 'REQUEST CHANGES' ? 'REQUEST_CHANGES' : 'COMMENT',
      verdict,
    );
    // Logins compare as GitHub does, whatever agent or model is reviewing.
    const same = reviewEvent({ verdict, viewer: 'Alice', author: 'alice' });
    assert.equal(same.event, 'COMMENT', verdict);
    const unknown = reviewEvent({
      verdict,
      viewer: null,
      author: 'alice',
      identityError: 'HTTP 403',
    });
    assert.equal(unknown.event, 'COMMENT', verdict);
    assert.match(String(unknown.note), /could not be compared.*HTTP 403/);
  }
  assert.match(
    String(
      reviewEvent({ verdict: 'REQUEST CHANGES', viewer: 'a', author: 'a' })
        .note,
    ),
    /rather than a change request.*share the GitHub account @a/,
  );
  assert.match(
    String(reviewEvent({ verdict: 'APPROVE', viewer: 'a', author: 'b' }).note),
    /never submits a GitHub approval/,
  );
  assert.equal(
    reviewEvent({ verdict: 'BLOCKED', viewer: 'a', author: 'b' }).note,
    null,
  );
  assert.throws(
    () => reviewEvent({ verdict: 'LGTM', viewer: 'a', author: 'b' }),
    /Unknown review verdict/,
  );
});

test('every manual PR review posts exactly one review with the right event', () => {
  const cases = [
    ['REQUEST CHANGES', 'reviewer', 'author', 'REQUEST_CHANGES'],
    ['APPROVE', 'reviewer', 'author', 'COMMENT'],
    ['BLOCKED', 'reviewer', 'author', 'COMMENT'],
    ['REQUEST CHANGES', 'samelogin', 'SameLogin', 'COMMENT'],
    ['APPROVE', 'samelogin', 'samelogin', 'COMMENT'],
    ['BLOCKED', 'samelogin', 'samelogin', 'COMMENT'],
  ];
  for (const [verdict, viewer, author, event] of cases) {
    const github = mockGitHub({ viewer, author });
    const result = publish(verdict, github);
    const label = `${verdict} ${viewer}/${author}`;
    assert.equal(github.posts.length, 1, label);
    const [payload] = github.posts;
    assert.equal(payload.event, event, label);
    assert.notEqual(payload.event, 'APPROVE', label);
    assert.equal(payload.commit_id, HEAD, label);
    assert.equal(result.event, event, label);
    assert.equal(result.posted, true, label);
    assert.match(result.url, /pullrequestreview-1$/, label);
    // The posted body carries the whole report and the reviewed pair.
    assert.ok(payload.body.includes(report(verdict)), label);
    assert.ok(payload.body.includes(`\`${BASE}..${HEAD}\``), label);
    if (verdict === 'REQUEST CHANGES' && event === 'COMMENT')
      assert.match(payload.body, /rather than a change request/, label);
  }
});

test('an unknown publishing identity posts a comment that says why', () => {
  const denied = () =>
    ghFailure(403, { message: 'Resource not accessible by integration' });
  for (const github of [
    mockGitHub({ user: denied() }),
    mockGitHub({ viewer: null }),
    mockGitHub({ author: null }),
  ]) {
    const result = publish('REQUEST CHANGES', github);
    assert.equal(github.posts.length, 1);
    assert.equal(github.posts[0].event, 'COMMENT');
    assert.match(github.posts[0].body, /could not be compared/);
    assert.equal(result.event, 'COMMENT');
  }
  const github = mockGitHub({ user: denied() });
  publish('APPROVE', github);
  assert.match(
    github.posts[0].body,
    /HTTP 403: Resource not accessible by integration/,
  );
});

test('a failed submission is reported, never claimed as posted', () => {
  const rejected = mockGitHub({
    review: ghFailure(422, {
      message: 'Unprocessable Entity',
      errors: ['Review Can not request changes on your own pull request'],
    }),
  });
  assert.throws(
    () => publish('REQUEST CHANGES', rejected),
    (/** @type {Error} */ error) =>
      error.name === 'ReviewNotPosted' &&
      /^Review not posted: GitHub REST request failed: HTTP 422: Unprocessable Entity; Review Can not request changes on your own pull request\. Check the pull request/.test(
        error.message,
      ),
  );
  assert.equal(rejected.posts.length, 1);
  /** @param {(args: string[]) => string | undefined} override */
  const wrap = (override) => {
    const github = mockGitHub();
    return {
      github,
      /** @type {MockRun} */
      run: (command, args, options) =>
        override(args) ?? github.run(command, args, options),
    };
  };
  /** @param {MockRun} run */
  const attempt = (run) =>
    publishReview(
      policy,
      { pr: '7', base: BASE, head: HEAD, report: report('APPROVE') },
      run,
    );
  const missing = wrap((args) => {
    if (args[2].endsWith('/reviews'))
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  });
  assert.throws(
    () => attempt(missing.run),
    /^ReviewNotPosted: Review not posted: .*gh is not installed/,
  );
  const silent = wrap((args) =>
    args[2].endsWith('/reviews') ? '{}' : undefined,
  );
  assert.throws(
    () => attempt(silent.run),
    /^ReviewNotPosted: Review not posted: GitHub returned no review URL/,
  );
  const notFound = wrap((args) => {
    if (args[2].endsWith('/pulls/7'))
      throw ghFailure(404, { message: 'Not Found' });
  });
  assert.throws(
    () => attempt(notFound.run),
    /^ReviewNotPosted: Review not posted: GitHub REST request failed: HTTP 404: Not Found\./,
  );
  assert.equal(notFound.github.posts.length, 0);
});

test('a merged or closed pull request gets no review and says why', () => {
  for (const [options, reason] of /** @type {[MockOptions, string][]} */ ([
    [{ state: 'closed', merged: true }, 'pull request is merged'],
    [{ state: 'closed' }, 'pull request is closed'],
    [{ state: 'locked' }, 'pull request state is locked, not open'],
  ]))
    for (const verdict of REVIEW_VERDICTS) {
      const github = mockGitHub(options);
      assert.throws(
        () => publish(verdict, github),
        (/** @type {Error} */ error) =>
          error.name === 'ReviewNotPosted' &&
          error.message === `Review not posted: ${reason}`,
        `${verdict} ${reason}`,
      );
      assert.equal(github.posts.length, 0, `${verdict} ${reason}`);
      assert.ok(
        github.calls.every((args) => !args[2].endsWith('/reviews')),
        `${verdict} ${reason}`,
      );
    }
});

test('moved or mismatched SHAs post nothing and ask for a fresh review', () => {
  for (const [
    github,
    reason,
  ] of /** @type {[ReturnType<typeof mockGitHub>, string][]} */ ([
    [mockGitHub({ head: 'c'.repeat(40) }), `head is now ${'c'.repeat(40)}`],
    [
      mockGitHub({ mergeBase: 'c'.repeat(40) }),
      `now has merge base ${'c'.repeat(40)} with main, not the reviewed ${BASE}`,
    ],
  ])) {
    assert.throws(
      () => publish('REQUEST CHANGES', github),
      (/** @type {Error} */ error) =>
        error.message.startsWith('Review not posted: pull request #7 ') &&
        error.message.includes(reason) &&
        error.message.endsWith('Run a fresh review for the new commits.'),
    );
    assert.equal(github.posts.length, 0);
  }
  // A base branch tip that moved on past the reviewed merge base still posts.
  const moved = mockGitHub({ tip: 'e'.repeat(40) });
  publish('APPROVE', moved);
  assert.equal(moved.posts.length, 1);
  const mismatch = mockGitHub();
  assert.throws(
    () =>
      publish('APPROVE', mismatch, {
        report: report('APPROVE', `${BASE}..${'c'.repeat(40)}`),
      }),
    /^ReviewNotPosted: Review not posted: the report reviewed .*Run a fresh review/,
  );
  assert.deepEqual(mismatch.calls, []);
  // A report that names no commits is not posted on the strength of the
  // arguments alone.
  const unbound = mockGitHub();
  assert.throws(
    () =>
      publish('APPROVE', unbound, {
        report: 'Verdict: APPROVE\nFindings: none',
      }),
    /^ReviewNotPosted: Review not posted: the report has no Base\/Head: <sha>\.\.<sha> line/,
  );
  assert.deepEqual(unbound.calls, []);
  // Abbreviated SHAs in the report still bind to the dispatched pair.
  const short = mockGitHub();
  publish('BLOCKED', short, {
    report: report('BLOCKED', `${BASE.slice(0, 7)}..${HEAD.slice(0, 7)}`),
  });
  assert.equal(short.posts.length, 1);
  for (const options of [
    { pr: 'abc' },
    { base: 'a'.repeat(7) },
    { head: undefined },
    { report: '  ' },
  ]) {
    const github = mockGitHub();
    assert.throws(
      () => publish('APPROVE', github, options),
      /^ReviewNotPosted: Review not posted:/,
    );
    assert.deepEqual(github.calls, []);
  }
});
