# ADR-006: Multi-database storage foundation

- Status: **Accepted** (implemented and tested Week 3)
- Date: 2026-11-15 (Week 3 of FINAL_PROJECT_PLAN.md)
- Related: plan §4 (metadata schema), §5.3 (DatabaseService), §5.6
  (naming/reconciliation); ADR-001 (pool capacity), ADR-003 (protocol),
  ADR-005 (tab guard, two-phase delete)

## Context

Weeks 1–2 ran a single hardcoded database (`/playground.sqlite3`). Week 3
delivers the foundation: a typed worker protocol for file operations, the
Storage Service (database lifecycle over IndexedDB + OPFS), startup
reconciliation, quota/availability detection, the error model, and the
workspace layout shell. The PoC's single-file assumptions had to be replaced
without breaking the ADR-001/003/004/005 guarantees.

## Decision

**Worker owns all pool file operations** (the sahpool's logical files are not
addressable from the main thread — names live inside the VFS):

- New protocol requests (ADR-003 unions extended): `open-db`, `list-files`,
  `delete-file`; `init` carries an optional `openFile`.
- The Worker Manager tracks the active file and re-sends it with **every**
  `init`, so restart (ADR-004) and crash recovery transparently re-open the
  same database. `deleteFile` clears the active file when it matches.
- `open-db` always closes the previous connection first — one active
  connection, matching the single-connection VFS (ADR-001).

**Metadata store** (plan §4): IndexedDB via `idb`, **schema version 1**, with
object stores `databases` (keyPath `id`), `history`, and `preferences`.
Version bumps ship tested migrations; user data is never dropped silently.

**File naming** (plan §5.6): only `/db_<id>.sqlite3` files are managed.
Reconciliation adopts orphaned ones as "Recovered database" entries and flags
metadata-without-file as `missing-file`. Foreign `*.sqlite3` files (e.g. the
PoC's legacy `/playground.sqlite3`) are **ignored and logged, never adopted**
— the sahpool VFS has no rename API, so adopting them would break the
id ↔ filename invariant.

**Lifecycle semantics**:

- `createDatabase` writes metadata first, **creates the pool file eagerly,
  and opens it** (create-implies-open: "New database" is instantly usable and
  metadata↔file consistency holds immediately). A failed file creation rolls
  the metadata back — no phantom entries.
- First run creates a default database (`My database`); startup opens the
  most recently used `ok`/`recovered` entry. `missing-file` entries are never
  opened — that would silently recreate an empty file over lost data.
- Delete is two-phase (ADR-005): mark `deleting` → unlink file → drop the
  entry; `reconcile` completes interrupted deletes. Deleting the *active*
  database falls back to another entry or a fresh default.
- Size metadata is `PRAGMA page_count × page_size` read on open — never a
  full-file load (100 MB import limit, plan §5.5).

**Pool capacity** (ADR-001): `initialCapacity` stays 12; when a *new* file is
created and the pool is full, capacity grows by 8 (`addCapacity`, persistent
by design) instead of failing with a confusing I/O error.

**In-memory fallback**: when OPFS is unavailable, `reconcile(persistent:false)`
skips file comparisons entirely — no `missing-file` storm — while the UI keeps
showing the "not persistent" banner (plan §2, never silent).

**Error model** (NFR-07): `DbError.code` values live in `shared/errors.ts`
(`DB_ERROR_CODES`) with a `describeDbError` guidance record — title, message,
and a concrete next step for every code, asserted by test. `DatabaseService`
promise rejections use `DbOperationError`. A React `ErrorBoundary` wraps the
app so a render failure shows recovery actions and reassures the user that
stored data is unaffected.

## Verification (Week 3)

- Unit: reconciliation drift rules (scenario 24), StorageService lifecycle
  (create/open/rename/two-phase delete, rollback on failure), DatabaseService
  startup (default creation, most-recent pick, recovered adoption, fallbacks),
  IndexedDB schema v1 (store names, version, round-trip), quota detection,
  error guidance coverage, Worker Manager file ops + restart re-open.
- E2E (`e2e/week3.spec.ts`, Chromium dev + production): create/rename/delete
  with confirmation, reload persistence of files *and* metadata, and separate
  contents when switching databases (single active connection).
- Full suite: 118 unit tests + 12 e2e tests green; `pnpm lint`,
  `pnpm typecheck`, `pnpm build` pass.

## Consequences

- The main thread never touches OPFS directly: every file operation round-trips
  through the worker's queue, keeping the single-writer model intact.
- `DatabaseService.startup()` is the single entry point after the tab guard
  (cached, StrictMode-safe); the UI only renders its result.
- History/preferences stores exist from schema v1 but stay empty until Week 5
  — avoids a migration the moment history ships.
- Capacity growth is silent until the pool meter in the status bar moves;
  a future improvement is surfacing a warning before the first `addCapacity`.
