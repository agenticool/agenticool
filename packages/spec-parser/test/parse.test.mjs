import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  expandBraces,
  filesMatch,
  parse,
  preflight,
  printTree,
  resolveOwner,
  RULES,
} from '@agenticool/spec-parser';

/** @param {string} path */
const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const conforming = read('fixtures/conforming-spec.md');
const violating = read('fixtures/violating-spec.md');
const LABELS = [
  'enhancement',
  'epic',
  'severity: none',
  'area: repository',
  'risk: data-contract',
  'risk: security',
];

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
const check = (text) => preflight(parse(text), { labels: LABELS });

test('the conforming fixture parses into the whole plan', () => {
  const plan = parse(conforming);
  assert.equal(plan.title, 'Notes service specification');
  assert.equal(plan.name, 'Notes service');
  assert.deepEqual(
    {
      number: plan.plan?.number,
      definitionOfDone: plan.plan?.definitionOfDone,
      classCatalog: plan.plan?.classCatalog,
    },
    { number: '9', definitionOfDone: '9.1', classCatalog: '7' },
  );
  assert.deepEqual(
    plan.phases.map((p) => [p.id, p.title, p.deferred, p.deferredUntil]),
    [
      ['0', 'Foundation', false, []],
      ['1', 'Storage', false, []],
      ['2', 'Sync backlog', true, ['P1.2']],
    ],
  );
  assert.deepEqual(plan.phases[0].contracts, ['1', '2', '7', '9.1', '9.2']);
  assert.equal(
    plan.phases[0].fields.Goal.value,
    'A buildable package with validated domain types and configuration.',
  );
  assert.deepEqual(
    plan.slices.map((s) => [s.planId, s.size, s.phase, s.source]),
    [
      ['P0.1', 'S', '0', 'heading'],
      ['P0.2', 'M', '0', 'heading'],
      ['P0.3', 'S', '0', 'heading'],
      ['P1.1a', 'S', '1', 'heading'],
      ['P1.1b', 'S', '1', 'heading'],
      ['P1.2', 'M', '1', 'heading'],
      ['P1.3', 'XS', '1', 'heading'],
      ['P2.1', 'M', '2', 'table'],
      ['P2.2', 'S', '2', 'table'],
    ],
  );
  const [scaffold, types] = plan.slices;
  assert.deepEqual(scaffold.blockedBy, []);
  assert.deepEqual(scaffold.spec, ['3']);
  assert.deepEqual(scaffold.owns, ['3']);
  assert.deepEqual(scaffold.labels, [
    'enhancement',
    'severity: none',
    'area: repository',
  ]);
  assert.deepEqual(scaffold.acceptance, [
    '`npm run build` and `npm test` pass on an empty source tree.',
    'The directories in §3 exist.',
  ]);
  assert.deepEqual(types.files, ['src/domain/{ids,note}.ts']);
  assert.deepEqual(types.paths, ['src/domain/ids.ts', 'src/domain/note.ts']);
  const index = plan.slices[5];
  assert.equal(
    index.fields.Notes.value,
    'Keep the index in memory; P2.1 rebuilds it after a pull.',
  );
  assert.deepEqual(index.validation, [
    'A benchmark with 10,000 notes answers a search in under 50 ms.',
  ]);
  const sync = plan.slices[7];
  assert.deepEqual(sync.acceptance, [
    'Two devices converge after a push and a pull',
    'No note is lost when the network drops mid-push',
  ]);
  assert.deepEqual(sync.blockedBy, ['P1.2']);
  assert.equal(sync.priority, 'P3');
  assert.deepEqual(plan.stacks, [
    {
      key: 'Stack P1.1',
      title: 'Note store',
      stem: 'P1.1',
      layers: ['P1.1a', 'P1.1b'],
    },
  ]);
  assert.deepEqual(preflight(plan, { labels: LABELS }), []);
});

