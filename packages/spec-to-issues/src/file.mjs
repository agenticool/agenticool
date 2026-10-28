// Files a confirmed plan through the File stages in order (create, patch,
// parents, blockers, project fields, triage and containers) and resumes an
// interrupted filing from state.json, as state-file.md and
// github-operations.md describe.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prefix, project, repository } from '@agenticool/policy';
import { parse, preflight, render } from '@agenticool/spec-parser';
import {
  reconcile,
  reconcileContainers,
  trackerGraphql,
} from '@agenticool/tracker';
import { restClient } from './rest.mjs';
import {
  checkGroups,
  confirmationDigest,
  planDigest,
  readPlan,
  sha256,
  stateDirectory,
  writeJson,
} from './state.mjs';

export const PROJECT_WAIT = 180_000;
export const PROJECT_POLL = 10_000;
const STARTED_EARLY = 300_000;
const PLACEHOLDER = /@@issue:([^@]+)@@/g;

/**
 * @typedef {import('./state.mjs').Plan} Plan
 * @typedef {Record<string, string[][]>} Groups
 * @typedef {{
 *   key: string, kind: string, title: string, parent: string | null,
 *   blockers: string[], labels: string[], priority: string, size: string,
 *   predicted: number | null, number: number | null, id: number | null,
 *   nodeId: string | null, sentSha256: string | null, parentLinked: boolean,
 *   blockersLinked: string[], projectItemId: number | null,
 *   fieldsSet: boolean, triaged: boolean, containersReconciled?: boolean,
 *   groups?: string[][] | null,
 * }} StateItem
 * @typedef {{
 *   repository: string, spec: string, specSha256: string, planSha256: string,
 *   login: string, assignee: string | null, startedAt: string | null,
 *   mismatch: boolean, items: StateItem[],
 * }} State
 * @typedef {{
 *   spec: string,
 *   state: string,
 *   policy: Record<string, any>,
 *   resume?: boolean,
 *   run?: import('@agenticool/github').Run,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   log?: (message: string) => void,
 * }} FileOptions
 */

/**
 * The independence record body-shapes.md appends to an epic, with
 * placeholders in place of issue numbers.
 * @param {string[][]} groups
 * @param {string} agentPrefix
 */
export const independenceRecord = (groups, agentPrefix) =>
  `\n\n### Independence groups\n\n<!-- ${agentPrefix}independence-groups -->\n${groups
    .map(
      (group, index) =>
        `- g${index + 1}: ${group.map((id) => `@@issue:${id}@@`).join(' ')}\n`,
    )
    .join('')}<!-- /${agentPrefix}independence-groups -->`;

/** @param {any} option */
const optionName = (option) =>
  typeof option.name === 'string' ? option.name : option.name?.raw;

/**
 * Files the plan, or resumes a filing whose state.json exists, and returns
 * the final state.
 * @param {FileOptions} options
 * @returns {Promise<State>}
 */
