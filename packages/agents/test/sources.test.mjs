// The rendered sources keep the wording that callers and the delivery
// procedure depend on, for the fixture consumer's binding.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { render, SOURCES } from '@agenticool/agents';
import { resolve, TOOLS } from '@agenticool/core';
import {
  FIXTURE,
  inBoth,
  lineWith,
  policy,
  section,
  sourcePairs,
} from './helpers.mjs';

const BIN = fileURLToPath(
  new URL('../bin/agenticool-agents.mjs', import.meta.url),
);
const all = render(FIXTURE);
// The fixture output, where reading a path that was not generated fails.
const rendered = {
  /** @param {string} path */
  get(path) {
    const content = all.get(path);
    assert.ok(content !== undefined, `not generated: ${path}`);
    return content;
  },
  keys: () => all.keys(),
  [Symbol.iterator]: () => all[Symbol.iterator](),
};

test('caller skills relay the agent result verbatim in both tools', () => {
  const files = rendered;
  for (const skill of ['ac-implement', 'ac-review-code', 'ac-review-security'])
    for (const path of [
      `.claude/skills/${skill}/SKILL.md`,
      `.agents/skills/${skill}/SKILL.md`,
    ])
      assert.ok(
        lineWith(
          files.get(path),
          /\b(relay|print)\b/i,
          'Requested settings:',
          /\bverbatim\b/,
        ),
        `${path} must relay the result and its Requested settings line verbatim`,
      );
});

test('every role reports its requested settings in both tools', () => {
  const files = rendered;
  for (const role of Object.keys(policy.roles))
    for (const path of [
      `.claude/agents/${role}.md`,
      `.codex/agents/${role}.toml`,
    ])
      assert.ok(
        files.get(path).includes('Requested settings: Policy:'),
        `${path} must return a Requested settings: Policy: line`,
      );
});

// The leaf delivery procedure that the main thread and an isolated
// implementer both follow, in each tool's package.
const DELIVERY = [
  `.claude/skills/ac-implement/references/delivery.md`,
  `.agents/skills/ac-implement/references/delivery.md`,
];
const QUEUE = DELIVERY.map((path) => path.replace('delivery.md', 'queue.md'));
const IMPLEMENT = [
  `.claude/skills/ac-implement/SKILL.md`,
  `.agents/skills/ac-implement/SKILL.md`,
];
const STACK = [
  `.claude/skills/ac-stack/SKILL.md`,
  `.agents/skills/ac-stack/SKILL.md`,
];

test('the delivery owner sends the reviewer its own resolved policy line', () => {
  const files = rendered;
  for (const path of DELIVERY)
    assert.ok(
      lineWith(
        files.get(path),
        'review_mode=pre_pr',
        'resolved `Policy:` line',
        'role=ac-code-reviewer',
      ),
      `${path} pre-PR packet must carry the reviewer's resolved Policy: line`,
    );
});

test('the delivery owner never sets In review and reports the state as read', () => {
  const files = rendered;
  for (const path of DELIVERY) {
    const content = files.get(path);
    assert.ok(
      lineWith(content, /^Never:/, 'In review or Done'),
      `${path} must forbid setting In review or Done`,
    );
    assert.ok(
      lineWith(
        section(content, 'Claim'),
        'In progress is the only project status you ever set',
      ),
      `${path} claim step must limit the agent to In progress`,
    );
    assert.ok(
      lineWith(section(content, 'PR'), "Leave the issue's status alone"),
      `${path} PR step must leave In review to automation`,
    );
    assert.ok(
      lineWith(content, /^Return /, 'project state as read'),
      `${path} handoff must report the project state as read`,
    );
    assert.doesNotMatch(content, /Move the issue to In review/i, path);
  }
});

