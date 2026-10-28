### What
The Notes service delivery plan: the 3 phase epics listed under How and every container and slice under them. This issue groups them and has no work of its own. It closes when the epics close.

### Why
`acme-implement` builds its dependency queue from one issue's native sub-issue tree and the blocked-by edges on its leaves. Without a common parent, `implement` could target only one phase at a time; with this issue as the parent of every phase epic, `implement` on it delivers the whole plan in dependency order.

### How
Phases in plan order:

1. P0 Foundation: @@issue:Phase 0@@
2. P1 Storage: @@issue:Phase 1@@
3. P2 Sync backlog: @@issue:Phase 2@@, deferred; blocked by P1.2 (@@issue:P1.2@@)

Dispatch order comes from the native blocked-by edges on the slices, 9 of them, not from whole phases. The phase epics carry no blocked-by edges of their own apart from the deferred one, and this issue adds none, so a slice becomes executable as soon as its own blockers close. Each epic's How section lists its slices with their blockers.

### Parent issue
None
