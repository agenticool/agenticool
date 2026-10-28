import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  check,
  generate,
  include,
  parseSource,
  render,
  renderBody,
  renderRole,
  renderWorkflow,
  SOURCES,
  substitute,
} from '@agenticool/agents';
import { resolve } from '@agenticool/policy';
import {
  consumer,
  FIXTURE,
  inBoth,
  other,
  policy,
  PREFIX,
  sourcePairs,
} from './helpers.mjs';

test('substitute resolves every placeholder and feature section', () => {
  const text =
    'Spawn {{prefix}}implementer in {{repository}}{{#infrastructure}} (infra){{/infrastructure}}.';
  assert.equal(
    substitute(text, policy),
    `Spawn ${PREFIX}implementer in ${policy.binding.repository}${
      policy.binding.features.infrastructure ? ' (infra)' : ''
    }.`,
  );
  assert.equal(
    substitute(text, {
      ...other,
      binding: { ...other.binding, features: { infrastructure: true } },
    }),
    'Spawn other-implementer in example/other (infra).',
  );
  assert.equal(
    substitute(text, other),
    'Spawn other-implementer in example/other.',
  );
  // Feature flags with camelCase names work as sections too.
  assert.equal(
    substitute('a{{#browserMcp}} b{{/browserMcp}}', {
      ...other,
      binding: {
        ...other.binding,
        features: { infrastructure: false, browserMcp: true },
      },
    }),
    'a b',
  );
  assert.throws(
    () => substitute('{{nope}}', policy),
    /Unknown placeholder: nope/,
  );
  assert.equal(substitute('a \\{{prefix}} b', policy), 'a {{prefix}} b');
  assert.equal(
    substitute('gh api {{project.restPath}}/fields', other),
    'gh api users/example/projectsV2/7/fields',
  );
  assert.throws(
    () => substitute('{{#magic}}x{{/magic}}', policy),
    /Unknown feature section: magic/,
  );
  assert.throws(
    () => substitute('{{#infrastructure}}x', policy),
    /Unbalanced feature section/,
  );
});

test('the security reviewer names the account checks the binding lists', () => {
  const source = readFileSync(
    join(SOURCES, 'roles/security-reviewer.md'),
    'utf8',
  );
  /** @param {Record<string, any>} extra */
  const rendered = (extra) =>
    renderRole(
      { ...other, binding: { ...other.binding, ...extra } },
      'security-reviewer',
      source,
      'claude',
    );
  const infrastructure = { features: { infrastructure: true } };
  assert.match(
    rendered({
      ...infrastructure,
      infrastructure: {
        accountChecks: ['scripts/app.mjs', 'packages/config'],
      },
    }),
    /OpenTofu, or CDK are in scope.*environment isolation, and the account checks in `scripts\/app\.mjs` and `packages\/config`\. /,
  );
  for (const extra of [
    { ...infrastructure, infrastructure: { accountChecks: [] } },
    infrastructure,
  ])
    assert.match(
      rendered(extra),
      /OpenTofu, or CDK are in scope.*environment isolation\. /,
    );
  const without = rendered({
    infrastructure: { accountChecks: ['scripts/app.mjs'] },
  });
  assert.match(without, /environment isolation\. /);
  assert.doesNotMatch(without, /OpenTofu|account checks/);
});

test('placeholder sections keep their content only for a non-empty value', () => {
  const text =
    '{{#infrastructure}}infra{{#infrastructure.accountChecks}} in {{infrastructure.accountChecks}}{{/infrastructure.accountChecks}}{{/infrastructure}}.';
  /** @param {string[]} accountChecks */
  const bound = (accountChecks) => ({
    ...other,
    binding: {
      ...other.binding,
      infrastructure: { accountChecks },
      features: { infrastructure: true },
    },
  });
  assert.equal(substitute(text, bound(['a'])), 'infra in `a`.');
  assert.equal(
    substitute(text, bound(['a', 'b', 'c'])),
    'infra in `a`, `b`, and `c`.',
  );
  assert.equal(substitute(text, bound([])), 'infra.');
  assert.equal(substitute(text, other), '.');
});

