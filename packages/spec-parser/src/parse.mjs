// Reads a specification written to spec-slicing.md into the plan that the
// pre-flight rules and the filing steps use. It never throws on malformed
// input: each format problem is recorded under its rule name, and
// `preflight` reports them in the guide's order.

/**
 * @typedef {{ value: string, items: string[], line: number }} Field
 * @typedef {{ number: string, title: string, level: number, line: number, end: number }} Section
 * @typedef {{
 *   id: string, title: string, line: number, end: number,
 *   fields: Record<string, Field>, deferred: boolean,
 *   deferredUntil: string[], contracts: string[],
 * }} Phase
 * @typedef {{ header: string, separator: string, rows: string[] }} CatalogTable
 * @typedef {{
 *   planId: string, title: string, size: string, phase: string,
 *   line: number, end: number, source: 'heading' | 'table',
 *   fields: Record<string, Field>, blockedBy: string[], crossSpec: string[],
 *   spec: string[], owns: string[], files: string[], paths: string[],
 *   stack: string | null, priority: string, severity: string,
 *   labels: string[], acceptance: string[], validation: string[],
 *   catalog: CatalogTable[],
 * }} Slice
 * @typedef {{ key: string, title: string, stem: string, layers: string[] }} Stack
 * @typedef {{
 *   number: number, key: string, kind: 'container' | 'epic' | 'leaf',
 *   title: string, size: string, priority: string, parent: string | null,
 *   blockedBy: string[], labels: string[], line: number,
 * }} Item
 * @typedef {{ section: string, owner: string, field: string }} Claim
 * @typedef {{ section: string, line: number, where: string }} Reference
 * @typedef {{ planId: string, line: number, where: string }} Mention
 * @typedef {{ rule: string, message: string }} Problem
 * @typedef {{
 *   number: string, title: string, line: number, level: number,
 *   fields: Record<string, Field>, definitionOfDone: string | null,
 *   classCatalog: string | null,
 * }} DeliveryPlan
 * @typedef {{
 *   title: string | null, name: string | null, sections: Section[],
 *   plan: DeliveryPlan | null, phases: Phase[], slices: Slice[],
 *   stacks: Stack[], items: Item[], claims: Claim[],
 *   owners: Record<string, string | null>, references: Reference[],
 *   mentions: Mention[], problems: Problem[],
 * }} Plan
 */

export const PLAN_ID = /^P\d+[A-Z]?\.\d+[a-z]?$/;
export const CROSS_SPEC = /^spec \d+(?:\.\d+)* P\d+[A-Z]?\.\d+[a-z]?$/;
const PLAN_ID_MENTION = /(?<![\w.])P\d+[A-Z]?\.\d+[a-z]?(?!\w|\.\d)/g;
const CROSS_SPEC_MENTION = /\bspec \d+(?:\.\d+)* P\d+[A-Z]?\.\d+[a-z]?\b/gi;
const SECTION_REF = /§(\d+(?:\.\d+)*)/g;
const NUMBERED = /^(\d+(?:\.\d+)*)\.? (.+)$/;
const SIZES = ['XS', 'S', 'M'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'none'];
const REQUIRED_FIELDS = [
  'Blocked by',
  'Spec',
  'Files',
  'Provides',
  'Acceptance',
];
const OPTIONAL_FIELDS = [
  'Cross-spec prerequisites',
  'Owns',
  'Notes',
  'Validation',
  'Stack',
  'Risk',
  'Area',
  'Priority',
  'Severity',
];
const LIST_FIELDS = ['Acceptance', 'Validation'];
const REQUIRED_COLUMNS = [
  'Plan ID',
  'Title',
  'Size',
  'Blocked by',
  'Provides',
  'Acceptance',
];
const OPTIONAL_COLUMNS = [
  'Spec',
  'Files',
  'Cross-spec prerequisites',
  'Owns',
  'Notes',
  'Risk',
  'Area',
  'Priority',
  'Severity',
];

/** @param {string} line */
const stripCode = (line) => line.replace(/(`+)[^`]*?\1/g, ' ');
/** @param {string} value */
const refs = (value) => [...value.matchAll(SECTION_REF)].map((m) => m[1]);
/** @param {string} value */
const entries = (value) =>
  /^none$/i.test(value.trim())
    ? []
    : value
        .split(',')
        .map((entry) => entry.trim().replace(/^`(.*)`$/, '$1'))
        .filter(Boolean);
