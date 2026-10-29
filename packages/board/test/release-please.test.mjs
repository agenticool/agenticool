import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isReleasePullRequest,
  RELEASE_BRANCH,
  releasedComponents,
} from '../src/index.mjs';

test('the release PR is the repository branch Release Please opens', () => {
  assert.equal(
    isReleasePullRequest({
      headRefName: RELEASE_BRANCH,
      isCrossRepository: false,
    }),
    true,
  );
  for (const pr of [
    { headRefName: RELEASE_BRANCH, isCrossRepository: true },
    { headRefName: 'agent/1-change', isCrossRepository: false },
    { headRefName: RELEASE_BRANCH },
  ])
    assert.equal(isReleasePullRequest(pr), false);
});

test('released components are the packages whose manifest version changes', () => {
  assert.deepEqual(
    releasedComponents(
      {
        packages: {
          'packages/a': { component: 'a' },
          'packages/same': { component: 'same' },
          'packages/new': { component: 'new' },
          'packages/removed': { component: 'removed' },
          'packages/unnamed': {},
        },
      },
      {
        'packages/a': '1.0.0',
        'packages/same': '1.0.0',
        'packages/removed': '1.0.0',
        'packages/unnamed': '1.0.0',
      },
      {
        'packages/a': '1.0.1',
        'packages/same': '1.0.0',
        'packages/new': '0.1.0',
        'packages/unnamed': '1.1.0',
      },
    ),
    ['a', 'new'],
  );
  assert.deepEqual(releasedComponents({}, {}, {}), []);
});
