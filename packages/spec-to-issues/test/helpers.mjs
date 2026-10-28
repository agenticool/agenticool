// A fake `gh api` that keeps issues, sub-issues, dependencies, and project
// items in memory, plus the policy fixtures and specification the tests file.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '@agenticool/policy';

/** @param {string} name */
export const fixture = (name) =>
  fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
/** @param {string} name */
export const load = (name) =>
  loadPolicy(fixture(name), {
    sections: ['binding.repository', 'binding.project'],
  });
export const SPEC = fileURLToPath(
  new URL('../../spec-parser/fixtures/conforming-spec.md', import.meta.url),
);
export const LABELS = [
  'enhancement',
  'epic',
  'severity: none',
  'area: repository',
  'risk: data-contract',
  'risk: security',
];
export const temporary = () => mkdtempSync(join(tmpdir(), 'spec-to-issues-'));

/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
const response = (status, body, headers = {}) =>
  `HTTP/2.0 ${status} Status\r\n${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('')}\r\n${body === undefined ? '' : JSON.stringify(body)}`;

/** @param {string} stdout */
const failure = (stdout) =>
  Object.assign(new Error('Command failed: gh api'), { status: 1, stdout });

/**
 * @typedef {{
 *   number: number, id: number, node_id: string, title: string, body: string,
 *   labels: string[], assignees: string[], created_at: string, creator: string,
 *   pull_request?: object,
 * }} Issue
 * @typedef {{ method: string, path: string, fields: Record<string, string>, input?: any }} Call
 */

export class FakeGitHub {
  /**
   * @param {{
   *   repository?: string, labels?: string[], latest?: number,
   *   assignable?: string[], projectDelay?: number, skip?: number[],
   *   fields?: any[],
   * }} [options]
   */
  constructor({
    repository = 'example/notes',
    labels = LABELS,
    latest = 40,
    assignable = ['sam'],
    projectDelay = 0,
    skip = [],
    fields = [
      {
        id: 101,
        name: 'Priority',
        options: ['P0', 'P1', 'P2', 'P3'].map((name) => ({
          id: `pri-${name}`,
          name: { raw: name },
        })),
      },
      {
        id: 102,
        name: 'Size',
        options: ['XS', 'S', 'M', 'L'].map((name) => ({
          id: `size-${name}`,
          name,
        })),
      },
      { id: 103, name: 'Status', options: [] },
    ],
  } = {}) {
    this.repository = repository;
    this.labels = labels;
    this.next = latest + 1;
    this.assignable = assignable;
    this.projectDelay = projectDelay;
    this.skip = new Set(skip);
    this.fields = fields;
    this.time = Date.parse('2026-10-27T12:00:00.250Z');
    /** @type {Issue[]} */
    this.issues = [];
    /** @type {Map<number, number[]>} */
    this.subIssues = new Map();
    /** @type {Map<number, number[]>} */
    this.blockedBy = new Map();
    /** @type {{ id: number, content_type: string, content: { id: number } }[]} */
    this.projectItems = [];
    /** @type {Map<number, any>} */
    this.itemFields = new Map();
    this.listings = 0;
    /** @type {Call[]} */
    this.calls = [];
    /** @type {{ query: string, variables: any }[]} */
    this.graphql = [];
    /** @type {number[]} */
    this.sleeps = [];
    /** Create the issue for this create count, then fail without a response. */
    this.stopAfterCreate = 0;
    /** @type {{ status: number, message: string, headers?: Record<string, string> }[]} */
    this.limits = [];
    /** @type {((call: Call) => void) | undefined} */
    this.beforeWrite = undefined;
    this.sleep = async (/** @type {number} */ ms) => {
      this.sleeps.push(ms);
      this.time += ms;
    };
    this.now = () => this.time;
    this.run = this.run.bind(this);
  }

  /** @param {number} number */
  issue(number) {
    return /** @type {Issue} */ (this.issues.find((i) => i.number === number));
  }

  /** @param {number} id */
  byId(id) {
    return /** @type {Issue} */ (this.issues.find((i) => i.id === id));
  }

  get writes() {
    return this.calls.filter((call) => call.method !== 'GET');
  }

  /**
   * @param {string} _command
   * @param {string[]} args
   * @param {{ input?: unknown }} options
   */
  run(_command, args, options) {
    let method = 'GET';
    let path = '';
    /** @type {Record<string, string>} */
    const fields = {};
    let input;
    for (let index = 2; index < args.length; index++) {
      const arg = args[index];
      if (arg === '-X') method = args[++index];
      else if (arg === '-F' || arg === '-f') {
        const [key, ...value] = args[++index].split('=');
        fields[key] = value.join('=');
      } else if (arg === '--input') {
        const file = args[++index];
        input = JSON.parse(
          file === '-' ? String(options.input) : readFileSync(file, 'utf8'),
        );
      } else path = arg;
    }
    if (path === 'graphql') return this.answerGraphql(input);
    const call = { method, path, fields, input };
    if (method !== 'GET') {
      this.beforeWrite?.(call);
      this.calls.push(call);
      const limit = this.limits.shift();
      if (limit)
        throw failure(
          response(limit.status, { message: limit.message }, limit.headers),
        );
    } else this.calls.push(call);
    return this.answer(call);
  }

