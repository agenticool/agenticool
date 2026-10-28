# agenticool

Shared, deterministic workflow tooling for GitHub repositories that use Claude Code and Codex agents, published as standalone `@agenticool/*` npm packages. A repository installs only the packages it needs and keeps its own `.agents/policy.json`.

## Packages

| Package | What it does |
| --- | --- |
| [`@agenticool/github`](packages/github) | Internal: GitHub REST and GraphQL calls through `gh api` |
| [`@agenticool/cli`](packages/cli) | Internal: argument parsing for the package commands |
| [`@agenticool/policy`](packages/policy) | Internal: policy loading, model and effort resolution, effort rubric |
| [`@agenticool/tracker`](packages/tracker) | Project triage, Done and Inbox, containers, membership, and PR status and metadata |
| [`@agenticool/delivery`](packages/delivery) | Delivery queue and branch names |
| [`@agenticool/spec-parser`](packages/spec-parser) | Specification parsing, pre-flight rules, and issue body rendering |
| [`@agenticool/spec-to-issues`](packages/spec-to-issues) | Filing and resuming a specification plan as linked issues |
| [`@agenticool/agents`](packages/agents) | Shared agents and skills, the generator, and the review publisher |
| [`@agenticool/workflow-lint`](packages/workflow-lint) | GitHub Actions workflow lint rules |

## Reusable workflows

Two workflows in `.github/workflows/` run on this repository's own pull requests and also accept `workflow_call`, so another repository calls them by tag:

| Workflow | Job and check name |
| --- | --- |
| `ci-pr-title.yml` | `check-pr-title`: Check PR title follows Conventional Commits |
| `ci-secret-scan.yml` | `scan-secrets`: Scan commits for secrets, with Gitleaks |

```yaml
on:
  pull_request:
    types: [opened, edited, synchronize]

jobs:
  check-pr-title:
    name: Check PR title
    uses: agenticool/agenticool/.github/workflows/ci-pr-title.yml@<tag>
  scan-secrets:
    name: Scan secrets
    permissions:
      contents: read
      pull-requests: write
    uses: agenticool/agenticool/.github/workflows/ci-secret-scan.yml@<tag>
    secrets: inherit
```

The secret scan reads the `GITLEAKS_LICENSE` secret, which Gitleaks needs only in organization-owned repositories.

## Development

Node.js 24 (see `.tool-versions`) and npm.

```sh
npm ci
npm run check   # format, lint, typecheck, and tests with a 90% coverage gate
```

## Releases

Each package has its own version, changelog, and tag (`<package>-vX.Y.Z`). release-please reads the Conventional Commit title of each squash-merged pull request and keeps one release pull request open for every package with pending changes. Its `node-workspace` plugin bumps a package whenever an internal dependency it uses is released. Merging the release pull request creates the releases, and the `Release: packages` workflow publishes the released packages to npm with provenance.

Without any setup, release-please runs with `GITHUB_TOKEN`, and merging a release pull request creates tags and GitHub releases but publishes nothing. Full releases need:

- A GitHub App that can write contents and pull requests, with its ID in the `RELEASE_PLEASE_APP_ID` variable and its private key in the `RELEASE_PLEASE_APP_PRIVATE_KEY` secret.
- The `NPM_PUBLISH_ENABLED` variable set to `true`, and npm trusted publishing for each package, pointing at `release-packages.yml`. npm accepts a trusted publisher only for a package that already exists, so each package's first publish uses an `NPM_TOKEN` secret, which can be deleted once every package has a trusted publisher.
