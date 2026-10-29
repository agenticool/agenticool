# @agenticool/core

Internal helpers the other `@agenticool/*` packages share: GitHub calls through `gh api`, command-line parsing, and loading and validating a repository's `.agents/policy.json`. It is published only because the other packages depend on it. It has no stable public API; do not depend on it directly.

## Bins

None.

## GitHub calls

Every call runs `gh api --include`, so a failure carries GitHub's HTTP status and rate-limit headers. Messages carry GitHub's own error type and text, but never a token, request headers, gh stderr, or a response body that is not JSON.

Every function that runs `gh` takes an optional `run` with the signature of `execFileSync`, so tests never call GitHub.

| Export | Purpose |
| --- | --- |
| `ghRest(args, { run, input })` | Runs one REST call and returns the response body text. `input` is sent on stdin. |
| `ghRestPages(path, { run })` | Reads every page of a REST list by following the `Link` header and returns each page's parsed body. |
| `ghGraphql(query, variables, { run, allowErrors })` | Runs one GraphQL call and returns `data`. `allowErrors(result)` accepts a response whose errors the caller expects. |
| `graphqlBudget(run)` | Reads the GraphQL budget from the REST `rate_limit` endpoint without spending it: `{ limit, remaining, used, reset }`. |
| `GitHubError` | The error every failed call throws, with `kind` (`rate-limit`, `access`, `not-found`, `other`) and `httpStatus` when GitHub sent one. |
| `failureMessage(error)` | The only text an entry point prints for a failure. Hides raw subprocess errors and redacts tokens. |
| `redact(text, env?)` | Replaces the values of `GH_TOKEN`, `GITHUB_TOKEN`, and `AGENTICOOL_PROJECT_TOKEN` (from `env`, default `process.env`), and any text shaped like a GitHub token, with `***`. |
| `PROJECT_TOKEN` | `AGENTICOOL_PROJECT_TOKEN`, the secret and environment variable that hold the Projects token |
| `ghRequest(api, args, { input, run })` | Runs `gh api --include` and returns the parsed response with `failed`. |
| `parseResponse(output)` | Splits `gh api --include` output into `status`, lowercased `headers`, parsed `body`, and raw `text`. |
| `githubError(api, response)` | Builds the `GitHubError` for a response that failed or carried errors. |

## Command-line parsing

Exact aliases, `--option=value`, `--`, help, and usage errors, built on `node:util` `parseArgs` with no runtime dependencies. Each calling package defines its own options and help text.

- `defineCli(usage, definitions, { passthrough })` returns a CLI description. `definitions` maps each long option name to `{ type: 'string' | 'boolean', alias?, description }`. `--help` / `-h` is always added. It throws when two options share a spelling, including `--help` or `-h`.
- `parseCli(argv, cli)` returns `{ options, positionals, passthrough }`. It throws `CliHelp` (message: the help text) for `--help` or `-h`, and `CliError` (message: the problem, then the help text) for malformed input.
- `cliError(cli, message)` builds a `CliError` with the help text appended, for a caller's own validation.
- `CliError`, `CliHelp`: error classes, so a bin can print help to stdout and exit 0, or print the error to stderr and exit 1.

```js
import { CliError, CliHelp, defineCli, parseCli } from '@agenticool/core';

const cli = defineCli('Usage: branch-name [options] <issue>', {
  layer: { type: 'string', alias: 'l', description: 'Stack layer' },
  'dry-run': { type: 'boolean', alias: 'n', description: 'Preview only' },
});
const { options, positionals } = parseCli(process.argv.slice(2), cli);
```

### Parsing rules

- Spellings are exact: `--layer` and `-l`. Short options cannot be grouped (`-nl` is an error), and an alias may be longer than one letter (`-env`).
- String options accept `--layer=2` or `--layer 2`. A separate value may begin with a single dash (`-a -sam`), but not with `--` or a known spelling; use `--actor=--x` for those. An empty string value is an error.
- Boolean options take no value (`--dry-run=false` is an error).
- Each option may appear once.
- `--` ends options; every later token is a positional.
- An unknown token starting with `-` (other than `-` itself) is an error; other tokens are positionals.

#### Passthrough mode

