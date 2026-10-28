---
name: spec-to-issues
description: "File a {{label}} specification's delivery plan as GitHub issues in {{repository}}: one root container for the whole plan, one epic per phase under it, a container per stacked slice pair, and one leaf per slice, linked as native sub-issues with blocked-by dependencies and {{label}} delivery project Priority and Size. Runs `agenticool-spec` to pre-flight the plan offline, records the triager's independence groups, prints the plan, and waits for confirmation; filing is paced and resumable. Use for 'file this spec as issues', 'turn the spec into epics', or 'resume the spec filing'. Does not implement or open PRs."
argument-hint: "<path to specification> [dry run] [assignee <login>]"
capability: issue-creation
codex:
  display_name: "{{label}}: Specification to issues"
  short_description: "File a specification's delivery plan as a root container, epics, and leaves"
  default_prompt: "Use ${{prefix}}spec-to-issues to file this specification's delivery plan as {{label}} issues."
---
# {{label}} specification to issues

Files a specification written to the spec-slicing format as issues in `{{repository}}`, in the project [{{project.name}}]({{project.url}}) (number {{project.number}}, owner `{{project.owner}}`). `npx agenticool-spec` does every deterministic step: `@agenticool/spec-parser` parses the specification, applies the pre-flight rules, and renders every body, and `@agenticool/spec-to-issues` records, confirms, files, and resumes the plan. Both packages are installed in the repository. This skill applies no rule and writes no issue body itself: it runs those commands, asks the triager for independence groups, and relays the output. `AGENTS.md` is already loaded. Repository commands run read-only against the checkout you were started in; never edit it.

The format, the ownership rules, and every pre-flight rule are in `node_modules/@agenticool/spec-parser/spec-slicing.md`; read it when the user asks why a rule failed or how to fix the specification. The commands, the confirmation digest, and the filing stages are described in `node_modules/@agenticool/spec-parser/README.md` and `node_modules/@agenticool/spec-to-issues/README.md`. `node_modules/@agenticool/spec-parser/fixtures/conforming-spec.md` and `fixtures/violating-spec.md` show a specification that files cleanly and one that fails pre-flight.

<!-- claude-only -->
This skill pins the main-thread model and effort for the turn from `.agents/policy.json` (`issue-creation`). A `model` or `effort` override in the request applies to this turn by naming it (`/model`, `--model`, `--effort`), not through this skill.
<!-- /claude-only -->
<!-- codex-only -->
Codex skills cannot set the session model, and nothing dispatched this session, so the `issue-creation` policy is advisory: the session keeps whatever model and effort Codex started with. Resolve it with `npx agenticool-agents resolve --tool codex --capability issue-creation` and state it in your first message as `Advisory policy: tool=codex capability=issue-creation model=<model> effort=<effort>`. Never present it as `Requested settings:`, because no dispatcher requested it. Start Codex with `codex -m <model> -c model_reasoning_effort=<effort>` to run the session at that policy, or at an explicit override.
<!-- /codex-only -->

## Authority

The request names the specification path. "Dry run", "plan", or "preview" means pre-flight, triage, and print the plan, then stop with no GitHub writes. "File" or "create" authorizes running `confirm` and `file` after the user confirms the printed plan, and with them every write `file` makes: the issues, their sub-issue links, dependencies, independence records, project Priority and Size, and the triage and container runs. Nothing else: never edit `.github/labels.json`, create or rename labels, change repository or project settings, set project Status, or edit, link, or close any issue that this filing did not create. A missing label, field, option, or permission is a blocker to report, never something to create. Never run `confirm` before the user confirms.

The assignee comes from the request, else from a local instruction file that sets a default assignee for filed issues (such as `CLAUDE.local.md` or `AGENTS.override.md`), else there is none. Metadata comes from the specification. {{prefix}}issue-triager runs only to form independence groups.

The state directory is `${XDG_STATE_HOME:-$HOME/.local/state}/{{prefix}}spec-to-issues/<owner>-<repo>-<spec file name without .md>-<path hash>/`, where `<path hash>` is the first 8 hex characters of the SHA-256 of the specification's absolute path (`printf '%s' /abs/spec.md | shasum -a 256 | cut -c1-8`), as `node_modules/@agenticool/spec-to-issues/state-file.md` defines it. Run every command from the repository root.