  /** @param {Call} call */
  answer({ method, path, fields, input }) {
    const repo = `repos/${this.repository}`;
    const [route, query = ''] = path.split('?');
    const params = new URLSearchParams(query);
    const ok = (/** @type {unknown} */ body) => response(200, body);
    if (route === 'user') return ok({ login: 'filer' });
    if (route === `${repo}/labels`)
      return ok(this.labels.map((name) => ({ name })));
    if (route.startsWith(`${repo}/assignees/`)) {
      if (this.assignable.includes(route.split('/').pop() ?? ''))
        return response(204, undefined);
      throw failure(response(404, { message: 'Not Found' }));
    }
    if (route.endsWith('/fields')) return ok(this.fields);
    if (route === `${repo}/issues` && method === 'GET') {
      if (params.get('creator'))
        return ok(
          this.issues.filter(
            (issue) =>
              issue.creator === params.get('creator') &&
              Date.parse(issue.created_at) >=
                Date.parse(String(params.get('since'))),
          ),
        );
      return ok(this.next > 1 ? [{ number: this.next - 1 }] : []);
    }
    if (route === `${repo}/issues` && method === 'POST') {
      while (this.skip.has(this.next)) this.next++;
      const number = this.next++;
      const issue = {
        number,
        id: 5000 + number,
        node_id: `I_${number}`,
        title: input.title,
        body: input.body,
        labels: input.labels,
        assignees: input.assignees ?? [],
        created_at: new Date(this.time).toISOString().replace(/\.\d+Z$/, 'Z'),
        creator: 'filer',
      };
      this.issues.push(issue);
      if (--this.stopAfterCreate === 0)
        throw Object.assign(new Error('Command timed out'), { status: null });
      return ok({
        number,
        id: issue.id,
        node_id: issue.node_id,
        html_url: `https://github.com/${this.repository}/issues/${number}`,
      });
    }
    const issuePath = new RegExp(`^${repo}/issues/(\\d+)(/.*)?$`).exec(route);
    if (issuePath) {
      const number = Number(issuePath[1]);
      const rest = issuePath[2] ?? '';
      if (rest === '' && method === 'PATCH') {
        this.issue(number).body = input.body;
        return ok({ number });
      }
      const edges = rest === '/sub_issues' ? this.subIssues : this.blockedBy;
      const list = edges.get(number) ?? [];
      edges.set(number, list);
      if (method === 'GET')
        return ok(list.map((linked) => ({ number: linked })));
      list.push(
        this.byId(Number(fields.sub_issue_id ?? fields.issue_id)).number,
      );
      return ok({ number });
    }
    if (route.endsWith('/items') && method === 'GET') {
      if (++this.listings > this.projectDelay)
        for (const issue of this.issues)
          if (!this.projectItems.some((item) => item.content.id === issue.id))
            this.projectItems.push({
              id: 9000 + issue.number,
              content_type: 'Issue',
              content: { id: issue.id },
            });
      return ok([
        { id: 1, content_type: 'DraftIssue', content: null },
        ...this.projectItems,
      ]);
    }
    if (route.endsWith('/items') && method === 'POST') {
      const item = {
        id: 8000 + this.byId(Number(fields.id)).number,
        content_type: 'Issue',
        content: { id: Number(fields.id) },
      };
      this.projectItems.push(item);
      return ok({ id: item.id });
    }
    const item = /\/items\/(\d+)$/.exec(route);
    if (item && method === 'PATCH') {
      this.itemFields.set(Number(item[1]), input.fields);
      return ok({ id: Number(item[1]) });
    }
    throw new Error(`Unexpected call ${method} ${path}`);
  }

  /** @param {{ query: string, variables: any }} request */
  answerGraphql({ query, variables }) {
    this.graphql.push({ query, variables });
    const page = { hasNextPage: false, endCursor: null };
    /** @param {unknown} data */
    const ok = (data) => response(200, { data });
    if (query.includes('projectV2(number:')) {
      const board = {
        projectV2: {
          id: 'PVT_1',
          fields: {
            nodes: [
              ['Status', ['Inbox', 'Ready']],
              ['Priority', ['P0', 'P1', 'P2', 'P3']],
              ['Size', ['XS', 'S', 'M', 'L']],
            ].map(([name, options]) => ({
              id: `F_${name}`,
              name,
              options: /** @type {string[]} */ (options).map((option) => ({
                id: `O_${option}`,
                name: option,
              })),
            })),
            pageInfo: page,
          },
        },
      };
      return ok({ user: board, organization: board });
    }
    if (query.includes('label(name:'))
      return ok({ repository: { label: { id: 'LA_1' } } });
    if (query.includes('projectItems(first: 20'))
      return ok({
        repository: { issue: { projectItems: { nodes: [], pageInfo: page } } },
      });
    if (query.includes('issue(number: $number)'))
      return ok({
        repository: {
          issue: {
            id: `I_${variables.number}`,
            number: variables.number,
            state: 'OPEN',
            repository: { nameWithOwner: this.repository },
            parent: null,
            subIssuesSummary: { total: 0, completed: 0 },
          },
        },
      });
    throw new Error(`Unexpected GraphQL query ${query}`);
  }
}
