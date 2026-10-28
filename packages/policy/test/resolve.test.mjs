import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  binding,
  implementationEffort,
  loadPolicy,
  placeholders,
  prefix,
  resolve,
  TOOLS,
} from '@agenticool/policy';

const policy = loadPolicy(
  fileURLToPath(new URL('fixtures/prismatic', import.meta.url)),
);
const PREFIX = prefix(policy);
// The same policy bound to another repository with no CI-applied infrastructure.
const other = {
  ...policy,
  binding: {
    namespace: 'other',
    label: 'Other',
    repository: 'example/other',
    project: { owner: 'example', number: 7, name: 'Other delivery' },
    docs: { triage: 'TRIAGE.md', workflow: 'AGENTS.md', guides: ['AGENTS.md'] },
    features: { infrastructure: false },
  },
};

test('the binding resolves every placeholder', () => {
  assert.equal(PREFIX, `${policy.binding.namespace}-`);
  assert.deepEqual(placeholders(other), {
    prefix: 'other-',
    label: 'Other',
    repository: 'example/other',
    'project.owner': 'example',
    'project.number': '7',
    'project.name': 'Other delivery',
    'project.url': 'https://github.com/users/example/projects/7',
    'project.restPath': 'users/example/projectsV2/7',
    'docs.triage': 'TRIAGE.md',
    'docs.workflow': 'AGENTS.md',
    'docs.guides': '`AGENTS.md`',
    'infrastructure.accountChecks': '',
  });
  assert.equal(
    placeholders({
      ...other,
      binding: {
        ...other.binding,
        docs: { ...other.binding.docs, guides: ['A.md', 'B.md', 'C.md'] },
      },
    })['docs.guides'],
    '`A.md`, `B.md`, or `C.md`',
  );
  assert.equal(
    placeholders({
      ...other,
      binding: {
        ...other.binding,
        docs: { ...other.binding.docs, guides: ['A.md', 'B.md'] },
      },
    })['docs.guides'],
    '`A.md` or `B.md`',
  );
  assert.equal(
    placeholders({
      ...other,
      binding: {
        ...other.binding,
        infrastructure: { accountChecks: ['a.mjs', 'b', 'c'] },
      },
    })['infrastructure.accountChecks'],
    '`a.mjs`, `b`, and `c`',
  );
  assert.throws(
    () => binding({ ...policy, binding: undefined }),
    /missing binding/,
  );
  assert.throws(
    () =>
      binding({
        ...policy,
        binding: { ...policy.binding, namespace: 'Bad-Name' },
      }),
    /namespace must be lowercase/,
  );
  assert.throws(
    () =>
      binding({
        ...policy,
        binding: { ...policy.binding, project: { owner: 'x', name: 'y' } },
      }),
    /missing project.number/,
  );
});

test('spawn parameters follow the binding namespace', () => {
  const resolved = resolve(other, { tool: 'claude', role: 'implementer' });
  assert.equal(resolved.spawn.subagent_type, 'other-implementer');
});

test('every role and capability resolves to a supported setting for both tools', () => {
  for (const tool of TOOLS) {
    for (const role of Object.keys(policy.roles)) {
      const resolved = resolve(policy, { tool, role });
      assert.equal(resolved.source.model, 'policy');
      assert.equal(resolved.source.effort, 'policy');
      assert.ok(resolved.model);
      assert.ok(resolved.effort);
    }
    for (const capability of Object.keys(policy.capabilities))
      assert.ok(resolve(policy, { tool, capability }).model);
  }
});

test('capabilities have explicit, differentiated policies per tool', () => {
  const required = [
    'issue-creation',
    'issue-triage',
    'implementation',
    'code-review',
    'security-review',
  ];
  for (const capability of required)
    for (const tool of TOOLS)
      assert.ok(policy.capabilities[capability][tool].model, capability);
  for (const tool of TOOLS) {
    const settings = new Set(
      required.map((capability) => {
        const entry = policy.capabilities[capability][tool];
        return `${entry.model}/${entry.effort}`;
      }),
    );
    assert.ok(settings.size > 1, `${tool} policy is undifferentiated`);
  }
});