test('items are numbered in creation order and keyed as the skill keys them', () => {
  const { items } = parse(conforming);
  assert.deepEqual(
    items.map((i) => [i.number, i.key, i.kind, i.parent]),
    [
      [1, 'Plan', 'container', null],
      [2, 'Phase 0', 'epic', 'Plan'],
      [3, 'Phase 1', 'epic', 'Plan'],
      [4, 'Phase 2', 'epic', 'Plan'],
      [5, 'Stack P1.1', 'container', 'Phase 1'],
      [6, 'P0.1', 'leaf', 'Phase 0'],
      [7, 'P0.2', 'leaf', 'Phase 0'],
      [8, 'P0.3', 'leaf', 'Phase 0'],
      [9, 'P1.1a', 'leaf', 'Stack P1.1'],
      [10, 'P1.1b', 'leaf', 'Stack P1.1'],
      [11, 'P1.2', 'leaf', 'Phase 1'],
      [12, 'P1.3', 'leaf', 'Phase 1'],
      [13, 'P2.1', 'leaf', 'Phase 2'],
      [14, 'P2.2', 'leaf', 'Phase 2'],
    ],
  );
  const [root, , , backlog, stack] = items;
  assert.deepEqual(
    [root.title, root.priority, root.size, root.labels],
    [
      'Notes service delivery plan',
      'P2',
      'L',
      ['enhancement', 'severity: none'],
    ],
  );
  assert.deepEqual(
    [backlog.priority, backlog.blockedBy, backlog.labels],
    ['P3', ['P1.2'], ['epic', 'severity: none']],
  );
  assert.deepEqual(
    [stack.title, stack.priority, stack.labels],
    ['Note store', 'P2', ['enhancement', 'severity: none']],
  );
});

test('a stack container takes the highest priority of its layers and the first layer severity', () => {
  const { items } = parse(
    edit(
      [
        '- **Stack:** Note store\n',
        '- **Stack:** Note store\n- **Severity:** high\n',
      ],
      [
        '- **Blocked by:** P1.1a\n',
        '- **Blocked by:** P1.1a\n- **Priority:** P1\n',
      ],
    ),
  );
  const stack = items.find((i) => i.key === 'Stack P1.1');
  assert.deepEqual(
    [stack?.priority, stack?.labels],
    ['P1', ['enhancement', 'severity: high']],
  );
  const root = parse(
    conforming
      .replace(
        '### Phase 0: Foundation',
        '### Phase 0: Foundation\n\n**Deferred until:** P2.1',
      )
      .replace(
        '**Contracts:** §6\n',
        '**Contracts:** §6\n\n**Deferred until:** P2.1\n',
      ),
  ).items[0];
  assert.equal(root.priority, 'P3');
});

test('every numbered section maps to its owner, and references resolve to the nearest owned ancestor', () => {
  const plan = parse(conforming);
  assert.deepEqual(plan.owners, {
    1: 'Phase 0',
    1.1: 'Phase 0',
    1.2: 'Phase 0',
    2: 'Phase 0',
    3: 'P0.1',
    4: 'P0.2',
    4.1: 'P0.2',
    5: 'P0.3',
    6: 'Phase 1',
    6.1: 'Phase 1',
    6.2: 'Phase 1',
    7: 'Phase 0',
    8: 'Phase 2',
    9: null,
    9.1: 'Phase 0',
    9.2: 'Phase 0',
  });
  const claims = [
    { section: '4', owner: 'Phase 0', field: 'Contracts' },
    { section: '4.1', owner: 'P0.2', field: 'Owns' },
  ];
  assert.equal(resolveOwner(claims, '4.1.3'), 'P0.2');
  assert.equal(resolveOwner(claims, '4.2'), 'Phase 0');
  assert.equal(resolveOwner(claims, '5'), null);
  const reference = plan.references.find(
    (r) => r.section === '4.1' && r.where === 'P1.1b',
  );
  assert.ok(reference);
  assert.equal(resolveOwner(plan.claims, reference.section), 'P0.2');
});

