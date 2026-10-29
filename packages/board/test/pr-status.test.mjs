import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { repository } from '@agenticool/core';
import {
  closingIssues,
  moveIssuesToReview,
  sourceStatuses,
} from '../src/index.mjs';
import {
  isProjectQuery,
  orgPolicy,
  POLICIES,
  projectAnswer,
  REPOSITORY,
  userPolicy,
} from './helpers.mjs';

test('only closing keyword references supply status targets', () => {
  assert.deepEqual(
    closingIssues(
      `Closes #40. Follow-up to #12, blocked by #30.\nFIXES ${REPOSITORY}#41; resolves https://github.com/${REPOSITORY}/issues/42\nCloses other/repo#9\nParent issue or epic: Closes #8\n<!-- Closes #7 -->\n\`Fixes #6\`\n\`\`\`\nCloses #5\n\`\`\`\n    Closes #4`,
      REPOSITORY,
    ),
    [40, 41, 42],
  );
  assert.deepEqual(closingIssues(null, REPOSITORY), []);
  assert.deepEqual(
    closingIssues(
      'Closes #1, fixes #2, resolved #3; close #4; fix #5; resolve #6',
      REPOSITORY,
    ),
    [1, 2, 3, 4, 5, 6],
  );
  // A qualified reference counts only for the repository it names.
  const other = repository(orgPolicy);
  assert.deepEqual(closingIssues(`Closes ${other}#3`, REPOSITORY), []);
  assert.deepEqual(closingIssues(`Closes ${other}#3`, other), [3]);
});

test('trusted authors move Ready and In progress issues, others only In progress', () => {
  assert.deepEqual(sourceStatuses('MEMBER'), ['Ready', 'In progress']);
  assert.deepEqual(sourceStatuses('NONE'), ['In progress']);
});

/**
 * @param {{
 *   status?: string | null,
 *   freshStatus?: string | null,
 *   state?: string,
 *   freshState?: string,
 *   draft?: boolean,
 *   prState?: string,
 *   member?: boolean,
 *   association?: string,
 *   changed?: boolean,
 *   changedAssociation?: boolean,
 *   unknown?: boolean,
 *   renumbered?: boolean,
 *   foreign?: boolean,
 *   missingPr?: boolean,
 *   policy?: Record<string, any>,
 * }} [options]
 */
