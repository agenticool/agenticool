# @agenticool/tracker

Keep a GitHub Project in step with issues and pull requests: triage, Done and Inbox, containers, membership, closing-issue status, and issue metadata on pull requests.

The package exports the tracker core and the triage reconcilers. Every GitHub call goes through `@agenticool/github`, and every repository and project fact comes from the policy that `@agenticool/policy` loads.

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