test('class catalog rows go to the leaves whose Files name their file', () => {
  const { slices } = parse(conforming);
  const rows = Object.fromEntries(
    slices.map((s) => [s.planId, s.catalog.flatMap((t) => t.rows)]),
  );
  assert.equal(rows['P0.2'].length, 2);
  assert.match(rows['P0.2'][0], /`NoteId` \(`domain\/ids.ts`\)/);
  assert.match(rows['P0.2'][1], /`Note` \(`domain\/note.ts`\)/);
  assert.equal(rows['P0.1'].length, 0);
  assert.equal(rows['P2.2'].length, 0);
  assert.match(rows['P2.1'][0], /SyncClient/);
  const [table] = slices[1].catalog;
  assert.equal(table.header, '| Class (`file`) | Public methods | Purpose |');
  assert.equal(table.separator, '| --- | --- | --- |');
  const directory = parse(
    edit([
      '- **Files:** `src/storage/index.ts`',
      '- **Files:** `src/storage/`',
    ]),
  ).slices[5];
  assert.deepEqual(
    directory.catalog[0].rows.map((row) => /`(\w+)`/.exec(row)?.[1]),
    ['NoteWriter', 'NoteReader', 'NoteIndex'],
  );
});

test('catalog tables are read in catalog order, each with its own header', () => {
  const plan = parse(
    edit([
      '| `SyncClient` (`sync/client.ts`) | `push()`, `pull()` | Device sync (§8). |\n',
      '| `SyncClient` (`sync/client.ts`) | `push()`, `pull()` | Device sync (§8). |\n\n| Function (`file`) | Purpose |\n| --- | --- |\n| `merge` (`sync/client.ts`) | Merges copies. |\n| no file | Unmatched. |\n',
    ]),
  );
  const client = plan.slices[7];
  assert.deepEqual(
    client.catalog.map((t) => [t.header, t.rows.length]),
    [
      ['| Class (`file`) | Public methods | Purpose |', 1],
      ['| Function (`file`) | Purpose |', 1],
    ],
  );
});

test('braces expand and catalog paths match whole segments', () => {
  assert.deepEqual(expandBraces('src/{a,b}/{x,y}.ts'), [
    'src/a/x.ts',
    'src/a/y.ts',
    'src/b/x.ts',
    'src/b/y.ts',
  ]);
  assert.deepEqual(expandBraces('src/a.ts'), ['src/a.ts']);
  assert.ok(filesMatch('src/shared/identifiers.ts', 'shared/identifiers.ts'));
  assert.ok(filesMatch('shared/identifiers.ts', 'shared/identifiers.ts'));
  assert.ok(
    !filesMatch('src/myshared/identifiers.ts', 'shared/identifiers.ts'),
  );
  assert.ok(filesMatch('src/shared/', 'shared/identifiers.ts'));
  assert.ok(filesMatch('shared/', 'shared/identifiers.ts'));
  assert.ok(!filesMatch('src/', 'shared/identifiers.ts'));
  assert.ok(!filesMatch('src/other/', 'shared/identifiers.ts'));
});

test('a cross-spec prerequisite is kept as text and is never a local blocker or Plan ID reference', () => {
  const plan = parse(conforming);
  const loader = plan.slices[2];
  assert.deepEqual(loader.crossSpec, ['spec 2 P0.4']);
  assert.deepEqual(loader.blockedBy, ['P0.2']);
  assert.deepEqual(plan.slices[0].crossSpec, []);
  assert.ok(!plan.mentions.some((m) => m.planId === 'P0.4'));
  const many = parse(
    edit([
      '- **Cross-spec prerequisites:** spec 2 P0.4',
      '- **Cross-spec prerequisites:** spec 2 P0.4, spec 3.1 P8A.2b',
    ]),
  );
  assert.deepEqual(many.slices[2].crossSpec, [
    'spec 2 P0.4',
    'spec 3.1 P8A.2b',
  ]);
  assert.deepEqual(preflight(many, { labels: LABELS }), []);
});

