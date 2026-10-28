// Manual review publication. The code-reviewer agent stays read-only. The
// review-code skill passes its finished report here, and this posts exactly
// one review to the pull request it reviewed, or posts nothing and says why.
import { execFileSync } from 'node:child_process';
import { failureMessage, ghRest } from '@agenticool/github';
import { binding, prefix, repository } from '@agenticool/policy';

/**
 * @typedef {Record<string, any>} Policy
 * @typedef {import('@agenticool/github').Run} Run
 */

export const REVIEW_VERDICTS = ['APPROVE', 'REQUEST CHANGES', 'BLOCKED'];
const FULL_SHA = /^[0-9a-f]{40}$/;

export class ReviewNotPosted extends Error {
  /** @param {string} message */
  constructor(message) {
    super(`Review not posted: ${message}`);
    this.name = 'ReviewNotPosted';
  }
}

// Reads the verdict and the reviewed SHAs from a code-reviewer report, which
// has `Verdict: <verdict>` and `Base/Head: <sha>..<sha>` lines. Light
// Markdown around either is tolerated. Two different verdicts are an error,
// and so is a missing or unreadable pair: a review binds to the commits it
// read, so a report that does not name them is never posted.
/** @param {unknown} text */
export function parseReviewReport(text) {
  const verdicts = new Set(
    [
      ...String(text).matchAll(
        /^[\s>*_`-]*Verdict:[\s*_`]*(APPROVE|REQUEST CHANGES|BLOCKED)\b/gm,
      ),
    ].map((match) => match[1]),
  );
  if (verdicts.size !== 1)
    throw new ReviewNotPosted(
      verdicts.size
        ? `the report has conflicting verdicts (${[...verdicts].join(', ')})`
        : `the report has no Verdict: line with ${REVIEW_VERDICTS.join(', ')}`,
    );
  const pair =
    /^[\s>*_`-]*Base\/Head:[\s*_`]*([0-9a-f]{7,40})`?\s*\.\.\s*`?([0-9a-f]{7,40})\b/m.exec(
      String(text),
    );
  if (!pair)
    throw new ReviewNotPosted(
      'the report has no Base/Head: <sha>..<sha> line naming the reviewed commits',
    );
  return { verdict: [...verdicts][0], base: pair[1], head: pair[2] };
}

// GitHub rejects REQUEST_CHANGES and APPROVE from a pull request's own
// author, so a change request goes out only when the publishing account is
// known and differs from the author. Logins compare case-insensitively, as
// GitHub treats them. Agent names and models never enter the comparison.
// Every other case is a COMMENT review, and nothing here ever approves.
/**
 * @param {{ verdict: string, viewer?: string | null, author?: string | null, identityError?: string }} identity
 * @returns {{ event: 'COMMENT' | 'REQUEST_CHANGES', note: string | null }}
 */
export function reviewEvent({ verdict, viewer, author, identityError }) {
  if (!REVIEW_VERDICTS.includes(verdict))
    throw new Error(`Unknown review verdict: ${verdict}`);
  if (!viewer || !author)
    return {
      event: 'COMMENT',
      note: `The publishing GitHub account could not be compared with the pull request author (${identityError ?? 'GitHub returned no login'}), so this review is posted as a comment and cannot request changes.`,
    };
  const same = viewer.toLowerCase() === author.toLowerCase();
  if (verdict === 'REQUEST CHANGES')
    return same
      ? {
          event: 'COMMENT',
          note: `The verdict is REQUEST CHANGES, but it is posted as a comment rather than a change request because the reviewer and the pull request author share the GitHub account @${author}, and GitHub does not let an account request changes on its own pull request.`,
        }
      : { event: 'REQUEST_CHANGES', note: null };
  if (verdict === 'APPROVE')
    return {
      event: 'COMMENT',
      note: 'This workflow never submits a GitHub approval, so the APPROVE verdict is posted as a comment.',
    };
  return { event: 'COMMENT', note: null };
}

/**
 * @param {Policy} policy
 * @param {{ report: string, base: string, head: string, note: string | null }} review
 */
export function reviewBody(policy, { report, base, head, note }) {
  const parts = [
    `${binding(policy).label} code review of \`${base}..${head}\`, requested through \`${prefix(policy)}review-code\`.`,
  ];
  if (note) parts.push(`> ${note}`);
  parts.push(String(report).trim());
  return `${parts.join('\n\n')}\n`;
}

/**
 * @param {string} path
 * @param {Run} run
 * @param {{ method?: string, input?: string, jq?: string }} [options]
 * @returns {any}
 */
