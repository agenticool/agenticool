# @agenticool/delivery

Read the delivery queue for an issue tree (order, claims, effort, independence groups, stacking) and print canonical branch names. Every GitHub call is a REST `GET` through `gh api`; the queue keeps no cache, so each run reads current issues, pull requests, branches, checks, and project fields.

## Bins

`agenticool-delivery <command>`, run from the repository root so it finds `.agents/policy.json`. `agenticool-delivery <command> --help` prints each command's options.

### `queue <issue> [--next] [--resume <issue>] [--actor <delivery-agent>]`

Walks the native sub-issues under `<issue>` and prints one ledger line per leaf, in dependency order with a numeric tie break:

```text
#<n> | <state> | effort=...; rule=...; evidence=...; reason=... | branch=...; head=...; PR=...; project=...; size=... | claim=... | dispatch={...}[ | <blocker>]
```

- States: `done`, `in review`, `resume`, `owned elsewhere`, `waiting`, `ready`.
- `--next` prints only the next leaf: the first `resume` row, else the first `owned elsewhere` or `ready` row.
- `--resume <issue>` treats that claimed leaf as resumable.
- `--actor <id>` treats a claim as resumable when its agent is `<id>` and its worktree appears in `git worktree list`.
- `dispatch` carries the implementation base (trunk `main`, or the one stack-ready prerequisite branch), dependencies, prerequisites, independence groups, ownership notes, and parallel candidates.
- An inaccessible issue, a dependency cycle, a cross-repository relationship, or a malformed record blocks only its own rows; each problem is also printed to stderr as `BLOCKED: ...` and the exit code is 1.

Only comments and pull requests from an `OWNER`, `MEMBER`, or `COLLABORATOR` count. The queue reads these records, where `<namespace>` is `binding.namespace`:

| Record | Where | Meaning |
| --- | --- | --- |
| `<!-- <namespace>-claim {json} -->` | Issue comment | Claim (`agent`, `branch`, `worktree`), or release with `released: true` |
| `<!-- <namespace>-effort {json} -->` | Issue comment | Implementation effort decision, checked against the `implementationEffort` rubric |
| `<!-- <namespace>-independence-groups -->` ... `<!-- /<namespace>-independence-groups -->` | Container issue body | Lines `- gN: #a #b` naming leaves in the container's subtree; older lines without `gN:` number the groups in order |
| `Pre-PR review: APPROVE; base=<sha>; head=<sha>` | Pull request body | Approved base and head for stacking; the older `APPROVE for <base>..<head>` form is also read |

Comments that open with `Claimed`, `Claiming`, `Re-claimed`, or `Re-claiming` are read as legacy claims, and ones that open with `Releasing`, `Released`, `Claim released`, or `Pausing this claim` release a legacy claim written by the same account.

#### Independence groups and parallel candidates

A container's record may name any leaf in its subtree, so a spec plan's root container can carry one plan-wide record whose groups mix leaves of different phase epics, while each epic or container may keep its own record. Every record is validated on its own and ignored, adding no groups, when it is malformed, names an issue outside the container's subtree or one that is not a leaf, lists an issue twice, or puts in different groups two leaves linked by a chain of blocked-by edges or sharing a blocker that is still open. `groups` lists the leaf's group in each valid record that names it, as `<container>/gN`.

`parallelWith` lists another leaf when both are `ready`, sized `M`, and have complete implementation notes (backticked `Files:` and a `Contracts:` or `Provides:` line), some valid record puts them in different groups, their `Files` do not overlap (a glob counts from its literal prefix), and they share no contract. Each entry carries the other leaf's issue, its group in that record, and its files and contracts.

### `branch-name <issue> [--layer <n>] [--actor <login>]`

Prints `<actor>/<issue>-<slug>`, with `-part-<n>` for layer 2 and up. The slug is the issue title in lowercase, with accents dropped, every run of other characters turned into `-`, "part N" joined into `partN`, and the result cut to 40 characters at a word boundary; it is `issue` when the title has no ASCII letters or digits. `--actor` defaults to `agent`.

## Exports

| Export | What it does |
| --- | --- |
| `deliveryQueue(policy, issue, { api?, resume?, actor?, worktrees? })` | Returns `{ rows, errors }` for the issue tree |
| `runQueue(argv, { api?, base?, worktrees? })` | The `queue` command: returns `{ lines, errors }` |
| `nextLeaf(rows)`, `ledgerLine(row)` | The `--next` choice and one printed ledger line |
| `claimRecord(comments, policy)`, `effortRecord(comments, policy)` | The active claim and the effort decision from issue comments |
| `orderLeaves(leaves, nodes)` | Dependency order and cycle components |
| `approvalPair(pr)`, `stackReady(pr, checks, statuses, verifiedAncestor)` | The recorded pre-PR approval and whether a prerequisite PR can be stacked on |
| `ownershipNotes(body)` | `Files:` and `Contracts:` (or `Provides:`) from an issue's implementation notes |
| `restClient(run?)` | The read-only REST client the queue uses by default |
| `closingIssues(body, repository)` | Issues a pull request body closes with a closing keyword |
| `branchName({ issue, title, actor?, layer? })`, `slugify(title)`, `isCanonicalBranch(name)` | Branch name rules |
| `runBranchName(argv, { api?, base? })`, `parseArguments(argv)` | The `branch-name` command |

## Config keys

Read from `.agents/policy.json` through `@agenticool/policy`:

| Key | Used by | Meaning |
| --- | --- | --- |
| `binding.namespace` | `queue` | Prefix of the claim, effort, and independence-group records |
| `binding.repository` | `queue`, `branch-name` | The repository whose issues, pull requests, and branches are read |
| `binding.project` | `queue` | Project whose `Status`, `Priority`, and `Size` fields are read; `ownerType: "organization"` reads it under `orgs/` |
| `implementationEffort` | `queue` | The effort rubric for recorded decisions |
