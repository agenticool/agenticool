# @agenticool/tracker

Keep a GitHub Project in step with issues and pull requests: triage, Done and Inbox, containers, membership, closing-issue status, and issue metadata on pull requests.

The package exports the tracker core, the triage reconcilers, container closure, project membership, closing-issue status, and pull request metadata. Every GitHub call goes through `@agenticool/github`, and every repository and project fact comes from the policy that `@agenticool/policy` loads.

## Bins

None.

## Config keys

Load the policy with `loadPolicy(base, { sections: ['binding.repository', 'binding.project', 'binding.tokenEnv'] })` and pass it as `policy`.

| Key | Used for |
| --- | --- |
| `binding.repository` | The repository whose issues are reconciled; items from other repositories are skipped |
| `binding.project.owner`, `binding.project.number` | The Projects v2 board to read and write |
| `binding.project.ownerType` | `user` (default) reads the board through GraphQL `user(login:)`, `organization` through `organization(login:)` |
| `binding.project.name` | The project name in error messages |
| `binding.tokenEnv` | The token variable that failure messages redact |
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

### Release Please

Used by `copyMetadata` only when `binding.features.releasePlease` is `true`.

| Export | Purpose |
| --- | --- |
| `RELEASE_BRANCH`, `isReleasePullRequest(pr)` | The release pull request is the same-repository branch `release-please--branches--main` |
| `releasedComponents(config, base, head)` | Components in `release-please-config.json` whose `.release-please-manifest.json` version differs between two commits |
| `releaseLabels(api, policy, pr, log)` | IDs of the existing `package: <component>` labels for the components the release pull request changes |
