import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkBodies,
  loadIssueForms,
  parse,
  preflight,
  readIssueForm,
  render,
} from '@agenticool/spec-parser';

/** @param {string} path */
const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const conforming = read('fixtures/conforming-spec.md');
const forms = loadIssueForms(mkdtempSync(join(tmpdir(), 'forms-')));
const PREFIX = 'acme-';

/**
 * The conforming fixture with each `[before, after]` pair replaced once.
 * @param {...[string, string]} pairs
 */
const edit = (...pairs) =>
  pairs.reduce((text, [before, after]) => {
    assert.ok(text.includes(before), `fixture lacks ${before}`);
    return text.replace(before, after);
  }, conforming);

/** @param {string} text */
const build = (text) => {
  const plan = parse(text);
  assert.deepEqual(preflight(plan), []);
  return { plan, bodies: render(plan, text, { prefix: PREFIX }) };
};

/** @param {string} body */
const headings = (body) =>
  body
    .split('\n')
    .filter((line) => line.startsWith('### '))
    .map((line) => line.slice(4));

const ONE_PHASE = `# The tiny specification

## 1. Scope

One slice.

## 2. Delivery plan

**Definition of done:** §2.1

### Phase 0: Only

**Goal:** Ship it.

**Exit criteria:** It ships.

**Contracts:** §1, §2.1

| Plan ID | Title | Size | Blocked by | Provides | Acceptance |
| --- | --- | --- | --- | --- | --- |
| P0.1 | Ship | XS | none | The thing | It works |

### 2.1 Definition of done

1. Tests pass.
`;

test('the conforming fixture renders the checked-in bodies', () => {
  const { plan, bodies } = build(conforming);
  const expected = readdirSync(new URL('expected/', import.meta.url));
  assert.deepEqual(
    Object.keys(bodies),
    plan.items.map((item) => item.key),
  );
  assert.deepEqual(
    expected.sort(),
    Object.keys(bodies)
      .map((key) => `${key}.md`)
      .sort(),
  );
  for (const [key, body] of Object.entries(bodies))
    assert.equal(`${body}\n`, read(`test/expected/${key}.md`), key);
  assert.deepEqual(checkBodies(plan, bodies, { forms, prefix: PREFIX }), []);
});

