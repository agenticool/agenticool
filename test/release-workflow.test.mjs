import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync(
    new URL('../.github/workflows/release-packages.yml', import.meta.url),
    'utf8',
  ),
);
const release = workflow.jobs['update-release-pr'];
/** @type {Array<Record<string, any>>} */
const steps = release.steps;
/** @param {string} id */
const step = (id) => {
  const found = steps.find((s) => s.id === id);
  assert.ok(found, `step ${id}`);
  return found;
};
const CONFIGURED = "steps.release-app.outputs.configured == 'true'";

test('the release job first warns and skips when the release app is not set', () => {
  const guard = steps[0];
  assert.equal(guard.id, 'release-app');
  assert.equal(guard.env.APP_ID, '${{ vars.RELEASE_PLEASE_APP_ID }}');
  assert.match(
    guard.run,
    /::warning::RELEASE_PLEASE_APP_ID is not set; skipping releases/,
  );
  assert.match(guard.run, /configured=false/);
});

test('release-please runs only with the release app token', () => {
  assert.equal(step('app-token').if, CONFIGURED);
  const releasePlease = step('release');
  assert.equal(releasePlease.if, CONFIGURED);
  assert.equal(
    releasePlease.with.token,
    '${{ steps.app-token.outputs.token }}',
  );
  assert.doesNotMatch(JSON.stringify(workflow), /github\.token|GITHUB_TOKEN/);
});

test('the release job asks for no write permission of its own', () => {
  assert.equal(release.permissions, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
});

test('publishing waits for created releases and NPM_PUBLISH_ENABLED', () => {
  assert.equal(
    workflow.jobs['publish-packages'].if,
    "needs.update-release-pr.outputs.releases_created == 'true' && vars.NPM_PUBLISH_ENABLED == 'true'",
  );
});