test('removed coordination roles cannot be selected through any entry point', () => {
  assert.deepEqual(Object.keys(policy.roles).sort(), [
    'ac-code-reviewer',
    'ac-implementer',
    'ac-issue-triager',
    'ac-security-reviewer',
  ]);
  for (const capability of ['orchestration', 'stack-management'])
    assert.equal(policy.capabilities[capability], undefined, capability);
  for (const tool of TOOLS)
    for (const role of ['orchestrator', 'stack-manager'])
      assert.throws(
        () => resolve(policy, { tool, role }),
        /Unknown role/,
        `${tool} ${role}`,
      );
  const files = rendered;
  const agents = [...files.keys()].filter((path) =>
    /^\.(claude|codex)\/agents\//.test(path),
  );
  assert.deepEqual(
    agents.sort(),
    Object.keys(policy.roles)
      .flatMap((role) => [
        `.claude/agents/${role}.md`,
        `.codex/agents/${role}.toml`,
      ])
      .sort(),
  );
  for (const [path, content] of files)
    assert.doesNotMatch(
      content,
      /stack-manager|`orchestrator`|_type: orchestrator/,
      path,
    );
  // The CLI refuses the removed roles as well.
  for (const role of ['orchestrator', 'stack-manager']) {
    const result = spawnSync(
      process.execPath,
      [BIN, 'resolve', '--tool', 'claude', '--role', role],
      { cwd: FIXTURE, encoding: 'utf8' },
    );
    assert.equal(result.status, 1, role);
    assert.match(result.stderr, /Unknown role/, role);
  }
});

test('default delivery dispatches isolated implementers and keeps the main thread thin', () => {
  const files = rendered;
  for (const path of IMPLEMENT) {
    const content = files.get(path);
    for (const target of ['Leaf issue', 'PR rework'])
      assert.ok(
        lineWith(
          content,
          `| ${target} |`,
          `isolated implementer`,
          'references/delivery.md',
        ),
        path,
      );
    for (const requirement of [
      'explicit `inline` keyword',
      'queue ledger and fixed result fields only',
      'Do not read source or diffs',
      'detailed review reports',
      'npx agenticool-dispatch queue',
      "leaf's ledger line",
      'actual base branch and SHA',
      'Owned by other running leaves:',
      'reads its own issue',
      'never spawns another implementer',
    ])
      assert.ok(content.includes(requirement), `${path}: ${requirement}`);
    assert.doesNotMatch(content, /concrete-benefit|concrete benefit/);
    assert.match(content, /session settings.*cannot change/s);
    assert.match(content, /Advisory policy:/);
    assert.doesNotMatch(content, /^model:/m);
  }
  const [claude, codex] = IMPLEMENT.map((path) =>
    section(files.get(path), 'Dispatch and continuation'),
  );
  assert.match(claude, new RegExp(`subagent_type: ac-implementer`));
  assert.match(claude, /`model` and `effort` explicitly copied/);
  assert.match(
    codex,
    /`agent_type`, `model`, and `reasoning_effort` explicitly copied/,
  );
  assert.match(codex, /fork_turns: "none"/);
  assert.match(claude, /SendMessage/);
  assert.match(codex, /continue mechanism/);
});

