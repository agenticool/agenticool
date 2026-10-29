import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { renderTemplate, SEVERITIES, TEMPLATES } from '../src/index.mjs';
import { POLICIES, userPolicy } from './helpers.mjs';

const NAMES = readdirSync(TEMPLATES, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) =>
    relative(fileURLToPath(TEMPLATES), join(entry.parentPath, entry.name)),
  )
  .sort();

test('the templates are the label catalog, issue forms, PR template, triage guide, and caller workflows', () => {
  assert.deepEqual(NAMES, [
    'ISSUE_TEMPLATE/bug.yml',
    'ISSUE_TEMPLATE/config.yml',
    'ISSUE_TEMPLATE/container.yml',
    'ISSUE_TEMPLATE/epic.yml',
    'ISSUE_TEMPLATE/task.yml',
    'ISSUE_TRIAGE.md',
    'labels.json',
    'pull_request_template.md',
    'workflows/board-issue-states.yml',
    'workflows/board-pr-issue-status.yml',
    'workflows/board-pr-metadata.yml',
    'workflows/board-project-membership.yml',
  ]);
});

test('templates render repository facts from the policy and name no other repository', () => {
  for (const name of NAMES) {
    const source = readFileSync(new URL(name, TEMPLATES), 'utf8');
    assert.doesNotMatch(source, /prismatic|mcc|samlevin/i, name);
    for (const policy of POLICIES) {
      const text = renderTemplate(name, policy);
      assert.doesNotMatch(text, /(?<!\$)\{\{/, name);
      if (name.endsWith('.yml')) parse(text);
      if (name.endsWith('.json')) JSON.parse(text);
    }
  }
  assert.match(
    renderTemplate('ISSUE_TEMPLATE/task.yml', POLICIES[1]),
    /\[docs\/triage\.md\]\(https:\/\/github\.com\/example-org\/gadgets\/blob\/HEAD\/docs\/triage\.md\)/,
  );
  assert.match(
    renderTemplate('pull_request_template.md', userPolicy),
    /\[ISSUE_TRIAGE\.md\]\(\.\.\/ISSUE_TRIAGE\.md\)/,
  );
  const triage = renderTemplate('ISSUE_TRIAGE.md', POLICIES[1]);
  assert.match(
    triage,
    /\[Gadgets board\]\(https:\/\/github\.com\/orgs\/example-org\/projects\/3\)/,
  );
  assert.match(triage, /`docs\/workflow\.md`/);
});

test('an unknown placeholder fails the render', () => {
  assert.throws(
    () => renderTemplate('../test/fixtures/templates/unknown.md', userPolicy),
    /Unknown placeholder \{\{nope\}\} in \.\.\/test\/fixtures\/templates\/unknown\.md/,
  );
});

test('label descriptions do not name OpenTofu or Terraform', () => {
  const { labels } = JSON.parse(renderTemplate('labels.json', userPolicy));
  for (const label of labels)
    assert.doesNotMatch(label.description, /OpenTofu|Terraform/, label.name);
});

test('catalog has unique names and supported severities', () => {
  for (const policy of POLICIES) {
    const catalog = JSON.parse(renderTemplate('labels.json', policy));
    assert.equal(catalog.repository, policy.repository);
    assert.equal(
      new Set(catalog.labels.map((/** @type {any} */ label) => label.name))
        .size,
      catalog.labels.length,
    );
    assert.deepEqual(
      catalog.labels
        .filter((/** @type {any} */ label) =>
          label.name.startsWith('severity:'),
        )
        .map((/** @type {any} */ label) => label.name)
        .sort(),
      [...SEVERITIES].sort(),
    );
    for (const label of catalog.labels) {
      assert.match(label.color, /^[a-f0-9]{6}$/);
      assert.ok(label.description.length > 0);
    }
  }
});
