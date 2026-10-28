import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint, W } from './helpers.mjs';

test('missing timeouts are detected, except on reusable workflow calls', () => {
  assert.deepEqual(
    lint('timeouts', {
      [`${W}ci-jobs.yml`]: `name: 'CI: jobs'
on: pull_request
jobs:
  bounded:
    name: Bounded
    runs-on: ubuntu-latest
    timeout-minutes: 5
  unbounded:
    name: Unbounded
    runs-on: ubuntu-latest
  zero:
    name: Zero
    runs-on: ubuntu-latest
    timeout-minutes: 0
  call:
    name: Call
    uses: ./.github/workflows/_ci-build.yml
`,
    }),
    [
      'unbounded needs timeout-minutes, a positive whole number',
      'zero needs timeout-minutes, a positive whole number',
    ],
  );
});

test('every workflow job that runs steps in the clean fixture sets timeout-minutes', () => {
  assert.deepEqual(lint('timeouts'), []);
});
