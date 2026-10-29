### What
Notes persist locally and can be found by title.

Slices:
- `P1.1a` Note store write path (S): @@issue:P1.1a@@
- `P1.1b` Note store read path (S): @@issue:P1.1b@@
- `P1.2` Note index (M): @@issue:P1.2@@
- `P1.3` Storage benchmark record (XS): @@issue:P1.3@@

### Why
Notes written by P1.1a (@@issue:P1.1a@@) survive a crash and P1.2 (@@issue:P1.2@@) finds them by title.

### How
Order by blocked-by, not by number:
- `P1.1a`: blocked by P0.2 (@@issue:P0.2@@), P0.3 (@@issue:P0.3@@)
- `P1.1b`: blocked by P1.1a (@@issue:P1.1a@@)
- `P1.2`: blocked by P1.1b (@@issue:P1.1b@@)
- `P1.3`: blocked by P1.2 (@@issue:P1.2@@)
- Container @@issue:Stack P1.1@@ groups `P1.1a`, `P1.1b` as stacked deliveries.

Definition of done for every slice: §9.1 (@@issue:Phase 0@@).

### Parent issue
@@issue:Plan@@

### Contracts
#### 6. Storage

##### 6.1 Write path

Writes go to a temporary file and are renamed into place, so a crash never leaves half a note.

##### 6.2 Read path

Reads validate every note against the §4.1 (@@issue:P0.2@@) schema and skip notes that fail, reporting them.
