// Renders every issue body of a plan as body-shapes.md describes, with
// `@@issue:KEY@@` placeholders for issue numbers, and checks the rendered
// bodies against `body-size` and `template-headings`. No body names the
// specification's path or URL, so the specification can live anywhere.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CROSS_SPEC_MENTION,
  fencedLines,
  PLAN_ID_MENTION,
  SECTION_REF,
} from './parse.mjs';

/**
 * @typedef {import('./parse.mjs').Plan} Plan
 * @typedef {import('./parse.mjs').Slice} Slice
 * @typedef {import('./parse.mjs').Section} Section
 * @typedef {{ label: string, id: string | null, required: boolean }} FormField
 * @typedef {{ epic: FormField[], container: FormField[], task: FormField[] }} Forms
 */

export const BODY_LIMIT = 65_536;
const FILLED = '#9999999';
const PLACEHOLDER = /@@issue:[^@]+@@/g;
const FORMS = ['epic', 'container', 'task'];
// Code spans and cross-spec entries stay as written.
const PROTECTED = new RegExp(
  `(\`+)[^\`]*?\\1|${CROSS_SPEC_MENTION.source}`,
  'gi',
);
const REFERENCE = new RegExp(
  `${SECTION_REF.source}|(${PLAN_ID_MENTION.source})`,
  'g',
);

/** @param {string} key */
const issue = (key) => `@@issue:${key}@@`;
/** @param {string} planId */
const planRef = (planId) => `${planId} (${issue(planId)})`;
/**
 * @param {string} a
 * @param {string} b
 */
const bySection = (a, b) => {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++)
    if (left[i] !== right[i]) return (left[i] ?? -1) - (right[i] ?? -1);
  return 0;
};
/**
 * @param {string} section
 * @param {string} ancestor
 */
const within = (section, ancestor) => section.startsWith(`${ancestor}.`);

/**
 * The independence record the groups step can append to the root or an epic,
 * with each leaf it can name in a group of its own.
 * @param {number} leaves
 */
const largestRecord = (leaves) =>
  `\n\n### Independence groups\n\n<!-- independence-groups -->\n${Array.from(
    { length: leaves },
    (_, index) => `- g${index + 1}: ${FILLED}\n`,
  ).join('')}<!-- /independence-groups -->`;

