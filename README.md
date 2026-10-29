# agenticool

Shared, deterministic workflow tooling for GitHub repositories that use Claude Code and Codex agents, published as standalone `@agenticool/*` npm packages. A repository installs only the packages it needs and keeps its own `.agents/policy.json`.

## Packages

| Package | What it does |
| --- | --- |
| [`@agenticool/agents`](packages/agents) | Shared agents and skills, the generator, the review publisher, and the repository-file sync |
| [`@agenticool/spec`](packages/spec) | Specification parsing, pre-flight rules, issue body rendering, and filing and resuming a plan as linked issues (`agenticool-spec`) |
| [`@agenticool/dispatch`](packages/dispatch) | Delivery queue and branch names (`agenticool-dispatch`) |
| [`@agenticool/board`](packages/board) | Project triage, Done and Inbox, containers, membership, and PR status and metadata (`agenticool-board`) |
| [`@agenticool/core`](packages/core) | Internal: GitHub calls through `gh api`, argument parsing, and policy loading with the model, effort, role, and rubric defaults; no stable public API |

A repository's `.agents/policy.json` needs only `binding.project`. Model, effort, role, and rubric defaults ship with the packages, and a repository may override them there. The repository comes from the `origin` remote, and the board workflows read the Projects token from the `AGENTICOOL_PROJECT_TOKEN` secret.

## Pull request checks

Besides `npm run check`, two workflows in `.github/workflows/` check this repository's own pull requests:

| Workflow | Job and check name |
| --- | --- |
| `ci-pr-title.yml` | `check-pr-title`: Check PR title follows Conventional Commits |
| `ci-secret-scan.yml` | `scan-secrets`: Scan commits for secrets, with Gitleaks |

The secret scan runs a pinned Gitleaks CLI release, checked against its SHA-256, and needs no secrets or license key. On a pull request it scans the pull request's commits; on a push it scans the pushed range; on a manual run or a new branch it scans the full history.

## Development

Node.js 24 (see `.tool-versions`) and npm.

```sh
npm ci
npm run check   # format, lint, typecheck, and tests with a 90% coverage gate
```

## Releases

Each package has its own version, changelog, and tag (`<package>-vX.Y.Z`). release-please reads the Conventional Commit title of each squash-merged pull request and keeps one release pull request open for every package with pending changes. Its `node-workspace` plugin bumps a package whenever an internal dependency it uses is released. Merging the release pull request creates the releases, and the `Release: packages` workflow publishes the released packages to npm with provenance.

Releases start once a release GitHub App is configured. Until then, the `Release: packages` workflow warns that `RELEASE_PLEASE_APP_ID` is not set and skips releases, because this organization does not let `GITHUB_TOKEN` create pull requests. Full releases need:

- A GitHub App that can write contents and pull requests, with its ID in the `RELEASE_PLEASE_APP_ID` variable and its private key in the `RELEASE_PLEASE_APP_PRIVATE_KEY` secret. With only the app, merging a release pull request creates tags and GitHub releases but publishes nothing.
- The `NPM_PUBLISH_ENABLED` variable set to `true`, and npm trusted publishing for each package, pointing at `release-packages.yml`. npm accepts a trusted publisher only for a package that already exists, so each package's first publish uses an `NPM_TOKEN` secret, which can be deleted once every package has a trusted publisher.