test('a prompt override replaces only the named setting', () => {
  const base = resolve(policy, { tool: 'claude', role: 'implementer' });
  const modelOnly = resolve(policy, {
    tool: 'claude',
    role: 'implementer',
    model: 'sonnet',
  });
  assert.equal(modelOnly.model, 'sonnet');
  assert.equal(modelOnly.effort, base.effort);
  assert.deepEqual(modelOnly.source, { model: 'override', effort: 'policy' });
  const effortOnly = resolve(policy, {
    tool: 'codex',
    role: 'code-reviewer',
    effort: 'xhigh',
  });
  assert.equal(
    effortOnly.model,
    policy.capabilities['code-review'].codex.model,
  );
  assert.equal(effortOnly.effort, 'xhigh');
  assert.deepEqual(effortOnly.source, { model: 'policy', effort: 'override' });
  const both = resolve(policy, {
    tool: 'codex',
    role: 'implementer',
    model: 'gpt-6-sol',
    effort: 'ultra',
  });
  assert.deepEqual(both.spawn, {
    agent_type: `${PREFIX}implementer`,
    model: 'gpt-6-sol',
    reasoning_effort: 'ultra',
    fork_turns: 'none',
  });
});

test('spawn parameters use each tool vocabulary and the namespaced agent', () => {
  const claude = resolve(policy, { tool: 'claude', role: 'security-reviewer' });
  assert.deepEqual(claude.spawn, {
    subagent_type: `${PREFIX}security-reviewer`,
    model: claude.model,
    effort: claude.effort,
  });
  const codex = resolve(policy, { tool: 'codex', role: 'security-reviewer' });
  assert.equal(codex.spawn.agent_type, `${PREFIX}security-reviewer`);
  assert.equal(codex.spawn.reasoning_effort, codex.effort);
  assert.equal(codex.spawn.fork_turns, 'none');
  assert.equal(
    resolve(policy, { tool: 'claude', capability: 'issue-creation' }).spawn
      .subagent_type,
    null,
  );
});

test('unsupported models and efforts fail instead of falling back', () => {
  assert.throws(
    () =>
      resolve(policy, {
        tool: 'claude',
        role: 'implementer',
        model: 'gpt-6-luna',
      }),
    /Unsupported claude model "gpt-6-luna"/,
  );
  assert.throws(
    () =>
      resolve(policy, { tool: 'codex', role: 'implementer', model: 'opus' }),
    /Unsupported codex model "opus"/,
  );
  assert.throws(
    () =>
      resolve(policy, { tool: 'claude', role: 'implementer', effort: 'ultra' }),
    /Unsupported claude effort "ultra"/,
  );
  assert.throws(
    () =>
      resolve(policy, {
        tool: 'codex',
        role: 'implementer',
        model: 'gpt-6-luna',
        effort: 'ultra',
      }),
    /Unsupported codex effort "ultra" for model "gpt-6-luna"/,
  );
  assert.throws(
    () => resolve(policy, { tool: 'cursor', role: 'implementer' }),
    /Unknown tool/,
  );
  assert.throws(() => resolve(policy), /Unknown tool/);
  assert.throws(
    () => resolve(policy, { tool: 'claude', role: 'reviewer' }),
    /Unknown role/,
  );
  assert.throws(
    () => resolve(policy, { tool: 'claude', capability: 'deploy' }),
    /Unknown capability/,
  );
});

test('a full Claude model ID is accepted with the shared effort levels', () => {
  const resolved = resolve(policy, {
    tool: 'claude',
    role: 'code-reviewer',
    model: 'claude-opus-5-5',
    effort: 'max',
  });
  assert.equal(resolved.model, 'claude-opus-5-5');
  assert.throws(
    () =>
      resolve(policy, {
        tool: 'claude',
        role: 'code-reviewer',
        model: 'gpt-x',
      }),
    /Unsupported claude model/,
  );
});