/**
 * Renders every item's body, keyed by item key in creation order. The plan
 * must pass `preflight`; `text` is the specification it was parsed from.
 * @param {Plan} plan
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function render(plan, text) {
  const lines = text.split(/\r?\n/);
  const fenced = fencedLines(lines);
  const delivery = /** @type {import('./parse.mjs').DeliveryPlan} */ (
    plan.plan
  );
  const done = /** @type {string} */ (delivery.definitionOfDone);
  /** @param {string} number */
  const sectionOf = (number) =>
    /** @type {Section} */ (plan.sections.find((s) => s.number === number));
  /** @param {string} planId */
  const sliceOf = (planId) =>
    /** @type {Slice} */ (plan.slices.find((s) => s.planId === planId));

  /**
   * Carried text with `§` references and Plan ID mentions rewritten outside
   * code spans and fenced code, for the body of item `self`.
   * @param {string} value
   * @param {string} self
   */
  const carry = (value, self) => {
    const valueLines = value.split('\n');
    const valueFenced = fencedLines(valueLines);
    /** @param {string} prose */
    const rewrite = (prose) =>
      prose.replace(REFERENCE, (match, section, planId, offset) => {
        if (planId) return planId === self ? planId : planRef(planId);
        const owner = plan.owners[section];
        return !owner ||
          owner === self ||
          prose.startsWith(' (#', offset + match.length)
          ? match
          : `${match} (${issue(owner)})`;
      });
    return valueLines
      .map((line, index) => {
        if (valueFenced[index]) return line;
        let result = '';
        let last = 0;
        for (const match of line.matchAll(PROTECTED)) {
          result += rewrite(line.slice(last, match.index)) + match[0];
          last = match.index + match[0].length;
        }
        return result + rewrite(line.slice(last));
      })
      .join('\n');
  };
  /**
   * @param {string} number
   * @param {string} self
   */
  const sectionRef = (number, self) => carry(`§${number}`, self);

  /**
   * The claimed sections, each with its headings two levels deeper and
   * without subsections that another item claims.
   * @param {string[]} numbers
   * @param {string} self
   */
  const carrySections = (numbers, self) =>
    [...new Set(numbers)]
      .filter((n, _, all) => !all.some((other) => within(n, other)))
      .sort(bySection)
      .map((number) => {
        const section = sectionOf(number);
        const excluded = plan.claims
          .filter((c) => within(c.section, number) && c.owner !== self)
          .map((c) => sectionOf(c.section));
        /** @type {string[]} */
        const kept = [];
        for (let index = section.line - 1; index < section.end - 1; index++) {
          const line = index + 1;
          if (excluded.some((s) => s.line <= line && line < s.end)) continue;
          const heading = !fenced[index] && /^(#{1,6}) /.exec(lines[index]);
          kept.push(
            heading
              ? '#'.repeat(Math.min(heading[1].length + 2, 6)) +
                  lines[index].slice(heading[1].length)
              : lines[index],
          );
        }
        return carry(kept.join('\n').trimEnd(), self);
      })
      .join('\n\n');

  // Each top-level list item of the definition-of-done section, with its
  // indented continuation lines.
  /** @type {string[]} */
  const doneItems = [];
  const doneSection = sectionOf(done);
  for (let index = doneSection.line; index < doneSection.end - 1; index++) {
    const item =
      !fenced[index] && /^(?:[-*+]|\d+[.)]) (.*)$/.exec(lines[index]);
    if (item) doneItems.push(item[1]);
    else if (doneItems.length && /^\s+\S/.test(lines[index]))
      doneItems[doneItems.length - 1] += `\n${lines[index]}`;
  }

  /** @type {Record<string, string>} */
  const bodies = {};
  for (const item of plan.items) {
    if (item.key === 'Plan') bodies.Plan = root();
    else if (item.kind === 'epic') bodies[item.key] = epic(item.key);
    else if (item.kind === 'container') bodies[item.key] = container(item.key);
    else bodies[item.key] = leaf(sliceOf(item.key));
  }
  return bodies;

  function root() {
    const name = /** @type {string} */ (plan.name);
    const count = plan.phases.length;
    const deferred = plan.phases.filter((p) => p.deferred).length;
    const edges = plan.slices.reduce((sum, s) => sum + s.blockedBy.length, 0);
    const phases = plan.phases.map(
      (phase, index) =>
        `${index + 1}. P${phase.id} ${phase.title}: ${issue(`Phase ${phase.id}`)}${
          phase.deferred
            ? `, deferred; blocked by ${phase.deferredUntil.map(planRef).join(', ')}`
            : ''
        }`,
    );
    return [
      '### What',
      `${/^The\b/.test(name) ? '' : 'The '}${name} delivery plan: the ${count} ${count === 1 ? 'phase epic' : 'phase epics'} listed under How and every container and slice under them. This issue groups them and has no work of its own. It closes when the epics close.`,
      '',
      '### Why',
      `\`implement\` builds its dependency queue from one issue's native sub-issue tree and the blocked-by edges on its leaves. Without a common parent, \`implement\` could target only one phase at a time; with this issue as the parent of every phase epic, \`implement\` on it delivers the whole plan in dependency order.`,
      '',
      '### How',
      'Phases in plan order:',
      '',
      ...phases,
      '',
      `Dispatch order comes from the native blocked-by edges on the slices, ${edges} of them, not from whole phases. The phase epics carry no blocked-by edges of their own${
        deferred
          ? ` apart from ${deferred === 1 ? 'the deferred one' : 'the deferred ones'}`
          : ''
      }, and this issue adds none, so a slice becomes executable as soon as its own blockers close. Each epic's How section lists its slices with their blockers.`,
      '',
      '### Parent issue',
      'None',
    ].join('\n');
  }

  /** @param {string} key */
  function epic(key) {
    const phase = /** @type {import('./parse.mjs').Phase} */ (
      plan.phases.find((p) => `Phase ${p.id}` === key)
    );
    const slices = plan.slices.filter((s) => s.phase === phase.id);
    const stacks = plan.stacks.filter((s) =>
      slices.some((slice) => slice.planId === s.layers[0]),
    );
    const contracts = carrySections(phase.contracts, key);
    return [
      '### What',
      carry(phase.fields.Goal.value, key),
      '',
      'Slices:',
      ...slices.map(
        (s) => `- \`${s.planId}\` ${s.title} (${s.size}): ${issue(s.planId)}`,
      ),
      '',
      '### Why',
      carry(phase.fields['Exit criteria'].value, key),
      ...(phase.deferred
        ? [
            '',
            `Deferred: filed now and blocked until ${phase.deferredUntil.map(planRef).join(', ')} ${phase.deferredUntil.length === 1 ? 'closes' : 'close'}.`,
          ]
        : []),
      '',
      '### How',
      'Order by blocked-by, not by number:',
      ...slices.map(
        (s) =>
          `- \`${s.planId}\`: blocked by ${s.blockedBy.map(planRef).join(', ') || 'none'}`,
      ),
      ...stacks.map(
        (s) =>
          `- Container ${issue(s.key)} groups ${s.layers.map((id) => `\`${id}\``).join(', ')} as stacked deliveries.`,
      ),
      '',
      `Definition of done for every slice: ${sectionRef(done, key)}.`,
      '',
      '### Parent issue',
      issue('Plan'),
      ...(contracts ? ['', '### Contracts', contracts] : []),
    ].join('\n');
  }

  /** @param {string} key */
  function container(key) {
    const stack = /** @type {import('./parse.mjs').Stack} */ (
      plan.stacks.find((s) => s.key === key)
    );
    return [
      '### What',
      `Stacked slices ${stack.layers.map((id) => `\`${id}\` (${issue(id)})`).join(', ')}: each layer builds on the branch of the layer before it and is reviewed on its own.`,
      '',
      '### Why',
      'Each layer is one reviewable delivery; the layers share one seam and land as stacked PRs.',
      '',
      '### How',
      stack.layers.map((id) => `- \`${id}\``).join(' then\n'),
      '',
      '### Parent epic',
      issue(`Phase ${sliceOf(stack.layers[0]).phase}`),
    ].join('\n');
  }

  /** @param {Slice} slice */
  function leaf(slice) {
    const self = slice.planId;
    /** @param {string} label */
    const field = (label) => slice.fields[label]?.value ?? '';
    const stack = plan.stacks.find((s) => s.layers.includes(self));
    const notes = [
      field('Notes') && carry(field('Notes'), self),
      field('Files') && `Files: ${field('Files')}`,
      field('Spec') && `Contracts: ${carry(field('Spec'), self)}`,
      slice.owns.length &&
        `Owned contracts:\n\n${carrySections(slice.owns, self)}`,
      slice.catalog.length &&
        `Class contracts:\n\n${carry(
          slice.catalog
            .map((t) => [t.header, t.separator, ...t.rows].join('\n'))
            .join('\n\n'),
          self,
        )}`,
    ].filter(Boolean);
    const crossSpec = slice.crossSpec.join(', ');
    const dependencies = [
      slice.blockedBy.length &&
        `Blocked by: ${slice.blockedBy.map(planRef).join(', ')}`,
      crossSpec && `Cross-spec prerequisites: ${crossSpec}`,
    ].filter(Boolean);
    return [
      stack ? '### Parent issue' : '### Parent epic',
      issue(stack ? stack.key : `Phase ${slice.phase}`),
      '',
      '### Outcome',
      `Plan ID: ${self}. ${carry(field('Provides'), self)}`,
      '',
      '### Acceptance criteria',
      ...slice.acceptance.map((a) => `- [ ] ${carry(a, self)}`),
      '',
      ...(notes.length
        ? ['### Implementation notes', notes.join('\n\n'), '']
        : []),
      '### Validation',
      ...[...doneItems, ...slice.validation].map((v) => `- ${carry(v, self)}`),
      `- Definition of done: ${sectionRef(done, self)}.`,
      '',
      '### Dependencies',
      dependencies.join('\n\n') || 'None',
    ].join('\n');
  }
}

