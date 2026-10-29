// The structural pre-flight rules of spec-slicing.md, in the guide's order.
// `body-size` and `template-headings` check rendered bodies and live with
// the body renderer.
import { CROSS_SPEC } from './parse.mjs';

/**
 * @typedef {import('./parse.mjs').Plan} Plan
 * @typedef {import('./parse.mjs').Field} Field
 * @typedef {{ labels?: string[], labelSource?: string }} Options
 * @typedef {(plan: Plan, options: Options) => string[]} Check
 */

/** @param {string} text */
const isPlaceholder = (text) =>
  /^(?:tbd|tbc|tba|todo|fixme|n\/a|na|\?+|\.\.\.|…|-|—)\.?$/i.test(text) ||
  /^(?:TBD|TODO|FIXME)\b/.test(text);

/** @param {string} rule */
const recorded = (rule) => /** @type {Check} */ (plan) =>
  plan.problems.filter((p) => p.rule === rule).map((p) => p.message);

/** @param {string[]} values */
const duplicates = (values) => [
  ...new Set(values.filter((v, i) => values.indexOf(v) !== i)),
];

/** @type {Check} */
function crossSpecPrerequisites(plan) {
  /** @type {string[]} */
  const messages = [];
  for (const slice of plan.slices) {
    const field = slice.fields['Cross-spec prerequisites'];
    if (field?.value && !/^none$/i.test(field.value)) {
      const bad = slice.crossSpec.filter((entry) => !CROSS_SPEC.test(entry));
      if (bad.length)
        messages.push(
          `${slice.planId}: Cross-spec prerequisites must be none or comma-separated "spec <n> <Plan ID>" entries; got ${bad.map((b) => `"${b}"`).join(', ')}.`,
        );
    }
    for (const entry of slice.blockedBy)
      if (/^spec\s/i.test(entry))
        messages.push(
          `${slice.planId}: Blocked by names "${entry}", a slice of another specification; move it to Cross-spec prerequisites.`,
        );
  }
  return messages;
}

/** @type {Check} */
function sliceUnique(plan) {
  const ids = plan.slices.map((s) => s.planId);
  return duplicates(ids).map((id) => {
    const lines = plan.slices.filter((s) => s.planId === id).map((s) => s.line);
    return `${id} appears in ${lines.length} slices, on lines ${lines.join(', ')}.`;
  });
}

/** @type {Check} */
function titleUnique(plan) {
  const titles = plan.items.map((item) => item.title);
  return duplicates(titles).map(
    (title) =>
      `"${title}" is the title of ${plan.items
        .filter((item) => item.title === title)
        .map((item) => item.key)
        .join(', ')}.`,
  );
}

/** @type {Check} */
function blockedByResolves(plan) {
  const ids = new Set(plan.slices.map((s) => s.planId));
  /** @type {string[]} */
  const messages = [];
  for (const slice of plan.slices)
    for (const entry of slice.blockedBy) {
      if (entry === slice.planId)
        messages.push(`${slice.planId}: the slice blocks itself.`);
      else if (!ids.has(entry))
        messages.push(
          `${slice.planId}: Blocked by names "${entry}", which is no slice.`,
        );
    }
  for (const phase of plan.phases)
    for (const entry of phase.deferredUntil)
      if (!ids.has(entry))
        messages.push(
          `Phase ${phase.id}: Deferred until names "${entry}", which is no slice.`,
        );
  return messages;
}

/** @type {Check} */
function acyclic(plan) {
  const blockers = new Map(plan.slices.map((s) => [s.planId, s.blockedBy]));
  /** @type {string[]} */
  const messages = [];
  const seen = new Set();
  const done = new Set();
  /** @type {string[]} */
  const path = [];
  /** @param {string} id */
  const visit = (id) => {
    if (done.has(id)) return;
    const at = path.indexOf(id);
    if (at >= 0) {
      const cycle = path.slice(at);
      const key = [...cycle].sort().join(' ');
      if (!seen.has(key))
        messages.push(`Blocked-by cycle: ${[...cycle, id].join(' -> ')}.`);
      seen.add(key);
      return;
    }
    path.push(id);
    for (const blocker of blockers.get(id) ?? []) visit(blocker);
    path.pop();
    done.add(id);
  };
  for (const slice of plan.slices) visit(slice.planId);
  return messages;
}

/** @type {Check} */
function stackShape(plan) {
  /** @type {string[]} */
  const messages = [];
  for (const key of duplicates(plan.stacks.map((s) => s.key)))
    messages.push(
      `Stacks ${plan.stacks
        .filter((s) => s.key === key)
        .map((s) => `"${s.title}"`)
        .join(' and ')} share the stem ${key.slice('Stack '.length)}.`,
    );
  for (const stack of plan.stacks) {
    const layers = stack.layers.map(
      (id) =>
        /** @type {import('./parse.mjs').Slice} */ (
          plan.slices.find((s) => s.planId === id)
        ),
    );
    const name = `Stack "${stack.title}"`;
    if (layers.length < 2)
      messages.push(
        `${name} has one layer, ${stack.layers[0]}; a stack needs two or more.`,
      );
    const phases = [...new Set(layers.map((l) => `Phase ${l.phase}`))];
    if (phases.length > 1)
      messages.push(`${name} spans ${phases.join(' and ')}.`);
    for (const layer of layers)
      if (!/[a-z]$/.test(layer.planId))
        messages.push(`${name}: layer ${layer.planId} has no letter suffix.`);
    if (new Set(layers.map((l) => l.planId.replace(/[a-z]$/, ''))).size > 1)
      messages.push(`${name} mixes Plan ID stems: ${stack.layers.join(', ')}.`);
    for (const [index, layer] of layers.entries())
      if (index && !layer.blockedBy.includes(layers[index - 1].planId))
        messages.push(
          `${name}: layer ${layer.planId} is not blocked by ${layers[index - 1].planId}, the layer before it.`,
        );
  }
  return messages;
}