function ghJson(path, run, { method, input, jq } = {}) {
  const args = [path, ...(method ? ['--method', method] : [])];
  if (input !== undefined) args.push('--input', '-');
  if (jq) args.push('--jq', jq);
  let output;
  try {
    output = ghRest(args, { run, input });
  } catch (cause) {
    throw new Error(failureMessage(cause), { cause });
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`gh api ${path} returned a response that is not JSON`);
  }
}

/** @param {unknown} error */
const messageOf = (error) => /** @type {Error} */ (error).message;

/**
 * @param {Policy} policy
 * @param {{ pr?: string, base?: string, head?: string, report?: string }} review
 * @param {Run} [run]
 */
export function publishReview(
  policy,
  { pr, base = '', head = '', report },
  run = execFileSync,
) {
  const repo = repository(policy);
  if (!/^[1-9][0-9]*$/.test(String(pr)))
    throw new ReviewNotPosted('--pr must be a pull request number');
  for (const [name, sha] of Object.entries({ base, head }))
    if (!FULL_SHA.test(sha))
      throw new ReviewNotPosted(`--${name} must be a full 40-character SHA`);
  if (!String(report ?? '').trim())
    throw new ReviewNotPosted('the review report is empty');
  const text = String(report);
  const reviewed = parseReviewReport(text);
  if (!base.startsWith(reviewed.base) || !head.startsWith(reviewed.head))
    throw new ReviewNotPosted(
      `the report reviewed ${reviewed.base}..${reviewed.head}, not ${base}..${head}. Run a fresh review.`,
    );
  let pull;
  try {
    pull = ghJson(`repos/${repo}/pulls/${pr}`, run);
  } catch (error) {
    throw new ReviewNotPosted(messageOf(error));
  }
  // A review posts only to an open pull request. A merged or closed one
  // still gets its report, but nothing is written to it.
  if (pull?.merged === true || pull?.merged_at)
    throw new ReviewNotPosted('pull request is merged');
  if (pull?.state !== 'open')
    throw new ReviewNotPosted(
      pull?.state === 'closed'
        ? 'pull request is closed'
        : `pull request state is ${pull?.state ?? 'unknown'}, not open`,
    );
  if (pull?.head?.sha !== head)
    throw new ReviewNotPosted(
      `pull request #${pr} head is now ${pull?.head?.sha}, not the reviewed ${head}. Run a fresh review for the new commits.`,
    );
  // The skill reviews from `git merge-base <base_sha> <head_sha>`, so the
  // review still posts after the base branch tip moves, as long as the
  // reviewed diff is unchanged. --jq keeps the file patches out of the output.
  let mergeBase;
  try {
    mergeBase = ghJson(
      `repos/${repo}/compare/${pull?.base?.sha}...${head}?per_page=1`,
      run,
      { jq: '{sha: .merge_base_commit.sha}' },
    )?.sha;
  } catch (error) {
    throw new ReviewNotPosted(messageOf(error));
  }
  if (mergeBase !== base)
    throw new ReviewNotPosted(
      `pull request #${pr} now has merge base ${mergeBase} with ${pull?.base?.ref}, not the reviewed ${base}. Run a fresh review for the new commits.`,
    );
  let viewer = null;
  let identityError;
  try {
    viewer = ghJson('user', run)?.login || null;
  } catch (error) {
    identityError = messageOf(error);
  }
  const author = pull.user?.login || null;
  if (!identityError && !author)
    identityError = 'GitHub returned no pull request author';
  const { event, note } = reviewEvent({
    verdict: reviewed.verdict,
    viewer,
    author,
    identityError,
  });
  let posted;
  try {
    posted = ghJson(`repos/${repo}/pulls/${pr}/reviews`, run, {
      method: 'POST',
      // commit_id pins the review to the reviewed head, so GitHub shows it
      // as outdated once the pull request moves.
      input: JSON.stringify({
        commit_id: head,
        event,
        body: reviewBody(policy, { report: text, base, head, note }),
      }),
    });
  } catch (error) {
    throw new ReviewNotPosted(
      `${messageOf(error).replace(/\.$/, '')}. Check the pull request before retrying.`,
    );
  }
  if (!posted?.html_url)
    throw new ReviewNotPosted(
      'GitHub returned no review URL, so the review cannot be confirmed as posted. Check the pull request before retrying.',
    );
  return {
    posted: true,
    event,
    verdict: reviewed.verdict,
    note,
    url: posted.html_url,
    reviewer: viewer,
    author,
    base,
    head,
  };
}