test('Files `none` marks a slice that changes no source files and matches no catalog row', () => {
  const record = parse(conforming).slices[6];
  assert.equal(record.planId, 'P1.3');
  assert.deepEqual(record.files, ['none']);
  assert.deepEqual(record.paths, []);
  assert.deepEqual(record.catalog, []);
  const table = parse(edit(['| `src/sync/conflicts.ts` |', '| `none` |']))
    .slices[8];
  assert.deepEqual([table.files, table.paths], [['none'], []]);
});

test('headings, references, and Plan IDs inside fenced code or code spans are ignored', () => {
  const plan = parse(
    edit(
      [
        '## 8. Sync',
        '```markdown\n# Not the title\n## 99. Fenced\n```\n\n~~~\n```\n§98 and P9.9\n~~~\n\n## 8. Sync',
      ],
      [
        'Conflicts keep both copies',
        'Conflicts (`§97`, `P9.8`) keep both copies',
      ],
    ),
  );
  assert.equal(plan.title, 'Notes service specification');
  assert.ok(!plan.sections.some((s) => s.number === '99'));
  assert.ok(!plan.references.some((r) => ['97', '98'].includes(r.section)));
  assert.ok(!plan.mentions.some((m) => m.planId.startsWith('P9.')));
  assert.deepEqual(preflight(plan, { labels: LABELS }), []);
});

test('Windows line endings, letter-suffixed phase ids, and multi-line paragraphs parse', () => {
  const plan = parse(
    edit(
      ['### Phase 1: Storage', '### Phase 1A: Storage'],
      [
        '**Goal:** Notes persist locally and can be found by title.',
        '**Goal:** Notes persist locally\nand can be found by title.',
      ],
    ).replaceAll('\n', '\r\n'),
  );
  assert.equal(plan.phases[1].id, '1A');
  assert.equal(
    plan.phases[1].fields.Goal.value,
    'Notes persist locally and can be found by title.',
  );
  assert.equal(plan.items[2].key, 'Phase 1A');
  assert.deepEqual(preflight(plan, { labels: LABELS }), []);
});