test('a container runs as a dependency queue in the owning thread', () => {
  const files = rendered;
  for (const path of QUEUE) {
    const content = files.get(path);
    assert.ok(lineWith(content, 'No separate orchestrator agent'), path);
    assert.ok(lineWith(content, 'Detect cycles in the blocked-by edges'), path);
    assert.ok(lineWith(content, '`resume`', 'Reuse its pushed branch'), path);
    assert.ok(lineWith(content, '`waiting`', 'blocker is unmet'), path);
    assert.ok(
      lineWith(
        content,
        'Delivery is sequential by default',
        'record its result',
        'before you start the next leaf',
      ),
      `${path} must deliver one leaf at a time and record each result`,
    );
    const parallel = section(content, 'Parallel exception');
    assert.match(parallel, /explicitly asked for parallel delivery/);
    assert.match(parallel, /different groups/);
    assert.match(parallel, /no overlapping files or shared contracts/);
    assert.match(parallel, /At most one leaf per group runs at a time/);
    assert.match(parallel, /Never infer, form, extend, or merge groups/);
    // Each concurrent implementer learns what the other running leaves own.
    assert.ok(
      lineWith(
        parallel,
        'carries an `Owned by other running leaves:` field',
        'issue numbers of the other leaves',
        'files and shared contracts',
      ),
      `${path} must hand each concurrent leaf the other leaves' ownership`,
    );
    // Resume checks out the existing branch instead of creating it.
    assert.ok(
      lineWith(content, '`resume`', 'git worktree add <path> <branch>'),
      `${path} must check out the existing branch on resume`,
    );
    // A claim whose worktree is missing here is never taken over silently.
    assert.ok(
      lineWith(content, '`resume`', '`git worktree list`'),
      `${path} must tie resume to a worktree in this checkout`,
    );
    assert.ok(
      lineWith(content, 'whose worktree is missing here', 'Ask the person'),
      `${path} must treat a missing worktree as owned elsewhere`,
    );
  }
  // Concurrent leaves really run at the same time in each tool.
  assert.match(
    section(files.get(QUEUE[0]), 'Parallel exception'),
    /`run_in_background: true`/,
  );
  // Claude records each background result as it arrives and lets a finished
  // group start its next leaf while other groups still run.
  for (const fragment of [
    'Record each result as its notification arrives',
    'the next ready leaf in that group may start while leaves in other groups still run',
    'Before any early return, wait for every running implementer and record each result',
  ])
    assert.ok(
      section(files.get(QUEUE[0]), 'Parallel exception').includes(fragment),
      fragment,
    );
  assert.doesNotMatch(
    section(files.get(QUEUE[0]), 'Parallel exception'),
    /blocks until it returns/,
  );
  assert.match(
    section(files.get(QUEUE[1]), 'Parallel exception'),
    /`spawn_agent` returns at once/,
  );
  const creation = rendered.get('.agents/independence-groups.md');
  assert.ok(
    lineWith(creation, `ac-implement\` reads only the lines`),
    'independence-groups.md must name the queue as the record reader',
  );
});

test('the delivery owner runs stack operations itself through the shared stack skill', () => {
  const files = rendered;
  for (const path of DELIVERY)
    assert.ok(
      lineWith(
        section(files.get(path), 'Stack'),
        `Run every stack operation yourself with the ac-stack skill`,
        'in the worktree you created',
      ),
      path,
    );
  assert.match(
    section(files.get(DELIVERY[0]), 'Stack'),
    new RegExp(`Skill tool \\(\`ac-stack\`\\)`),
  );
  assert.match(
    section(files.get(DELIVERY[1]), 'Stack'),
    new RegExp(`\\$ac-stack`),
  );
  for (const path of STACK) {
    const content = files.get(path);
    assert.ok(
      lineWith(content, 'You run this skill yourself', 'worktree you created'),
      path,
    );
    assert.match(content, /git worktree list --porcelain/, path);
    const never = section(content, 'Never run');
    for (const phrase of [
      '`gh stack sync`',
      '`gh stack rebase`',
      '`--no-trunk`',
      '`gh stack push`',
      '`gh stack submit`',
      'rebase.updateRefs=false',
      'bare `git push --force`',
    ])
      assert.ok(never.includes(phrase), `${path} never runs: ${phrase}`);
    assert.ok(
      lineWith(never, '`gh stack push`', 'fetch', 'previously verified SHA'),
      `${path} must explain why the stack push lease is unsafe`,
    );
    const operations = section(content, 'Operations');
    assert.match(
      operations,
      /git -c rebase\.updateRefs=false rebase --onto/,
      path,
    );
    assert.match(
      operations,
      /--force-with-lease=<branch>:<expected SHA>/,
      path,
    );
    assert.match(operations, /gh stack link --base main <PR URL>/, path);
    assert.match(operations, /Never adopt, rebase, or push the prerequisite/);
    // Rework and resume of an earlier delivery's branch have working paths.
    assert.ok(
      lineWith(content, 'earlier delivery', 'head branch of the target PR'),
      `${path} must define ownership for rework and resume`,
    );
    assert.match(
      operations,
      /rebase\.updateRefs=false rebase --onto <new parent head> <old parent head>`, then push with `git push --force-with-lease=<branch>:<verified remote head> origin HEAD:<branch>`/,
      path,
    );
    assert.match(operations, /`git worktree add <path> <branch>`/, path);
    assert.ok(
      lineWith(content, 'Authority:', 'never covers merges'),
      `${path} must not authorize merges`,
    );
  }
});

test('delivery stops when another worktree has the target branch checked out', () => {
  for (const path of DELIVERY) {
    const worktree = section(rendered.get(path), 'Worktree');
    const check = worktree.indexOf('run `git worktree list --porcelain`');
    assert.ok(check > worktree.indexOf('After `git fetch origin`'), path);
    assert.ok(check < worktree.indexOf('git worktree add -b'), path);
    if (worktree.includes('git switch -c'))
      assert.ok(check < worktree.indexOf('git switch -c'), path);
    assert.ok(
      lineWith(
        worktree,
        'a new branch, a resumed claim',
        'a stacked layer',
        "stop and report that worktree's path",
        '.agents/worktree-isolation.md',
      ),
      path,
    );
    assert.ok(
      lineWith(worktree, 'Rework is not blocked', 'detaches at `origin/'),
      path,
    );
  }
  assert.ok(
    lineWith(
      rendered.get('.agents/worktree-isolation.md'),
      '`git worktree list --porcelain`',
      "stop and report that worktree's path",
      'no forced checkout',
      'no deleting or renaming the other worktree or its branch',
      'no `git worktree prune` or `git worktree remove` on a worktree you did not create',
    ),
  );
  for (const path of STACK)
    assert.ok(
      lineWith(
        section(rendered.get(path), 'Operations'),
        'A rebase, cascade, or push never moves a branch that another worktree has checked out',
        '(#inspect-before-every-mutation)',
      ),
      path,
    );
});

