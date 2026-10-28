### What
Device sync, filed now so the work survives outside this specification.

Slices:
- `P2.1` Sync client (M): @@issue:P2.1@@
- `P2.2` Conflict report (S): @@issue:P2.2@@

### Why
Two devices converge after a push and a pull, and conflicts are reported.

Deferred: filed now and blocked until P1.2 (@@issue:P1.2@@) closes.

### How
Order by blocked-by, not by number:
- `P2.1`: blocked by P1.2 (@@issue:P1.2@@)
- `P2.2`: blocked by P2.1 (@@issue:P2.1@@)

Definition of done for every slice: §9.1 (@@issue:Phase 0@@).

### Parent issue
@@issue:Plan@@

### Contracts
#### 8. Sync

Sync pushes and pulls notes through a remote folder. Conflicts keep both copies and report them. This work waits until local storage ships.
