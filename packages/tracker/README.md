# @agenticool/tracker

Keep a GitHub Project in step with issues and pull requests: triage, Done and Inbox, containers, membership, closing-issue status, and issue metadata on pull requests.

The package exports the tracker core, the triage reconcilers, container closure, project membership, closing-issue status, and pull request metadata, plus the `agenticool-tracker` command, the repository templates, and the reusable tracker workflows. Every GitHub call goes through `@agenticool/github`, and every repository and project fact comes from the policy that `@agenticool/policy` loads.

## Bins

`agenticool-tracker <command> [--dry-run | --apply] …` reads `.agents/policy.json` in the working directory and prints `agenticool-tracker --help` for usage.

| Command | Options and environment | What it does |
| --- | --- | --- |
| `triage` | `--issue <n>` | Removes conflicting epic labels, moves eligible issues to Ready, and reconciles Done, for one issue or the whole project |
| `containers` | `--issue <n>` | Closes finished containers and reopens the ones it closed, for one issue's hierarchy or every issue |
| `membership` | `--issue <n>` or `CONTENT_TYPE` and `CONTENT_NUMBER`; `--sweep` or `SWEEP=true` | Adds one issue to the project, or every open issue missing from it |
| `pr-status` | `PR_NUMBER`, `PR_ACTION` | Moves the issues a pull request closes to In review |
| `pr-metadata` | `PR_NUMBER` | Copies linked issue labels, assignees, and milestone to a pull request |

- Without `--apply`, every command is a dry run unless `DRY_RUN=false`. `--dry-run` always wins. `DRY_RUN` and `SWEEP` must be `true` or `false`.
- `triage`, `containers`, and `membership` run between two GraphQL budget readings (`runTracker`): a sweep skips below the budget floor, and a single-issue run that is rate-limited or whose issue is gone warns and succeeds.
- `pr-status` reads GitHub through `metadataGraphql`, so a closing reference to a missing issue reads as `null`.
- With `GITHUB_ACTIONS=true`, every command requires the token variable named by `binding.tokenEnv` (`GITHUB_TOKEN` cannot reach Projects) and copies it into `GH_TOKEN`. `membership`, `pr-status`, and `pr-metadata` also require `GITHUB_REPOSITORY` to be `binding.repository`, and `pr-status` requires `PR_ACTION` to be `opened`, `edited`, `reopened`, or `ready_for_review`.
- The exit code is 1 on any failure and 0 otherwise, including for `--help`.

## Templates

`renderTemplate(name, policy)` reads `templates/<name>` and replaces each `{{placeholder}}` with a policy value; an unknown placeholder throws. GitHub Actions `${{ … }}` expressions stay as they are. The placeholders are those of `placeholders(policy)` from `@agenticool/policy` (`repository`, `project.name`, `project.url`, `docs.triage`, `docs.workflow`, and the rest), plus `tokenEnv` and `version`, this package's version.

| Template | Rendered copy in the consumer |
| --- | --- |
| `labels.json` | `.github/labels.json`, the base label catalog; `labels.extra` adds repository labels |
| `ISSUE_TEMPLATE/bug.yml`, `config.yml`, `container.yml`, `epic.yml`, `task.yml` | `.github/ISSUE_TEMPLATE/` |
| `pull_request_template.md` | `.github/pull_request_template.md` |
| `ISSUE_TRIAGE.md` | The path in `binding.docs.triage`: severity, Priority, and Size; Status meanings and who sets each; blocked-by dependencies; labels; and the leaf, container, and epic hierarchy |
| `workflows/tracker-issue-states.yml`, `tracker-project-membership.yml`, `tracker-pr-issue-status.yml`, `tracker-pr-metadata.yml` | `.github/workflows/`, the caller workflows |

## Reusable workflows

Each caller workflow template keeps its tracker workflow's triggers, label and body-edit filters, concurrency, and fork guard (`github.repository == '{{repository}}'`), and calls one reusable workflow from this repository with `secrets: inherit`, pinned at `tracker-v{{version}}`:

