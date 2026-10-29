# @agenticool/spec

Parse a specification written to the spec-slicing format, check its pre-flight rules, and render every issue body offline, then file the confirmed plan as linked GitHub issues and resume an interrupted filing from its state file.

[spec-slicing.md](spec-slicing.md) is the normative format: numbered sections, the `Delivery plan` section, phases, slices, stacks, deferred tables, Plan IDs, and the pre-flight rules. [body-shapes.md](body-shapes.md) is the normative shape of every rendered body: root container, epic, stack container, and leaf. [fixtures/conforming-spec.md](fixtures/conforming-spec.md) passes every rule; [fixtures/violating-spec.md](fixtures/violating-spec.md) fails `acyclic`. [state-file.md](state-file.md) is the normative state directory and `state.json` format, and [github-operations.md](github-operations.md) the normative REST calls, pacing, retries, and resume lookup. Every GitHub call goes through `@agenticool/core`; triage and container reconciliation run in-process through `@agenticool/board`.

## Bins

`agenticool-spec plan <spec> [--bodies <dir>] [--json <file>]` parses the specification, checks the structural pre-flight rules in order, renders every body, checks `body-size` and `template-headings`, and stops at the first rule that fails. It makes no GitHub call.

- A violation prints one `[<rule>] <message>` line per problem to stderr, naming the phase, slice, or section, and exits 1.
- A clean plan prints the tree to stdout and exits 0: one line per item in tree order (root, each epic, its containers and leaves), indented two spaces per level, with columns `#n kind Plan ID size priority parent blocked by labels title`. `#n`, parents, and blockers are creation positions written `(n)`. Totals per kind follow.
- `--json <file>` also writes the parsed plan as JSON on success.
- `--bodies <dir>` also writes each rendered body, with its `@@issue:KEY@@` placeholders, to `<dir>/<KEY>.md` on success, such as `Plan.md`, `Phase 0.md`, `Stack P1.1.md`, and `P0.1.md`. The directory must be outside any git checkout, so drafts never land in tracked paths; it is created when missing.

`agenticool-spec plan <spec> --state <dir> [--groups <file>] [--assignee <login>]` also records the plan, its independence groups, and its assignee in `<dir>/plan.json`, and prints each epic's groups, the totals, the assignee, the state directory, and `Plan digest: <sha256>`. `agenticool-spec confirm <digest> --state <dir>`, `agenticool-spec file <spec> --state <dir>`, and `agenticool-spec resume <spec> --state <dir>` file the confirmed plan, as [Filing](#filing) describes.

The offline half of `label-exists` reads `.github/labels.json` in the working directory, plus `labels.extra` from `.agents/policy.json` when that file exists. Without `.github/labels.json` the rule is skipped, with a note on stderr. `template-headings` reads `.github/ISSUE_TEMPLATE/epic.yml`, `container.yml`, and `task.yml` in the working directory, and uses the default form in [fixtures/ISSUE_TEMPLATE/](fixtures/ISSUE_TEMPLATE/) for each one that is missing.

## Exports

| Export | What it does |
| --- | --- |
| `parse(text)` | Reads a specification into a plan: title, numbered sections, the delivery plan's `Definition of done` and `Class catalog`, phases, slices (headings and deferred tables), stacks, items numbered in creation order, section claims and owners, `§` references, Plan ID mentions, and format problems. Never throws on malformed input. |
| `preflight(plan, { labels?, labelSource? })` | Checks the rules in order and returns the violations of the first failing rule as `[<rule>] <message>` strings, or `[]`. `label-exists` runs only when `labels` lists the known label names; `labelSource` names the catalog in its messages (default `.github/labels.json`). |
| `RULES` | The rule names `preflight` checks, in order |
| `printTree(plan)` | The dry-run tree described under Bins |
| `render(plan, text)` | Every item's body as body-shapes.md describes, keyed by item key in creation order, with `@@issue:KEY@@` placeholders. `text` is the specification the plan was parsed from, and the plan must pass `preflight`. Carried text keeps code spans and fenced code as written; elsewhere `§x.y` becomes `§x.y (@@issue:OWNER@@)` and a Plan ID becomes `Pn.m (@@issue:Pn.m@@)`, except references to the body's own item. No body names the specification's path or URL. |
| `checkBodies(plan, bodies, { forms })` | Checks `body-size`, then `template-headings`, and returns the violations of the first failing rule as `[<rule>] <message>` strings, or `[]`. |
| `loadIssueForms(base?)` | The `epic`, `container`, and `task` issue forms from `<base>/.github/ISSUE_TEMPLATE/` (default the working directory), each falling back to the shipped default, as lists of `{ label, id, required }` |
| `readIssueForm(text)` | The non-markdown fields of one issue form YAML, in order, as `{ label, id, required }` |
| `resolveOwner(claims, number)` | The item key that owns a section: the claimant of the section or of its nearest claimed ancestor, or `null` |
| `expandBraces(pattern)` | Expands `{a,b}` groups in a `Files` entry |
| `filesMatch(entry, path)` | Whether a `Files` entry covers a class catalog row's path, by whole-segment suffix or, for an entry ending in `/`, by containment |
| `PLAN_ID`, `CROSS_SPEC` | Patterns for a Plan ID and a `spec <n> <Plan ID>` cross-spec entry |

