# @agenticool/policy

Load and validate a repository's `.agents/policy.json`, resolve models and efforts, and apply the implementation effort rubric. Internal to @agenticool; no stability promise for other callers.

## Bins

None.

## Exports

| Export | What it does |
| --- | --- |
| `loadPolicy(base?, { sections? })` | Reads `<base>/.agents/policy.json` (`base` defaults to the working directory), validates it, fills in defaults, and requires each listed section |
| `validatePolicy(policy, { sections? })` | The same validation for a parsed policy |
| `schema`, `POLICY_PATH` | The JSON Schema object and the policy file path |
| `prefix(policy)` | `<namespace>-`, the agent and skill name prefix |
| `repository(policy)` | `owner/name` of the repository |
| `project(policy)` | `{ owner, ownerType, number, name }` of the delivery project; `ownerType` defaults to `user` |
| `tokenEnv(policy)` | Name of the environment variable that holds the Projects token |
| `binding(policy)` | The full binding the agent sources need, or an error naming the first missing key |
| `placeholders(policy)` | The `{{placeholder}}` values a source may use |
| `TOOLS` | `['claude', 'codex']` |
| `resolve(policy, { tool, role?, capability?, model?, effort? })` | The model, effort, and spawn parameters for a role or capability, with overrides applied one setting at a time; unsupported values throw |
| `implementationEffort(policy, { decision?, transitions? })` | The implementation effort a recorded decision earns under the rubric |

The schema is also exported as `@agenticool/policy/policy.schema.json`, so a policy file can point its `$schema` at `node_modules/@agenticool/policy/src/policy.schema.json`.

## Sections

The schema rejects unknown keys and wrong types everywhere, but requires no section by itself. Each caller passes the dotted paths it reads, such as `sections: ['binding.repository', 'binding.project']`, and loading fails when one is missing. A repository configures only what its installed packages read. A path the schema does not define fails as an unknown section.

## Config keys

| Key | Type | Meaning |
| --- | --- | --- |
| `binding.namespace` | lowercase letters and digits | Agent and skill name prefix, without the dash |
| `binding.label` | string | Display name of the repository |
| `binding.repository` | `owner/name` | The GitHub repository |
| `binding.project` | `{ owner, ownerType, number, name }` | Delivery project; `ownerType` is `user` (default) or `organization` |
| `binding.tokenEnv` | `UPPER_CASE` name | Environment variable that holds the Projects token |
| `binding.docs` | `{ triage, workflow, guides[] }` | Tracker documents the agent sources name |
| `binding.features.infrastructure` | boolean | Infrastructure sections in the agent sources |
| `binding.features.releasePlease` | boolean, default `false` | Release pull requests get package labels |
| `binding.features.browserMcp` | boolean, default `false` | Sync writes project MCP configuration for browser tools |
| `capabilities.<name>` | `{ summary?, claude: { model, effort }, codex: { model, effort } }` | Model and effort per tool |
| `roles.<role>` | capability name | The capability a role uses |
| `supported.<tool>` | `{ description?, modelIdPattern?, models: { <model>: [efforts] } }` | Models and efforts each tool accepts |
| `implementationEffort` | `{ default, automaticMaximum, maximumTransitions, rules, assessmentOrder?, blockers?, nonTriggers? }` | The effort rubric; each rule lists the criteria it `requires` |
| `labels.extra` | `[{ name, color, description }]` | Repository-only labels merged over the base catalog |
| `workflowLint` | `{ areas?, exclude?, pullRequestTarget? }` | Workflow area prefixes to name prefixes, vendor workflow files to skip, and workflows allowed to run on `pull_request_target` |
| `local` | `{ roles, workflows }` | Repository-only agent sources; default `.agents/local/roles` and `.agents/local/workflows` |

`$schema` and `description` are allowed at the top level.