| Reusable workflow | Inputs | Runs |
| --- | --- | --- |
| `.github/workflows/_tracker-issue-states.yml` | `issue` (0 sweeps), `dry_run` | `membership` (sweep only), `triage`, `containers` |
| `.github/workflows/_tracker-project-membership.yml` | `issue` (0 sweeps), `dry_run` | `membership`, then `triage --issue` for one issue |
| `.github/workflows/_tracker-pr-issue-status.yml` | `pull_request`, `action`, `dry_run` | `pr-status` |
| `.github/workflows/_tracker-pr-metadata.yml` | `pull_request`, `dry_run` | `pr-metadata` |

Every reusable workflow also takes `token_env`, the name of the secret that holds the Projects token, which the templates fill from `binding.tokenEnv`. Each job checks out the caller's default branch, sets up Node.js from its `.tool-versions`, runs `npm ci`, and runs the caller's installed `npx --no agenticool-tracker`. When the `token_env` secret is empty or missing, each job prints a `<token_env> secret is not set; skipping` warning and succeeds without running those steps, so a repository can add the workflows before its project and token exist; a set but invalid token still fails the job. A caller therefore needs `@agenticool/tracker` in its `package.json` and `package-lock.json`, a `.tool-versions` with a `nodejs` line, and `.agents/policy.json` on its default branch.

## Config keys

Load the policy with `loadPolicy(base, { sections: SECTIONS })` (`binding.repository`, `binding.project`, `binding.tokenEnv`) and pass it as `policy`. `renderTemplate` also needs the full binding that `binding(policy)` checks.

| Key | Used for |
| --- | --- |
| `binding.repository` | The repository whose issues are reconciled; items from other repositories are skipped |
| `binding.project.owner`, `binding.project.number` | The Projects v2 board to read and write |
| `binding.project.ownerType` | `user` (default) reads the board through GraphQL `user(login:)`, `organization` through `organization(login:)` |
| `binding.project.name` | The project name in error messages |
| `binding.tokenEnv` | The token variable that failure messages redact, that the command requires in GitHub Actions, and the secret the caller workflows pass |
| `binding.docs.triage`, `binding.docs.workflow` | Document paths the issue forms, PR template, and `ISSUE_TRIAGE.md` link to |
| `binding.features.releasePlease` | `true` gives the release pull request package labels instead of issue labels (default `false`) |

## Exports

Every function that calls GitHub takes `api(query, variables)`, which returns GraphQL `data`. Pass `trackerGraphql` in production and a mock in tests.

### Core

| Export | Purpose |
| --- | --- |
| `trackerGraphql(query, variables, run?)` | GraphQL client: a deleted or transferred issue reads as `null`; a write to a target deleted mid-run throws `MissingIssueError`; every other error throws `GitHubError` |
| `paginate(fetchPage, first?)` | Reads every page of a connection, starting from a nested first page when given; rejects a cursor that does not advance |
| `discover(api, policy, required?)` | Finds the project and its single-select fields, failing unless each required field and option exists exactly once. Default: Status `Inbox`/`Ready`, Priority, and Size |
| `listItems(api, policy, projectId, filter)` | Project items matching a project search filter, with their first page of field values and labels |
| `issueItems(api, policy, number)` | One issue's unarchived project items; throws `MissingIssueError` when the issue is gone |
| `completeItem(api, node, context)` | Turns an item node into `{ id, type, project, fields, content, labels }`, reading only overflowing pages; `null` for an item of another project |
| `readItem(api, id, context)` | Re-reads one item by ID, or `null` when it left the project |
| `updateProjectStatus(api, context, itemId, status)` | Sets an item's Status |
| `runTracker({ policy, sweep, task, budget?, log?, warn?, error? })` | Runs a task between two GraphQL budget readings and returns the exit code. A sweep skips below `SWEEP_FLOOR` points; a single-issue run warns and succeeds on a rate limit; a missing issue warns and succeeds |
| `skipWrite(warn, write)` | Runs one write, warning and returning `false` when its target was deleted mid-run |
| `MissingIssueError`, `missingIssue(number)` | The error and message for an issue that no longer exists in the repository |
| `warning(message)` | Prints a GitHub Actions `::warning::` annotation |
| `PRIORITIES`, `SIZES`, `SWEEP_FLOOR`, `PAGE`, `EMPTY` | Priority and Size options, the sweep budget floor, the GraphQL page-info selection, and an empty connection |

### Triage

Each reconciler takes `{ api, policy, dryRun = true, issueNumber?, log?, warn? }`. Without `issueNumber` it sweeps the project; with one it reads only that issue. Every write re-reads the item first.