function fixture({
  status = 'In progress',
  freshStatus = status,
  state = 'OPEN',
  freshState = state,
  draft = false,
  prState = 'OPEN',
  member = true,
  association = 'OWNER',
  changed = false,
  changedAssociation = false,
  unknown = false,
  renumbered = false,
  foreign = false,
  missingPr = false,
  policy = userPolicy,
} = {}) {
  const home = repository(policy);
  /** @type {Record<string, any>[]} */
  const writes = [];
  /** @type {{ query: string, vars: Record<string, any> }[]} */
  const calls = [];
  let reads = 0;
  let prReads = 0;
  /** @param {boolean} fresh */
  const content = (fresh) => ({
    id: 'issue',
    number: fresh && renumbered ? 2 : 1,
    state: fresh ? freshState : state,
    __typename: 'Issue',
    repository: { nameWithOwner: foreign ? 'other/repo' : home },
  });
  /**
   * @param {string} query
   * @param {Record<string, any>} vars
   * @returns {Promise<any>}
   */
  const api = async (query, vars) => {
    calls.push({ query, vars });
    if (query.startsWith('mutation')) {
      writes.push(vars);
      return {};
    }
    if (query.includes('repository(owner: $owner, name: $name)'))
      assert.equal(`${vars.owner}/${vars.name}`, home);
    if (query.includes('pullRequest(number:')) {
      prReads++;
      if (missingPr) return { repository: { pullRequest: null } };
      return {
        repository: {
          pullRequest: {
            body: changed && prReads > 1 ? 'Closes #2' : 'Closes #1. Also #99',
            state: prState,
            isDraft: draft,
            authorAssociation:
              changedAssociation && prReads > 1 ? 'CONTRIBUTOR' : association,
          },
        },
      };
    }
    if (isProjectQuery(query))
      return projectAnswer(query, vars, policy, {
        nodes: [
          {
            id: 'status',
            name: 'Status',
            options: ['In progress', 'In review', 'Inbox', 'Ready', 'Done'].map(
              (name) => ({ id: name, name }),
            ),
          },
        ],
        pageInfo: { hasNextPage: false },
      });
    if (query.includes('issueOrPullRequest'))
      return {
        repository: {
          issueOrPullRequest: {
            projectItems: {
              nodes: vars.cursor
                ? member
                  ? [{ id: 'item', project: { id: 'project' } }]
                  : []
                : [{ id: 'unrelated', project: { id: 'other' } }],
              pageInfo: { hasNextPage: !vars.cursor, endCursor: 'next' },
            },
          },
        },
      };
    if (query.includes('fieldValues(')) {
      if (!vars.cursor) reads++;
      return {
        node: {
          id: 'item',
          type: 'ISSUE',
          project: { id: 'project' },
          content: content(reads > 1),
          fieldValues: {
            nodes: vars.cursor
              ? [
                  {
                    field: { id: 'status' },
                    optionId: unknown
                      ? 'unrecognized'
                      : reads > 1
                        ? freshStatus
                        : status,
                  },
                ]
              : [],
            pageInfo: { hasNextPage: !vars.cursor, endCursor: 'next' },
          },
        },
      };
    }
    if (query.includes('labels('))
      return {
        node: {
          ...content(reads > 1),
          labels: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      };
    throw new Error(`Unexpected query ${query}`);
  };
  /** @type {string[]} */
  const logs = [];
  return {
    api,
    policy,
    writes,
    calls,
    logs,
    log: (/** @type {string} */ line) => logs.push(line),
  };
}

test('only claimed closing issues move, with paginated item and field reads', async () => {
  for (const policy of POLICIES) {
    const f = fixture({ policy });
    await moveIssuesToReview({ ...f, number: 10, dryRun: false });
    assert.deepEqual(f.writes, [
      {
        project: 'project',
        item: 'item',
        field: 'status',
        option: 'In review',
      },
    ]);
    assert.equal(
      f.calls.filter((c) => c.query.includes('issueOrPullRequest')).length,
      2,
    );
    assert.equal(
      f.calls.filter((c) => c.query.includes('fieldValues(')).length,
      4,
    );
    assert.ok(
      f.calls
        .filter((c) => c.query.includes('issueOrPullRequest'))
        .every((c) => c.vars.number === 1),
    );
  }
});

test('trusted authors also move Ready issues; others move only In progress', async () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    const f = fixture({ status: 'Ready', association });
    await moveIssuesToReview({ ...f, number: 10, dryRun: false });
    assert.equal(f.writes.length, 1, association);
    assert.deepEqual(f.logs, ['Issue #1: Ready -> In review.']);
  }
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) {
    const ready = fixture({ status: 'Ready', association });
    await moveIssuesToReview({ ...ready, number: 10, dryRun: false });
    assert.deepEqual(ready.writes, [], association);
    assert.deepEqual(ready.logs, [
      `Issue #1: skipped, Ready, and ${association} authors move only In progress issues.`,
    ]);
    const claimed = fixture({ association });
    await moveIssuesToReview({ ...claimed, number: 10, dryRun: false });
    assert.equal(claimed.writes.length, 1, association);
  }
});

