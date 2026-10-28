# @agenticool/workflow-lint

Lint a repository's GitHub Actions workflows: names, timeouts, checkout credentials, Node version source, and pull_request_target safety. Parses YAML with [`yaml`](https://www.npmjs.com/package/yaml), which keeps the comments the checkout rule reads.

The reusable PR-title and secret-scan workflows live at the monorepo root; see [Reusable workflows](../../README.md#reusable-workflows).

## Bins

`agenticool-workflow-lint [--dir .github/workflows]` lints every `.yml` and `.yaml` file in the directory, which must sit at `<root>/.github/workflows`. It reads the config from `.agents/policy.json` in the working directory. Each violation prints one line, `<file> [<job>] [<rule>] <message>`, with the file relative to the repository root. The exit code is 1 when there is any violation or error, otherwise 0.

## Exports

| Export | What it does |
| --- | --- |
| `lintWorkflows(dir, { config?, repository? })` | Runs every rule over a workflow directory and returns `{ file, job?, rule, message }` violations. `config` is the `workflowLint` section; `repository` is `binding.repository` |
| `rules` | The rule modules, each `{ rule, check(context) }` |
| `main(argv, { cwd?, stdout?, stderr? })` | The bin; returns the exit code |

## Rules

| Rule | Checks |
| --- | --- |
| `names` | Files are `<area>-<purpose>.yml` with a known area, and the workflow name starts with the area's prefix and `: `. A file starts with `_` and its name ends with ` (reusable)` only when it runs on `workflow_call`; a workflow that runs only on `workflow_call` starts with `_`. Job IDs are kebab-case, job names start with a capital letter or an expression, and step names start with a capital letter. A workflow not started by `pull_request`, `push`, or `workflow_call` has a `run-name` with an expression. `workflow_run` triggers name existing workflows. Files in `exclude` are skipped |
| `required-checks` | Each `requiredChecks` job exists, keeps its name, and has no matrix |
| `timeouts` | Every job that runs steps sets `timeout-minutes` to a positive whole number; a job that calls a reusable workflow cannot set it |
| `checkout-credentials` | Every `actions/checkout` step sets `persist-credentials: false`, or has `# persist-credentials: kept for "<later step name>"` directly above it, naming a later step in the same job |
| `node-version` | `.tool-versions` pins `nodejs <major>.<minor>.<patch>`. Every `actions/setup-node` step, in workflows and in `.github/actions/*/action.yml` composite actions, reads `node-version-file: .tool-versions`, sets no `node-version`, and runs after a checkout of the repository root. No file sets `node-version` anywhere, and at least one setup-node step exists |
| `pull-request-target` | Exactly the workflows in `pullRequestTarget` run on `pull_request_target`. Their jobs call no reusable workflow other than an agenticool one (`agenticool/agenticool/.github/workflows/_<name>.yml`) pinned at a full commit SHA or a release tag such as `tracker-v1.2.3`, whose jobs check out only the caller's default branch. In `agenticool/agenticool` itself, a local call to its tracker workflows (`./.github/workflows/_tracker-<name>.yml`) also passes, because GitHub loads it from the same default-branch commit as the caller. They check out neither the pull request head nor a repository other than the base (`binding.repository` or a `github.repository` expression), and neither `git fetch` the head nor run `gh pr checkout` |

## Config keys

The bin requires `workflowLint` and `binding.repository` in `.agents/policy.json`.

| Key | Meaning |
| --- | --- |
| `binding.repository` | `owner/name`; a checkout of it counts as the base repository |
| `workflowLint.areas` | File name area to the workflow name prefix it requires, such as `{ "ci": "CI" }` |
| `workflowLint.exclude` | Vendor workflow files the `names` rule skips |
| `workflowLint.pullRequestTarget` | The workflow files that run on `pull_request_target` |
| `workflowLint.requiredChecks` | `{ file, job, name }` jobs a branch ruleset requires as status checks |