export async function fileSpec({
  spec,
  state: stateDir,
  policy,
  resume = false,
  run = execFileSync,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = Date.now,
  log = console.log,
}) {
  const directory = resolve(stateDir);
  const statePath = join(directory, 'state.json');
  const specPath = resolve(spec);
  const text = readFileSync(specPath, 'utf8');
  const specSha256 = sha256(text);
  /** @type {State | null} */
  const recorded = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : null;
  if (recorded) {
    if (recorded.spec !== specPath)
      throw new Error(
        `${statePath} belongs to ${recorded.spec}, not ${specPath}; use another state directory`,
      );
    if (recorded.specSha256 !== specSha256)
      throw new Error(
        `${specPath} changed after filing began, so the confirmed plan is no longer the plan on disk`,
      );
  } else if (resume)
    throw new Error(`Nothing to resume: ${statePath} does not exist`);

  const plan = parse(text);
  const violations = preflight(plan);
  if (violations.length) throw new Error(violations.join('\n'));
  const agentPrefix = policy.binding.namespace ? prefix(policy) : '';
  const bodies = render(plan, text, { prefix: agentPrefix });
  const planSha256 = planDigest(plan, bodies);
  if (recorded && recorded.planSha256 !== planSha256)
    throw new Error(
      'The plan changed since filing began; print, confirm, and file it again from a new state directory',
    );
  /** @type {Groups} */
  const recordedGroups = recorded
    ? Object.fromEntries(
        recorded.items
          .filter((item) => item.groups)
          .map((item) => [item.key, /** @type {string[][]} */ (item.groups)]),
      )
    : {};
  let epicGroups = recordedGroups;
  let assigned = recorded?.assignee ?? null;
  if (!resume) {
    // The groups and assignee a filing uses are the ones the person confirmed.
    const confirmed = readPlan(directory);
    if (
      !confirmed?.confirmed ||
      confirmed.confirmed !== confirmationDigest(confirmed) ||
      confirmed.spec !== specPath ||
      confirmed.planSha256 !== planSha256
    )
      throw new Error(
        `No confirmed plan for ${specPath} in ${directory}; run agenticool-spec plan --state, then agenticool-spec confirm <digest>`,
      );
    if (
      recorded &&
      confirmationDigest(confirmed) !==
        confirmationDigest({
          planSha256,
          groups: recordedGroups,
          assignee: assigned,
        })
    )
      throw new Error(
        `The confirmed groups or assignee differ from the ones ${statePath} recorded when filing began; resume it instead`,
      );
    epicGroups = checkGroups(plan, confirmed.groups);
    assigned = confirmed.assignee;
  }
  stateDirectory(directory);
  for (const [key, list] of Object.entries(epicGroups))
    bodies[key] += independenceRecord(list, agentPrefix);
  for (const name of ['bodies', 'sent'])
    mkdirSync(join(directory, name), { recursive: true });
  for (const item of plan.items)
    writeFileSync(
      join(directory, 'bodies', `${item.key}.md`),
      `${bodies[item.key]}\n`,
    );

  // Checks against the live repository before the first write.
  const repo = repository(policy);
  const board = project(policy);
  const owner = `${board.ownerType === 'organization' ? 'orgs' : 'users'}/${board.owner}/projectsV2/${board.number}`;
  const client = restClient({ run, sleep, now });
  const labels = client
    .pages(`repos/${repo}/labels?per_page=100`)
    .map((label) => label.name);
  const missingLabels = preflight(plan, {
    labels,
    labelSource: `the labels of ${repo}`,
  });
  if (missingLabels.length) throw new Error(missingLabels.join('\n'));
  const login = recorded?.login ?? client.read('user').login;
  if (assigned)
    try {
      client.read(`repos/${repo}/assignees/${assigned}`);
    } catch (error) {
      if (/** @type {any} */ (error).kind === 'not-found')
        throw new Error(`${assigned} cannot be assigned issues in ${repo}`, {
          cause: error,
        });
      throw error;
    }
  const projectFields = client.pages(`${owner}/fields`);
  /**
   * @param {string} name
   * @param {'priority' | 'size'} key
   */
  const field = (name, key) => {
    const matches = projectFields.filter((f) => f.name === name);
    if (matches.length !== 1)
      throw new Error(`${board.name} needs one ${name} field`);
    const options = new Map(
      matches[0].options.map((/** @type {any} */ option) => [
        optionName(option),
        option.id,
      ]),
    );
    for (const item of plan.items)
      if (!options.has(item[key]))
        throw new Error(
          `${board.name} has no ${name} option ${item[key]}, which ${item.key} uses`,
        );
    return { id: matches[0].id, options };
  };
  const priority = field('Priority', 'priority');
  const size = field('Size', 'size');

  /** @type {State} */
  const state = recorded ?? {
    repository: repo,
    spec: specPath,
    specSha256,
    planSha256,
    login,
    assignee: assigned,
    startedAt: null,
    mismatch: false,
    items: plan.items.map((item) => ({
      key: item.key,
      kind: item.kind,
      title: item.title,
      parent: item.parent,
      blockers: item.blockedBy,
      labels: item.labels,
      priority: item.priority,
      size: item.size,
      predicted: null,
      number: null,
      id: null,
      nodeId: null,
      sentSha256: null,
      parentLinked: false,
      blockersLinked: [],
      projectItemId: null,
      fieldsSet: false,
      triaged: false,
      ...(item.key === 'Plan' ? { containersReconciled: false } : {}),
      ...(item.kind === 'epic' ? { groups: epicGroups[item.key] ?? null } : {}),
    })),
  };
  const save = () => writeJson(statePath, state);
  save();
  const byKey = new Map(state.items.map((item) => [item.key, item]));
  /** @param {string} key */
  const item = (key) => /** @type {StateItem} */ (byKey.get(key));
  /** @param {string} key */
  const fill = (key) =>
    bodies[key].replace(
      PLACEHOLDER,
      (_, other) => `#${item(other).number ?? item(other).predicted}`,
    );
  const sentPath = (/** @type {string} */ key) =>
    join(directory, 'sent', `${key}.md`);
  const inputPath = (/** @type {string} */ name) =>
    join(directory, `${name}.json`);

  // Resume lookup: adopt issues an interrupted run created before it could
  // record them.
  if (state.startedAt && state.items.some((entry) => entry.number === null)) {
    const started = Date.parse(state.startedAt);
    const created = client
      .pages(
        `repos/${repo}/issues?creator=${state.login}&state=all&since=${state.startedAt}&per_page=100`,
      )
      .filter(
        (issue) =>
          !issue.pull_request && Date.parse(issue.created_at) >= started,
      );
    for (const entry of state.items.filter((e) => e.number === null)) {
      const matches = created.filter((issue) => issue.title === entry.title);
      if (matches.length > 1)
        throw new Error(
          `${entry.key}: issues ${matches.map((m) => `#${m.number}`).join(' and ')} share the title "${entry.title}"; resolve the duplicate before resuming`,
        );
      if (!matches.length) continue;
      const [issue] = matches;
      Object.assign(entry, {
        number: issue.number,
        id: issue.id,
        nodeId: issue.node_id,
        sentSha256: sha256(issue.body ?? ''),
      });
      save();
      log(`Adopted #${issue.number} for ${entry.key}`);
    }
  }

  // 1. Create, with predicted numbers for items that do not exist yet.
  const earlier = state.items.some((entry) => entry.number !== null);
  const pending = state.items.filter((entry) => entry.number === null);
  if (pending.length) {
    const latest =
      client.read(
        `repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=1`,
      )[0]?.number ?? 0;
    pending.forEach((entry, index) => (entry.predicted = latest + 1 + index));
    state.startedAt ??= new Date(
      Math.floor((now() - STARTED_EARLY) / 1000) * 1000,
    )
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    save();
    for (const [index, entry] of pending.entries()) {
      const body = fill(entry.key);
      writeFileSync(sentPath(entry.key), body);
      writeJson(inputPath('create'), {
        title: entry.title,
        body,
        labels: entry.labels,
        ...(state.assignee ? { assignees: [state.assignee] } : {}),
      });
      const created = await client.write(
        ['-X', 'POST', `repos/${repo}/issues`, '--input', inputPath('create')],
        { create: true },
      );
      Object.assign(entry, {
        number: created.number,
        id: created.id,
        nodeId: created.node_id,
        sentSha256: sha256(body),
      });
      if (created.number !== entry.predicted) state.mismatch = true;
      pending
        .slice(index + 1)
        .forEach(
          (later, offset) => (later.predicted = created.number + offset + 1),
        );
      save();
      log(`Created #${created.number} ${entry.key}: ${entry.title}`);
    }
  }

  // 2. Patch every body whose filled text differs from what was sent.
  if (state.mismatch || earlier) {
    let changed = 0;
    for (const entry of state.items) {
      const body = fill(entry.key);
      if (sha256(body) === entry.sentSha256) continue;
      writeJson(inputPath('patch'), { body });
      await client.write([
        '-X',
        'PATCH',
        `repos/${repo}/issues/${entry.number}`,
        '--input',
        inputPath('patch'),
      ]);
      writeFileSync(sentPath(entry.key), body);
      entry.sentSha256 = sha256(body);
      save();
      changed++;
    }
    log(`Patch pass: ${changed} ${changed === 1 ? 'body' : 'bodies'} changed`);
  }

  // 3. Link parents, checking each parent's sub-issue list first.
  /** @type {Map<number, Set<number>>} */
  const children = new Map();
  for (const entry of state.items) {
    if (!entry.parent || entry.parentLinked) continue;
    const parent = item(entry.parent);
    const number = /** @type {number} */ (parent.number);
    let linked = children.get(number);
    if (!linked) {
      linked = new Set(
        client
          .pages(`repos/${repo}/issues/${number}/sub_issues?per_page=100`)
          .map((issue) => issue.number),
      );
      children.set(number, linked);
    }
    if (!linked.has(/** @type {number} */ (entry.number))) {
      await client.write([
        '-X',
        'POST',
        `repos/${repo}/issues/${number}/sub_issues`,
        '-F',
        `sub_issue_id=${entry.id}`,
      ]);
      linked.add(/** @type {number} */ (entry.number));
    }
    entry.parentLinked = true;
    save();
  }

  // 4. Link blockers, deferred epics included, checking each list first.
  for (const entry of state.items) {
    const unlinked = entry.blockers.filter(
      (key) => !entry.blockersLinked.includes(key),
    );
    if (!unlinked.length) continue;
    const linked = new Set(
      client
        .pages(
          `repos/${repo}/issues/${entry.number}/dependencies/blocked_by?per_page=100`,
        )
        .map((issue) => issue.number),
    );
    for (const key of unlinked) {
      const blocker = item(key);
      if (!linked.has(/** @type {number} */ (blocker.number)))
        await client.write([
          '-X',
          'POST',
          `repos/${repo}/issues/${entry.number}/dependencies/blocked_by`,
          '-F',
          `issue_id=${blocker.id}`,
        ]);
      entry.blockersLinked.push(key);
      save();
    }
  }

  // 5. Project items: list once, wait one window for the repository
  // automation, add what is still missing, then set Priority and Size.
  const unplaced = state.items.filter((entry) => entry.projectItemId === null);
  if (unplaced.length) {
    const list = () =>
      new Map(
        client
          .pages(`${owner}/items?per_page=100`)
          .filter((node) => node.content_type === 'Issue')
          .map((node) => [node.content?.id, node.id]),
      );
    let listed = list();
    const deadline = now() + PROJECT_WAIT;
    while (
      unplaced.some((entry) => !listed.has(entry.id)) &&
      now() < deadline
    ) {
      await sleep(PROJECT_POLL);
      listed = list();
    }
    for (const entry of unplaced) {
      let itemId = listed.get(entry.id);
      if (itemId === undefined) {
        itemId = (
          await client.write([
            '-X',
            'POST',
            `${owner}/items`,
            '-f',
            'type=Issue',
            '-F',
            `id=${entry.id}`,
          ])
        ).id;
        log(`Added #${entry.number} to ${board.name}`);
      }
      entry.projectItemId = /** @type {number} */ (itemId);
      save();
    }
  }
  for (const entry of state.items) {
    if (entry.fieldsSet) continue;
    writeJson(inputPath('fields'), {
      fields: [
        { id: priority.id, value: priority.options.get(entry.priority) },
        { id: size.id, value: size.options.get(entry.size) },
      ],
    });
    await client.write([
      '-X',
      'PATCH',
      `${owner}/items/${entry.projectItemId}`,
      '--input',
      inputPath('fields'),
    ]);
    entry.fieldsSet = true;
    save();
  }

  // 6. Triage each created issue, then reconcile containers once for the
  // root, whose subtree covers every epic.
  const api = (
    /** @type {string} */ query,
    /** @type {Record<string, unknown>} */ variables,
  ) => trackerGraphql(query, variables, run);
  for (const entry of state.items) {
    if (entry.triaged) continue;
    await reconcile({
      api,
      policy,
      dryRun: false,
      issueNumber: /** @type {number} */ (entry.number),
      log,
      warn: log,
    });
    entry.triaged = true;
    save();
  }
  const root = state.items[0];
  if (!root.containersReconciled) {
    await reconcileContainers({
      api,
      policy,
      dryRun: false,
      issueNumber: /** @type {number} */ (root.number),
      log,
      warn: log,
    });
    root.containersReconciled = true;
    save();
  }
  return state;
}