With `{ passthrough: true }`, a wrapper parses its own options and forwards the rest to another command. Unknown tokens, and `--` with every token after it, go to `passthrough` in their original order instead of being rejected or treated as positionals. Known options still follow every rule above, so a duplicate or missing value is still an error.

## Policy

| Export | What it does |
| --- | --- |
| `loadPolicy(base?, { sections? })` | Reads `<base>/.agents/policy.json` (`base` defaults to the working directory), validates it, fills in schema defaults and `DEFAULTS`, and requires each listed section |
| `validatePolicy(policy, { sections? })` | The same validation for a parsed policy |
| `schema`, `POLICY_PATH` | The JSON Schema object and the policy file path |
| `repository(policy)` | `owner/name` of the repository, read once from the `origin` remote of the directory the policy was loaded from; a caller that already knows it sets `policy.repository` |
| `originRepository(base?)` | `owner/name` of the GitHub repository that `base`'s `origin` remote points at |
| `project(policy)` | `{ owner, ownerType, number, name }` of the delivery project; `ownerType` defaults to `user` |
| `binding(policy)` | The binding the agent sources need, with `label` (default: the repository name) and `repository` filled in, or an error naming the first missing key |
| `placeholders(policy)` | The `{{placeholder}}` values a source may use |
| `DEFAULTS`, `withDefaults(policy)` | The model, effort, role, and rubric defaults in `src/defaults.json`, and the merge `loadPolicy` applies: capabilities and roles by name, supported models by tool, and the rubric as a whole |
| `TOOLS` | `['claude', 'codex']` |
| `resolve(policy, { tool, role?, capability?, model?, effort? })` | The model, effort, and spawn parameters for a role or capability, with overrides applied one setting at a time; unsupported values throw |
| `implementationEffort(policy, { decision?, transitions? })` | The implementation effort a recorded decision earns under the rubric |

The schema is also exported as `@agenticool/core/policy.schema.json`, so a policy file can point its `$schema` at `node_modules/@agenticool/core/src/policy.schema.json`.

### Sections

The schema rejects unknown keys and wrong types everywhere, but requires no section by itself. Each caller passes the dotted paths it reads, such as `sections: ['binding.project']`, and loading fails when one is missing. A repository configures only what its installed packages read. A path the schema does not define fails as an unknown section.

## Config keys

| Key | Type | Meaning |
| --- | --- | --- |
| `binding.label` | string, optional | Display name of the repository; defaults to the repository name |
| `binding.project` | `{ owner, ownerType, number, name }` | Delivery project; `ownerType` is `user` (default) or `organization` |
| `binding.docs` | `{ triage, workflow, guides[] }`, optional | Board documents the agent sources name; default `ISSUE_TRIAGE.md`, `AGENTS.md`, and `["AGENTS.md"]` |
| `binding.infrastructure.accountChecks` | string[], optional | Files holding the cloud account checks the security reviewer inspects; read only with the infrastructure feature |
| `binding.features.infrastructure` | boolean, default `false` | Infrastructure sections in the agent sources |
| `binding.features.releasePlease` | boolean, default `false` | Release pull requests get package labels |
| `binding.features.browserMcp` | boolean, default `false` | Sync writes project MCP configuration for browser tools |
| `capabilities.<name>` | `{ summary?, claude: { model, effort }, codex: { model, effort } }`, optional | Model and effort per tool, merged over the shipped defaults |
| `roles.<role>` | capability name, optional | The capability a role uses, merged over the shipped defaults |
| `supported.<tool>` | `{ description?, modelIdPattern?, models: { <model>: [efforts] } }`, optional | Models and efforts each tool accepts, merged over the shipped defaults |
| `implementationEffort` | `{ default, automaticMaximum, maximumTransitions, rules, assessmentOrder?, blockers?, nonTriggers? }`, optional | The effort rubric, replacing the shipped default; each rule lists the criteria it `requires` |
| `labels.extra` | `[{ name, color, description }]` | Repository-only labels merged over the base catalog |

`$schema` and `description` are allowed at the top level. The repository comes from the `origin` remote, the Projects token is always `AGENTICOOL_PROJECT_TOKEN`, generated names carry no prefix, and repository-only sources always live in `.agents/local/roles` and `.agents/local/workflows`, so `binding.namespace`, `binding.repository`, `binding.tokenEnv`, and `local` fail validation with a message that names the replacement.
