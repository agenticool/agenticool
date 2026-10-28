# @agenticool/spec-parser

Parse a specification written to the spec-slicing format, check its pre-flight rules, and render every issue body offline.

[spec-slicing.md](spec-slicing.md) is the normative format: numbered sections, the `Delivery plan` section, phases, slices, stacks, deferred tables, Plan IDs, and the pre-flight rules. [body-shapes.md](body-shapes.md) is the normative shape of every rendered body: root container, epic, stack container, and leaf. [fixtures/conforming-spec.md](fixtures/conforming-spec.md) passes every rule; [fixtures/violating-spec.md](fixtures/violating-spec.md) fails `acyclic`.

## Bins

`agenticool-spec plan <spec> [--bodies <dir>] [--json <file>]` parses the specification, checks the structural pre-flight rules in order, renders every body, checks `body-size` and `template-headings`, and stops at the first rule that fails. It makes no GitHub call.

- A violation prints one `[<rule>] <message>` line per problem to stderr, naming the phase, slice, or section, and exits 1.
- A clean plan prints the tree to stdout and exits 0: one line per item in tree order (root, each epic, its containers and leaves), indented two spaces per level, with columns `#n kind Plan ID size priority parent blocked by labels title`. `#n`, parents, and blockers are creation positions written `(n)`. Totals per kind follow.
- `--json <file>` also writes the parsed plan as JSON on success.
- `--bodies <dir>` also writes each rendered body, with its `@@issue:KEY@@` placeholders, to `<dir>/<KEY>.md` on success, such as `Plan.md`, `Phase 0.md`, `Stack P1.1.md`, and `P0.1.md`. The directory must be outside any git checkout, so drafts never land in tracked paths; it is created when missing.

`agenticool-spec plan <spec> --state <dir>` also records the plan digest in `<dir>/plan.json` and prints `Plan digest: <sha256>` after the tree. `agenticool-spec confirm <digest> --state <dir>`, `agenticool-spec file <spec> --state <dir> [--assignee <login>] [--groups <file>]`, and `agenticool-spec resume <spec> --state <dir>` file the confirmed plan. Those commands and `--state` live in `@agenticool/spec-to-issues`, which depends on this package, so the bin imports it only when one of them runs and says to install it when it is missing. Its README describes them.

The offline half of `label-exists` reads `.github/labels.json` in the working directory, plus `labels.extra` from `.agents/policy.json` when that file exists. Without `.github/labels.json` the rule is skipped, with a note on stderr. `template-headings` reads `.github/ISSUE_TEMPLATE/epic.yml`, `container.yml`, and `task.yml` in the working directory, and uses the default form in [fixtures/ISSUE_TEMPLATE/](fixtures/ISSUE_TEMPLATE/) for each one that is missing.

## Exports

| Export | What it does |
| --- | --- |
| `parse(text)` | Reads a specification into a plan: title, numbered sections, the delivery plan's `Definition of done` and `Class catalog`, phases, slices (headings and deferred tables), stacks, items numbered in creation order, section claims and owners, `§` references, Plan ID mentions, and format problems. Never throws on malformed input. |
| `preflight(plan, { labels?, labelSource? })` | Checks the rules in order and returns the violations of the first failing rule as `[<rule>] <message>` strings, or `[]`. `label-exists` runs only when `labels` lists the known label names; `labelSource` names the catalog in its messages (default `.github/labels.json`). |
| `RULES` | The rule names `preflight` checks, in order |
| `printTree(plan)` | The dry-run tree described under Bins |
| `render(plan, text, { prefix? })` | Every item's body as body-shapes.md describes, keyed by item key in creation order, with `@@issue:KEY@@` placeholders. `text` is the specification the plan was parsed from, and the plan must pass `preflight`. `prefix` is the agent prefix that names the implement skill in the root body (default empty). Carried text keeps code spans and fenced code as written; elsewhere `§x.y` becomes `§x.y (@@issue:OWNER@@)` and a Plan ID becomes `Pn.m (@@issue:Pn.m@@)`, except references to the body's own item. No body names the specification's path or URL. |
| `checkBodies(plan, bodies, { forms, prefix? })` | Checks `body-size`, then `template-headings`, and returns the violations of the first failing rule as `[<rule>] <message>` strings, or `[]`. `prefix` names the markers of the independence record that `body-size` counts for an epic. |
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

`body-size` fails when a body, the root's included, reaches 65,536 characters with every placeholder filled as `#9999999`. An epic with two or more direct leaf children also counts the largest independence record the groups step can append: one `- gN: #9999999` line per leaf between `<!-- <prefix>independence-groups -->` markers. `template-headings` fails when a body's `###` headings outside fenced code are not its form's labels in order: the root and stack containers use `container.yml`, epics `epic.yml`, and leaves `task.yml`. Every required label must appear; the `parent` field may read `Parent issue` or `Parent epic`; an epic may end with `Contracts` and then `Independence groups`.

A `Cross-spec prerequisites` entry (`spec <n> <Plan ID>`) is kept on the slice as text in `crossSpec` and never becomes a blocked-by edge or a Plan ID reference. `` Files: `none` `` marks a slice that changes no source files: its `files` is `['none']`, its `paths` is empty, and it matches no catalog row.

## Config keys

`labels.extra` and `binding.namespace` in `.agents/policy.json`, read only by the bin, and only when the file exists. `binding.namespace` followed by `-` is the agent prefix passed to `render` and `checkBodies`; without it the prefix is empty. The library reads no configuration.
