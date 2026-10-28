# @agenticool/spec-to-issues

File a confirmed specification plan as linked GitHub issues, and resume an interrupted filing from its state file.

[state-file.md](state-file.md) is the normative state directory and `state.json` format, and [github-operations.md](github-operations.md) the normative REST calls, pacing, retries, and resume lookup. Every GitHub call goes through `@agenticool/github`; triage and container reconciliation run in-process through `@agenticool/tracker`. Install this package next to `@agenticool/spec-parser`, whose bodies and pre-flight rules it uses.

## Bins

The `agenticool-spec` command of `@agenticool/spec-parser` loads this package for the commands below. This package depends on spec-parser, so spec-parser's bin imports it only when a filing command runs, and says to install it when it is missing.

| Command | What it does |
| --- | --- |
| `agenticool-spec plan <spec> --state <dir>` | Prints the tree as `plan` always does, records the plan digest (`planSha256`) unconfirmed in `<dir>/plan.json`, and prints `Plan digest: <sha256>` |
| `agenticool-spec confirm <digest> --state <dir>` | Marks the recorded plan confirmed when `<digest>` is its digest. A person or skill runs it after reviewing the printed tree. |
| `agenticool-spec file <spec> --state <dir> [--assignee <login>] [--groups <file>]` | Files the plan, or continues a filing whose `state.json` exists |
| `agenticool-spec resume <spec> --state <dir>` | Continues a filing; fails when `state.json` does not exist |

`file` refuses to run unless `<dir>/plan.json` is confirmed for the same specification path and its digest equals the digest of the plan rebuilt from the specification now. Running `plan --state` again resets the confirmation. The state directory must sit outside every git checkout; the skill passes the path state-file.md describes.

`--groups <file>` is a JSON object of independence groups keyed by epic, as the skill records them from the triager's `GROUPS` lines: `{ "Phase 0": [["P0.1", "P0.3"], ["P0.2"]] }`. Each group lists Plan IDs of that epic's direct leaf children, and no leaf appears twice. `file` stores each epic's groups in `state.json` and appends its independence record to the epic body as spec-parser's body-shapes.md describes. The groups never add edges: the specification's `Blocked by` fields are the only blocked-by source. A resume reuses the recorded groups and refuses `--groups`.

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

## Config keys

Read from `.agents/policy.json` in the working directory:

| Key | Used for |
| --- | --- |
| `binding.repository` | The repository the issues are filed in |
| `binding.project.owner`, `binding.project.number`, `binding.project.name` | The project that gets Priority and Size |
| `binding.project.ownerType` | `user` (default) uses `users/<owner>/projectsV2/<number>` REST paths, `organization` uses `orgs/<owner>/...` |
| `binding.namespace` | The agent prefix in rendered bodies and the independence record markers; empty when absent |
| `binding.tokenEnv` | The token variable that failure messages redact |

## Exports

Every function that calls GitHub takes `run` with the signature of `execFileSync`, plus `sleep(ms)` and `now()`, so tests use a fake `gh` and a fake clock.

| Export | Purpose |
| --- | --- |
| `main(argv, { cwd, run, sleep, now, log, error })` | Runs `confirm`, `file`, or `resume` and returns the exit code |
| `fileSpec({ spec, state, policy, resume?, assignee?, groups?, run, sleep, now, log })` | Files or resumes as described above and returns the final state |
| `recordPlan(dir, { spec, text, plan, bodies })` | Writes the unconfirmed plan digest to `<dir>/plan.json` and returns it |
| `confirmPlan(dir, digest)`, `readPlan(dir)` | Confirms the recorded plan; reads `plan.json`, or returns `null` |
| `planDigest(plan, bodies)`, `sha256(text)` | `planSha256` of rendered bodies; a hex SHA-256 |
| `stateDirectory(dir)` | Resolves and creates a state directory, refusing one inside a git checkout |
| `checkGroups(plan, groups)`, `independenceRecord(groups, prefix)` | Validates a groups object; the record appended to an epic body, with placeholders |
| `restClient({ run, sleep, now })` | REST `read`, `pages`, and paced, rate-limit-aware `write` |
| `CREATE_GAP`, `WRITE_GAP`, `RETRIES`, `PROJECT_WAIT`, `PROJECT_POLL` | 3 s, 1 s, 5 retries, 3 min, 10 s |