/** @param {string} line */
const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
/** @param {string} line */
const isSeparator = (line) =>
  /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line);

/**
 * Expands `{a,b}` groups, so `src/{a,b}.ts` stands for two files.
 * @param {string} pattern
 * @returns {string[]}
 */
export function expandBraces(pattern) {
  const group = /\{([^{}]*)\}/.exec(pattern);
  if (!group) return [pattern];
  const before = pattern.slice(0, group.index);
  const after = pattern.slice(group.index + group[0].length);
  return group[1]
    .split(',')
    .flatMap((part) => expandBraces(before + part + after));
}

/**
 * Whether a `Files` entry covers a class catalog row's path.
 * @param {string} entry
 * @param {string} path
 */
export function filesMatch(entry, path) {
  if (!entry.endsWith('/')) return entry === path || entry.endsWith(`/${path}`);
  const segments = entry.split('/').filter(Boolean);
  return segments.some((_, index) =>
    path.startsWith(`${segments.slice(index).join('/')}/`),
  );
}

/**
 * The item key that owns a section: the claimant of the section or of its
 * nearest claimed ancestor, or null.
 * @param {Claim[]} claims
 * @param {string} number
 * @returns {string | null}
 */
export function resolveOwner(claims, number) {
  for (let parts = number.split('.'); parts.length; parts.pop()) {
    const claim = claims.find((item) => item.section === parts.join('.'));
    if (claim) return claim.owner;
  }
  return null;
}

/**
 * @param {string} text
 * @returns {Plan}
 */