test('implementation is medium while every review dispatch has its own high settings', () => {
  for (const tool of TOOLS) {
    const implementer = resolve(policy, { tool, role: 'implementer' });
    const reviewer = resolve(policy, { tool, role: 'code-reviewer' });
    assert.equal(implementer.effort, 'medium');
    assert.equal(reviewer.effort, 'high');
    assert.equal(
      implementer.model,
      tool === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol',
    );
    assert.equal(reviewer.model, tool === 'claude' ? 'opus' : 'gpt-6.1-sol');
    for (const packet of [implementer, reviewer]) {
      /** @type {Record<string, unknown>} */
      const spawn = packet.spawn;
      assert.equal(spawn.model, packet.model);
      assert.equal(
        spawn[tool === 'claude' ? 'effort' : 'reasoning_effort'],
        packet.effort,
      );
      if (tool === 'codex') assert.equal(spawn.fork_turns, 'none');
    }
  }
});

/** @param {string} rule */
const assessment = (rule) => ({
  effort: 'high',
  rule,
  question: 'How do the unresolved constraints preserve correctness?',
  evidence: 'spec §4 and failing case race-1',
  reason: 'The supplied plan leaves the competing write orders unresolved.',
  criteria: Object.fromEntries(
    policy.implementationEffort.rules[rule].requires.map(
      (/** @type {string} */ key) => [key, true],
    ),
  ),
});
for (const rule of [
  'H1-boundary',
  'H2-coupled-design',
  'H3-demonstrated-limit',
]) {
  test(`${rule} requires every criterion and concrete evidence`, () => {
    const decision = assessment(rule);
    assert.equal(implementationEffort(policy, { decision }).effort, 'high');
    for (const key of policy.implementationEffort.rules[rule].requires)
      assert.equal(
        implementationEffort(policy, {
          decision: {
            ...decision,
            criteria: { ...decision.criteria, [key]: false },
          },
        }).effort,
        'medium',
        key,
      );
    for (const key of ['evidence', 'reason', 'question'])
      assert.equal(
        implementationEffort(policy, { decision: { ...decision, [key]: '' } })
          .effort,
        'medium',
        key,
      );
  });
}

test('specified mechanisms and routine corrections fail the high criteria', () => {
  assert.equal(
    implementationEffort(policy, {
      decision: {
        ...assessment('H1-boundary'),
        criteria: {
          ...assessment('H1-boundary').criteria,
          mechanismUnresolved: false,
        },
      },
    }).effort,
    'medium',
  );
  assert.equal(
    implementationEffort(policy, {
      decision: {
        ...assessment('H3-demonstrated-limit'),
        criteria: {
          ...assessment('H3-demonstrated-limit').criteria,
          designRevisionRequired: false,
        },
      },
    }).effort,
    'medium',
  );
});

test('without a decision, or with an unknown rule or effort, the default applies', () => {
  const ordinary = {
    effort: 'medium',
    rule: 'default',
    evidence: 'ticket/spec',
    reason: 'The written plan resolves the design.',
  };
  assert.deepEqual(implementationEffort(policy), ordinary);
  assert.deepEqual(
    implementationEffort(policy, {
      decision: { ...assessment('H1-boundary'), rule: 'H9-unknown' },
    }),
    ordinary,
  );
  assert.deepEqual(
    implementationEffort(policy, {
      decision: { ...assessment('H1-boundary'), effort: 'max' },
    }),
    ordinary,
  );
});

test('a recorded user override sets the effort and needs its evidence', () => {
  const override = {
    effort: 'medium',
    rule: 'user override',
    evidence: 'explicit user constraint',
    reason: 'The request selects this effort.',
  };
  const selected = implementationEffort(policy, { decision: override });
  assert.equal(selected.effort, 'medium');
  assert.equal(selected.rule, 'user override');
  assert.throws(
    () =>
      implementationEffort(policy, { decision: { ...override, reason: '' } }),
    /needs effort, evidence, and reason/,
  );
});

test('later escalation applies high once', () => {
  const decision = { ...assessment('H3-demonstrated-limit'), later: true };
  assert.equal(
    implementationEffort(policy, { decision, transitions: 0 }).effort,
    'high',
  );
  assert.throws(
    () => implementationEffort(policy, { decision, transitions: 1 }),
    /Only one automatic/,
  );
});
