# ADR-008: Schema explorer, sample database, and query history

- Status: **Accepted** (implemented and tested Week 5)
- Date: 2026-11-18 (Week 5 of FINAL_PROJECT_PLAN.md)
- Related: plan §3 (Epic 1 workspace, discovery), §5.1 (workspace layout),
  §5.5 (storage), §7 Week 5; ADR-002 (typed worker contracts), ADR-006
  (multi-database storage), ADR-007 (results grid)

## Context

Week 5 makes databases discoverable without SQL: browse tables, views,
columns, keys, indexes, and CHECK constraints; page through table data; start
from a useful sample schema; and re-run or clear recent queries. The plan’s
`browseTable(): Promise<StatementResult>` contract only describes one result
page, so paging needs additional metadata. The sample database must exercise
the real execution path, not bypass it, and history is local-only (no
backend by design) but must never break execution when storage fails.

The user chose an **integrated workspace**: schema lives under the database
list, table data opens as a tab beside Results, and History shares the right
panel with Analysis. This avoids a separate explorer mode and keeps one
active database in view.

## Decision

**Schema introspection is read-only PRAGMA metadata** (`services/database/schema.ts`):
`sqlite_master` lists user tables/views; per-object `pragma_table_info`,
`pragma_foreign_key_list`, `pragma_index_list`/`pragma_index_info` supply
columns, defaults, foreign keys (including `ON UPDATE`/`ON DELETE`), unique
constraints, expression indexes, and partial flags. CHECK constraints are not
exposed by any PRAGMA, so `extractCheckConstraints` scans the stored `CREATE`
SQL with a quote/comment/bracket-aware scanner and preserves the parenthesized
expressions. Internal `sqlite_*` objects are excluded.

**The sample database is ordinary SQL run through the execution contract**
(`services/database/sampleDatabase.ts`, `DatabaseService.createSampleDatabase`):
a music library (12 artists, 24 albums, 120 tracks, 6 playlists,
many-to-many playlist tracks, a view, indexes, and CHECK/UNIQUE/FK
constraints) plus five demo queries that cover joins, grouping, views,
many-to-many walks, and the rating index. Creation makes a normal database
record, activates it, runs the bundled `SAMPLE_SCHEMA_SQL`, and rolls the new
database back (deleting it through `StorageService`) if any statement errors.
`DatabaseInfo.sample` is a persisted additive flag so demo queries and sample
UI survive reload; reconciliation preserves it.

**`TablePage` deliberately extends the plan’s browse contract**:
`{ table, columns, rows, totalRows, limit, offset }`. `browseTable` clamps the
limit to `1..500` (default 50), clamps negative/non-finite offsets to 0,
quotes the table identifier, reads the page with `LIMIT/OFFSET`, and counts
separately so the UI can show “rows 51–100 of 120”. Only one page is in flight;
changing table/offset cancels the previous result. Switching databases closes
the browser so stale data is never shown.

**History uses the existing IndexedDB metadata stores** (`history` and
`preferences`, schema version unchanged): entries are `{ sql, at, ok,
engineMs? }`, trimmed whitespace, newest first, capped at 100. Recording is on
by default; disabling writes a preference and stops further writes while
keeping existing entries. Recording failures are surfaced in the panel but
never affect query execution. Clear is a two-step confirmation in the UI and
deletes all entries. A memory store implements the same port for tests.

**Integrated UI**: `SchemaExplorer` (table/view tree, detail expansion,
Refresh, demo queries), `TableBrowser` (page status, Prev/Next, close),
`HistoryPanel` (load/opt-out/clear), and App effects that load schema on
database/version change, refresh it after every run, and page table data.

## Alternatives considered

- **Separate full-page explorer**: rejected — the user chose the integrated
  layout and it keeps the active database and editor context visible.
- **Bundled SQLite file asset**: rejected — schema/data changes would need
  binary regeneration, and it would not prove the execution contract handles
  the sample setup.
- **Returning only `StatementResult` for browse**: rejected — row ranges and
  Next/Prev cannot be derived without a total count.
- **A new IndexedDB version/store just for history**: rejected — version 1
  already has history and preferences stores, so no migration is needed.
- **Auto-clearing history on disable**: rejected — disabling recording should
  not destroy data the user may still want.

## Verification (Week 5)

- Unit: schema introspection (tables/views, PK/default/nullability, FK
  actions, unique/expression indexes, CHECK extraction edge cases),
  `browseTable` paging/clamping/quoting/views/errors, the full sample script
  and every demo query, history service (trim, limit, opt-out, load, clear),
  IndexedDB history store round-trip, worker protocol/manager schema and page
  requests, `DatabaseService` sample creation/rollback and clamping,
  `SchemaExplorer`/`TableBrowser`/`HistoryPanel` behavior.
- E2E (`e2e/week5.spec.ts`): sample creation, schema details and constraints,
  demo loading, three-page browser with disabled edge buttons, schema refresh
  after DDL, history persistence across reload, opt-out, and confirmed clear.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e` pass.

## Consequences

- Introspection is N+1 per object; fine for local databases at this scale, but
  large schemas may want batching or caching later.
- Schema refreshes after every run (not per-statement) and can be triggered
  manually; a table dropped elsewhere while the browser is open shows a
  fetch error instead of silently emptying.
- `TablePage` is an intentional contract extension; any consumer typed only
  against `StatementResult` still works because it is a superset.
- History is plain SQL text in local IndexedDB; users can opt out or clear it,
  and no history leaves the browser. It is not encrypted, consistent with the
  local-only threat model.
- LIMIT/OFFSET is sufficient for 120 sample tracks and local tables; very
  large tables may later benefit from keyset paging.
