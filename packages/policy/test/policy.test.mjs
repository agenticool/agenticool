import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  binding,
  loadPolicy,
  placeholders,
  prefix,
  project,
  repository,
  tokenEnv,
  validatePolicy,
} from '@agenticool/policy';

/** @param {string} name */
const fixture = (name) =>
  fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
/** @param {string} name */
const read = (name) => loadPolicy(fixture(name));

// The contract fields each consumer adds next to its current keys.
/**
 * @param {Record<string, any>} policy
 * @param {string} token
 */
const withNewFields = (policy, token) => ({
  ...policy,
  binding: {
    ...policy.binding,
    project: { ...policy.binding.project, ownerType: 'user' },
    tokenEnv: token,
    features: {
      ...policy.binding.features,
      releasePlease: false,
      browserMcp: true,
    },
  },
  labels: {
    extra: [{ name: 'area: infra', color: '0e8a16', description: 'Infra' }],
  },
  workflowLint: {
    areas: { ci: 'CI', tracker: 'Tracker' },
    exclude: ['vendor-sync.yml'],
    pullRequestTarget: ['tracker-pr-metadata.yml'],
  },
  local: { roles: '.agents/local/roles', workflows: '.agents/local/workflows' },
});

test('both consumer policies validate as they are and with the new fields', () => {
  for (const [name, token] of [
    ['prismatic', 'PRISMATIC_PROJECT_TOKEN'],
    ['mcc', 'MCC_PROJECT_TOKEN'],
  ]) {
    const policy = read(name);
    const full = withNewFields(structuredClone(policy), token);
    assert.equal(validatePolicy(full), full, name);
    const sections = [
      'binding',
      'binding.project',
      'binding.tokenEnv',
      'binding.docs',
      'capabilities',
      'roles',
      'supported',
      'implementationEffort',
      'labels.extra',
      'workflowLint',
      'local',
    ];
    validatePolicy(full, { sections });
    assert.equal(tokenEnv(full), token);
    binding(full);
  }
});

test('loading fills in defaults for the new optional fields', () => {
  const policy = read('prismatic');
  assert.equal(policy.binding.project.ownerType, 'user');
  assert.deepEqual(policy.binding.features, {
    infrastructure: false,
    releasePlease: false,
    browserMcp: false,
  });
  assert.deepEqual(policy.local, {
    roles: '.agents/local/roles',
    workflows: '.agents/local/workflows',
  });
  const organization = validatePolicy({
    binding: {
      project: {
        owner: 'acme',
        ownerType: 'organization',
        number: 3,
        name: 'Acme',
      },
    },
  });
  assert.equal(project(organization).ownerType, 'organization');
  assert.equal(
    project({ binding: { project: { owner: 'a', number: 1, name: 'b' } } })
      .ownerType,
    'user',
  );
});

test('callers require only the sections they declare', () => {
  // A spec-parser user configures no project binding.
  const minimal = { binding: { namespace: 'spec', label: 'Spec' } };
  assert.equal(
    validatePolicy(minimal, { sections: ['binding.namespace'] }),
    minimal,
  );
  assert.throws(
    () => validatePolicy({ binding: {} }, { sections: ['binding.project'] }),
    /policy.json is missing binding.project/,
  );
  assert.throws(
    () => validatePolicy({}, { sections: ['binding.project.owner'] }),
    /policy.json is missing binding.project.owner/,
  );
  assert.throws(
    () => validatePolicy({}, { sections: ['bindings'] }),
    /Unknown policy section: bindings/,
  );
  assert.throws(
    () => validatePolicy({}, { sections: ['binding.projects'] }),
    /Unknown policy section: binding.projects/,
  );
  assert.throws(
    () => loadPolicy(fixture('prismatic'), { sections: ['labels'] }),
    /missing labels/,
  );
  assert.throws(
    () => loadPolicy(mkdtempSync(join(tmpdir(), 'policy-'))),
    /ENOENT/,
  );
});