test('generated output carries no unresolved placeholder and follows the binding', () => {
  for (const [path, content] of render(FIXTURE)) {
    // The maintainer skill documents the placeholders literally.
    if (!path.includes(`/${PREFIX}agents/`))
      assert.doesNotMatch(content, /\{\{/, path);
    if (!/^\.agents\/[^/]+\.md$/.test(path))
      assert.ok(path.includes(`/${PREFIX}`), path);
  }
  const resolved = resolve(other, { tool: 'claude', role: 'implementer' });
  assert.equal(resolved.spawn.subagent_type, 'other-implementer');
});

const source = `---
name: sample
description: Sample role.
claude:
  tools: Read, Grep
  color: blue
codex:
  default_permissions: ":read-only"
---
Shared line.
<!-- claude-only -->
Claude line.
<!-- /claude-only -->
<!-- codex-only -->
Codex line.
<!-- /codex-only -->
Last shared line.
`;

test('tool-only blocks render for one tool and vanish for the other', () => {
  const { body } = parseSource(source);
  assert.equal(
    renderBody(body, 'claude'),
    'Shared line.\nClaude line.\nLast shared line.\n',
  );
  assert.equal(
    renderBody(body, 'codex'),
    'Shared line.\nCodex line.\nLast shared line.\n',
  );
});

test('a plain frontmatter value containing " #" is rejected, not truncated', () => {
  const truncated = `---
name: implement
description: Use for "implement #N" or an issue URL.
---
Body
`;
  assert.throws(
    () => parseSource(truncated),
    /Quote the frontmatter value of description/,
  );
  const quoted = truncated.replace(
    'description: Use for "implement #N" or an issue URL.',
    'description: "Use for \\"implement #N\\" or an issue URL."',
  );
  assert.equal(
    parseSource(quoted).meta.description,
    'Use for "implement #N" or an issue URL.',
  );
  assert.equal(
    parseSource(`---\nname: x\nargument-hint: <#N | URL>\n---\nBody\n`).meta[
      'argument-hint'
    ],
    '<#N | URL>',
  );
  assert.throws(() => parseSource('Body\n'), /missing frontmatter/);
});

test('Claude agents pin the policy; Codex agents omit model and effort', () => {
  const sample = {
    ...policy,
    roles: { ...policy.roles, sample: 'code-review' },
  };
  const claude = renderRole(sample, 'sample', source, 'claude');
  assert.match(claude, new RegExp(`^name: ${PREFIX}sample$`, 'm'));
  assert.match(claude, /^tools: Read, Grep$/m);
  assert.match(
    claude,
    new RegExp(
      `^model: ${policy.capabilities['code-review'].claude.model}$`,
      'm',
    ),
  );
  assert.match(
    claude,
    new RegExp(
      `^effort: ${policy.capabilities['code-review'].claude.effort}$`,
      'm',
    ),
  );
  assert.match(claude, /Claude line\./);
  assert.doesNotMatch(claude, /Codex line\./);
  assert.match(
    claude,
    /<!-- Generated from @agenticool\/agents\/sources\/roles\/sample\.md by agenticool-agents\. Edit the source and run `npx agenticool-agents generate`\. -->/,
  );
  const codex = renderRole(sample, 'sample', source, 'codex');
  assert.match(codex, new RegExp(`^name = "${PREFIX}sample"$`, 'm'));
  assert.match(codex, /^default_permissions = ":read-only"$/m);
  assert.doesNotMatch(codex, /^model/m);
  assert.doesNotMatch(codex, /^model_reasoning_effort/m);
  assert.match(codex, /Codex line\./);
  assert.doesNotMatch(codex, /Claude line\./);
  assert.match(codex, /developer_instructions = '''\n[\s\S]*'''\n$/);
  assert.throws(
    () => renderRole(sample, 'other', source, 'claude'),
    /Role other declares name sample/,
  );
  assert.throws(
    () => renderRole(sample, 'sample', `${source}Text '''.\n`, 'codex', 'x.md'),
    /cannot contain three quotes/,
  );
});

test('workflows become a Claude skill and a Codex skill with a manifest', () => {
  const workflow = `---
name: sample
description: Sample workflow.
argument-hint: "[target]"
capability: issue-creation
claude:
  disable-model-invocation: true
codex:
  display_name: "Prismatic: Sample"
  allow_implicit_invocation: false
---
Body.
`;
  const claude = renderWorkflow(policy, 'sample', workflow, 'claude');
  assert.deepEqual(Object.keys(claude), ['SKILL.md']);
  assert.match(claude['SKILL.md'], new RegExp(`^name: ${PREFIX}sample$`, 'm'));
  assert.match(claude['SKILL.md'], /^argument-hint: '\[target\]'$/m);
  assert.match(claude['SKILL.md'], /^disable-model-invocation: true$/m);
  assert.match(
    claude['SKILL.md'],
    new RegExp(
      `^model: ${policy.capabilities['issue-creation'].claude.model}$`,
      'm',
    ),
  );
  const codex = renderWorkflow(policy, 'sample', workflow, 'codex');
  assert.deepEqual(Object.keys(codex).sort(), [
    'SKILL.md',
    'agents/openai.yaml',
  ]);
  assert.match(codex['SKILL.md'], new RegExp(`^name: ${PREFIX}sample$`, 'm'));
  assert.doesNotMatch(codex['SKILL.md'], /^model:/m);
  assert.match(
    codex['agents/openai.yaml'],
    /display_name: 'Prismatic: Sample'/,
  );
  assert.match(codex['agents/openai.yaml'], /allow_implicit_invocation: false/);
  assert.throws(
    () => renderWorkflow(policy, 'other', workflow, 'codex'),
    /Workflow other declares name sample/,
  );
});

test('every role and workflow renders for both tools with matching bodies', () => {
  const files = render(FIXTURE);
  const names = [...files.keys()];
  for (const role of Object.keys(policy.roles)) {
    assert.ok(names.includes(`.claude/agents/${PREFIX}${role}.md`), role);
    assert.ok(names.includes(`.codex/agents/${PREFIX}${role}.toml`), role);
  }
  for (const skill of [
    'agents',
    'implement',
    'create-github-issue',
    'spec-to-issues',
    'review-code',
    'review-security',
    'plain-language',
    'stack',
  ]) {
    assert.ok(
      names.includes(`.claude/skills/${PREFIX}${skill}/SKILL.md`),
      skill,
    );
    assert.ok(
      names.includes(`.agents/skills/${PREFIX}${skill}/SKILL.md`),
      skill,
    );
    assert.ok(
      names.includes(`.agents/skills/${PREFIX}${skill}/agents/openai.yaml`),
      skill,
    );
  }
  // Shared references are copied into both skills byte for byte.
  assert.equal(
    files.get(
      `.claude/skills/${PREFIX}create-github-issue/references/github-operations.md`,
    ),
    files.get(
      `.agents/skills/${PREFIX}create-github-issue/references/github-operations.md`,
    ),
  );
  // Tool-only blocks aside, the two renderings of a source are the same text:
  // every shared line of every role, workflow, and Markdown reference appears
  // in both tools' output.
  for (const [path, outputs] of sourcePairs(files)) {
    const text = substitute(
      include(readFileSync(join(SOURCES, path), 'utf8')),
      policy,
    );
    const body = /^(roles|workflows)\/[^/]+\.md$/.test(path)
      ? parseSource(text).body
      : text;
    for (const line of sharedLines(body))
      for (const output of outputs)
        assert.ok(
          files.get(output)?.includes(line),
          `${output}: ${line.slice(0, 60)}`,
        );
  }
});

// The non-empty lines outside every tool-only block. Codex TOML keeps the
// text verbatim, so the same lines must appear in both renderings.
/** @param {string} body */
function sharedLines(body) {
  return body
    .replace(/<!-- (claude|codex)-only -->\n[\s\S]*?<!-- \/\1-only -->\n?/g, '')
    .split('\n')
    .filter((line) => line.trim());
}

test('include inserts a shared source and rejects an unknown one', () => {
  const includes = mkdtempSync(join(tmpdir(), 'agenticool-includes-'));
  writeFileSync(join(includes, 'shared-rule.md'), 'Rule.\n');
  assert.equal(include('A {{> shared-rule}} B', includes), 'A Rule. B');
  assert.equal(
    substitute(include('A \\{{> shared-rule}} B', includes), policy),
    'A {{> shared-rule}} B',
  );
  for (const tag of [
    '{{> missing}}',
    '{{>shared-rule}}',
    '{{> shared_rule}}',
    '{{> ../roles/x}}',
  ])
    assert.throws(
      () => include(`A ${tag} B`, includes),
      (/** @type {Error} */ error) =>
        error.message === `Unknown include: ${tag}`,
      tag,
    );
  for (const tag of ['{{> shared-rule}', '{{> a}b}}', '{{>']) {
    assert.throws(
      () => include(`A {{> shared-rule}} B ${tag}`, includes),
      /Malformed include in source/,
      tag,
    );
    assert.equal(
      substitute(include(`A \\${tag} B`, includes), policy),
      `A ${tag} B`,
      tag,
    );
  }
  writeFileSync(join(includes, 'nested.md'), '{{> shared-rule}}\n');
  assert.throws(
    () => include('A {{> nested}} B', includes),
    (/** @type {Error} */ error) =>
      error.message === 'Nested include in includes/nested.md',
  );
});

const packet = readFileSync(
  join(SOURCES, 'includes/review-packet.md'),
  'utf8',
).trimEnd();

test('render expands includes in skill references and leaves no tag behind', () => {
  const base = consumer(policy, {
    '.agents/local/workflows/flow.md':
      '---\nname: flow\ndescription: Flow.\n---\nBody.\n',
    '.agents/local/workflows/flow/references/guide.md':
      'A {{> review-packet}} B \\{{> review-packet}}\n',
  });
  const files = render(base);
  for (const target of inBoth('flow'))
    assert.equal(
      files.get(`${target}/references/guide.md`),
      `A ${packet} B {{> review-packet}}\n`,
      target,
    );
  writeFileSync(
    join(base, '.agents/local/workflows/flow/references/guide.md'),
    'A {{> missing}} B\n',
  );
  assert.throws(() => render(base), /Unknown include: \{\{> missing\}\}/);
});

test('the review packet has one source that the reviewer, the delivery procedure, and review-code carry', () => {
  const files = render(FIXTURE);
  for (const field of [
    '`review_mode=pre_pr|requested`',
    'the acceptance criteria',
    'the immediate base SHA, the pushed head SHA',
    "the reviewer's own resolved `Policy:` line",
    'the accepted decisions',
    'a changed-file summary',
    'the relevant validation results',
    'verified prerequisites',
    "A re-review packet adds the previous round's base and head SHAs and its complete report",
  ])
    assert.ok(packet.includes(field), field);
  for (const path of [
    `.claude/agents/${PREFIX}code-reviewer.md`,
    `.codex/agents/${PREFIX}code-reviewer.toml`,
    ...inBoth('implement/references/delivery.md'),
    ...inBoth('review-code/SKILL.md'),
  ])
    assert.ok(files.get(path)?.includes(packet), path);
  // No source restates the fields, so the copies cannot drift apart.
  for (const path of [
    'roles/code-reviewer.md',
    'workflows/implement/references/delivery.md',
    'workflows/review-code.md',
  ]) {
    const text = readFileSync(join(SOURCES, path), 'utf8');
    assert.match(text, /\{\{> review-packet\}\}/, path);
    assert.doesNotMatch(text, /changed-file summary|immediate base SHA/, path);
  }
});

test('the fixture consumer output is current', () => {
  assert.deepEqual(check(FIXTURE), []);
});

const flow = '---\nname: flow\ndescription: Flow.\n---\nBody.\n';

test('generate writes every file and check reports stale or orphaned output', () => {
  const base = consumer(
    { ...policy, roles: { ...policy.roles, sample: 'code-review' } },
    {
      '.agents/local/roles/sample.md': source,
      '.agents/local/workflows/flow.md': flow,
    },
  );
  const written = generate(base);
  const local = written.filter((path) => /-(sample|flow)[./]/.test(path));
  assert.deepEqual(local, [
    `.agents/skills/${PREFIX}flow/SKILL.md`,
    `.agents/skills/${PREFIX}flow/agents/openai.yaml`,
    `.claude/agents/${PREFIX}sample.md`,
    `.claude/skills/${PREFIX}flow/SKILL.md`,
    `.codex/agents/${PREFIX}sample.toml`,
  ]);
  // The shared output is the fixture consumer's, byte for byte.
  for (const path of written.filter((path) => !local.includes(path)))
    assert.equal(
      readFileSync(join(base, path), 'utf8'),
      readFileSync(join(FIXTURE, path), 'utf8'),
      path,
    );
  assert.match(
    readFileSync(join(base, `.claude/agents/${PREFIX}sample.md`), 'utf8'),
    /Generated from \.agents\/local\/roles\/sample\.md by agenticool-agents/,
  );
  assert.deepEqual(check(base), []);
  writeFileSync(join(base, `.codex/agents/${PREFIX}sample.toml`), 'edited');
  writeFileSync(join(base, `.claude/agents/${PREFIX}orphan.md`), 'orphan');
  writeFileSync(join(base, '.claude/agents/personal.md'), 'not ours');
  mkdirSync(join(base, '.claude/skills/personal'));
  writeFileSync(join(base, '.claude/skills/personal/SKILL.md'), 'not ours');
  assert.deepEqual(check(base), [
    `.claude/agents/${PREFIX}orphan.md`,
    `.codex/agents/${PREFIX}sample.toml`,
  ]);
  generate(base);
  assert.deepEqual(check(base), []);
  assert.equal(
    readFileSync(join(base, '.claude/agents/personal.md'), 'utf8'),
    'not ours',
  );
  // Rebinding the same sources renames the output and resolves the text.
  writeFileSync(
    join(base, '.agents/policy.json'),
    JSON.stringify({
      ...other,
      roles: { ...other.roles, sample: 'code-review' },
    }),
  );
  writeFileSync(
    join(base, '.agents/local/roles/sample.md'),
    source.replace('Shared line.', 'Shared {{label}} line in {{repository}}.'),
  );
  assert.deepEqual(
    generate(base).filter((path) => /-(sample|flow)[./]/.test(path)),
    [
      '.agents/skills/other-flow/SKILL.md',
      '.agents/skills/other-flow/agents/openai.yaml',
      '.claude/agents/other-sample.md',
      '.claude/skills/other-flow/SKILL.md',
      '.codex/agents/other-sample.toml',
    ],
  );
  assert.match(
    readFileSync(join(base, '.claude/agents/other-sample.md'), 'utf8'),
    /Shared Other line in example\/other\./,
  );
  assert.match(
    readFileSync(
      join(base, '.agents/skills/other-flow/agents/openai.yaml'),
      'utf8',
    ),
    /display_name: 'Other: flow'/,
  );
});

test('local sources come from the configured directories', () => {
  const base = consumer(
    {
      ...policy,
      roles: { ...policy.roles, sample: 'code-review' },
      local: { roles: 'agents/roles', workflows: 'agents/flows' },
    },
    { 'agents/roles/sample.md': source, 'agents/flows/flow.md': flow },
  );
  const files = render(base);
  assert.match(
    String(files.get(`.claude/agents/${PREFIX}sample.md`)),
    /Generated from agents\/roles\/sample\.md/,
  );
  assert.match(
    String(files.get(`.claude/skills/${PREFIX}flow/SKILL.md`)),
    /Generated from agents\/flows\/flow\.md/,
  );
});

test('a local role or workflow with a shared name fails generation', () => {
  const role = consumer(policy, {
    '.agents/local/roles/implementer.md': source.replace(
      'name: sample',
      'name: implementer',
    ),
  });
  assert.throws(
    () => render(role),
    /Local role implementer in \.agents\/local\/roles has the name of a shared one/,
  );
  const workflow = consumer(policy, {
    '.agents/local/workflows/implement.md': flow.replace('flow', 'implement'),
  });
  assert.throws(
    () => generate(workflow),
    /Local workflow implement in \.agents\/local\/workflows has the name of a shared one/,
  );
});

test('a role without a policy entry or source is rejected', () => {
  const base = consumer({
    ...policy,
    roles: { ...policy.roles, missing: 'code-review' },
  });
  assert.throws(() => render(base), /Role missing has no source/);
  const extra = consumer(policy, {
    '.agents/local/roles/extra.md': source.replace(
      'name: sample',
      'name: extra',
    ),
  });
  assert.throws(() => render(extra), /Role extra has no entry/);
});

test('an incomplete binding fails before anything is generated', () => {
  const base = consumer({
    ...policy,
    binding: { ...policy.binding, docs: undefined },
  });
  assert.throws(() => generate(base), /binding is missing docs\.triage/);
});

test('the shared rules land in .agents with the binding resolved', () => {
  const files = render(consumer(other));
  const docs = [...files.keys()].filter((path) =>
    /^\.agents\/[^/]+\.md$/.test(path),
  );
  assert.deepEqual(docs, [
    '.agents/evidence.md',
    '.agents/independence-groups.md',
    '.agents/issue-creation.md',
    '.agents/review.md',
    '.agents/worktree-isolation.md',
  ]);
  const groups = String(files.get('.agents/independence-groups.md'));
  assert.match(
    groups,
    /^Only `other-issue-triager` forms independence groups/m,
  );
  assert.match(groups, /^<!-- other-independence-groups -->$/m);
  assert.match(
    String(files.get('.agents/issue-creation.md')),
    /^# Other issue creation\n[\s\S]*\[TRIAGE\.md\]\(\.\.\/TRIAGE\.md\)/,
  );
});
