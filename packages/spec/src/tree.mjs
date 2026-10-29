// The dry-run tree: one line per item in tree order, numbered by creation
// position, with parents and blockers in the same `(n)` notation.

/** @typedef {import('./parse.mjs').Item} Item */

const HEADER = [
  '#n',
  'kind',
  'Plan ID',
  'size',
  'priority',
  'parent',
  'blocked by',
  'labels',
  'title',
];

/**
 * @param {import('./parse.mjs').Plan} plan
 * @returns {string}
 */
export function printTree(plan) {
  const byKey = new Map(plan.items.map((item) => [item.key, item]));
  /** @param {string} key */
  const position = (key) => {
    const item = byKey.get(key);
    return item ? `(${item.number})` : key;
  };
  /** @param {Item} item */
  const planId = (item) =>
    item.kind === 'leaf'
      ? item.key
      : item.kind === 'epic'
        ? `P${item.key.slice('Phase '.length)}`
        : item.key === 'Plan'
          ? '-'
          : item.key.slice('Stack '.length);
  /** @type {string[][]} */
  const rows = [HEADER];
  /**
   * @param {Item} item
   * @param {number} depth
   */
  const walk = (item, depth) => {
    rows.push([
      `${'  '.repeat(depth)}(${item.number})`,
      item.kind,
      planId(item),
      item.size,
      item.priority,
      item.parent ? position(item.parent) : '-',
      item.blockedBy.map(position).join(', ') || '-',
      item.labels.join(', '),
      item.title,
    ]);
    for (const child of plan.items
      .filter((other) => other.parent === item.key)
      .sort((a, b) => a.line - b.line))
      walk(child, depth + 1);
  };
  walk(plan.items[0], 0);
  const widths = HEADER.map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  const lines = rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths[column]),
      )
      .join('  '),
  );
  /** @type {Record<string, number>} */
  const totals = { container: 0, epic: 0, leaf: 0 };
  for (const item of plan.items) totals[item.kind]++;
  const plural = { container: 'containers', epic: 'epics', leaf: 'leaves' };
  const summary = Object.entries(totals)
    .map(
      ([kind, count]) =>
        `${count} ${count === 1 ? kind : plural[/** @type {keyof typeof plural} */ (kind)]}`,
    )
    .join(', ');
  return `${lines.join('\n')}\n\nTotals: ${summary}.`;
}