### Plan items

Items are numbered in creation order: the root container, epics in phase order, one container per stack, then leaves in specification order. Keys are `Plan` (root), `Phase <id>` (epic), `Stack <stem>` (container, the Plan ID stem of its layers), and the Plan ID (leaf). Each item has its `kind` (`container`, `epic`, or `leaf`), `title`, `size`, `priority`, `parent` key, `blockedBy` keys, and `labels`, as the guide's "What the skill files" table sets them.

### Rules

`preflight` checks `reserved-text`, `plan-section`, `phase-format`, `slice-format`, `cross-spec-prerequisites`, `slice-unique`, `title-unique`, `blocked-by-resolves`, `acyclic`, `stack-shape`, `section-owner`, `section-reference`, `plan-id-reference`, `no-filler`, and `label-exists`. The guide's `body-size` and `template-headings` rules check rendered bodies, so `checkBodies` runs them after `render`.

`body-size` fails when a body, the root's included, reaches 65,536 characters with every placeholder filled as `#9999999`. An epic with two or more direct leaf children, and the root of a plan with two or more leaves, also counts the largest independence record the groups step can append: one `- gN: #9999999` line per leaf it can name (every leaf of the plan, for the root) between `<!-- independence-groups -->` markers. `template-headings` fails when a body's `###` headings outside fenced code are not its form's labels in order: the root and stack containers use `container.yml`, epics `epic.yml`, and leaves `task.yml`. Every required label must appear; the `parent` field may read `Parent issue` or `Parent epic`; an epic may end with `Contracts` and then `Independence groups`, and the root with `Independence groups`.

A `Cross-spec prerequisites` entry (`spec <n> <Plan ID>`) is kept on the slice as text in `crossSpec` and never becomes a blocked-by edge or a Plan ID reference. `` Files: `none` `` marks a slice that changes no source files: its `files` is `['none']`, its `paths` is empty, and it matches no catalog row.

## Filing

| Command | What it does |
| --- | --- |
| `agenticool-spec plan <spec> --state <dir> [--groups <file>] [--assignee <login>]` | Checks the groups, records the plan, groups, and assignee unconfirmed in `<dir>/plan.json`, and prints the tree, the plan-wide and each epic's groups as Plan IDs (or `none`), the totals, the assignee (or `none`), the state directory, and `Plan digest: <sha256>` |
| `agenticool-spec confirm <digest> --state <dir>` | Marks the recorded plan confirmed when `<digest>` is its digest. A person or skill runs it after reviewing the printed output. |
| `agenticool-spec file <spec> --state <dir>` | Files the confirmed plan with its confirmed groups and assignee, or continues a filing whose `state.json` exists |
| `agenticool-spec resume <spec> --state <dir>` | Continues a filing; fails when `state.json` does not exist |

The confirmation digest is the SHA-256 of `planSha256`, the groups (keys in sorted order, as JSON), and the assignee, so the person confirms all three. `file` refuses to run unless `<dir>/plan.json` is confirmed with the digest of its own contents, for the same specification path, and its `planSha256` equals the digest of the plan rebuilt from the specification now. Running `plan --state` again resets the confirmation, and editing `plan.json` after `confirm` breaks it. `state.json` keeps `planSha256` without the groups, as state-file.md defines it, for the resume check. When `state.json` exists, `file` also refuses confirmed groups or an assignee that differ from the ones it recorded. The state directory must sit outside every git checkout; the skill passes the path state-file.md describes.