test('the schema rejects unknown keys at every level', () => {
  const policy = withNewFields(read('mcc'), 'MCC_PROJECT_TOKEN');
  /** @type {[string, (copy: Record<string, any>) => void, RegExp][]} */
  const cases = [
    ['root', (copy) => (copy.extra = 1), /root has unknown key extra/],
    [
      'binding',
      (copy) => (copy.binding.repo = 'x'),
      /binding has unknown key repo/,
    ],
    [
      'project',
      (copy) => (copy.binding.project.type = 'user'),
      /binding.project has unknown key type/,
    ],
    [
      'features',
      (copy) => (copy.binding.features.mcp = true),
      /binding.features has unknown key mcp/,
    ],
    [
      'capability setting',
      (copy) => (copy.capabilities['code-review'].claude.temperature = 1),
      /capabilities.code-review.claude has unknown key temperature/,
    ],
    [
      'label',
      (copy) => (copy.labels.extra[0].default = true),
      /labels.extra\[0\] has unknown key default/,
    ],
    [
      'workflowLint',
      (copy) => (copy.workflowLint.vendor = []),
      /workflowLint has unknown key vendor/,
    ],
    [
      'local',
      (copy) => (copy.local.skills = 'x'),
      /local has unknown key skills/,
    ],
  ];
  for (const [name, change, error] of cases) {
    const copy = structuredClone(policy);
    change(copy);
    assert.throws(() => validatePolicy(copy), error, name);
  }
});

test('the schema rejects values of the wrong shape', () => {
  /** @type {[Record<string, any>, RegExp][]} */
  const cases = [
    [{ binding: [] }, /binding must be object/],
    [{ binding: { namespace: 'Bad-Name' } }, /binding.namespace must match/],
    [{ binding: { label: '' } }, /binding.label must not be empty/],
    [{ binding: { repository: 'no-owner' } }, /binding.repository must match/],
    [
      { binding: { project: { owner: 'a', name: 'b' } } },
      /binding.project is missing number/,
    ],
    [
      { binding: { project: { owner: 'a', number: 0, name: 'b' } } },
      /binding.project.number must be at least 1/,
    ],
    [
      { binding: { project: { owner: 'a', number: 1.5, name: 'b' } } },
      /binding.project.number must be integer/,
    ],
    [
      {
        binding: {
          project: { owner: 'a', ownerType: 'team', number: 1, name: 'b' },
        },
      },
      /binding.project.ownerType must be one of user, organization/,
    ],
    [{ binding: { tokenEnv: 'lower' } }, /binding.tokenEnv must match/],
    [
      { binding: { features: { browserMcp: 'yes' } } },
      /browserMcp must be boolean/,
    ],
    [
      { binding: { docs: { triage: 'T.md', workflow: 'W.md', guides: [] } } },
      /binding.docs.guides needs at least 1 item/,
    ],
    [
      { binding: { docs: { triage: 'T.md', workflow: 'W.md', guides: [1] } } },
      /binding.docs.guides\[0\] must be string/,
    ],
    [{ roles: { implementer: 3 } }, /roles.implementer must be string/],
    [{ supported: { claude: { models: {} } } }, /supported is missing codex/],
    [
      { labels: { extra: [{ name: 'x', color: 'red', description: '' }] } },
      /labels.extra\[0\].color must match/,
    ],
    [
      { implementationEffort: { default: 'medium' } },
      /implementationEffort is missing automaticMaximum/,
    ],
  ];
  for (const [policy, error] of cases)
    assert.throws(() => validatePolicy(policy), error);
});

test('binding helpers read repository facts and name what is missing', () => {
  const policy = withNewFields(read('prismatic'), 'PRISMATIC_PROJECT_TOKEN');
  assert.equal(prefix(policy), `${policy.binding.namespace}-`);
  assert.equal(repository(policy), policy.binding.repository);
  assert.deepEqual(project(policy), policy.binding.project);
  assert.throws(() => prefix({}), /binding is missing binding/);
  assert.throws(() => prefix({ binding: {} }), /binding is missing namespace/);
  assert.throws(() => repository({ binding: {} }), /missing repository/);
  assert.throws(() => tokenEnv({ binding: {} }), /missing tokenEnv/);
  assert.throws(() => project({}), /missing project.owner/);
  assert.throws(
    () => project({ binding: { project: { owner: 'a', number: 1 } } }),
    /missing project.name/,
  );
  /** @type {[(value: Record<string, any>) => void, RegExp][]} */
  const cases = [
    [(value) => delete value.label, /missing label/],
    [(value) => delete value.docs, /missing docs.triage/],
    [(value) => (value.docs.guides = []), /missing docs.guides/],
    [(value) => delete value.features, /missing features.infrastructure/],
  ];
  for (const [change, error] of cases) {
    const copy = structuredClone(policy);
    change(copy.binding);
    assert.throws(() => binding(copy), error);
  }
});

test('the project URL follows the owner type', () => {
  const policy = read('mcc');
  assert.equal(
    placeholders(policy)['project.url'],
    `https://github.com/users/${policy.binding.project.owner}/projects/${policy.binding.project.number}`,
  );
  policy.binding.project.ownerType = 'organization';
  assert.equal(
    placeholders(policy)['project.url'],
    `https://github.com/orgs/${policy.binding.project.owner}/projects/${policy.binding.project.number}`,
  );
});
