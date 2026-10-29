## Repository agent workflows

Version-controlled agents and skills under `.claude/agents/` and `.claude/skills/` (Claude Code) and `.codex/agents/` and `.agents/skills/` (Codex) encapsulate {{label}} delivery. Routing always names these definitions. Both tools get the same roles, handoffs, and checks; only the packaging differs. The definitions are generated from the shared sources in `@agenticool/agents`, the repository's own sources under `.agents/local/`, and `.agents/policy.json`: edit a local source or the policy, run `npx agenticool-agents generate`, and commit the output, or ask the `agents` skill to do all three. The `@agenticool/agents` README has the parity matrix, trust and discovery requirements, known runtime limits, and how to check effective settings.

| Request | Claude Code | Codex | Role it dispatches |
| --- | --- | --- | --- |
| `implement #N`, an issue URL, or a PR URL | `/implement` | `$implement` | `implementer` per leaf or rework (`inline` keeps a small one here); `code-reviewer` for the pre-PR gate |
| Build, link, rebase, or sync stacked branches during delivery | `/stack` | `$stack` | none; the agent that created the worktree runs it |
| File or draft issues | `/create-github-issue` | `$create-github-issue` | none by default; `issue-triager` (read-only) when a batch needs independent judgment |
| File a specification's delivery plan as a root container, epics, and leaves | `/spec-to-issues` | `$spec-to-issues` | `issue-triager` (read-only) for independence groups only |
| Review a pushed branch or PR | `/review-code` | `$review-code` | `code-reviewer` (read-only, reports to you; the skill posts the report to a target PR) |
| Security review, only when a person asks | `/review-security` | `$review-security` | `security-reviewer` (read-only) |
| Write a PR body, issue body, comment, or doc | `/plain-language` | `$plain-language` | none |
| Change, add, or regenerate these agents and skills | `/agents` | `$agents` | none; edits the policy or local sources, regenerates both tools, verifies |

- Delivery and handoffs: [the implement workflow](.agents/skills/implement/SKILL.md) owns dispatch, its [dependency queue](.agents/skills/implement/references/queue.md) owns containers and the parallel exception, and [leaf delivery](.agents/skills/implement/references/delivery.md) owns the pre-PR reviewer spawn. Only `issue-triager` forms independence groups, under `.agents/independence-groups.md`. No automatic flow spawns `security-reviewer`.
- Model and effort: `@agenticool/agents` ships the model and effort for each role, per tool, and the implementation effort rubric, and `.agents/policy.json` may override them. Every dispatcher runs `npx agenticool-agents resolve --tool <claude|codex> --role <role>` and passes the result explicitly when it spawns; it never inherits a session or contributor default. An explicit `model <name>` or `effort <level>` in the request overrides only that setting, for that task and the handoffs it names (`reviewer effort max`), and changes nothing on disk; unsupported values fail. Each agent labels the dispatched `Policy:` line `Requested settings:`, including overrides, and omits model self-identification and runtime-verification commentary. `CLAUDE_CODE_EFFORT_LEVEL` and Codex agent file fields can silently override requested settings.
