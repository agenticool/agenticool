## GitHub Actions workflow names

- Workflow files are named `<area>-<purpose>.yml` in lowercase kebab-case, and each workflow's `name` starts with the area's prefix and `: `, as in `tracker-issue-states.yml`, named `Tracker: reconcile issue states`. `workflowLint.areas` in `.agents/policy.json` maps each area to its prefix; add an area there before you use it.
- A reusable workflow, one that runs on `workflow_call`, has a file name that starts with `_` and a `name` that ends in ` (reusable)`, as in `_tracker-issue-states.yml`, named `Tracker: reconcile issue states (reusable)`. A workflow that runs only on `workflow_call` must follow this rule; no workflow without `workflow_call` starts with `_` or ends its name with ` (reusable)`.
- Job IDs are kebab-case. Every job and every step has a name that says what it does and starts with a capital letter; a job name may start with an expression instead.
- A workflow that `pull_request`, `push`, or `workflow_call` does not start sets a `run-name` with an expression that names its subject. A `workflow_run` trigger names an existing workflow by its `name`.
- Vendor workflows listed in `workflowLint.exclude` keep the vendor's names. `npx agenticool-workflow-lint` checks these rules.