export function parse(text) {
  const lines = text.split(/\r?\n/);
  /** @type {Problem[]} */
  const problems = [];
  /**
   * @param {string} rule
   * @param {string} message
   */
  const report = (rule, message) => problems.push({ rule, message });

  /** @type {boolean[]} */
  const fenced = [];
  let fence = '';
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !fence) {
      fence = marker;
      fenced.push(true);
    } else if (
      marker &&
      marker[0] === fence[0] &&
      marker.length >= fence.length
    ) {
      fence = '';
      fenced.push(true);
    } else fenced.push(Boolean(fence));
  }

  for (const [index, line] of lines.entries())
    if (line.includes('@@issue:'))
      report(
        'reserved-text',
        `Line ${index + 1} contains \`@@issue:\`, the skill's issue-number placeholder.`,
      );

  /** @type {{ level: number, text: string, index: number }[]} */
  const headings = [];
  for (const [index, line] of lines.entries()) {
    const match = !fenced[index] && /^(#{1,6}) (.+)$/.exec(line);
    if (match)
      headings.push({ level: match[1].length, text: match[2].trim(), index });
  }
  /** @param {number} position index into headings */
  const endOf = (position) => {
    const next = headings
      .slice(position + 1)
      .find((h) => h.level <= headings[position].level);
    return (next?.index ?? lines.length) + 1;
  };
  /** @param {number} position */
  const nextHeadingLine = (position) =>
    (headings[position + 1]?.index ?? lines.length) + 1;

  const title = headings.find((h) => h.level === 1)?.text ?? null;
  const name =
    title === null ? null : title.replace(/(?:^|\s+)specification$/i, '');
  if (title === null)
    report(
      'plan-section',
      'The specification has no `# ` title heading outside fenced code.',
    );
  else if (!name)
    report(
      'plan-section',
      `The title "${title}" is empty after the trailing word "specification" is removed.`,
    );

  /** @type {Section[]} */
  const sections = [];
  for (const [position, h] of headings.entries()) {
    const match = h.level > 1 && NUMBERED.exec(h.text);
    if (match)
      sections.push({
        number: match[1],
        title: match[2],
        level: h.level,
        line: h.index + 1,
        end: endOf(position),
      });
  }

  /**
   * Bold-label paragraphs, such as `**Goal:** ...`, between two lines.
   * @param {number} from 1-based first line
   * @param {number} to 1-based line after the last
   */
  const paragraphFields = (from, to) => {
    /** @type {Record<string, Field>} */
    const fields = {};
    /** @type {Field | null} */
    let current = null;
    for (let index = from - 1; index < to - 1; index++) {
      const line = lines[index];
      const match = !fenced[index] && /^\*\*([^*]+?):\*\*\s*(.*)$/.exec(line);
      if (match) {
        current = { value: match[2].trim(), items: [], line: index + 1 };
        fields[match[1]] ??= current;
      } else if (!line.trim() || fenced[index]) current = null;
      else if (current)
        current.value = `${current.value} ${line.trim()}`.trim();
    }
    return fields;
  };

  /**
   * Markdown tables between two lines, outside fenced code.
   * @param {number} from 1-based first line
   * @param {number} to 1-based line after the last
   */
  const tables = (from, to) => {
    /** @type {{ header: string, separator: string, rows: { text: string, line: number }[] }[]} */
    const found = [];
    for (let index = from - 1; index < to - 1; index++) {
      if (
        fenced[index] ||
        !lines[index].trim().startsWith('|') ||
        index + 1 >= to - 1 ||
        !isSeparator(lines[index + 1].trim())
      )
        continue;
      const table = {
        header: lines[index],
        separator: lines[index + 1],
        rows: /** @type {{ text: string, line: number }[]} */ ([]),
      };
      index += 2;
      while (
        index < to - 1 &&
        !fenced[index] &&
        lines[index].trim().startsWith('|')
      ) {
        table.rows.push({ text: lines[index], line: index + 1 });
        index++;
      }
      found.push(table);
    }
    return found;
  };

  const planSections = sections.filter((s) => s.title === 'Delivery plan');
  if (planSections.length !== 1)
    report(
      'plan-section',
      planSections.length
        ? `The specification has ${planSections.length} \`Delivery plan\` sections: ${planSections.map((s) => `§${s.number}`).join(', ')}.`
        : 'The specification has no `Delivery plan` section.',
    );

  /** @type {DeliveryPlan | null} */
  let plan = null;
  /** @type {Phase[]} */
  const phases = [];
  /** @type {Slice[]} */
  const slices = [];

  if (planSections.length === 1) {
    const section = planSections[0];
    const start = headings.findIndex((h) => h.index + 1 === section.line);
    const fields = paragraphFields(section.line + 1, nextHeadingLine(start));
    /** @param {string} label */
    const sectionField = (label) => {
      const field = fields[label];
      if (!field) return null;
      const match = /^§(\d+(?:\.\d+)*)$/.exec(field.value);
      if (!match)
        report(
          'plan-section',
          `Delivery plan: ${label} names no section; write one reference such as §${section.number}.1.`,
        );
      else if (!sections.some((s) => s.number === match[1]))
        report(
          'plan-section',
          `Delivery plan: ${label} names §${match[1]}, which does not exist.`,
        );
      return match?.[1] ?? null;
    };
    if (!fields['Definition of done'])
      report(
        'plan-section',
        'Delivery plan: the required **Definition of done:** field is missing.',
      );
    plan = {
      number: section.number,
      title: section.title,
      line: section.line,
      level: section.level,
      fields,
      definitionOfDone: sectionField('Definition of done'),
      classCatalog: sectionField('Class catalog'),
    };

    const phaseLevel = section.level + 1;
    const sliceLevel = section.level + 2;
    /** @type {Phase | null} */
    let phase = null;
    for (let position = start + 1; position < headings.length; position++) {
      const h = headings[position];
      if (h.index + 1 >= section.end) break;
      const heading = `${'#'.repeat(h.level)} ${h.text}`;
      if (h.level === phaseLevel) {
        phase = null;
        if (NUMBERED.test(h.text)) continue;
        const match = /^Phase (\d+[A-Z]?): (.+)$/.exec(h.text);
        if (!match) {
          report(
            'phase-format',
            `Phase heading "${heading}" is malformed; expected "${'#'.repeat(phaseLevel)} Phase <id>: <title>".`,
          );
          continue;
        }
        const [, id, phaseTitle] = match;
        const name = `Phase ${id}`;
        if (phases.some((p) => p.id === id))
          report('phase-format', `${name} repeats.`);
        const fields = paragraphFields(h.index + 2, nextHeadingLine(position));
        for (const label of ['Goal', 'Exit criteria'])
          if (!fields[label])
            report('phase-format', `${name} has no ${label}.`);
        phase = {
          id,
          title: phaseTitle,
          line: h.index + 1,
          end: endOf(position),
          fields,
          deferred: Boolean(fields['Deferred until']),
          deferredUntil: (fields['Deferred until']?.value ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
          contracts: fields.Contracts ? refs(fields.Contracts.value) : [],
        };
        phases.push(phase);
        for (const table of tables(h.index + 2, nextHeadingLine(position)))
          if (cells(table.header)[0] === 'Plan ID') readTable(phase, table);
      } else if (phase && h.level === sliceLevel)
        readSliceHeading(phase, h, position, heading);
      else if (phase && h.level > sliceLevel)
        report(
          'slice-format',
          `Phase ${phase.id}: heading "${heading}" is deeper than a slice heading.`,
        );
    }
  }

  /**
   * @param {Phase} phase
   * @param {{ level: number, text: string, index: number }} h
   * @param {number} position
   * @param {string} heading
   */
  function readSliceHeading(phase, h, position, heading) {
    const match = /^(P\d+[A-Z]?\.\d+[a-z]?) (.+) · (\S+)$/.exec(h.text);
    if (!match) {
      report(
        'slice-format',
        `Phase ${phase.id}: slice heading "${heading}" is malformed; expected "${'#'.repeat(h.level)} <Plan ID> <title> · <size>".`,
      );
      return;
    }
    const [, planId, sliceTitle, size] = match;
    /** @type {Record<string, Field>} */
    const fields = {};
    /** @type {Field | null} */
    let current = null;
    for (
      let index = h.index + 1;
      index < nextHeadingLine(position) - 1;
      index++
    ) {
      const line = lines[index];
      const item = /^(?: {2,3}|\t)[-*] (.*)$/.exec(line);
      const field = !fenced[index] && /^- \*\*([^*]+?):\*\*\s*(.*)$/.exec(line);
      if (field) {
        const label = field[1];
        if (![...REQUIRED_FIELDS, ...OPTIONAL_FIELDS].includes(label))
          report('slice-format', `${planId}: field "${label}" is unknown.`);
        else if (fields[label])
          report('slice-format', `${planId}: field "${label}" repeats.`);
        current = { value: field[2].trim(), items: [], line: index + 1 };
        fields[label] ??= current;
      } else if (!line.trim()) continue;
      else if (current && item && !fenced[index])
        current.items.push(item[1].trim());
      else if (current && (/^\s/.test(line) || fenced[index])) {
        const last = current.items.length - 1;
        if (last >= 0) current.items[last] = `${current.items[last]}\n${line}`;
        else current.value = `${current.value}\n${line}`.trim();
      } else {
        report(
          'slice-format',
          `${planId}: line ${index + 1} is not a field item: "${line.trim()}".`,
        );
        current = null;
      }
    }
    for (const label of REQUIRED_FIELDS)
      if (!fields[label])
        report(
          'slice-format',
          `${planId}: required field ${label} is missing.`,
        );
    for (const [label, field] of Object.entries(fields)) {
      const isList = LIST_FIELDS.includes(label);
      if (isList && field.value && !field.items.length)
        report(
          'slice-format',
          `${planId}: ${label} items must be nested list items.`,
        );
      if (!isList && field.items.length)
        report('slice-format', `${planId}: ${label} takes a one-line value.`);
    }
    addSlice({
      phase,
      planId,
      title: sliceTitle,
      size,
      line: h.index + 1,
      end: endOf(position),
      source: 'heading',
      fields,
    });
  }

  /**
   * @param {Phase} phase
   * @param {{ header: string, rows: { text: string, line: number }[] }} table
   */
  function readTable(phase, table) {
    const columns = cells(table.header);
    for (const column of columns)
      if (![...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].includes(column))
        report(
          'slice-format',
          `Phase ${phase.id}: table column "${column}" is unknown.`,
        );
    const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
    for (const column of missing)
      report(
        'slice-format',
        `Phase ${phase.id}: the slice table has no "${column}" column.`,
      );
    if (missing.length) return;
    for (const row of table.rows) {
      const values = cells(row.text);
      /** @type {Record<string, Field>} */
      const fields = {};
      for (const [index, column] of columns.entries()) {
        const value = values[index] ?? '';
        if (!value && OPTIONAL_COLUMNS.includes(column)) continue;
        fields[column] =
          column === 'Acceptance'
            ? {
                value: '',
                items: value
                  ? value.split(/<br\s*\/?>/i).map((v) => v.trim())
                  : [],
                line: row.line,
              }
            : { value, items: [], line: row.line };
      }
      const planId = fields['Plan ID'].value;
      if (!PLAN_ID.test(planId)) {
        report(
          'slice-format',
          `Phase ${phase.id}: table row on line ${row.line} has the malformed Plan ID "${planId}".`,
        );
        continue;
      }
      addSlice({
        phase,
        planId,
        title: fields.Title.value,
        size: fields.Size.value,
        line: row.line,
        end: row.line + 1,
        source: 'table',
        fields,
      });
    }
  }

  /**
   * @param {{
   *   phase: Phase, planId: string, title: string, size: string,
   *   line: number, end: number, source: 'heading' | 'table',
   *   fields: Record<string, Field>,
   * }} input
   */
  function addSlice({ phase, fields, ...rest }) {
    const { planId, size } = rest;
    if (!SIZES.includes(size))
      report('slice-format', `${planId}: size "${size}" is not XS, S, or M.`);
    /** @param {string} label */
    const value = (label) => fields[label]?.value ?? '';
    const files = value('Files');
    if (files && !/^`[^`\n]+`(?:\s*,\s*`[^`\n]+`)*$/.test(files))
      report(
        'slice-format',
        `${planId}: Files must be comma-separated code spans, or \`none\` alone.`,
      );
    const fileEntries = [...files.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (fileEntries.includes('none') && fileEntries.length > 1)
      report(
        'slice-format',
        `${planId}: Files lists \`none\` together with paths.`,
      );
    const priority = value('Priority') || (phase.deferred ? 'P3' : 'P2');
    if (fields.Priority?.value && !/^P[0-3]$/.test(priority))
      report(
        'slice-format',
        `${planId}: Priority "${priority}" is not P0, P1, P2, or P3.`,
      );
    const severity = value('Severity') || 'none';
    if (fields.Severity?.value && !SEVERITIES.includes(severity))
      report(
        'slice-format',
        `${planId}: Severity "${severity}" is not ${SEVERITIES.join(', ')}.`,
      );
    const risk = entries(value('Risk'));
    const area = entries(value('Area'));
    const paths = fileEntries
      .filter((entry) => entry !== 'none')
      .flatMap(expandBraces);
    slices.push({
      ...rest,
      phase: phase.id,
      fields,
      blockedBy: entries(value('Blocked by')),
      crossSpec: entries(value('Cross-spec prerequisites')),
      spec: refs(value('Spec')),
      owns: refs(value('Owns')),
      files: fileEntries,
      paths,
      stack: value('Stack') || null,
      priority,
      severity,
      labels: [
        'enhancement',
        `severity: ${severity}`,
        ...risk.map((r) => `risk: ${r}`),
        ...area.map((a) => `area: ${a}`),
      ],
      acceptance: fields.Acceptance?.items ?? [],
      validation: fields.Validation?.items ?? [],
      catalog: [],
    });
  }

  // Stacks in the order their first layer appears.
  /** @type {Stack[]} */
  const stacks = [];
  for (const slice of slices) {
    if (!slice.stack) continue;
    const stack = stacks.find((s) => s.title === slice.stack);
    if (stack) stack.layers.push(slice.planId);
    else {
      const stem = slice.planId.replace(/[a-z]$/, '');
      stacks.push({
        key: `Stack ${stem}`,
        title: slice.stack,
        stem,
        layers: [slice.planId],
      });
    }
  }

  // Creation order: root, epics in phase order, one container per stack,
  // then leaves in specification order.
  /** @param {string[]} priorities */
  const highest = (priorities) => [...priorities].sort()[0] ?? 'P2';
  /** @param {string} planId */
  const sliceOf = (planId) =>
    /** @type {Slice} */ (slices.find((s) => s.planId === planId));
  /** @type {Omit<Item, 'number'>[]} */
  const ordered = [
    {
      key: 'Plan',
      kind: 'container',
      title: `${name} delivery plan`,
      size: 'L',
      priority: highest(phases.map((p) => (p.deferred ? 'P3' : 'P2'))),
      parent: null,
      blockedBy: [],
      labels: ['enhancement', 'severity: none'],
      line: 0,
    },
    ...phases.map((phase) => ({
      key: `Phase ${phase.id}`,
      kind: /** @type {const} */ ('epic'),
      title: phase.title,
      size: 'L',
      priority: phase.deferred ? 'P3' : 'P2',
      parent: 'Plan',
      blockedBy: phase.deferredUntil,
      labels: ['epic', 'severity: none'],
      line: phase.line,
    })),
    ...stacks.map((stack) => {
      const first = sliceOf(stack.layers[0]);
      return {
        key: stack.key,
        kind: /** @type {const} */ ('container'),
        title: stack.title,
        size: 'L',
        priority: highest(stack.layers.map((id) => sliceOf(id).priority)),
        parent: `Phase ${first.phase}`,
        blockedBy: [],
        labels: ['enhancement', `severity: ${first.severity}`],
        line: first.line,
      };
    }),
    ...slices.map((slice) => ({
      key: slice.planId,
      kind: /** @type {const} */ ('leaf'),
      title: slice.title,
      size: slice.size,
      priority: slice.priority,
      parent: slice.stack
        ? /** @type {Stack} */ (stacks.find((s) => s.title === slice.stack)).key
        : `Phase ${slice.phase}`,
      blockedBy: slice.blockedBy,
      labels: slice.labels,
      line: slice.line,
    })),
  ];
  const items = ordered.map((item, index) => ({ number: index + 1, ...item }));

  /** @type {Claim[]} */
  const claims = [];
  for (const phase of phases)
    for (const section of new Set(phase.contracts))
      claims.push({ section, owner: `Phase ${phase.id}`, field: 'Contracts' });
  for (const slice of slices)
    for (const section of new Set(slice.owns))
      claims.push({ section, owner: slice.planId, field: 'Owns' });
  /** @type {Record<string, string | null>} */
  const owners = {};
  for (const section of sections)
    owners[section.number] = resolveOwner(claims, section.number);

  if (plan?.classCatalog) {
    const catalog = /** @type {Section} */ (
      sections.find((s) => s.number === plan?.classCatalog)
    );
    const catalogTables = tables(catalog.line + 1, catalog.end).map(
      (table) => ({
        ...table,
        rows: table.rows.map(({ text: row }) => ({
          text: row,
          path: [
            ...(cells(row)[0] ?? '').matchAll(/\(`([^`]+)`\)/g),
          ].pop()?.[1],
        })),
      }),
    );
    for (const slice of slices)
      for (const table of catalogTables) {
        const rows = table.rows
          .filter(
            ({ path }) =>
              path && slice.paths.some((entry) => filesMatch(entry, path)),
          )
          .map(({ text: row }) => row);
        if (rows.length)
          slice.catalog.push({
            header: table.header,
            separator: table.separator,
            rows,
          });
      }
  }

  // The smallest slice, phase, or section around a line names it in messages.
  const regions = [
    ...slices.map((s) => ({ name: s.planId, line: s.line, end: s.end })),
    ...phases.map((p) => ({ name: `Phase ${p.id}`, line: p.line, end: p.end })),
    ...sections.map((s) => ({
      name: `§${s.number}`,
      line: s.line,
      end: s.end,
    })),
  ];
  /** @param {number} line */
  const where = (line) =>
    regions
      .filter((r) => r.line <= line && line < r.end)
      .sort((a, b) => a.end - a.line - (b.end - b.line))[0]?.name ??
    'Specification';

  /** @type {Reference[]} */
  const references = [];
  /** @type {Mention[]} */
  const mentions = [];
  for (const [index, line] of lines.entries()) {
    if (fenced[index]) continue;
    const prose = stripCode(line);
    for (const match of prose.matchAll(SECTION_REF))
      references.push({
        section: match[1],
        line: index + 1,
        where: where(index + 1),
      });
    for (const match of prose
      .replace(CROSS_SPEC_MENTION, ' ')
      .matchAll(PLAN_ID_MENTION))
      mentions.push({
        planId: match[0],
        line: index + 1,
        where: where(index + 1),
      });
  }

  return {
    title,
    name,
    sections,
    plan,
    phases,
    slices,
    stacks,
    items,
    claims,
    owners,
    references,
    mentions,
    problems,
  };
}