test('nested lines continue the field or item above them', () => {
  const plan = parse(
    edit(
      [
        '  - A write interrupted before the rename leaves the previous note intact.',
        '  - A write interrupted before the rename\n    leaves the previous note intact.\n\n    ```text\n    - kept\n    ```',
      ],
      [
        '- **Provides:** Validated note reads on top of the write path',
        '- **Provides:** Validated note reads\n  on top of the write path',
      ],
    ),
  );
  const [write, read] = [plan.slices[3], plan.slices[4]];
  assert.equal(write.acceptance.length, 1);
  assert.match(
    write.acceptance[0],
    /rename\n {4}leaves.*\n\n?.*```text\n {4}- kept/s,
  );
  assert.equal(
    read.fields.Provides.value,
    'Validated note reads\n  on top of the write path',
  );
});

test('the violating fixture fails on its rule', () => {
  assert.deepEqual(check(violating), [
    '[acyclic] Blocked-by cycle: P0.1 -> P0.2 -> P0.1.',
  ]);
});

test('the rules run in the order of the guide rule table, without the rendered-body rules', () => {
  const table = [
    ...read('spec-slicing.md').matchAll(/^\| `([a-z-]+)` \| /gm),
  ].map((m) => m[1]);
  assert.deepEqual(
    RULES,
    table.filter((rule) => !['body-size', 'template-headings'].includes(rule)),
  );
  assert.deepEqual(table.slice(-2), ['body-size', 'template-headings']);
});

test('label-exists runs only with a label catalog', () => {
  const plan = parse(conforming);
  assert.deepEqual(preflight(plan), []);
  assert.deepEqual(
    preflight(plan, {
      labels: LABELS.filter((l) => l !== 'severity: none'),
      labelSource: 'the catalog',
    }),
    [
      '[label-exists] Plan, Phase 0, Phase 1, Phase 2, Stack P1.1, P0.1, P0.2, P0.3, P1.1a, P1.1b, P1.2, P1.3, P2.1, P2.2: label "severity: none" is missing from the catalog.',
    ],
  );
});

/**
 * One failing case per rule: [rule, specification, expected violations].
 * @type {[string, string, string[]][]}
 */
const failures = [
  [
    'reserved-text',
    edit(['One user, one device', 'One user (@@issue:Plan@@), one device']),
    [
      "[reserved-text] Line 11 contains `@@issue:`, the skill's issue-number placeholder.",
    ],
  ],
  [
    'plan-section',
    edit(['# Notes service specification\n', '']),
    [
      '[plan-section] The specification has no `# ` title heading outside fenced code.',
    ],
  ],
  [
    'plan-section',
    edit(['# Notes service specification', '# Specification']),
    [
      '[plan-section] The title "Specification" is empty after the trailing word "specification" is removed.',
    ],
  ],
  [
    'plan-section',
    edit(['## 9. Delivery plan', '## 9. Plan']),
    ['[plan-section] The specification has no `Delivery plan` section.'],
  ],
  [
    'plan-section',
    edit(['## 8. Sync', '## 8. Delivery plan']),
    [
      '[plan-section] The specification has 2 `Delivery plan` sections: §8, §9.',
    ],
  ],
  [
    'plan-section',
    edit(['**Definition of done:** §9.1\n', '']),
    [
      '[plan-section] Delivery plan: the required **Definition of done:** field is missing.',
    ],
  ],
  [
    'plan-section',
    edit(['**Definition of done:** §9.1', '**Definition of done:** §9.7']),
    [
      '[plan-section] Delivery plan: Definition of done names §9.7, which does not exist.',
    ],
  ],
  [
    'plan-section',
    edit(['**Class catalog:** §7', '**Class catalog:** the class table']),
    [
      '[plan-section] Delivery plan: Class catalog names no section; write one reference such as §9.1.',
    ],
  ],
  [
    'phase-format',
    edit(['### Phase 1: Storage', '### Phase one']),
    [
      '[phase-format] Phase heading "### Phase one" is malformed; expected "### Phase <id>: <title>".',
    ],
  ],
  [
    'phase-format',
    edit(['### Phase 1: Storage', '### Phase 0: Storage']),
    ['[phase-format] Phase 0 repeats.'],
  ],
  [
    'phase-format',
    edit(['**Goal:** Notes persist locally and can be found by title.\n', '']),
    ['[phase-format] Phase 1 has no Goal.'],
  ],
  [
    'phase-format',
    edit(['**Exit criteria:** Notes written', 'Notes written']),
    ['[phase-format] Phase 1 has no Exit criteria.'],
  ],
  [
    'slice-format',
    edit(['#### P0.2 Domain types · M', '#### P0.2 Domain types (M)']),
    [
      '[slice-format] Phase 0: slice heading "#### P0.2 Domain types (M)" is malformed; expected "#### <Plan ID> <title> · <size>".',
    ],
  ],
  [
    'slice-format',
    edit(['#### P0.2 Domain types · M', '#### P0.2 Domain types · L']),
    ['[slice-format] P0.2: size "L" is not XS, S, or M.'],
  ],
  [
    'slice-format',
    edit(['- **Spec:** §4, §1.1\n', '']),
    ['[slice-format] P0.2: required field Spec is missing.'],
  ],
  [
    'slice-format',
    edit(['- **Risk:** data-contract', '- **Labels:** data-contract']),
    ['[slice-format] P0.2: field "Labels" is unknown.'],
  ],
  [
    'slice-format',
    edit([
      '- **Risk:** data-contract',
      '- **Risk:** data-contract\n- **Risk:** security',
    ]),
    ['[slice-format] P0.2: field "Risk" repeats.'],
  ],
  [
    'slice-format',
    edit(['- **Risk:** data-contract', 'Risk: data-contract']),
    [
      '[slice-format] P0.2: line 105 is not a field item: "Risk: data-contract".',
    ],
  ],
  [
    'slice-format',
    edit([
      '- **Acceptance:**\n  - A write interrupted',
      '- **Acceptance:** A write interrupted',
    ]),
    ['[slice-format] P1.1a: Acceptance items must be nested list items.'],
  ],
  [
    'slice-format',
    edit([
      '- **Files:** `src/config/loader.ts`',
      '- **Files:**\n  - `src/config/loader.ts`',
    ]),
    ['[slice-format] P0.3: Files takes a one-line value.'],
  ],
  [
    'slice-format',
    edit([
      '- **Files:** `src/config/loader.ts`',
      '- **Files:** src/config/loader.ts',
    ]),
    [
      '[slice-format] P0.3: Files must be comma-separated code spans, or `none` alone.',
    ],
  ],
  [
    'slice-format',
    edit(['- **Files:** `none`', '- **Files:** `none`, `bench/results.md`']),
    ['[slice-format] P1.3: Files lists `none` together with paths.'],
  ],
  [
    'slice-format',
    edit([
      '- **Risk:** security',
      '- **Risk:** security\n- **Priority:** high',
    ]),
    ['[slice-format] P0.3: Priority "high" is not P0, P1, P2, or P3.'],
  ],
  [
    'slice-format',
    edit([
      '- **Risk:** security',
      '- **Risk:** security\n- **Severity:** major',
    ]),
    [
      '[slice-format] P0.3: Severity "major" is not critical, high, medium, low, none.',
    ],
  ],
  [
    'slice-format',
    edit(['| Acceptance | Files |', '| Acceptance | Path |']),
    ['[slice-format] Phase 2: table column "Path" is unknown.'],
  ],
  [
    'slice-format',
    edit(
      ['| Plan ID | Title | Size |', '| Plan ID | Title |'],
      [
        '| --- | --- | --- | --- | --- | --- | --- |',
        '| --- | --- | --- | --- | --- | --- |',
      ],
    ),
    ['[slice-format] Phase 2: the slice table has no "Size" column.'],
  ],
  [
    'slice-format',
    edit(['| P2.2 | Conflict report |', '| 2.2 | Conflict report |']),
    [
      '[slice-format] Phase 2: table row on line 185 has the malformed Plan ID "2.2".',
    ],
  ],
  [
    'slice-format',
    edit([
      '  - A benchmark with 10,000 notes answers a search in under 50 ms.\n',
      '  - A benchmark with 10,000 notes answers a search in under 50 ms.\n\n##### Notes\n',
    ]),
    [
      '[slice-format] Phase 1: heading "##### Notes" is deeper than a slice heading.',
    ],
  ],
  [
    'cross-spec-prerequisites',
    edit([
      '- **Cross-spec prerequisites:** spec 2 P0.4',
      '- **Cross-spec prerequisites:** spec 2 P0.4, #12',
    ]),
    [
      '[cross-spec-prerequisites] P0.3: Cross-spec prerequisites must be none or comma-separated "spec <n> <Plan ID>" entries; got "#12".',
    ],
  ],
  [
    'cross-spec-prerequisites',
    edit([
      '- **Blocked by:** P0.2\n- **Cross',
      '- **Blocked by:** P0.2, spec 2 P0.4\n- **Cross',
    ]),
    [
      '[cross-spec-prerequisites] P0.3: Blocked by names "spec 2 P0.4", a slice of another specification; move it to Cross-spec prerequisites.',
    ],
  ],
  [
    'slice-unique',
    edit(['#### P0.3 Configuration loader', '#### P0.2 Configuration loader']),
    ['[slice-unique] P0.2 appears in 2 slices, on lines 98, 110.'],
  ],
  [
    'title-unique',
    edit(['#### P1.2 Note index', '#### P1.2 Note store']),
    ['[title-unique] "Note store" is the title of Stack P1.1, P1.2.'],
  ],
  [
    'blocked-by-resolves',
    edit(['- **Blocked by:** P0.1\n', '- **Blocked by:** P0.1, P0.2, P9.9\n']),
    [
      '[blocked-by-resolves] P0.2: the slice blocks itself.',
      '[blocked-by-resolves] P0.2: Blocked by names "P9.9", which is no slice.',
    ],
  ],
  [
    'blocked-by-resolves',
    edit(['**Deferred until:** P1.2', '**Deferred until:** P1.2, P1.9']),
    [
      '[blocked-by-resolves] Phase 2: Deferred until names "P1.9", which is no slice.',
    ],
  ],
  ['acyclic', violating, ['[acyclic] Blocked-by cycle: P0.1 -> P0.2 -> P0.1.']],
  [
    'acyclic',
    edit(
      [
        '- **Blocked by:** none\n- **Cross',
        '- **Blocked by:** P1.2\n- **Cross',
      ],
      [
        '| P2.1 | Sync client | M | P1.2 |',
        '| P2.1 | Sync client | M | P2.2 |',
      ],
    ),
    [
      '[acyclic] Blocked-by cycle: P0.1 -> P1.2 -> P1.1b -> P1.1a -> P0.2 -> P0.1.',
      '[acyclic] Blocked-by cycle: P2.1 -> P2.2 -> P2.1.',
    ],
  ],
  [
    'stack-shape',
    edit([
      '- **Provides:** Validated note reads on top of the write path\n- **Stack:** Note store\n',
      '- **Provides:** Validated note reads on top of the write path\n',
    ]),
    [
      '[stack-shape] Stack "Note store" has one layer, P1.1a; a stack needs two or more.',
    ],
  ],
  [
    'stack-shape',
    edit([
      '- **Provides:** A loader that validates the configuration file\n',
      '- **Provides:** A loader that validates the configuration file\n- **Stack:** Note store\n',
    ]),
    [
      '[stack-shape] Stack "Note store" spans Phase 0 and Phase 1.',
      '[stack-shape] Stack "Note store": layer P0.3 has no letter suffix.',
      '[stack-shape] Stack "Note store" mixes Plan ID stems: P0.3, P1.1a, P1.1b.',
    ],
  ],
  [
    'stack-shape',
    edit(['- **Blocked by:** P1.1a\n', '- **Blocked by:** P0.3\n']),
    [
      '[stack-shape] Stack "Note store": layer P1.1b is not blocked by P1.1a, the layer before it.',
    ],
  ],
  [
    'stack-shape',
    edit([
      '- **Stack:** Note store\n- **Acceptance:**\n  - A note',
      '- **Stack:** Note reads\n- **Acceptance:**\n  - A note',
    ]),
    [
      '[stack-shape] Stacks "Note store" and "Note reads" share the stem P1.1.',
      '[stack-shape] Stack "Note store" has one layer, P1.1a; a stack needs two or more.',
      '[stack-shape] Stack "Note reads" has one layer, P1.1b; a stack needs two or more.',
    ],
  ],
  [
    'section-owner',
    edit(['- **Owns:** §5', '- **Owns:** §5, §55']),
    ['[section-owner] P0.3: Owns names §55, which does not exist.'],
  ],
  [
    'section-owner',
    edit(['- **Owns:** §5', '- **Owns:** §5, §9']),
    [
      '[section-owner] P0.3: Owns claims §9, the delivery plan section, which has no owner.',
    ],
  ],
  [
    'section-owner',
    edit(['- **Owns:** §5', '- **Owns:** §5, §6']),
    ['[section-owner] §6 is claimed by Phase 1 and P0.3.'],
  ],
  [
    'section-owner',
    edit(['**Contracts:** §8\n', '']),
    [
      "[section-owner] §8 Sync has no owner; claim it in a phase's Contracts or a slice's Owns.",
    ],
  ],
  [
    'section-owner',
    edit(['### 6.2 Read path', '### 6.1 Read path']),
    ['[section-owner] §6.1 heads more than one section, on lines 47, 51.'],
  ],
  [
    'section-reference',
    edit(['Storage details are in §6;', 'Storage details are in §16;']),
    ['[section-reference] §1: §16 on line 7 does not exist.'],
  ],
  [
    'section-reference',
    edit([
      '- **Spec:** §6\n- **Files:** `none`',
      '- **Spec:** §9\n- **Files:** `none`',
    ]),
    ['[section-reference] P1.3: §9 on line 166 has no owner.'],
  ],
  [
    'plan-id-reference',
    edit(['P2.1 rebuilds it after a pull', 'P2.7 rebuilds it after a pull']),
    ['[plan-id-reference] P1.2: P2.7 on line 157 names no slice.'],
  ],
  [
    'no-filler',
    edit([
      '- **Notes:** Keep the index in memory; P2.1 rebuilds it after a pull.',
      '- **Notes:** TBD',
    ]),
    ['[no-filler] P1.2: Notes holds the placeholder "TBD".'],
  ],
  [
    'no-filler',
    edit(
      ['**Goal:** A buildable package', '**Goal:**\n\nA buildable package'],
      [
        '  - The measured times are recorded on the issue.',
        '  - TODO: decide\n  - ',
      ],
      [
        '| `src/sync/client.ts` |',
        '| `src/sync/client.ts` |\n| P2.3 |  | S | P2.1 | n/a | x |',
      ],
    ),
    [
      '[no-filler] Phase 0: Goal is empty.',
      '[no-filler] P1.3: Acceptance holds the placeholder "TODO: decide".',
      '[no-filler] P1.3: Acceptance has an empty item.',
      '[no-filler] P2.3: Title is empty.',
      '[no-filler] P2.3: Provides holds the placeholder "n/a".',
    ],
  ],
  [
    'label-exists',
    conforming,
    [
      '[label-exists] P0.3: label "risk: security" is missing from .github/labels.json.',
    ],
  ],
];

