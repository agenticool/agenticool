# @agenticool/spec-parser

Parse a specification written to the spec-slicing format, check its pre-flight rules, and render every issue body offline.

[spec-slicing.md](spec-slicing.md) is the normative format: numbered sections, the `Delivery plan` section, phases, slices, stacks, deferred tables, Plan IDs, and the pre-flight rules. [fixtures/conforming-spec.md](fixtures/conforming-spec.md) passes every rule; [fixtures/violating-spec.md](fixtures/violating-spec.md) fails `acyclic`.

## Bins

`agenticool-spec plan <spec> [--json <file>]` parses the specification, checks the structural pre-flight rules in order, and stops at the first rule that fails. It makes no GitHub call.

- A violation prints one `[<rule>] <message>` line per problem to stderr, naming the phase, slice, or section, and exits 1.
- A clean plan prints the tree to stdout and exits 0: one line per item in tree order (root, each epic, its containers and leaves), indented two spaces per level, with columns `#n kind Plan ID size priority parent blocked by labels title`. `#n`, parents, and blockers are creation positions written `(n)`. Totals per kind follow.
- `--json <file>` also writes the parsed plan as JSON on success.

The offline half of `label-exists` reads `.github/labels.json` in the working directory, plus `labels.extra` from `.agents/policy.json` when that file exists. Without `.github/labels.json` the rule is skipped, with a note on stderr.

## Exports

| Export | What it does |
| --- | --- |
| `parse(text)` | Reads a specification into a plan: title, numbered sections, the delivery plan's `Definition of done` and `Class catalog`, phases, slices (headings and deferred tables), stacks, items numbered in creation order, section claims and owners, `§` references, Plan ID mentions, and format problems. Never throws on malformed input. |
| `preflight(plan, { labels?, labelSource? })` | Checks the rules in order and returns the violations of the first failing rule as `[<rule>] <message>` strings, or `[]`. `label-exists` runs only when `labels` lists the known label names; `labelSource` names the catalog in its messages (default `.github/labels.json`). |
| `RULES` | The rule names `preflight` checks, in order |
| `printTree(plan)` | The dry-run tree described under Bins |
| `resolveOwner(claims, number)` | The item key that owns a section: the claimant of the section or of its nearest claimed ancestor, or `null` |
| `expandBraces(pattern)` | Expands `{a,b}` groups in a `Files` entry |
| `filesMatch(entry, path)` | Whether a `Files` entry covers a class catalog row's path, by whole-segment suffix or, for an entry ending in `/`, by containment |
| `PLAN_ID`, `CROSS_SPEC` | Patterns for a Plan ID and a `spec <n> <Plan ID>` cross-spec entry |

### Plan items

Items are numbered in creation order: the root container, epics in phase order, one container per stack, then leaves in specification order. Keys are `Plan` (root), `Phase <id>` (epic), `Stack <stem>` (container, the Plan ID stem of its layers), and the Plan ID (leaf). Each item has its `kind` (`container`, `epic`, or `leaf`), `title`, `size`, `priority`, `parent` key, `blockedBy` keys, and `labels`, as the guide's "What the skill files" table sets them.

### Rules

`preflight` checks `reserved-text`, `plan-section`, `phase-format`, `slice-format`, `cross-spec-prerequisites`, `slice-unique`, `title-unique`, `blocked-by-resolves`, `acyclic`, `stack-shape`, `section-owner`, `section-reference`, `plan-id-reference`, `no-filler`, and `label-exists`. The guide's `body-size` and `template-headings` rules check rendered bodies and are not part of `preflight`.

A `Cross-spec prerequisites` entry (`spec <n> <Plan ID>`) is kept on the slice as text in `crossSpec` and never becomes a blocked-by edge or a Plan ID reference. `` Files: `none` `` marks a slice that changes no source files: its `files` is `['none']`, its `paths` is empty, and it matches no catalog row.

## Config keys

`labels.extra` in `.agents/policy.json`, read only by the bin, and only when the file exists. The library reads no configuration.
