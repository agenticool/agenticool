### What
A buildable package with validated domain types and configuration.

Slices:
- `P0.1` Package scaffold (S): @@issue:P0.1@@
- `P0.2` Domain types (M): @@issue:P0.2@@
- `P0.3` Configuration loader (S): @@issue:P0.3@@

### Why
The package builds, the §4 (@@issue:P0.2@@) types validate, and P0.3 (@@issue:P0.3@@) loads a sample configuration.

### How
Order by blocked-by, not by number:
- `P0.1`: blocked by none
- `P0.2`: blocked by P0.1 (@@issue:P0.1@@)
- `P0.3`: blocked by P0.2 (@@issue:P0.2@@)

Definition of done for every slice: §9.1.

### Parent issue
@@issue:Plan@@

### Contracts
#### 1. Decisions

Notes are plain text with a title. The service stores them locally first and syncs later (§8 (@@issue:Phase 2@@)). Storage details are in §6 (@@issue:Phase 1@@); the first storage slice is P1.1a (@@issue:P1.1a@@).

##### 1.1 Scope

One user, one device, and a local store. Sync between devices is deferred to Phase 2.

##### 1.2 Non-goals

No rich text, no sharing, and no server-side search.

#### 2. Architecture

The service is a library with injected ports. Only the storage adapter touches the file system. Types come from §4 (@@issue:P0.2@@) and configuration from §5 (@@issue:P0.3@@).

#### 7. Class catalog

| Class (`file`) | Public methods | Purpose |
| --- | --- | --- |
| `NoteId` (`domain/ids.ts`) | `parse(raw)` | Validates and brands note identifiers. |
| `Note` (`domain/note.ts`) | `create(input)` | Builds a validated note. |
| `ConfigLoader` (`config/loader.ts`) | `load(path)` | Reads and validates the configuration file. |
| `NoteWriter` (`storage/writer.ts`) | `put(note)` | Atomic writes (§6.1 (@@issue:Phase 1@@)). |
| `NoteReader` (`storage/reader.ts`) | `get(id)`, `list()` | Validated reads (§6.2 (@@issue:Phase 1@@)). |
| `NoteIndex` (`storage/index.ts`) | `search(text)` | Title search over stored notes. |
| `SyncClient` (`sync/client.ts`) | `push()`, `pull()` | Device sync (§8 (@@issue:Phase 2@@)). |

##### 9.1 Definition of done

- `npm run build` and `npm test` pass, with no network access in tests.
- Public contract changes update the matching `docs/` page and follow §2.

##### 9.2 Dependency order

P0.1 (@@issue:P0.1@@) -> P0.2 (@@issue:P0.2@@) -> P0.3 (@@issue:P0.3@@) -> P1.1a (@@issue:P1.1a@@) -> P1.1b (@@issue:P1.1b@@) -> P1.2 (@@issue:P1.2@@) -> P1.3 (@@issue:P1.3@@). Phase 2 starts after P1.2 (@@issue:P1.2@@).