`plan --groups <file>` takes a JSON object of independence groups keyed by `Plan` or by epic. The skill records the triager's plan-wide `Plan | GROUPS` line under `Plan`, where a group may list leaves of any epic, stack layers included: `{ "Plan": [["P0.1", "P1.2"], ["P0.2", "P2.1"]] }`. An epic key, such as `{ "Phase 0": [["P0.1", "P0.3"], ["P0.2"]] }`, lists only that epic's direct leaf children. No leaf appears twice under one key. `file` stores the groups on the root or epic item in `state.json` and appends each independence record to that body as body-shapes.md describes; the delivery queue reads the root's record across epics. The groups never add edges: the specification's `Blocked by` fields are the only blocked-by source. A resume reuses the groups and assignee recorded in `state.json`.

`file` and `resume` run in this order, writing `state.json` atomically after every successful GitHub write:

1. Check the state: a different specification path, a changed specification, or a changed plan stops the run. Rebuild and pre-flight the plan, append the groups, and write `bodies/`.
2. Check the live repository before any write: `label-exists` against the repository's labels, then the authenticated login, the assignee, and the project's Priority and Size fields with every option the plan uses.
3. Resume lookup: adopt, by title, each issue an interrupted run created but did not record. Two issues with one title stop the run.
4. Create each item without a number, in creation order, with predicted numbers (the latest issue or pull request number plus the item's position among the items still to create). `startedAt` is set 5 minutes early, in whole seconds, before the first create. A create that returns another number sets `mismatch`, and filing continues with new predictions.
5. Patch every body whose filled text differs from what was sent, when `mismatch` is set or an earlier run created items.
6. Link each item to its parent as a sub-issue, then link each blocker, deferred epics included, after checking GitHub's lists.
7. List the project's items once, wait up to 3 minutes for the repository automation (re-listing every 10 seconds), add each issue still missing, then set Priority and Size. Status is never set.
8. Run `reconcile` (triage) for each created issue, then `reconcileContainers` once for the root.

Creates are at least 3 seconds apart and other writes 1 second apart. A secondary rate limit waits `retry-after` seconds, or 60 without one, doubles on each further limit, and fails after five retries; the failure message prints the resume command.

### Filing exports

Every function that calls GitHub takes `run` with the signature of `execFileSync`, plus `sleep(ms)` and `now()`, so tests use a fake `gh` and a fake clock.

| Export | Purpose |
| --- | --- |
| `main(argv, { cwd, run, sleep, now, log, error })` | Runs `confirm`, `file`, or `resume` and returns the exit code |
| `fileSpec({ spec, state, policy, resume?, run, sleep, now, log })` | Files or resumes as described above and returns the final state |
| `recordPlan(dir, { spec, text, plan, bodies, groups?, assignee? })` | Writes the unconfirmed plan, groups, and assignee to `<dir>/plan.json` and returns `{ digest, output }`, the text `plan --state` prints |
| `confirmationDigest({ planSha256, groups, assignee })` | The digest a person confirms |
| `confirmPlan(dir, digest)`, `readPlan(dir)` | Confirms the recorded plan; reads `plan.json`, or returns `null` |
| `planDigest(plan, bodies)`, `sha256(text)` | `planSha256` of rendered bodies; a hex SHA-256 |
| `stateDirectory(dir)` | Resolves and creates a state directory, refusing one inside a git checkout |
| `checkGroups(plan, groups)`, `independenceRecord(groups)` | Validates a groups object; the record appended to an epic body, with placeholders |
| `restClient({ run, sleep, now })` | REST `read`, `pages`, and paced, rate-limit-aware `write` |
| `CREATE_GAP`, `WRITE_GAP`, `RETRIES`, `PROJECT_WAIT`, `PROJECT_POLL` | 3 s, 1 s, 5 retries, 3 min, 10 s |

## Config keys

Read from `.agents/policy.json` in the working directory, when the file exists for `plan` and always for `file` and `resume`:

| Key | Used for |
| --- | --- |
| `labels.extra` | The offline half of `label-exists`, with `.github/labels.json` |
| `binding.project.owner`, `binding.project.number`, `binding.project.name` | The project that gets Priority and Size |
| `binding.project.ownerType` | `user` (default) uses `users/<owner>/projectsV2/<number>` REST paths, `organization` uses `orgs/<owner>/...` |

The issues are filed in the repository the `origin` remote points at, and failure messages redact `AGENTICOOL_PROJECT_TOKEN`. The library functions other than `main` read no configuration.