test('independent review stays a separate fresh-context gate on mandatory paths', () => {
  const files = rendered;
  for (const path of DELIVERY) {
    const review = section(files.get(path), 'Pre-PR review');
    for (const scope of [
      '`.agents/`',
      '`AGENTS.md`',
      '`.claude/`',
      '`.github/workflows/`',
      ...(policy.binding.features.infrastructure
        ? [
            '`infrastructure/`',
            '`.terrateam/`',
            'CDK account or environment checks',
          ]
        : []),
    ])
      assert.ok(
        lineWith(review, 'always required', scope),
        `${path}: ${scope}`,
      );
    assert.match(review, new RegExp(`fresh ac-code-reviewer`));
    assert.match(review, /Leave out your self-assessment/);
    assert.match(review, /exact base\/head pair/);
    assert.match(review, /After two rejected rounds, return BLOCKED/);
    assert.match(review, /Never self-approve/);
    assert.ok(
      lineWith(files.get(path), 'Once a PR exists, never invoke'),
      `${path} must keep requested review separate from pre-PR review`,
    );
    assert.ok(
      lineWith(files.get(path), /^Never:/, `ac-security-reviewer`),
      `${path} must never start a security review`,
    );
  }
  assert.match(
    files.get(`.claude/skills/ac-review-security/SKILL.md`),
    /^disable-model-invocation: true$/m,
  );
  assert.match(
    files.get(`.agents/skills/ac-review-security/agents/openai.yaml`),
    /allow_implicit_invocation: false/,
  );
});

test('an isolated implementer follows the shared procedure and delegates nothing else', () => {
  const files = rendered;
  const claude = files.get(`.claude/agents/ac-implementer.md`);
  const codex = files.get(`.codex/agents/ac-implementer.toml`);
  assert.match(claude, /^isolation: worktree$/m);
  assert.match(
    claude,
    new RegExp(
      `git show origin/main:\\.claude/skills/ac-implement/references/delivery\\.md`,
    ),
  );
  assert.match(
    codex,
    new RegExp(
      `git show origin/main:\\.agents/skills/ac-implement/references/delivery\\.md`,
    ),
  );
  for (const content of [claude, codex]) {
    assert.ok(lineWith(content, 'Never spawn another implementer'));
    assert.ok(lineWith(content, 'BLOCKED: container'));
    assert.ok(
      lineWith(content, '`Owned by other running leaves:`', 'return BLOCKED'),
    );
  }
});