/** @type {Check} */
function sectionOwner(plan) {
  /** @type {string[]} */
  const messages = [];
  const numbers = plan.sections.map((s) => s.number);
  for (const number of duplicates(numbers))
    messages.push(
      `§${number} heads more than one section, on lines ${plan.sections
        .filter((s) => s.number === number)
        .map((s) => s.line)
        .join(', ')}.`,
    );
  for (const claim of plan.claims) {
    if (!numbers.includes(claim.section))
      messages.push(
        `${claim.owner}: ${claim.field} names §${claim.section}, which does not exist.`,
      );
    else if (claim.section === plan.plan?.number)
      messages.push(
        `${claim.owner}: ${claim.field} claims §${claim.section}, the delivery plan section, which has no owner.`,
      );
  }
  for (const number of duplicates(plan.claims.map((c) => c.section)))
    messages.push(
      `§${number} is claimed by ${plan.claims
        .filter((c) => c.section === number)
        .map((c) => c.owner)
        .join(' and ')}.`,
    );
  for (const section of plan.sections)
    if (section.number !== plan.plan?.number && !plan.owners[section.number])
      messages.push(
        `§${section.number} ${section.title} has no owner; claim it in a phase's Contracts or a slice's Owns.`,
      );
  return messages;
}

/** @type {Check} */
function sectionReference(plan) {
  const numbers = new Set(plan.sections.map((s) => s.number));
  return plan.references.flatMap(({ section, line, where }) =>
    !numbers.has(section)
      ? [`${where}: §${section} on line ${line} does not exist.`]
      : !plan.owners[section]
        ? [`${where}: §${section} on line ${line} has no owner.`]
        : [],
  );
}

/** @type {Check} */
function planIdReference(plan) {
  const ids = new Set(plan.slices.map((s) => s.planId));
  return plan.mentions
    .filter(({ planId }) => !ids.has(planId))
    .map(
      ({ planId, line, where }) =>
        `${where}: ${planId} on line ${line} names no slice.`,
    );
}

/** @type {Check} */
function noFiller(plan) {
  /** @type {string[]} */
  const messages = [];
  /**
   * @param {string} owner
   * @param {Record<string, Field>} fields
   */
  const check = (owner, fields) => {
    for (const [label, { value, items }] of Object.entries(fields)) {
      if (!value && !items.length)
        messages.push(`${owner}: ${label} is empty.`);
      for (const text of value ? [value, ...items] : items) {
        const bare = text.trim().replace(/^[`*_]+|[`*_]+$/g, '');
        if (!bare) messages.push(`${owner}: ${label} has an empty item.`);
        else if (isPlaceholder(bare))
          messages.push(
            `${owner}: ${label} holds the placeholder "${text.trim()}".`,
          );
      }
    }
  };
  if (plan.plan) check('Delivery plan', plan.plan.fields);
  for (const phase of plan.phases) check(`Phase ${phase.id}`, phase.fields);
  for (const slice of plan.slices) check(slice.planId, slice.fields);
  return messages;
}

/** @type {Check} */
function labelExists(plan, { labels, labelSource = '.github/labels.json' }) {
  if (!labels) return [];
  const known = new Set(labels);
  const used = [...new Set(plan.items.flatMap((item) => item.labels))];
  return used
    .filter((label) => !known.has(label))
    .map(
      (label) =>
        `${plan.items
          .filter((item) => item.labels.includes(label))
          .map((item) => item.key)
          .join(', ')}: label "${label}" is missing from ${labelSource}.`,
    );
}

/** @type {[string, Check][]} */
const CHECKS = [
  ['reserved-text', recorded('reserved-text')],
  ['plan-section', recorded('plan-section')],
  ['phase-format', recorded('phase-format')],
  ['slice-format', recorded('slice-format')],
  ['cross-spec-prerequisites', crossSpecPrerequisites],
  ['slice-unique', sliceUnique],
  ['title-unique', titleUnique],
  ['blocked-by-resolves', blockedByResolves],
  ['acyclic', acyclic],
  ['stack-shape', stackShape],
  ['section-owner', sectionOwner],
  ['section-reference', sectionReference],
  ['plan-id-reference', planIdReference],
  ['no-filler', noFiller],
  ['label-exists', labelExists],
];

/** The rules `preflight` checks, in order. */
export const RULES = CHECKS.map(([rule]) => rule);

/**
 * Checks the rules in order and returns the violations of the first rule
 * that fails, each as `[<rule>] <message>`, or an empty array.
 * `label-exists` runs only when `labels` lists the known label names.
 * @param {Plan} plan
 * @param {Options} [options]
 * @returns {string[]}
 */
export function preflight(plan, options = {}) {
  for (const [rule, check] of CHECKS) {
    const messages = check(plan, options);
    if (messages.length) return messages.map((m) => `[${rule}] ${m}`);
  }
  return [];
}
