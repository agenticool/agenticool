# @agenticool/github

Run GitHub REST and GraphQL calls through `gh api` with typed errors, token redaction, pagination, and the GraphQL budget. Internal to @agenticool; no stability promise for other callers.

Every call runs `gh api --include`, so a failure carries GitHub's HTTP status and rate-limit headers. Messages carry GitHub's own error type and text, but never a token, request headers, gh stderr, or a response body that is not JSON.

## Bins

None.

## Config keys

None read directly. Callers pass the name of their extra token variable (`binding.tokenEnv` in `.agents/policy.json`) to `redact` and `failureMessage`.

## Exports

Every function that runs `gh` takes an optional `run` with the signature of `execFileSync`, so tests never call GitHub.

| Export | Purpose |
| --- | --- |
| `ghRest(args, { run, input })` | Runs one REST call and returns the response body text. `input` is sent on stdin. |
| `ghRestPages(path, { run })` | Reads every page of a REST list by following the `Link` header and returns each page's parsed body. |
| `ghGraphql(query, variables, { run, allowErrors })` | Runs one GraphQL call and returns `data`. `allowErrors(result)` accepts a response whose errors the caller expects. |
| `graphqlBudget(run)` | Reads the GraphQL budget from the REST `rate_limit` endpoint without spending it: `{ limit, remaining, used, reset }`. |
| `GitHubError` | The error every failed call throws, with `kind` (`rate-limit`, `access`, `not-found`, `other`) and `httpStatus` when GitHub sent one. |
| `failureMessage(error, tokenEnv)` | The only text an entry point prints for a failure. Hides raw subprocess errors and redacts tokens. |
| `redact(text, tokenEnv, env)` | Replaces the values of `GH_TOKEN`, `GITHUB_TOKEN`, and the variable named by `tokenEnv` (from `env`, default `process.env`), and any text shaped like a GitHub token, with `***`. |
| `ghRequest(api, args, { input, run })` | Runs `gh api --include` and returns the parsed response with `failed`. |
| `parseResponse(output)` | Splits `gh api --include` output into `status`, lowercased `headers`, parsed `body`, and raw `text`. |
| `githubError(api, response)` | Builds the `GitHubError` for a response that failed or carried errors. |