test('every rule has a failing case that prints [<rule>] <message>', () => {
  for (const [rule, text, expected] of failures) {
    const labels = rule === 'label-exists' ? LABELS.slice(0, -1) : LABELS;
    assert.deepEqual(preflight(parse(text), { labels }), expected, rule);
  }
  assert.deepEqual([...new Set(failures.map(([rule]) => rule))], RULES);
});

test('the tree lists every item in tree order, indented by level, with totals', () => {
  const tree = printTree(parse(conforming)).split('\n');
  assert.match(
    tree[0],
    /^#n +kind +Plan ID +size +priority +parent +blocked by +labels +title$/,
  );
  assert.match(
    tree[1],
    /^\(1\) +container +- +L +P2 +- +- +enhancement, severity: none +Notes service delivery plan$/,
  );
  assert.match(
    tree[2],
    /^ {2}\(2\) +epic +P0 +L +P2 +\(1\) +- +epic, severity: none +Foundation$/,
  );
  assert.match(tree[7], /^ {4}\(5\) +container +P1\.1 +L +P2 +\(3\) +- +/);
  assert.match(
    tree[8],
    /^ {6}\(9\) +leaf +P1\.1a +S +P2 +\(5\) +\(7\), \(8\) +enhancement, severity: none +Note store write path$/,
  );
  assert.match(tree[12], /^ {2}\(4\) +epic +P2 +L +P3 +\(1\) +\(11\) +/);
  assert.deepEqual(tree.slice(-2), [
    '',
    'Totals: 2 containers, 3 epics, 9 leaves.',
  ]);
  assert.equal(tree.length, 17);
  const single = printTree(
    parse(
      '# Tiny\n\n## 1. Delivery plan\n\n**Definition of done:** §1.1\n\n### Phase 0: Only\n\n**Goal:** One.\n\n**Exit criteria:** Done.\n\n**Contracts:** §1.1\n\n#### P0.1 Single · XS\n\n- **Blocked by:** none\n- **Spec:** §1.1\n- **Files:** `none`\n- **Provides:** Nothing\n- **Acceptance:**\n  - Works.\n\n### 1.1 Definition of done\n\n- Tests pass.\n',
    ),
  );
  assert.match(single, /Totals: 1 container, 1 epic, 1 leaf\.$/);
});
