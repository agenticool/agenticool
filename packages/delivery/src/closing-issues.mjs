// Closing-issue parsing for pull request bodies. The tracker owns the same
// rules; the queue keeps its own copy so it does not depend on the tracker.

/**
 * Body text that can carry a real reference: no comments, code, or the
 * parent issue line.
 * @param {string | null | undefined} body
 */
function referenceText(body) {
  return (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/(`+)[\s\S]*?\1(?!`)/g, '')
    .replace(/^(?: {4}|\t).*$/gm, '')
    .replace(/^.*\bparent\s+(?:issue|epic)\b.*$/gim, '');
}

/**
 * Issue numbers in `repository` that the text references.
 * @param {string | null | undefined} body
 * @param {string} repository
 */
function linkedIssues(body, repository) {
  const text = referenceText(body);
  /** @type {Set<number>} */
  const numbers = new Set();
  const references =
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\b|([\w.-]+\/[\w.-]+)#([1-9]\d*)\b|(?<![\w/#])#([1-9]\d*)\b/g;
  for (const match of text.matchAll(references)) {
    const target = match[1] ?? match[3] ?? repository;
    const number = Number(match[2] ?? match[4] ?? match[5]);
    if (
      target.toLowerCase() === repository.toLowerCase() &&
      Number.isSafeInteger(number)
    )
      numbers.add(number);
  }
  return [...numbers];
}

/**
 * Issue numbers in `repository` that a closing keyword references.
 * @param {string | null | undefined} body
 * @param {string} repository
 */
export function closingIssues(body, repository) {
  const references = referenceText(body).matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*\b|[\w.-]+\/[\w.-]+#[1-9]\d*\b|#[1-9]\d*\b)/gi,
  );
  return [
    ...new Set(
      [...references].flatMap((match) => linkedIssues(match[1], repository)),
    ),
  ];
}
