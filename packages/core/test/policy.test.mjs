import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  binding,
  loadPolicy,
  originRepository,
  placeholders,
  project,
  repository,
  validatePolicy,
} from '@agenticool/core';

/** @param {string} name */
const fixture = (name) =>
  fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
/** @param {string} name */
const read = (name) => loadPolicy(fixture(name));

/**
 * A git repository whose origin remote is `url`.
 * @param {string} url
 */
const clone = (url) => {
  const directory = mkdtempSync(join(tmpdir(), 'policy-origin-'));
  execFileSync('git', ['init', '-q', directory]);
  execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', url]);
  return directory;
};

// Every optional field a consumer may add next to its current keys.
/**
 * @param {Record<string, any>} policy
 * @returns {Record<string, any>}
 */
const withNewFields = (policy) => ({
  ...policy,
  binding: {
    ...policy.binding,
    project: { ...policy.binding.project, ownerType: 'user' },
    infrastructure: { accountChecks: ['scripts/app.mjs'] },
    features: {
      ...policy.binding.features,
      releasePlease: false,
      browserMcp: true,
    },
  },
  labels: {
    extra: [{ name: 'area: infra', color: '0e8a16', description: 'Infra' }],
  },
});

test('both consumer policies validate as they are and with the optional fields', () => {
  for (const name of ['prismatic', 'mcc']) {
    const policy = read(name);
    const full = withNewFields(structuredClone(policy));
    assert.equal(validatePolicy(full), full, name);
    const sections = [
      'binding',
      'binding.project',
      'binding.docs',
      'capabilities',
      'roles',
      'supported',
      'implementationEffort',
      'labels.extra',
    ];
    validatePolicy(full, { sections });
    full.repository = 'example/notes';
    binding(full);
  }
});

test('a policy with only the project and features fills in every default', () => {
  const policy = validatePolicy({
    binding: {
      project: { owner: 'acme', number: 1, name: 'Acme delivery' },
      features: {},
    },
  });
  policy.repository = 'acme/widgets';
  assert.deepEqual(binding(policy), {
    label: 'widgets',
    repository: 'acme/widgets',
    project: {
      owner: 'acme',
      ownerType: 'user',
      number: 1,
      name: 'Acme delivery',
    },
    docs: {
      triage: 'ISSUE_TRIAGE.md',
      workflow: 'AGENTS.md',
      guides: ['AGENTS.md'],
    },
    features: {
      infrastructure: false,
      releasePlease: false,
      browserMcp: false,
    },
  });
});

test('removed keys fail with what replaced them', () => {
  /** @type {[Record<string, any>, RegExp][]} */
  const cases = [
    [
      { binding: { namespace: 'acme' } },
      /binding.namespace is no longer read: generated agents and skills have no repository prefix/,
    ],
    [
      { binding: { repository: 'acme/widgets' } },
      /binding.repository is no longer read: the repository comes from the origin remote/,
    ],
    [
      { binding: { tokenEnv: 'ACME_TOKEN' } },
      /binding.tokenEnv is no longer read: the Projects token is always the AGENTICOOL_PROJECT_TOKEN secret/,
    ],
    [
      { local: { roles: 'roles' } },
      /local is no longer read: repository-only sources always live in .agents\/local\/roles/,
    ],
  ];
  for (const [policy, error] of cases)
    assert.throws(() => validatePolicy(policy), error);
});

test('the repository comes from the origin remote of the policy directory', () => {
  for (const url of [
    'https://github.com/acme/widgets.git',
    'git@github.com:acme/widgets.git',
    'https://github.com/acme/widgets',
  ]) {
    const directory = clone(url);
    cpSync(join(fixture('prismatic'), '.agents'), join(directory, '.agents'), {
      recursive: true,
    });
    const policy = loadPolicy(directory);
    assert.equal(repository(policy), 'acme/widgets', url);
    assert.equal(policy.repository, 'acme/widgets');
    assert.equal(originRepository(directory), 'acme/widgets');
  }
  // A known repository is never read again.
  assert.equal(repository({ repository: 'acme/known' }), 'acme/known');
  assert.throws(
    () => originRepository(clone('https://gitlab.com/acme/widgets.git')),
    /is not a GitHub repository/,
  );
  assert.throws(
    () => originRepository(mkdtempSync(join(tmpdir(), 'policy-none-'))),
    /Cannot read the origin remote/,
  );
});

test('loading fills in defaults for the new optional fields', () => {
  const policy = read('prismatic');
  assert.equal(policy.binding.project.ownerType, 'user');
  assert.deepEqual(policy.binding.features, {
    infrastructure: false,
    releasePlease: false,
    browserMcp: false,
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
  // A spec user configures no project binding.
  const minimal = { binding: { label: 'Spec' } };
  assert.equal(
    validatePolicy(minimal, { sections: ['binding.label'] }),
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
  const policy = withNewFields(read('mcc'));
  /** @type {[string, (copy: Record<string, any>) => void, RegExp][]} */
  const cases = [
    ['root', (copy) => (copy.extra = 1), /root has unknown key extra/],
    [
      'workflowLint',
      (copy) => (copy.workflowLint = {}),
      /root has unknown key workflowLint/,
    ],
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
    [{ binding: { label: '' } }, /binding.label must not be empty/],
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
    [
      { binding: { infrastructure: { accountChecks: 'scripts/app.mjs' } } },
      /binding.infrastructure.accountChecks must be array/,
    ],
    [
      { binding: { infrastructure: { accountChecks: [''] } } },
      /binding.infrastructure.accountChecks\[0\] must not be empty/,
    ],
    [
      { binding: { infrastructure: { paths: [] } } },
      /binding.infrastructure has unknown key paths/,
    ],
    [{ roles: { implementer: 3 } }, /roles.implementer must be string/],
    [{ supported: { claude: {} } }, /supported.claude is missing models/],
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
  const policy = withNewFields(read('prismatic'));
  policy.repository = 'samlevin/prismatic';
  assert.deepEqual(project(policy), policy.binding.project);
  assert.equal(binding(policy).label, 'Prismatic');
  assert.equal(binding(policy).repository, 'samlevin/prismatic');
  assert.throws(() => binding({}), /binding is missing binding/);
  assert.throws(() => binding({ binding: {} }), /missing project.owner/);
  assert.throws(() => project({}), /missing project.owner/);
  assert.throws(
    () => project({ binding: { project: { owner: 'a', number: 1 } } }),
    /missing project.name/,
  );
  assert.throws(
    () => project({ binding: { project: { owner: 'a', name: 'b' } } }),
    /missing project.number/,
  );
});

test('the project URL and REST path follow the owner type', () => {
  const policy = read('mcc');
  policy.repository = 'samlevin/mcc-stats-suite';
  const { owner, number } = policy.binding.project;
  assert.equal(
    placeholders(policy)['project.url'],
    `https://github.com/users/${owner}/projects/${number}`,
  );
  assert.equal(
    placeholders(policy)['project.restPath'],
    `users/${owner}/projectsV2/${number}`,
  );
  policy.binding.project.ownerType = 'organization';
  assert.equal(
    placeholders(policy)['project.url'],
    `https://github.com/orgs/${owner}/projects/${number}`,
  );
  assert.equal(
    placeholders(policy)['project.restPath'],
    `orgs/${owner}/projectsV2/${number}`,
  );
});
