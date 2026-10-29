## Delivery binding

Issue tracker: GitHub Issues. This marker turns on the GitHub issue flows (`implement #N`, GitHub issue filing), which run through the skills and agents in Repository agent workflows.

Repo `{{repository}}`, trunk `main`, project [{{project.name}}]({{project.url}}).

- PR titles use Conventional Commits with a component scope, e.g. `fix(<component>): ...`. Body: `Closes #N`, plus `Parent issue or epic: #P` when one exists.
- Issue states: an agent sets only `In progress`, when it claims the issue before coding, as [leaf delivery](.agents/skills/implement/references/delivery.md#claim) describes. `board-pr-issue-status.yml` moves the closing issue to `In review` when the PR opens. Board automation moves a closed issue to `Done` and a reopened issue in `Done` back to `Ready`. An agent never sets `In review` or `Done`.
- Every request needs an issue before work starts. Search for an existing one first; if none exists, file it with `create-github-issue` (`$create-github-issue` in Codex), then claim it and do the work.
- Issue titles follow `{{docs.triage}}`. For issue filing, follow `.agents/issue-creation.md`.