| Export | Purpose |
| --- | --- |
| `reconcile(options)` | Moves eligible open issues from Inbox or an empty Status to Ready; returns `{ candidates, updated }` |
| `reconcileDone(options)` | Moves closed issues to Done and reopened issues out of Done to Ready; returns `{ candidates, updated }` |
| `reconcileEpicLabels(options)` | Removes standard category and `type:` labels from issues labeled `epic` |
| `eligible(item, policy)` | Whether an item qualifies for Ready: an open issue of the repository with Inbox or no Status, one Priority, one Size, and exactly one supported severity label |
| `SWEEP_FILTER`, `SETTLED_STATUSES` | The triage sweep's project filter and the statuses it excludes |
| `DONE_FILTERS` | The two filters a Done sweep lists |
| `SEVERITIES` | The supported `severity:` labels |

### Containers

| Export | Purpose |
| --- | --- |
| `reconcileContainers({ api, policy, dryRun = true, issueNumber?, log?, warn? })` | Closes open containers whose sub-issues are all closed, setting Done, and reopens containers it closed when a sub-issue reopens, setting Ready. Without `issueNumber` it sweeps every issue; with one it reads only that issue's subtree and ancestors. Returns `{ updated }` |
| `MARKER` | The `automation: container-closed` label that marks a container this automation closed. It is added before closing, kept on a closed container, and removed only from an open, incomplete container after a fresh read. A container deleted or transferred during the run is skipped with a warning |

### Membership

| Export | Purpose |
| --- | --- |
| `addToProject({ api, policy, kind, number, dryRun = true, log? })` | Adds one issue (`kind` must be `issue`) to the project and sets Status `Inbox` when the item has none; an existing Status never changes. Returns the item's REST ID, or `null` on a dry run |
| `sweep({ api, policy, dryRun = true, log?, logError?, warn? })` | Adds every open issue missing from the project. An issue deleted before its add is a warning; any other failure is logged, the rest are added, and the sweep then fails. Returns `{ missing, failed }` |
| `INITIAL_STATUS` | `Inbox` |

### Pull request status

| Export | Purpose |
| --- | --- |
| `moveIssuesToReview({ api, policy, number, dryRun = true, log? })` | Moves the open issues an open, ready pull request closes to In review. Every write re-reads the pull request and the item first |
| `closingIssues(body, repository)` | Issue numbers that follow a closing keyword in a description, ignoring comments, code, and parent lines |
| `sourceStatuses(authorAssociation)`, `TRUSTED_AUTHORS` | Owners, members, and collaborators move Ready and In progress issues; other authors move only In progress issues |

### Pull request metadata

| Export | Purpose |
| --- | --- |
| `copyMetadata({ api, policy, number, dryRun = true, log? })` | Adds the labels, assignees, and single shared milestone of the issues an open pull request references, keeping what the pull request already has. A description edit during the run stops it before any write |
| `metadataGraphql(query, variables, run?)` | GraphQL client that reads a reference to a missing issue or pull request as `null` |
| `linkedIssues(body, repository)`, `referenceText(body)` | Issue references of the repository in a description, and the description without comments, code, and parent lines |
| `readMetadata(api, id)` | Label and assignee IDs of an issue or pull request |

### Command and templates

| Export | Purpose |
| --- | --- |
| `main(argv, { env?, cwd?, run?, log?, warn?, error? })` | The bin; returns the exit code. `run` replaces the `gh` subprocess in tests |
| `configuration(env, args, policy)` | The `triage` and `containers` options: `{ dryRun, issueNumber? }` |
| `SECTIONS`, `USAGE` | The policy sections the command loads, and its help text |
| `renderTemplate(name, policy)`, `TEMPLATES` | A rendered template, and the URL of the `templates/` directory |

### Release Please

Used by `copyMetadata` only when `binding.features.releasePlease` is `true`.

| Export | Purpose |
| --- | --- |
| `RELEASE_BRANCH`, `isReleasePullRequest(pr)` | The release pull request is the same-repository branch `release-please--branches--main` |
| `releasedComponents(config, base, head)` | Components in `release-please-config.json` whose `.release-please-manifest.json` version differs between two commits |
| `releaseLabels(api, policy, pr, log)` | IDs of the existing `package: <component>` labels for the components the release pull request changes |