test('every skip is logged with its reason', async () => {
  for (const [
    options,
    line,
  ] of /** @type {[Record<string, any>, string][]} */ ([
    [{ draft: true }, 'Pull request #10 is a draft.'],
    [{ prState: 'CLOSED' }, 'Pull request #10 is not open.'],
    [{ member: false }, 'Issue #1: skipped, not in Widgets delivery.'],
    [
      { member: false, policy: orgPolicy },
      'Issue #1: skipped, not in Gadgets board.',
    ],
    [{ foreign: true }, `Issue #1: skipped, not an issue of ${REPOSITORY}.`],
    [{ state: 'CLOSED' }, 'Issue #1: skipped, closed.'],
    [{ status: 'Inbox' }, 'Issue #1: skipped, status is Inbox.'],
    [{ status: 'In review' }, 'Issue #1: skipped, status is In review.'],
    [{ unknown: true }, 'Issue #1: skipped, status is unset.'],
    [
      { freshStatus: 'Done' },
      'Issue #1: skipped after re-read, status is Done.',
    ],
    [
      { renumbered: true },
      'Issue #1: skipped after re-read, project item changed.',
    ],
  ])) {
    const f = fixture(options);
    await moveIssuesToReview({ ...f, number: 10, dryRun: false });
    assert.deepEqual(f.logs, [line], JSON.stringify(options));
  }
});

test('draft, closed, unclaimed, unknown, missing and finished work stays put', async () => {
  for (const options of [
    { draft: true },
    { prState: 'CLOSED' },
    { state: 'CLOSED' },
    { member: false },
    { unknown: true },
    ...['Inbox', 'In review', 'Done', undefined].map((status) => ({
      status: status ?? null,
    })),
    { status: 'Ready', association: 'CONTRIBUTOR' },
  ]) {
    const f = fixture(options);
    await moveIssuesToReview({ ...f, number: 10, dryRun: false });
    assert.deepEqual(f.writes, [], JSON.stringify(options));
  }
});

test('concurrent status or issue changes cannot be overwritten', async () => {
  for (const options of [
    { freshStatus: 'Done' },
    { freshStatus: 'Inbox' },
    { freshStatus: null },
    { freshState: 'CLOSED' },
  ]) {
    const f = fixture(options);
    await moveIssuesToReview({ ...f, number: 10, dryRun: false });
    assert.deepEqual(f.writes, []);
  }
});

test('dry runs make no writes and changed PR descriptions or authors abort writes', async () => {
  const f = fixture();
  await moveIssuesToReview({ ...f, number: 10 });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.logs, ['Issue #1: In progress -> In review (dry run).']);
  for (const options of [
    { changed: true },
    { status: 'Ready', changedAssociation: true },
  ]) {
    const changed = fixture(options);
    await assert.rejects(
      moveIssuesToReview({ ...changed, number: 10, dryRun: false }),
      /changed during discovery/,
    );
    assert.deepEqual(changed.writes, []);
  }
});

test('a missing pull request, an invalid number, and a body without closing references', async () => {
  await assert.rejects(
    moveIssuesToReview({ ...fixture({ missingPr: true }), number: 10 }),
    /Pull request not found/,
  );
  for (const number of [0, 1.5])
    await assert.rejects(
      moveIssuesToReview({
        api: () => assert.fail('API access with invalid number'),
        policy: userPolicy,
        number,
      }),
      /positive pull request number/,
    );
  /** @type {string[]} */
  const logs = [];
  await moveIssuesToReview({
    api: async () => ({
      repository: {
        pullRequest: {
          body: 'Follow-up to #1',
          state: 'OPEN',
          isDraft: false,
          authorAssociation: 'OWNER',
        },
      },
    }),
    policy: userPolicy,
    number: 10,
    log: (line) => logs.push(line),
  });
  assert.deepEqual(logs, ['Pull request #10 closes no issues.']);
});

test('status changes stay isolated from metadata reconciliation', () => {
  const metadata = readFileSync(
    new URL('../src/pr-metadata.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    metadata,
    /discover\(|updateProjectStatus\(|moveIssuesToReview\(/,
  );
});

test('a run discovers project fields once, including the write-boundary re-read', async () => {
  const f = fixture();
  await moveIssuesToReview({ ...f, number: 10, dryRun: false });
  assert.equal(f.writes.length, 1);
  assert.equal(f.calls.filter(({ query }) => isProjectQuery(query)).length, 1);
});