test('issue filing classifies inline and reserves the triager for independent judgment', () => {
  const files = rendered;
  for (const path of [
    `.claude/skills/ac-create-github-issue/SKILL.md`,
    `.agents/skills/ac-create-github-issue/SKILL.md`,
  ]) {
    const triage = section(files.get(path), 'Triage');
    assert.match(triage, /Classify inline by default/);
    for (const reason of [
      '- Classification:',
      '- Decomposition:',
      '- Dependency judgment:',
    ])
      assert.ok(triage.includes(reason), `${path}: ${reason}`);
    assert.match(triage, /Only the triager forms independence groups/);
    assert.match(triage, /the batch files two or more leaves/);
    assert.match(triage, /single leaf .* still classifies inline/);
    assert.match(triage, /`EDGES` line/);
    const publish = section(files.get(path), 'Publish');
    assert.match(
      publish,
      /native parent links, then blocked-by edges, planned and triager-returned alike/,
    );
  }
  const role = readFileSync(join(SOURCES, 'roles/ac-issue-triager.md'), 'utf8');
  for (const rule of [
    'EDGES | <waiting ref> <- <blocker ref>: <=15-word reason',
    '`EDGES | none`',
    'whether or not they share a container',
    'even when the pair needs no particular order',
    'never recommend an edge that closes a cycle',
    'leaves linked by an edge never sit in different groups',
  ])
    assert.ok(role.includes(rule), rule);
});

// Every generated agent and skill name.
const NAMES = [
  ...new Set(
    [...rendered.keys()]
      .map((path) =>
        path.match(
          /^\.(?:claude|codex)\/agents\/([a-z-]+)\.|^\.claude\/skills\/([a-z-]+)\//,
        ),
      )
      .flatMap((match) => (match ? [match[1] ?? match[2]] : [])),
  ),
];
// Routing facts: the agents and skills a file names and the references it
// links. Both tools' renderings of one source must agree.
/** @param {string} content */
function routing(content) {
  return [
    ...new Set(
      [
        ...content.matchAll(
          new RegExp(
            `(?<![\\w-])(?:${NAMES.join('|')})(?![\\w-])|references/[a-z-]+\\.md`,
            'g',
          ),
        ),
      ].map((match) => match[0]),
    ),
  ].sort();
}

test('both tools route every source to the same agents, skills, and references', () => {
  const files = rendered;
  for (const [source, [claude, codex]] of sourcePairs(rendered))
    assert.deepEqual(
      routing(files.get(claude)),
      routing(files.get(codex)),
      source,
    );
  // The delivery result fields match word for word.
  const [claudeResult, codexResult] = DELIVERY.map((path) =>
    lineWith(files.get(path), /^Return READY FOR REVIEW or BLOCKED/),
  );
  assert.ok(claudeResult);
  assert.equal(claudeResult, codexResult);
});

test('the README keeps the effective-model verification row', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(
    lineWith(
      readme,
      /^\|/,
      'Effective-model verification',
      'sqlite3',
      'state_5.sqlite',
    ),
    'README must keep the effective-model verification row with the Codex sqlite3 check',
  );
});

test('review publication runs only from a manual PR review', () => {
  const files = rendered;
  for (const path of [
    `.claude/skills/ac-review-code/SKILL.md`,
    `.agents/skills/ac-review-code/SKILL.md`,
  ]) {
    const content = files.get(path);
    assert.ok(
      lineWith(content, 'review_mode=requested'),
      `${path} must dispatch requested-mode reviews`,
    );
    assert.ok(
      lineWith(content, /^For a pull request target/, 'For a branch target'),
      `${path} must publish for pull requests and skip branches`,
    );
    assert.ok(
      lineWith(
        content,
        'npx agenticool-agents publish-review',
        '--base',
        '--head',
        'the only way this skill posts',
      ),
      `${path} must post only through publish-review with the reviewed SHAs`,
    );
    assert.ok(
      lineWith(content, 'Posted: none (branch review)'),
      `${path} must keep branch reviews report-only`,
    );
    assert.ok(
      lineWith(content, 'fresh review'),
      `${path} must ask for a fresh review when the SHAs moved`,
    );
    assert.ok(
      lineWith(
        content,
        'ls-remote --exit-code --heads',
        'pull/N/head main',
        'merge-base',
        'base_fallback=deleted base branch',
      ),
      `${path} must review against the merge base with main when the base branch was deleted`,
    );
    assert.ok(
      lineWith(content, '`base_fallback` when Gather used it'),
      `${path} must put the base fallback in the packet`,
    );
    assert.ok(
      lineWith(
        content,
        'Base: merge base of the head and origin/main, because base branch',
      ),
      `${path} must print the base fallback in the report`,
    );
    assert.doesNotMatch(content, /nothing in this flow writes to GitHub/, path);
  }
  for (const path of [
    `.claude/agents/ac-code-reviewer.md`,
    `.codex/agents/ac-code-reviewer.toml`,
  ]) {
    const content = files.get(path);
    assert.ok(
      lineWith(content, /^Never:/, 'touch issues, projects, or PRs'),
      `${path} must keep the reviewer read-only`,
    );
    assert.ok(
      lineWith(content, '`requested` mode', 'never post to it'),
      `${path} must leave publication to the skill`,
    );
  }
  // The delivery owner's pre-PR review relays its verdict and posts nothing.
  for (const path of DELIVERY)
    assert.ok(lineWith(files.get(path), 'review_mode=pre_pr'), path);
  for (const [path, content] of files)
    if (!path.includes(`/ac-review-code/`))
      assert.doesNotMatch(content, /publish-review/, path);
});