/** @param {string} value */
const unquote = (value) =>
  /^'.*'$/.test(value)
    ? value.slice(1, -1).replaceAll("''", "'")
    : /^".*"$/.test(value)
      ? JSON.parse(value)
      : value;

/**
 * The non-markdown fields of a GitHub issue form, in form order. Reads only
 * the `body` list's `type`, `id`, `label`, and `validations.required` keys.
 * @param {string} text
 * @returns {FormField[]}
 */
export function readIssueForm(text) {
  /** @type {(FormField & { type: string })[]} */
  const fields = [];
  let inBody = false;
  let block = -1;
  for (const line of text.split(/\r?\n/)) {
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    if (block >= 0 && (!line.trim() || indent > block)) continue;
    block = -1;
    if (/^\S/.test(line)) inBody = /^body:\s*$/.test(line);
    const entry = inBody && /^(\s*)(- )?(\w+):\s*(.*?)\s*$/.exec(line);
    if (!entry) continue;
    const [, , item, key, value] = entry;
    if (/^[|>][-+]?$/.test(value)) block = indent;
    if (item)
      fields.push({ type: 'markdown', id: null, label: '', required: false });
    const field = fields.at(-1);
    if (!field) continue;
    if (key === 'type') field.type = unquote(value);
    else if (key === 'id') field.id = unquote(value);
    else if (key === 'label') field.label = unquote(value);
    else if (key === 'required') field.required = value === 'true';
  }
  return fields
    .filter((f) => f.type !== 'markdown')
    .map(({ label, id, required }) => ({ label, id, required }));
}