## 1. Pre-flight

Run `npx agenticool-spec plan <spec>`. It makes no GitHub call. When it exits non-zero, report its `[rule] message` lines exactly as printed and stop; file nothing. Do not repair the specification yourself unless the user asks; a fix belongs in the specification. When it exits 0, keep the printed tree for the next step.

## 2. Independence groups

Only the triager forms independence groups, by the definition in `.agents/independence-groups.md`. Skip this step when no epic has two or more direct leaf children in the tree (layers of a stack container are its children, not the epic's).

Otherwise create a scratch directory outside the repository (`mktemp -d`) and run `npx agenticool-spec plan <spec> --bodies <scratch>/bodies --json <scratch>/plan.json`, which writes each rendered body to `<scratch>/bodies/<KEY>.md` and the parsed plan, with each item's `key`, `parent`, and `blockedBy`, to `plan.json`. Resolve the triager settings with `npx agenticool-agents resolve --tool <tool> --role issue-triager`, adding `--model` or `--effort` only for a `triager` override in the request. If it exits non-zero, stop and report its message. Spawn one `{{prefix}}issue-triager` for the plan with the resolved model and effort. Send only the drafts of the leaves under those epics (Plan ID as ref, title, and the rendered body from `<scratch>/bodies/<Plan ID>.md`), each leaf's parent key and blocker keys from `plan.json`, the reason `dependency judgment: independence groups only; metadata comes from the specification`, and the `Policy:` line (`Policy: tool=<tool> role={{prefix}}issue-triager model=<model> effort=<effort> (model: <source>, effort: <source>)`).

<!-- claude-only -->
Spawn with the Agent tool: `subagent_type: {{prefix}}issue-triager`, passing `model` and `effort` from the resolver explicitly.
<!-- /claude-only -->
<!-- codex-only -->
Spawn with `spawn_agent`: `agent_type: {{prefix}}issue-triager`, `model` and `reasoning_effort` from the resolver's `spawn` object, `fork_turns: "none"`. Always pass both values; the agent file carries neither. An unknown `agent_type` means the project is not trusted in Codex yet; say so and stop.
<!-- /codex-only -->

Apply only its `GROUPS` lines and ignore its `EDGES` line, because the specification's `Blocked by` fields are the plan's only edges. Write the groups to `<scratch>/groups.json`, keyed by epic, one list of Plan IDs per group, leaving out ungrouped leaves and every epic whose line reads `none`:

```json
{ "Phase 0": [["P0.1", "P0.3"], ["P0.2"]] }
```

## 3. Print the plan and wait

Run `npx agenticool-spec plan <spec> --state <dir> [--groups <scratch>/groups.json] [--assignee <login>]`, passing `--groups` only when step 2 wrote the file and `--assignee` only when there is one. Print its output in full: the tree, each epic's groups, the totals, the assignee, the state directory, and the `Plan digest:` line. Delete the scratch directory. A dry run ends here. A filing request waits for the user to confirm this output; any change to the specification afterwards means running steps 1 to 3 again.

## 4. File

After the user confirms, run `npx agenticool-spec confirm <digest> --state <dir>` with the digest from the printed `Plan digest:` line, then `npx agenticool-spec file <spec> --state <dir>`. Print the output as it arrives. When either command exits non-zero, report its message and stop; when the message names a resume command, the filing can resume.

## Resume

A request to resume, or to file a specification whose state directory already holds `state.json`, runs `npx agenticool-spec resume <spec> --state <dir>`. It reuses the groups and assignee recorded in the state, so never spawn the triager again. When it refuses because the specification or the plan changed, run steps 1 to 3 again for a new confirmation.

## Verify and return

Read back a sample of the filed bodies and every item's labels, parent, blockers, and project Priority, Size, and Status. Return the issue lines `file` or `resume` printed (key, number, title, URL), each epic's independence groups, the triager's `Requested settings:` line verbatim when it ran, the patch pass line when it ran, the state directory, and any unfinished item with what is missing (not on the project, no Status, no Priority or Size, a link that failed). Say whether the run is complete or can resume.