test('review entry points share bounded packets and preserve independent coverage', () => {
  const files = rendered;
  const review = rendered.get('.agents/review.md');
  for (const path of [
    ...DELIVERY,
    `.claude/skills/ac-review-code/SKILL.md`,
    `.agents/skills/ac-review-code/SKILL.md`,
    `.claude/agents/ac-code-reviewer.md`,
    `.codex/agents/ac-code-reviewer.toml`,
  ]) {
    const content = files.get(path);
    assert.ok(content.includes('.agents/review.md'), path);
    for (const field of [
      'accepted decisions',
      'changed-file summary',
      'validation results',
      'verified prerequisites',
    ])
      assert.ok(content.includes(field), `${path}: ${field}`);
  }
  for (const rule of [
    'full in-scope base/head diff',
    'relevant callers and contracts',
    'Retrieve only missing or stale context',
    'previous base/head SHAs',
    'complete previous report',
    'Expand review when subsequent changes affect additional behavior',
    'including changes introduced by a moved base',
    'missed earlier',
    'exact reviewed base/head pair',
    'otherwise perform a complete initial review',
  ])
    assert.ok(review.includes(rule), rule);
  assert.doesNotMatch(review, /report only defects the fixes introduced/);
});

test('evidence reuse retains complete relevant output and meaningful validation', () => {
  const evidence = rendered.get('.agents/evidence.md');
  for (const rule of [
    'targeted `rg` searches',
    'Read each unchanged file once',
    'A new commit SHA alone does not invalidate',
    'temporary file from `mktemp` outside tracked paths',
    'keeping the file available',
    'A read-only role, such as a code reviewer, never writes that file',
    'reruns the query in narrower bounded pieces',
    'Never let a filter hide a failing exit status',
    'retrieve the missing part',
    'Never act on partial output',
    'never wait for, poll, or rerun remote CI',
  ])
    assert.ok(evidence.includes(rule), rule);
  const files = rendered;
  for (const path of DELIVERY) {
    const build = section(files.get(path), 'Build');
    assert.match(build, /focused tests/);
    assert.match(build, /every required scope-appropriate check/);
    assert.match(build, /rerun affected checks and broaden validation/);
    assert.match(
      build,
      /Meaningful behavioral tests and required checks remain mandatory/,
    );
    const claim = section(files.get(path), 'Claim');
    assert.match(claim, /Reuse current metadata and verified prerequisites/);
    assert.match(claim, /one useful claim comment/);
    assert.match(claim, /Do not add status-only comments or repeat the claim/);
  }
});