/**
 * The epic, container, and task issue forms: each from the repository's
 * `.github/ISSUE_TEMPLATE/<name>.yml` when it exists, otherwise from the
 * default forms this package ships.
 * @param {string} [base]
 * @returns {Forms}
 */
export function loadIssueForms(base = process.cwd()) {
  /** @type {Record<string, FormField[]>} */
  const forms = {};
  for (const name of FORMS) {
    const own = join(base, '.github/ISSUE_TEMPLATE', `${name}.yml`);
    const path = existsSync(own)
      ? own
      : new URL(`../fixtures/ISSUE_TEMPLATE/${name}.yml`, import.meta.url);
    forms[name] = readIssueForm(readFileSync(path, 'utf8'));
  }
  return /** @type {Forms} */ (forms);
}

/**
 * Why a body's `###` headings do not match its form, or null when they do.
 * @param {string} body
 * @param {FormField[]} fields
 * @param {boolean} isEpic
 * @param {boolean} grouped whether the groups step can append a record
 */
function headingProblem(body, fields, isEpic, grouped) {
  const bodyLines = body.split('\n');
  const fenced = fencedLines(bodyLines);
  const headings = bodyLines
    .filter((line, index) => !fenced[index] && /^### /.test(line))
    .map((line) => line.slice(4).trim());
  if (grouped && headings.at(-1) === 'Independence groups') headings.pop();
  if (isEpic && headings.at(-1) === 'Contracts') headings.pop();
  /**
   * @param {FormField} field
   * @param {string} heading
   */
  const matches = (field, heading) =>
    field.label === heading ||
    (field.id === 'parent' && /^Parent (?:issue|epic)$/.test(heading));
  let position = 0;
  for (const heading of headings) {
    while (position < fields.length && !matches(fields[position], heading)) {
      if (fields[position].required)
        return `"${heading}" comes where the required "${fields[position].label}" belongs`;
      position++;
    }
    if (position === fields.length)
      return `"${heading}" is not a form label, or is out of order`;
    position++;
  }
  const missing = fields.slice(position).find((f) => f.required);
  return missing ? `the required "${missing.label}" is missing` : null;
}

/**
 * Checks `body-size`, then `template-headings`, and returns the violations
 * of the first rule that fails as `[<rule>] <message>`, or an empty array.
 * @param {Plan} plan
 * @param {Record<string, string>} bodies
 * @param {{ forms: Forms }} options
 * @returns {string[]}
 */
export function checkBodies(plan, bodies, { forms }) {
  // The root's plan-wide record can name every leaf; an epic's, its own.
  /** @param {Plan['items'][number]} item */
  const groupable = (item) =>
    item.key === 'Plan' || item.kind === 'epic'
      ? plan.items.filter(
          (other) =>
            other.kind === 'leaf' &&
            (item.key === 'Plan' || other.parent === item.key),
        ).length
      : 0;
  const size = plan.items.flatMap((item) => {
    const leaves = groupable(item);
    const filled =
      bodies[item.key].replace(PLACEHOLDER, FILLED) +
      (leaves >= 2 ? largestRecord(leaves) : '');
    return filled.length < BODY_LIMIT
      ? []
      : [
          `[body-size] ${item.key}: the body is ${filled.length} characters with placeholders filled${leaves >= 2 ? ' and the largest independence record' : ''}; it must stay under ${BODY_LIMIT}.`,
        ];
  });
  if (size.length) return size;
  return plan.items.flatMap((item) => {
    const form =
      item.kind === 'epic'
        ? 'epic'
        : item.kind === 'leaf'
          ? 'task'
          : 'container';
    const problem = headingProblem(
      bodies[item.key],
      forms[form],
      item.kind === 'epic',
      item.key === 'Plan' || item.kind === 'epic',
    );
    return problem
      ? [`[template-headings] ${item.key}: ${problem} in ${form}.yml.`]
      : [];
  });
}