test('no rendered body names the specification path or links to it', () => {
  for (const body of Object.values(build(conforming).bodies)) {
    assert.doesNotMatch(body, /conforming-spec|fixtures\//);
    assert.doesNotMatch(body, /:\/\/|\]\(/);
  }
});

test('every issue reference is a placeholder for a plan item', () => {
  const { plan, bodies } = build(conforming);
  const keys = new Set(plan.items.map((item) => item.key));
  for (const body of Object.values(bodies)) {
    assert.doesNotMatch(body, /#\d/);
    for (const [, key] of body.matchAll(/@@issue:([^@]+)@@/g))
      assert.ok(keys.has(key), key);
  }
});

test('references are rewritten outside code, and the own Plan ID stays bare', () => {
  const { bodies } = build(
    edit(
      [
        '- **Notes:** Keep the index in memory; P2.1 rebuilds it after a pull.',
        '- **Notes:** Keep `§6` and `P0.1` as written, after spec 3 P0.1 and §6.1 (#5); P1.2 is this slice.',
      ],
      [
        'renamed into place, so a crash never leaves half a note.',
        'renamed into place, so a crash never leaves half a note.\n\n```text\n§5 and P0.1 stay\n```',
      ],
    ),
  );
  assert.match(
    bodies['P1.2'],
    /^Keep `§6` and `P0\.1` as written, after spec 3 P0\.1 and §6\.1 \(#5\); P1\.2 is this slice\.$/m,
  );
  assert.match(bodies['Phase 1'], /^```text\n§5 and P0\.1 stay\n```$/m);
  assert.match(bodies['P1.2'], /^Plan ID: P1\.2\. /m);
});

test('a carried section leaves out subsections another item claims and shifts headings, capped at six', () => {
  const { bodies } = build(
    edit(
      ['- **Spec:** §6.1\n', '- **Spec:** §6.1\n- **Owns:** §6.1\n'],
      ['**Contracts:** §1, §2,', '**Contracts:** §1, §1.2, §2,'],
      [
        'No rich text, no sharing, and no server-side search.',
        'No rich text, no sharing, and no server-side search.\n\n#### 1.2.1 Detail\n\nMore.\n\n##### 1.2.1.1 Deeper\n\nMost.',
      ],
    ),
  );
  assert.doesNotMatch(bodies['Phase 1'], /6\.1 Write path/);
  assert.match(bodies['Phase 1'], /^##### 6\.2 Read path$/m);
  assert.match(
    bodies['P1.1a'],
    /Contracts: §6\.1\n\nOwned contracts:\n\n##### 6\.1 Write path\n/,
  );
  assert.equal(bodies['Phase 0'].match(/1\.2 Non-goals/g)?.length, 1);
  assert.match(bodies['Phase 0'], /^###### 1\.2\.1 Detail$/m);
  assert.match(bodies['Phase 0'], /^###### 1\.2\.1\.1 Deeper$/m);
});

test('definition-of-done items keep their continuation lines', () => {
  const { bodies } = build(
    edit([
      '- `npm run build` and `npm test` pass, with no network access in tests.',
      '- `npm run build` and `npm test` pass,\n  with no network access in tests.',
    ]),
  );
  assert.match(
    bodies['P0.1'],
    /### Validation\n- `npm run build` and `npm test` pass,\n {2}with no network access in tests\.\n- Public/,
  );
});

test('the root and epics phrase deferred phases and titles starting with The', () => {
  const { bodies } = build(
    edit(
      ['# Notes service specification', '# The notes service specification'],
      [
        '**Contracts:** §6\n',
        '**Contracts:** §6\n\n**Deferred until:** P0.3\n',
      ],
      ['**Deferred until:** P1.2', '**Deferred until:** P1.2, P1.3'],
    ),
  );
  assert.match(bodies.Plan, /^The notes service delivery plan: the 3 phase/m);
  assert.match(
    bodies.Plan,
    /^3\. P2 Sync backlog: @@issue:Phase 2@@, deferred; blocked by P1\.2 \(@@issue:P1\.2@@\), P1\.3 \(@@issue:P1\.3@@\)$/m,
  );
  assert.match(bodies.Plan, /of their own apart from the deferred ones, and/);
  assert.match(
    bodies['Phase 2'],
    /^Deferred: filed now and blocked until P1\.2 \(@@issue:P1\.2@@\), P1\.3 \(@@issue:P1\.3@@\) close\.$/m,
  );
});

test('a plan with one phase and no deferred work, and a leaf with only required fields', () => {
  const { plan, bodies } = build(ONE_PHASE);
  assert.match(
    bodies.Plan,
    /^The tiny delivery plan: the 1 phase epic listed/m,
  );
  assert.match(bodies.Plan, /of their own, and this issue adds none/);
  assert.match(bodies.Plan, /on the slices, 0 of them,/);
  assert.deepEqual(headings(bodies['P0.1']), [
    'Parent epic',
    'Outcome',
    'Acceptance criteria',
    'Validation',
    'Dependencies',
  ]);
  assert.match(
    bodies['P0.1'],
    /### Validation\n- Tests pass\.\n- Definition of done: §2\.1 \(@@issue:Phase 0@@\)\.\n\n### Dependencies\nNone$/,
  );
  assert.match(
    bodies['Phase 0'],
    /Definition of done for every slice: §2\.1\./,
  );
  assert.deepEqual(checkBodies(plan, bodies, { forms }), []);
});

test('cross-spec prerequisites appear in Dependencies as text, without a link', () => {
  const { bodies } = build(
    edit([
      '- **Cross-spec prerequisites:** none',
      '- **Cross-spec prerequisites:** spec 4 P1.1, spec 2.3 P5.2',
    ]),
  );
  assert.match(
    bodies['P0.1'],
    /### Dependencies\nCross-spec prerequisites: spec 4 P1\.1, spec 2\.3 P5\.2$/,
  );
  assert.match(
    bodies['P0.3'],
    /### Dependencies\nBlocked by: P0\.2 \(@@issue:P0\.2@@\)\n\nCross-spec prerequisites: spec 2 P0\.4$/,
  );
});

test('body-size counts placeholders filled as seven-digit numbers', () => {
  const { plan, bodies } = build(conforming);
  const sized = (/** @type {number} */ length) =>
    checkBodies(
      plan,
      { ...bodies, 'P0.1': `@@issue:Plan@@${'a'.repeat(length - 8)}` },
      { forms },
    ).filter((v) => v.startsWith('[body-size]'));
  assert.deepEqual(sized(65_535), []);
  assert.deepEqual(sized(65_536), [
    '[body-size] P0.1: the body is 65536 characters with placeholders filled; it must stay under 65536.',
  ]);
});

test('body-size checks the root body with the largest plan-wide independence record', () => {
  const { plan, bodies } = build(conforming);
  // The root's record can name all nine leaves of the plan.
  const record = `\n\n### Independence groups\n\n<!-- acme-independence-groups -->\n${Array.from(
    { length: 9 },
    (_, index) => `- g${index + 1}: #9999999\n`,
  ).join('')}<!-- /acme-independence-groups -->`;
  const sized = (/** @type {number} */ length) =>
    checkBodies(
      plan,
      { ...bodies, Plan: 'a'.repeat(length - record.length) },
      { forms, prefix: PREFIX },
    ).filter((v) => v.startsWith('[body-size]'));
  assert.deepEqual(sized(65_535), []);
  assert.deepEqual(sized(65_536), [
    '[body-size] Plan: the body is 65536 characters with placeholders filled and the largest independence record; it must stay under 65536.',
  ]);
  // A plan with one leaf gets no root record.
  const tiny = build(ONE_PHASE);
  assert.deepEqual(
    checkBodies(
      tiny.plan,
      { ...tiny.bodies, Plan: 'a'.repeat(70_000) },
      { forms },
    ),
    [
      '[body-size] Plan: the body is 70000 characters with placeholders filled; it must stay under 65536.',
    ],
  );
});

test('body-size counts the largest independence record of an epic with two or more leaves', () => {
  const { plan, bodies } = build(conforming);
  const record =
    '\n\n### Independence groups\n\n<!-- acme-independence-groups -->\n- g1: #9999999\n- g2: #9999999\n- g3: #9999999\n<!-- /acme-independence-groups -->';
  const sized = (/** @type {number} */ length) =>
    checkBodies(
      plan,
      { ...bodies, 'Phase 0': 'a'.repeat(length - record.length) },
      { forms, prefix: PREFIX },
    ).filter((v) => v.startsWith('[body-size]'));
  assert.deepEqual(sized(65_535), []);
  assert.deepEqual(sized(65_536), [
    '[body-size] Phase 0: the body is 65536 characters with placeholders filled and the largest independence record; it must stay under 65536.',
  ]);
  // An epic with one direct leaf gets no record.
  const tiny = build(ONE_PHASE);
  assert.deepEqual(
    checkBodies(
      tiny.plan,
      { ...tiny.bodies, 'Phase 0': `### What\n${'a'.repeat(65_520)}` },
      { forms },
    ).filter((v) => v.startsWith('[body-size]')),
    [],
  );
});

test('a body over the limit fails the plan through an owned section', () => {
  const text = edit([
    '`NoteId` is a validated branded string.',
    `\`NoteId\` is a validated branded string. ${'x'.repeat(70_000)}`,
  ]);
  const { plan, bodies } = build(text);
  const violations = checkBodies(plan, bodies, { forms });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^\[body-size\] P0\.2: the body is \d+ /);
});

test('template-headings compares ### headings outside fenced code with the form', () => {
  const { plan, bodies } = build(conforming);
  /**
   * @param {string} key
   * @param {string} body
   */
  const check = (key, body) =>
    checkBodies(plan, { ...bodies, [key]: body }, { forms });
  const leaf = bodies['P0.1'];
  assert.deepEqual(check('P0.1', `${leaf}\n\n### Extra\nText`), [
    '[template-headings] P0.1: "Extra" is not a form label, or is out of order in task.yml.',
  ]);
  assert.deepEqual(check('P0.1', leaf.replace('### Outcome', '### Result')), [
    '[template-headings] P0.1: "Result" comes where the required "Outcome" belongs in task.yml.',
  ]);
  assert.deepEqual(check('P0.1', leaf.replace(/### Validation[\s\S]*$/, '')), [
    '[template-headings] P0.1: the required "Validation" is missing in task.yml.',
  ]);
  assert.deepEqual(check('P0.1', `${leaf}\n\n\`\`\`\n### Extra\n\`\`\``), []);
  const epic = bodies['Phase 0'];
  assert.deepEqual(
    check('Phase 0', `${epic}\n\n### Independence groups\n- g1: #1`),
    [],
  );
  assert.deepEqual(
    check(
      'Phase 0',
      epic.replace('### Parent issue', '### Contracts\nx\n\n### Parent issue'),
    ),
    [
      '[template-headings] Phase 0: "Contracts" is not a form label, or is out of order in epic.yml.',
    ],
  );
  assert.deepEqual(
    check('Plan', `${bodies.Plan}\n\n### Independence groups\n- g1: #1`),
    [],
  );
  assert.deepEqual(
    check(
      'Stack P1.1',
      `${bodies['Stack P1.1']}\n\n### Independence groups\n- g1: #1`,
    ),
    [
      '[template-headings] Stack P1.1: "Independence groups" is not a form label, or is out of order in container.yml.',
    ],
  );
  assert.deepEqual(check('Plan', `${bodies.Plan}\n\n### Contracts\nx`), [
    '[template-headings] Plan: "Contracts" is not a form label, or is out of order in container.yml.',
  ]);
});

test('issue forms come from the repository, else from the shipped defaults', () => {
  const base = mkdtempSync(join(tmpdir(), 'forms-'));
  mkdirSync(join(base, '.github/ISSUE_TEMPLATE'), { recursive: true });
  writeFileSync(
    join(base, '.github/ISSUE_TEMPLATE/task.yml'),
    [
      'name: Task',
      'body:',
      '  - type: markdown',
      '    attributes:',
      '      value: |',
      '        label: not a field',
      '  - id: summary',
      '    type: textarea',
      '    attributes:',
      '      label: "Summary"',
      '    validations:',
      '      required: true',
      '  - type: input',
      '    attributes:',
      "      label: 'Owner''s note'",
      'labels:',
      '  - type: ignored',
    ].join('\n'),
  );
  const own = loadIssueForms(base);
  assert.deepEqual(own.task, [
    { label: 'Summary', id: 'summary', required: true },
    { label: "Owner's note", id: null, required: false },
  ]);
  assert.deepEqual(own.epic, forms.epic);
  assert.deepEqual(
    forms.container.map((f) => [f.label, f.id, f.required]),
    [
      ['What', 'what', true],
      ['Why', 'why', true],
      ['How', 'how', true],
      ['Parent issue', 'parent', false],
      ['Milestone', 'milestone', false],
    ],
  );
  const { plan, bodies } = build(conforming);
  assert.match(
    checkBodies(plan, bodies, { forms: own })[0],
    /^\[template-headings\] P0\.1: "Parent epic" comes where the required "Summary" belongs in task\.yml\.$/,
  );
  assert.deepEqual(readIssueForm('name: Empty\n'), []);
});
