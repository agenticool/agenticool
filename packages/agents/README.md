# @agenticool/agents

Shared Claude Code and Codex agents and skills, the generator that renders them for a repository, the review publisher, and the sync that keeps a repository's board files and shared agent rules current. A consumer repository gets the same roles, routing, checks, and handoffs in both tools without installing anything into a contributor's workstation configuration.

## Bins

`agenticool-agents <command> [options]`, run from the consumer repository root:

| Command | What it does |
| --- | --- |
| `generate` | Renders every shared and local source for both tools and the shared rules, writes the output into the repository, removes owned output that no source produces any more, refuses to overwrite an agent or skill at a generated path that it did not generate, and prints every path it owns |
| `check` | Exits 1 and lists every generated file that is missing, stale, or orphaned, and every synced file that differs from what `sync` writes; writes nothing |
| `sync` | Writes the repository files listed in [Synced files](#synced-files) and prints every synced path |
| `resolve --tool <claude\|codex> (--role <role> \| --capability <name>) [--model <model>] [--effort <effort>]` | Prints the resolved model, effort, and spawn parameters as JSON; unsupported values exit 1 |
| `publish-review --pr <N> --base <sha> --head <sha> --report <file>` | Posts one finished code review to an open pull request, or prints `Review not posted: <reason>` and exits 1 |

Unknown or missing commands exit 2 with the help text; any other usage error exits 1.

## Exports

| Export | What it does |
| --- | --- |
| `render(base?)` | Every generated file, as a `Map` from repository-relative path to content; `base` defaults to the working directory |
| `generate(base?)`, `check(base?)` | The `generate` and `check` commands; `generate` returns the sorted paths it wrote, `check` the sorted stale paths |
| `renderRole(policy, name, source, tool, sourcePath?)` | One role as a Claude Code agent (`.md`) or a Codex agent (`.toml`) |
| `renderWorkflow(policy, name, source, tool, sourcePath?)` | One workflow as a skill: `{ 'SKILL.md' }` for Claude Code, plus `agents/openai.yaml` for Codex |
| `parseSource(text)` | Splits a source into its YAML frontmatter and body; refuses an unquoted value that YAML would truncate at ` #` |
| `renderBody(body, tool)` | Keeps the tool-only blocks for one tool and drops the other tool's |
| `substitute(text, policy)` | Resolves `{{placeholders}}` and `{{#feature}}` sections against the binding |
| `include(text, directory?)` | Expands `{{> name}}` includes from `sources/includes/` |
| `SOURCES` | Absolute path of the shared sources in the installed package |
| `publishReview(policy, { pr, base, head, report }, run?)` | The `publish-review` command; `run` stands in for `execFileSync` |
| `parseReviewReport(text)`, `reviewEvent(identity)`, `reviewBody(policy, review)` | The verdict and reviewed SHAs of a report, the review event for a verdict and identity, and the posted body |
| `REVIEW_VERDICTS`, `ReviewNotPosted` | The verdicts a report may carry, and the error for every review that was not posted |
| `sync(base?)`, `syncCheck(base?)` | The `sync` command and its part of `check`; `sync` writes only files whose content differs and returns every synced path, `syncCheck` the synced paths that are missing or differ |
| `renderSync(base?)` | Every synced file, as a `Map` from repository-relative path to the content `sync` writes, given the files already in the repository |
| `replaceBlock(text, name, content, comment, path)` | Replaces one marked block in a file's text, or appends it when the file has none; fails on unbalanced markers |
| `AGENTS_SECTIONS`, `AGENT_LOCAL_FILES`, `BROWSER_MCP` | The shared `AGENTS.md` sections in append order, the `.gitignore` entries, and the browser MCP servers and their `npx` arguments |
| `main(args, base?)` | The command line, returning the exit code |

## Config keys

The generator reads `.agents/policy.json` through `@agenticool/core` and requires only `binding.project`. The repository comes from the `origin` remote, and generated names carry no repository prefix. A minimal policy:

```json
{
  "binding": {
    "project": { "owner": "acme", "number": 1, "name": "Acme delivery" },
    "features": {}
  }
}
```

| Key | Use |
| --- | --- |
| `binding.*` | Placeholder values and feature sections in every source; `label` defaults to the repository name and `docs` to `ISSUE_TRIAGE.md` and `AGENTS.md` |
| `capabilities`, `supported` | Optional. The model and effort each role and skill resolves to, and the values each tool accepts; merged by capability and by tool over the defaults that ship in `@agenticool/core` |
| `roles` | Optional. Roles mapped to a capability, merged by name over the shipped defaults; every role, shared and local, needs a source and every source needs an entry |
| `implementationEffort` | Optional. Replaces the shipped rubric; read by the delivery sources and `agenticool-dispatch`, not by the generator |

Repository-only sources always live in `.agents/local/roles` and `.agents/local/workflows`. `publish-review` and `sync` read the same binding. `sync` also reads:

| Key | Use |
| --- | --- |
| `binding.docs.triage` | Where `ISSUE_TRIAGE.md` is written |
| `binding.features.browserMcp` | When true, `sync` also writes the browser MCP configuration; default false |
| `labels.extra` | Repository labels added to the base catalog in `.github/labels.json`; one with the name of a base label replaces it |

The board caller workflows always pass the `AGENTICOOL_PROJECT_TOKEN` secret.

## Sources

| Path | Purpose |
| --- | --- |
| `sources/roles/*.md` | Source of each agent role (shared text, with `<!-- claude-only -->` and `<!-- codex-only -->` blocks) |
| `sources/workflows/*.md` | Source of each skill, the user-facing entry points |
| `sources/workflows/<name>/` | Supporting references copied into both tools' skills, with includes and placeholders resolved and, in Markdown, only that tool's tool-only blocks |
| `sources/workflows/implement/references/delivery.md` | The one leaf delivery procedure, for the main thread and an isolated implementer alike |
| `sources/workflows/implement/references/queue.md` | The queue procedure the main thread runs for leaves and containers |
| `sources/workflows/stack.md` | The stack skill, the one source for branch, link, rebase, and sync safety |
| `sources/includes/*.md` | Text shared by several sources, inserted with `{{> name}}`; `review-packet.md` defines the review packet once for the code reviewer, the delivery procedure, and `review-code` |
| `sources/*.md` | The shared rules, rendered to `.agents/<name>.md` in the consumer with placeholders resolved |
| `sources/worktree-isolation.md` | Shared worktree ownership and setup rules, read before roles or skills use a worktree |
| `sources/review.md` | Shared reviewer packet, initial coverage, and re-review scope, loaded for code review |
| `sources/evidence.md` | Shared retrieval and waiting rules for delivery owners, isolated implementers, and code reviewers |
| `sources/issue-creation.md` | Tool-agnostic issue drafting adapter, read by the issue filing skills; points to the classification and filing owners |
| `sources/independence-groups.md` | Shared independence group definition and record format, read by the triager and the implement skill, and by the filing skills only when the triager returns groups |

The shipped roles are `code-reviewer`, `implementer`, `issue-triager`, and `security-reviewer`. The shipped skills are `agent-config`, `create-github-issue`, `implement`, `plain-language`, `review-code`, `review-security`, `spec-to-issues`, and `stack`.

### Source syntax

- `{{label}}`, `{{repository}}`, `{{project.owner}}`, `{{project.number}}`, `{{project.name}}`, `{{project.url}}`, `{{project.restPath}}` (the Projects v2 REST path, `users/` or `orgs/` by `ownerType`), `{{docs.triage}}`, `{{docs.workflow}}`, `{{docs.guides}}`, and `{{infrastructure.accountChecks}}` (a list joined with "and", empty when the list is empty or absent) resolve from `binding` and the `origin` remote. An unknown placeholder fails generation.
- `{{#feature}}...{{/feature}}` keeps its text only when `binding.features.<feature>` is true, and `{{#placeholder}}...{{/placeholder}}`, such as `{{#infrastructure.accountChecks}}`, only when that placeholder is not empty. Sections may nest. An unknown section or an unbalanced section fails generation.
- `{{> name}}` inserts `sources/includes/<name>.md` without its trailing newline. Names are lowercase letters and dashes, includes cannot nest, and an unknown or malformed include fails generation.
- `\{{` stays a literal `{{`, for text that documents the syntax itself.
- `<!-- claude-only -->` ... `<!-- /claude-only -->` and `<!-- codex-only -->` ... `<!-- /codex-only -->` blocks render for one tool only; everything else is shared.
- Frontmatter carries `name` (the generated agent or skill name), `description`, and optional `argument-hint`, `capability` (a skill's main-thread policy), `claude:` keys, and `codex:` keys.

## Consumer guide

### Set up a repository

1. Install the package and write `.agents/policy.json` with at least `binding.project`, and add the `AGENTICOOL_PROJECT_TOKEN` repository secret for the board workflows.
2. Run `npx agenticool-agents generate` and `npx agenticool-agents sync`, and commit the output.
3. Read the new `AGENTS.md` sections. The first sync appends each one at the end of the file between its markers. Move a block, markers included, to where it belongs, such as the checks block above the repository's checks table, and delete any of the repository's own sections it replaces. Later syncs rewrite each block where it stands.
4. Run `npx agenticool-agents check` in CI, so a pull request whose generated or synced files are stale fails. CI never regenerates, syncs, or commits on a contributor's behalf.
5. Rerun `npx agenticool-agents sync` after upgrading `@agenticool/agents` or `@agenticool/board`, or after changing `binding` or `labels.extra`, and commit the result.

| Output | Tool |
| --- | --- |
| `.claude/agents/<role>.md` | Claude Code subagents |
| `.claude/skills/<skill>/` | Claude Code skills |
| `.codex/agents/<role>.toml` | Codex custom agents |
| `.agents/skills/<skill>/` | Codex skills (`SKILL.md`, `agents/openai.yaml`) |
| `.agents/evidence.md`, `independence-groups.md`, `issue-creation.md`, `review.md`, `worktree-isolation.md` | The shared rules, which roles and skills in both tools read by these paths |

Generated agents and skills carry a header naming their source, and the shared rules are copies of `sources/*.md` with placeholders resolved. The generator owns only files that carry that header (for a skill, its `SKILL.md`), and removes those no source produces any more; a contributor's other agents and skills in the same directories stay untouched. When one of them sits at a generated path, such as a personal `.claude/agents/implementer.md` or `.agents/skills/stack/`, `generate` fails and names it: rename it, or move its source into `.agents/local/`.

### Synced files

| Path | Content | Ownership |
| --- | --- | --- |
| `.github/labels.json` | The `@agenticool/board` base label catalog plus `labels.extra`, sorted by name | Whole file |
| `.github/ISSUE_TEMPLATE/*.yml`, `.github/pull_request_template.md` | The board issue forms and pull request template | Whole file |
| `binding.docs.triage` | The board `ISSUE_TRIAGE.md` | Whole file |
| `.github/workflows/board-*.yml` | The board caller workflows, pinned to the installed board release; in the repository that hosts the reusable workflows (whose `origin` remote is `agenticool/agenticool`), they call them locally (`./.github/workflows/_board-*.yml`) with `board_version: 'workspace'`, so the jobs run the workspace board | Whole file |
| `AGENTS.md` | The shared sections `checks` (how to run checks, without the repository's table), `delivery` (Autonomous delivery), `code` (Code and comments, with the current-state docs rule), `workflows` (Repository agent workflows), `binding` (Delivery binding), and `branches` (Branch names), from `templates/agents-md/` with placeholders and feature sections resolved | Each section between `<!-- agenticool-agents sync: begin <name> -->` and `<!-- agenticool-agents sync: end <name> -->` |
| `.gitignore` | `.claude/worktrees/`, `.codex/worktrees/`, `CLAUDE.local.md`, `.claude/settings.local.json`, and `.claude/scheduled_tasks.lock`, plus `.playwright-mcp/` with `binding.features.browserMcp` | The lines between `# agenticool-agents sync: begin agent-local` and its end marker |
| `.mcp.json` | The `playwright` and `playwriter` servers, only with `binding.features.browserMcp` | Those two entries under `mcpServers`; other servers stay |
| `.codex/config.toml` | `[mcp_servers.playwright]` and `[mcp_servers.playwriter]`, only with `binding.features.browserMcp` | The lines between `# agenticool-agents sync: begin browser-mcp` and its end marker |

Lines outside a marked block are the repository's own, and `sync` never changes them. A file without a block gets it appended at the end, and `AGENTS.md` is created with a `# Agent rules` heading when it does not exist. On the first sync of `.codex/config.toml`, existing `[mcp_servers.playwright]` and `[mcp_servers.playwriter]` tables move into the block, so the file never defines them twice. A begin marker without its end marker fails the sync. Without `browserMcp`, `sync` and `check` leave both MCP files alone.

### Browser MCP servers

With `binding.features.browserMcp`, both tools start the same stdio servers through `npx -y`: [Playwright MCP](https://github.com/microsoft/playwright-mcp) (`@playwright/mcp@latest --headless`) and [Playwriter](https://github.com/remorses/playwriter) (`playwriter@latest`). Node.js and npm must be on `PATH`; the first start downloads the packages into npm's cache.

Agents use Playwright MCP for headless checks by default. Use Playwriter only for a person's connected Chrome session. Install its Chrome extension and click its icon on each tab to connect it. In this extension setup, Playwriter controls only the Chrome tabs a person connects through the extension. Disconnect a tab through the extension to stop control. Keep browser credentials and personal paths out of repository configuration.

Claude Code asks for approval before using project MCP servers in an interactive session. Codex loads its project MCP configuration after the project is trusted. See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp#project-scope) and [Codex MCP documentation](https://developers.openai.com/codex/mcp).

To check discovery, open a fresh session in a new worktree and run `claude mcp list` and `codex mcp list`. Both lists must include `playwright` and `playwriter`. Claude Code may list them as pending approval until a person approves them. Use `/mcp` inside either tool to inspect the active server connections.

### Add repository-only roles and skills

Put a repository-only role in `.agents/local/roles/<name>.md` (with a `roles` entry) and a skill in `.agents/local/workflows/<name>.md`, with its references in `.agents/local/workflows/<name>/`. Local sources use the same syntax and shared includes, and their generated headers name the local file. A local source with the name of a shared role or workflow fails generation: rename it rather than replacing shared behavior.

The generated `agents` skill tells a consumer where each change goes: models, efforts, and the binding in `.agents/policy.json`, repository-only roles and skills under `.agents/local/`, and shared roles, skills, and rules upstream in this package. It regenerates with `npx agenticool-agents generate` and `sync` and verifies with `check`.

### Agents and skills

Both tools support both packaging forms, and the sources use both, each for what it does well.

Skills carry the entry points in the thread a person is talking to. `implement` dispatches a leaf or PR rework to one `implementer` by default. The main thread runs the delivery queue, starts implementers sequentially, records fixed results, and assesses compact escalation requests. It reads source, diffs, or detailed review reports only when needed to explain a blocker requiring a person. An explicit `inline` keyword keeps a small leaf or rework there. `create-github-issue` drafts, classifies, and files issues inline. `spec-to-issues` runs `agenticool-spec` from `@agenticool/spec`, which the repository installs alongside this package: the scripts apply every pre-flight rule, render every body, and file the confirmed plan, while the skill gets independence groups from the triager and waits for the person's confirmation. There is no separate dispatcher, orchestrator, or stack manager agent.

Agents are for work that needs a fresh context or a hard boundary. An agent definition carries the role boundary (read-only reviewer, implementer that may write and push), an isolated context, a tool allowlist in Claude Code and a permission profile in Codex, and the slot where the model and effort policy applies:

- `code-reviewer`: the independent, read-only pre-PR gate and requested reviews. A reviewer must not share the implementer's context or self-assessment, so it is always a separate agent.
- `security-reviewer`: explicitly requested read-only security review.
- `issue-triager`: independent classification, decomposition, and dependency judgment, when an ad hoc filing batch needs it, and for every spec delivery plan.
- `implementer`: the default isolated delivery owner for one leaf or PR rework. It creates the worktree, claims, implements, validates, handles review findings, runs stacks, and opens the PR. It never delegates to another implementer.

Skills are also the policy adapter. A skill is what a person invokes (`/implement`, `$implement`), it runs in the main thread where it can ask a question, and it is the only place that can apply the repository policy at spawn time. That last point decides the split for Codex: a Codex agent file that sets `model` or `model_reasoning_effort` takes precedence over every spawn-time value, so a pinned agent file would defeat prompt overrides. The generated Codex agents therefore carry neither field, and the skills pass the resolved values to `spawn_agent` on every dispatch. Codex also loads repository skills in an untrusted project but loads project agents only after trust, so a skill is the right place to tell the contributor that the agents are missing. In Claude Code the per-invocation `model` and `effort` parameters already override frontmatter, so the generated Claude agents pin the policy and the skills still pass the resolved values explicitly for the same reason: a dispatch must never depend on a session or contributor default.

A skill cannot change the session model in either tool, so inline work runs at whatever model and effort the session has. `implement` applies the implementation policy through explicit implementer spawn settings. Only explicit inline delivery reports it as `Advisory policy:`. Claude Code skill frontmatter can pin a model for the turn that loads the skill; `create-github-issue` and `spec-to-issues` use that for their filing flows, while `implement` does not, because a delivery spans many turns and both tools should behave alike.

### Parity matrix

| Component | Claude Code | Codex | Checked by |
| --- | --- | --- | --- |
| Leaf and PR rework delivery (isolated, default) | `implementer` through the Agent tool; worktree under `.claude/worktrees/`; independent reviewer | `implementer` through `spawn_agent` with `fork_turns: "none"`; worktree under `.codex/worktrees/`; independent reviewer | same source and `references/delivery.md`; routing tests |
| Container queue (main thread, sequential) | `/implement` with `references/queue.md` | `$implement` with `references/queue.md` | same source; routing tests |
| Explicit inline implementation (small leaf or rework) | `/implement inline`, session settings | `$implement inline`, session settings | same source; routing tests |
| Stack operations | `/stack`, loaded by the worktree's creator with the Skill tool | `$stack`, loaded by the worktree's creator | same source; routing tests |
| Issue creation | `.claude/skills/create-github-issue` (pins the `issue-creation` policy for the turn) | `.agents/skills/create-github-issue` | same source; routing tests |
| Spec delivery plan | `/spec-to-issues` | `$spec-to-issues` | same source; command sequence tests; `@agenticool/spec` tests |
| Issue triage (when filing needs it) | `.claude/agents/issue-triager.md` (`Read, Grep, Glob, Bash`) | `.codex/agents/issue-triager.toml` (`:read-only`) | same source |
| Code review | `code-reviewer` (`Bash, Read, Grep, Glob`, `isolation: worktree`) | `code-reviewer` (`:read-only`) | same source; routing tests |
| Security review | `security-reviewer` (adds `WebFetch, WebSearch`) | `security-reviewer` (`:read-only`) | same source; routing tests |
| Entry points | `/implement`, `/stack`, `/review-code`, `/review-security`, `/plain-language`, `/agent-config` | `$implement`, `$stack`, `$review-code`, `$review-security`, `$plain-language`, `$agent-config` | same source; manifests generated |
| Policy resolution | `npx agenticool-agents resolve --tool claude ...` | `... --tool codex ...` | `@agenticool/core` tests |

"Same source" means the Claude and Codex files are rendered from one Markdown file; only the tool-only blocks differ (how to spawn, how to load a skill, how the worktree is created, and the Claude reviewer's optional detached checkout). The package tests render every role, workflow, and Markdown reference for both tools against a fixture consumer and require every shared line in both renderings. The routing tests also check behavior: each source names the same agents, skills, and references in both tools; `implement` dispatches a leaf and rework to an implementer by default and runs the read-only queue for containers; the queue stays sequential unless a person asks for parallel delivery; the delivery owner loads `stack` itself; the pre-PR review stays mandatory on its paths; issue filing classifies inline unless it needs independent judgment; and only the four shipped roles resolve and generate, so no generated file names an `orchestrator` or `stack-manager` agent.

`worktree-isolation.md` owns the setup and ownership rules for every role and skill. The worktree's creator runs every mutation in it, stack operations included.

### Model and effort policy

`policy.json` names a model and effort per capability and tool (`issue-creation`, `issue-triage`, `implementation`, `code-review`, `security-review`), and `supported` lists the models and effort levels each tool accepts. Update `supported` when a tool adds or retires a model (`codex debug models` prints the Codex catalog; Claude Code aliases are `haiku`, `sonnet`, `opus`, and `fable`, or a full `claude-*` ID). A repository that keeps a copy of its policy table in its own docs keeps that copy current.

Most leaves use medium. `implementationEffort` holds stable rubric IDs, such as `H1-boundary` for an unresolved new cross-component guarantee, `H2-coupled-design` for interacting correctness constraints the supplied design does not resolve, and `H3-demonstrated-limit` for a reproducible medium correctness failure or substantive finding requiring design revision. The assessment names the unresolved question, evidence, and why medium with the written plan is insufficient. Labels, Size, infrastructure, contracts, and routine fixes never select high alone. Explicit medium prevents escalation; missing decisions or prerequisites stay blockers. The implement workflow owns announcements, confirmation, and the one-transition recovery procedure. Reviewer settings stay independent.

#### Precedence

1. An explicit `model <name>` or `effort <level>` in the request wins, for the role the skill dispatches. A role prefix targets a handoff: `reviewer effort max`, `implementer model opus`, `triager effort medium`. In `implement`, an unprefixed override targets an isolated implementer; inline work runs at the session settings, and the skill says so instead of applying the override.
2. Otherwise the repository policy applies.
3. A partial override changes only the named setting; the other stays at the policy value (`source` in the resolver output says which).
4. Overrides last for the task and the handoffs they name. Nothing rewrites `policy.json`, `~/.claude`, or `~/.codex`.

The resolver refuses a model or effort the repository does not list and prints why; the dispatcher stops and reports that message. Nothing substitutes another value. This matters because the runtimes do not fail on their own: Claude Code maps an unsupported effort to the highest supported level below it, and Codex falls back to `[agents]` defaults or the parent when a spawn field is missing.

#### Reports

Each dispatched role reports `Requested settings: Policy: <as dispatched>`. The policy line records the requested model and effort and whether each came from policy or an explicit override. Caller workflows retain that label when relaying results, including a container's per-leaf rows and issue triage results. Inline work reports `Advisory policy: ...` instead, because nothing dispatched it and it runs at the session settings. These values describe the dispatch request, not what the runtime ran: `CLAUDE_CODE_EFFORT_LEVEL` and a Codex agent file field override them silently (see [Known limitations](#known-limitations)). Use the effective-model verification row below when that matters. Routine reports omit model self-identification, runtime-verification fields, and automatic verification warnings or discussions.

For example, an inline Codex delivery reports `Advisory policy: tool=codex capability=implementation model=gpt-6.1-sol effort=medium (session settings apply)`, and an isolated Codex implementer reports `Requested settings: Policy: tool=codex role=implementer model=gpt-6.1-sol effort=medium (model: policy, effort: policy); decision: default; evidence: ticket/spec; reason: The written plan resolves the design.`. A code review requested with `model gpt-6-sol effort xhigh` reports `Requested settings: Policy: tool=codex role=code-reviewer model=gpt-6-sol effort=xhigh (model: override, effort: override)`.

#### Vendor differences and adapters

| Concern | Claude Code | Codex |
| --- | --- | --- |
| Where the policy is applied | agent frontmatter (`model`, `effort`) plus explicit Agent tool parameters | explicit `spawn_agent` parameters only; agent files omit both fields on purpose |
| Precedence in the runtime | per-invocation parameter > frontmatter > `CLAUDE_CODE_SUBAGENT_MODEL` > session model; `CLAUDE_CODE_EFFORT_LEVEL` beats every effort source | agent file field > spawn value > `[agents].default_subagent_*` > parent |
| Main-thread skill model | skill frontmatter can pin it for the turn that loads the skill (used by `create-github-issue` and `spec-to-issues`); otherwise set the session with `/model` or `claude --model <model> --effort <effort>` | not possible; start the session with `codex -m <model> -c model_reasoning_effort=<effort>` |
| Built-in guidance | none against overrides | the `spawn_agent` description says not to set `model` unless the user asks; the skills override that because the repository policy is the user's standing request |
| Effective-model verification (operator check) | the Agent tool call shows the parameters, and the subagent's system prompt names its model | the child cannot read its model reliably; verify with `sqlite3 ~/.codex/state_5.sqlite "select agent_role, model, reasoning_effort from threads order by rowid desc limit 5"` (Codex 0.162 schema) or the thread view |

### Discovery, trust, and versions

The per-invocation `effort` parameter needs Claude Code 2.1.292 or later; Codex needs a release with `spawn_agent` (subagent workflows are on by default in current releases).

Claude Code loads `.claude/agents/` and `.claude/skills/` by walking up from the working directory to the repository root, so they load from the root, a nested directory, and a linked worktree. No trust step gates them. A project agent with the same name as a personal agent replaces the personal one, and a personal skill shadows a project skill of the same name. `/review-security` has `disable-model-invocation: true`, so only a person can start it.

Codex loads `.agents/skills/` from every directory between the working directory and the repository root, in trusted and untrusted projects alike. It loads `.codex/agents/` only when the project is trusted (`trust_level = "trusted"` for the repository path in `~/.codex/config.toml`, which Codex writes when you accept the trust prompt). A linked worktree inherits the main checkout's trust. Until the project is trusted, `spawn_agent` reports an unknown `agent_type` for `*`, and the skills say so instead of continuing. Inline delivery and stack operations need no agent, so they start without trust, but a delivery that needs the pre-PR reviewer stops at that gate. Codex lists skills that share a name side by side rather than picking one. `$review-security` has `allow_implicit_invocation: false`, so Codex never picks it on its own.

Generated identifiers carry no repository prefix, so a contributor's own agent or skill with the same name, such as a personal `implement` skill, can shadow or clash with a generated one; keep personal names distinct.

Trusting the folder activates the agent definitions. Nothing here installs, copies, symlinks, or registers agent definitions outside the checkout, and a session in another repository does not see them. Ordinary prerequisites stay the contributor's: the tool itself, `gh` with authentication, the `gh stack` extension for stacked branches, and the repository's own dependencies for its checks.

### Manual review publication

`review-code` posts the reviewer's report to an open target pull request after `code-reviewer` returns. The reviewer itself stays read-only, and the skill posts through `npx agenticool-agents publish-review`, so both tools follow one rule. That command reads the pull request again and posts nothing when the pull request is merged or closed, or when its head moved or the merge base of its current base and head is no longer the reviewed base. It compares the `gh api user` login with the PR creator's login and submits one review pinned to the reviewed head commit. The event is `REQUEST_CHANGES` only for a `REQUEST CHANGES` verdict from a different account, because GitHub rejects a change request or an approval from a pull request's own author. Every other case, including an identity it cannot establish, is a `COMMENT` review whose body says why when the event differs from the verdict. It never approves. Branch reviews and the implementer's pre-PR reviews post nothing. The package tests cover each case against mocked `gh` responses.

### Known limitations

- Codex skills cannot change the session model, so the issue-creation policy for Codex is advisory for the main thread and binding only for a spawned triager.
- `implement` cannot change the session model in either tool. The implementation policy binds only an isolated implementer; inline delivery runs at the session settings and reports the policy as advisory.
- Inline delivery keeps exploration in the main conversation and requires an explicit `inline` request for a small leaf or rework. The default main thread stays thin and records only ledger and fixed result fields.
- If a Codex runtime refuses main -> implementer -> reviewer depth, the main thread starts the reviewer, reads verdict/blocker lines, and passes a complete findings file to the implementer. Exact-SHA approval and the two-round limit still apply.
- Token metrics are available only when a tool exposes them. PR usage records name unavailable input, cached input, output, and reasoning metrics for parent, implementer, and reviewer and make no savings claim.
- Claude Code honors `CLAUDE_CODE_EFFORT_LEVEL` above everything, including the repository policy and a prompt override. Leave it unset when you want the repository defaults.
- Reports carry requested settings, never verified ones. Codex cannot verify a child's model from inside the child; the thread table or thread view is the ground truth.
- Prompt overrides are read from natural language by the dispatching skill; the resolver validates the values but cannot see the request.
- Codex approval rules belong to each contributor. The package ships no exec policy, so a contributor's own rules decide which `git` and `gh` commands run without a prompt.
- The shared sources also name the documents in `binding.docs.workflow` and `binding.docs.guides`, which the consumer repository provides; `sync` writes `AGENTS.md`'s shared sections, `.github/labels.json`, `.github/pull_request_template.md`, and `binding.docs.triage`. No shared source, `AGENTS.md` section, or board template names `CONTRIBUTING.md`, which stays a guide for people: the rules agents need from it, such as workflow names, Status meanings, and blocked-by dependencies, live in the synced `AGENTS.md` sections and `ISSUE_TRIAGE.md`. Set `binding.docs.guides` to agent-facing files only; a test fails when a shared file names `CONTRIBUTING.md`.