test('queue recomputes and main reads only fixed results until a blocker needs a person', () => {
  const files = rendered;
  for (const path of QUEUE) {
    const content = files.get(path);
    for (const rule of [
      'npx agenticool-dispatch queue',
      'refetches',
      'fixed result fields',
      'Do not read source, diffs, or detailed review reports',
      'rerun the script after each result',
      'Ask the person before taking it over',
    ])
      assert.ok(content.includes(rule), `${path}: ${rule}`);
  }
  for (const path of IMPLEMENT) {
    const content = files.get(path);
    const escalation = section(content, 'Later escalation');
    for (const rule of [
      'at most one automatic medium-to-high transition',
      'end the old agent',
      '--effort high',
      'explicit spawn settings',
      'no',
      'two-round',
    ])
      assert.ok(
        (escalation + section(content, 'Settings')).includes(rule),
        `${path}: ${rule}`,
      );
    assert.match(content, /first progress message/);
    assert.match(content, /Implementation effort: medium ->/);
    assert.match(content, /Implementation effort: medium \(default\)/);
    assert.match(content, /reads only the verdict and blocker lines/);
  }
});

test('specification filing runs the spec commands and asks the triager for plan-wide independence groups only', () => {
  const files = rendered;
  for (const path of inBoth('ac-spec-to-issues/SKILL.md')) {
    const skill = files.get(path);
    // The packages own every rule and every body; the skill only runs them.
    assert.match(
      skill,
      /This skill applies no rule and writes no issue body itself/,
      path,
    );
    for (const owned of [
      /`@@issue:/,
      /reserved-text|plan-section|body-size|template-headings/,
      /Render every body|Check the rules/,
      /predicted number|Prediction:/,
      /references\//,
      /\.agents\/spec-slicing\.md/,
    ])
      assert.doesNotMatch(skill, owned, path);
    assert.match(
      skill,
      /`node_modules\/@agenticool\/spec\/spec-slicing\.md`/,
      path,
    );
    const preflight = section(skill, '1. Pre-flight');
    assert.match(preflight, /Run `npx agenticool-spec plan <spec>`\./, path);
    assert.match(preflight, /report its `\[rule\] message` lines/, path);
    const groups = section(skill, '2. Independence groups');
    assert.match(
      groups,
      /^Only the triager forms independence groups, by the definition in `\.agents\/independence-groups\.md`\./m,
      path,
    );
    assert.match(groups, /groups the whole plan at once/, path);
    assert.match(groups, /fewer than two leaves/, path);
    assert.match(
      groups,
      /`npx agenticool-spec plan <spec> --bodies <scratch>\/bodies --json <scratch>\/plan\.json`/,
      path,
    );
    assert.match(groups, /scratch directory outside the repository/, path);
    assert.match(
      groups,
      /`npx agenticool-agents resolve --tool <tool> --role ac-issue-triager`/,
      path,
    );
    assert.match(
      groups,
      /`dependency judgment: plan-wide independence groups only, container ref Plan; metadata comes from the specification`/,
      path,
    );
    assert.match(
      groups,
      /Apply only its `Plan \| GROUPS` line and ignore its `EDGES` line/,
      path,
    );
    assert.match(
      groups,
      /\{ "Plan": \[\["P0\.1", "P1\.2"\], \["P0\.2", "P2\.1"\]\] \}/,
      path,
    );
    const print = section(skill, '3. Print the plan and wait');
    assert.match(
      print,
      /`npx agenticool-spec plan <spec> --state <dir> \[--groups <scratch>\/groups\.json\] \[--assignee <login>\]`/,
      path,
    );
    assert.match(print, /`Plan digest:` line/, path);
    assert.match(print, /waits for the user to confirm/, path);
    const file = section(skill, '4. File');
    assert.match(
      file,
      /After the user confirms, run `npx agenticool-spec confirm <digest> --state <dir>`[^\n]*then `npx agenticool-spec file <spec> --state <dir>`/,
      path,
    );
    const resume = section(skill, 'Resume');
    assert.match(
      resume,
      /`npx agenticool-spec resume <spec> --state <dir>`/,
      path,
    );
    assert.match(resume, /never spawn the triager again/, path);
    // A filing that began stays tied to its state directory, so a changed
    // specification stops for a person instead of re-planning.
    assert.match(
      resume,
      /specification or the plan changed, report its message and stop/,
      path,
    );
    assert.doesNotMatch(resume, /steps 1 to 3/, path);
    assert.ok(section(skill, 'Verify and return'), path);
  }
  assert.match(
    files.get(`.agents/skills/ac-spec-to-issues/SKILL.md`),
    new RegExp(
      `Spawn with \`spawn_agent\`: \`agent_type: ac-issue-triager\`[^\\n]*\`fork_turns: "none"\``,
    ),
  );
  assert.match(
    files.get(`.claude/skills/ac-spec-to-issues/SKILL.md`),
    new RegExp(
      `Spawn with the Agent tool: \`subagent_type: ac-issue-triager\``,
    ),
  );
  // The package docs are the only copy of the format, state, and REST rules.
  assert.deepEqual(
    [...files.keys()]
      .filter((path) => path.includes(`ac-spec-to-issues/`))
      .sort(),
    [
      `.agents/skills/ac-spec-to-issues/SKILL.md`,
      `.agents/skills/ac-spec-to-issues/agents/openai.yaml`,
      `.claude/skills/ac-spec-to-issues/SKILL.md`,
    ],
  );
});

test('implementation is medium while every review dispatch has its own high settings', () => {
  for (const tool of TOOLS) {
    const implementer = resolve(policy, { tool, role: 'ac-implementer' });
    const reviewer = resolve(policy, { tool, role: 'ac-code-reviewer' });
    assert.equal(implementer.effort, 'medium');
    assert.equal(reviewer.effort, 'high');
    assert.equal(
      implementer.model,
      tool === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol',
    );
    assert.equal(reviewer.model, tool === 'claude' ? 'opus' : 'gpt-6.1-sol');
    for (const packet of [implementer, reviewer]) {
      assert.equal(packet.spawn.model, packet.model);
      assert.equal(
        packet.spawn[tool === 'claude' ? 'effort' : 'reasoning_effort'],
        packet.effort,
      );
      if (tool === 'codex') assert.equal(packet.spawn.fork_turns, 'none');
    }
  }
  const files = rendered;
  for (const path of DELIVERY) {
    const review = section(files.get(path), 'Pre-PR review');
    assert.match(review, /--role ac-code-reviewer/);
    if (path.startsWith('.claude'))
      assert.match(review, /`model` and `effort` explicitly/);
    else {
      assert.match(review, /`agent_type`, `model`, and `reasoning_effort`/);
      assert.match(review, /fork_turns: "none"/);
    }
  }
});

test('delivery instructions persist later effort decisions and advance after a released blocker', () => {
  const files = rendered;
  for (const path of IMPLEMENT)
    assert.match(
      section(files.get(path), 'Later escalation'),
      /parent posts exactly one later-escalation.*later:true.*question.*criteria/,
    );
  for (const path of QUEUE) {
    const content = files.get(path);
    assert.match(
      section(content, 'Effort records'),
      /parent posts exactly one new decision comment/,
    );
    assert.match(content, /"later":true/);
    assert.match(
      content,
      /rerun the full ledger rather than blindly using `--next`/,
    );
    assert.match(content, /saved fixed-result file outside tracked paths/);
  }
});

// A consumer has only its policy, its local sources, and the generated and
// synced output, never the shared sources under `.agents/roles/`,
// `.agents/workflows/`, a `.agents/README.md`, or another repository's
// `scripts/`.
test('every consumer path a generated file names exists in the fixture consumer', () => {
  const files = readdirSync(FIXTURE, {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && !entry.parentPath.includes('/.git'))
    .map((entry) =>
      join(entry.parentPath, entry.name).slice(FIXTURE.length + 1),
    );
  const local = ['.agents/local/roles', '.agents/local/workflows'];
  for (const [path, content] of rendered)
    for (const [named] of content.matchAll(
      /(?<![\w./-])(?:\.agents|scripts)\/[\w.*<>/-]*[\w*>]/g,
    )) {
      // `.agents/*.md` and `.agents/skills/<name>` name every match.
      const stem = named.split(/[*<]/)[0];
      const directory = stem.endsWith('/') ? stem : `${stem}/`;
      assert.ok(
        local.some((directory) => named.startsWith(directory)) ||
          files.some((file) => file === stem || file.startsWith(directory)),
        `${path} names ${named}, which the consumer does not have`,
      );
    }
});
