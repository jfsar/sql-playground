# Browser-Based SQL Playground — Final Project Plan

**Status:** Final plan. Items marked **Proposed** are working decisions that the Week 1–2 proof of concept (PoC) must confirm or overturn, with a hard go/no-go at the end of Week 2.
**Primary objective:** Advanced engineering portfolio project
**Estimated MVP duration:** 11 weeks at about 25 focused hours per week (roughly 275 hours). At 15 hours per week, plan for about 18–20 calendar weeks.
**Architecture:** Browser-only, client-side SQLite execution

---

## 1. Project Overview

### Vision

Build a browser-based SQLite development environment that lets developers explore, query, and analyze SQLite databases without installing database software or running a backend server.

The application combines:

- A SQL editor with syntax highlighting.
- A database explorer (schema, tables, indexes).
- A query execution environment with per-statement results and timing.
- SQLite database import and export.
- Query execution-plan analysis, including a before/after plan comparison.
- Persistent browser-based database storage (OPFS).

### Audience and positioning

**Primary audience: developers.** They import existing SQLite files, explore schemas, run scripts, inspect query plans, measure timing, and export modified databases.

**Secondary audience: SQL learners.** They start from a bundled sample database, write and run SQL, and see how SQLite reports query plans. Guided learning content is **Future**; the MVP serves learners only through the sample database and readable plan output.

**Differentiator (user-facing):** query-plan understanding. The user can run a query, add an index, re-run, and see exactly how the plan changed. SQLite WASM + OPFS (+ Rust, if it passes its gate) is the *technical* differentiator, not the user-facing one.

### Decisions

| Area | Decision | Status |
|------|----------|--------|
| Audience | Developers (primary), SQL learners (secondary) | Confirmed |
| SQL execution | Entirely in the browser | Confirmed |
| Database engine | SQLite | Confirmed |
| Frontend | React + TypeScript + Vite | Confirmed |
| Backend | None for MVP | Confirmed |
| Deployment | Static hosting (e.g., Cloudflare Pages) | Confirmed |
| UI layout | Desktop-first: ≥ 1024 px supported, tablet best-effort, phones unsupported | Confirmed |
| SQLite WASM build | Official `@sqlite.org/sqlite-wasm` | **Proposed** — evaluate `sql.js` / `wa-sqlite` only if the official build fails a PoC criterion |
| Persistence VFS | `opfs-sahpool` (see ADR-001) | **Proposed** — PoC-gated |
| Rust analysis layer | Rust + wasm-bindgen, narrow scope, behind a TS interface | **Proposed** — PoC-gated (ADR-002) |
| Async data and UI state | TanStack Query for async reads (schema, table pages, database list); a small store (e.g., Zustand) for UI state | **Proposed** |

**Core architectural principle:** SQL execution, database management, and persistence happen locally in the browser. User database content is never uploaded to a server.

### Architecture Decision Records (written during Weeks 1–2)

| ADR | Question | Default if PoC passes |
|-----|----------|-----------------------|
| ADR-001 | Which OPFS VFS, and what hosting headers? | `opfs-sahpool`, no COOP/COEP required |
| ADR-002 | Is the Rust crate included in the MVP? | Yes, if it integrates cleanly with Vite + worker; otherwise a TypeScript implementation behind the same interface |
| ADR-003 | Value model and message protocol | As specified in §5 |
| ADR-004 | Cancellation strategy | Terminate and re-initialize the worker (see §5.4) |
| ADR-005 | Tab-ownership guard and database reconciliation | Web Locks API; ID-based file names with startup reconciliation (see §5.6) |

---

## 2. Project Goal and Success Criteria

### Goal

Deliver a client-side SQLite IDE for creating, importing, managing, querying, and analyzing SQLite databases in a modern browser, with query-plan analysis as its standout feature.

### Success criteria

Numeric values are **Proposed targets**, validated by benchmarks in Week 10. Targets marked *unvalidated* depend on PoC measurements and may be relaxed or tightened. Reference machine: mid-range laptop, current Chrome/Edge, broadband connection.

| ID | Success criterion | Measurable target |
|----|-------------------|-------------------|
| SC-01 | Users can execute SQLite queries in the browser. | Single and multi-statement scripts run correctly against the test suite. |
| SC-02 | Users can create, modify, and delete tables. | Covered by acceptance scenario 1. |
| SC-03 | Users can insert, update, and delete records. | Covered by acceptance scenario 2. |
| SC-04 | Users can import valid `.db`, `.sqlite`, `.sqlite3` files and `.sql` scripts. | Files up to **100 MB** import successfully; larger files show a warning (soft limit 250 MB, see §5.5). |
| SC-05 | Query results appear in a structured data grid. | Default cap of 1,000 rows per statement with a "truncated" indicator; the virtualized grid renders 1,000 rows without visible jank. |
| SC-06 | Users can inspect query execution plans. | Plan tree shown for any `SELECT`; raw SQLite output always available. |
| SC-07 | Query execution duration is displayed. | Engine time reported per statement, defined in §5.2. |
| SC-08 | SQL errors give useful feedback. | Error shows SQLite message and code; position highlighted where SQLite provides it. |
| SC-09 | No remote database server is required. | Playwright network test records zero requests carrying database content (scenario 14). |
| SC-10 | Databases persist across reloads. | After reload, the database list and contents are intact; a 50 MB database reopens in under 2 s (*unvalidated*). |
| SC-11 | Users can export modified databases. | Exported file opens in the `sqlite3` CLI and passes `PRAGMA integrity_check`. |
| SC-12 | Expensive SQL does not block the UI. | During a ≥ 5 s CPU-bound query, the main thread records no long tasks over 100 ms. |
| SC-13 | Users can cancel a running query. | UI returns to idle and the database is reopened intact within **5 s** (*unvalidated*; cancel = worker restart + WASM init + VFS install + database reopen, measured in the PoC). |
| SC-14 | Users can compare a query plan before and after a schema change. | Pin a plan, change schema, re-run, see a node-level diff. |

### Browser support matrix (Proposed)

| Browser | Support |
|---------|---------|
| Chrome / Edge (current) | Supported |
| Firefox (current, 111+) | Supported |
| Safari 17+ | Supported (verify in PoC) |
| Safari < 17 | Unsupported (known sub-worker bug affects the default `opfs` VFS) |
| Private/incognito windows | Best-effort. OPFS may be restricted or non-persistent; the app must detect this and warn the user. |
| Mobile phones | Unsupported (documented) |

The app must detect missing OPFS support at startup and either fall back to an in-memory database with a visible "not persistent" banner or refuse to start with a clear message. It must never silently fall back.

### User stories

**US-01 — Execute SQL queries**
As a developer or SQL learner, I want to write and run SQL in my browser so that I can test SQL without installing database software.
Acceptance criteria:
- The editor supports SQL syntax highlighting.
- Users can run the whole script or the selected text.
- Each statement produces its own result (see execution contract, §5.2).
- Errors identify the failing statement.
- Statements before the failing statement are reported as completed.

**US-02 — Import and explore databases**
As a developer, I want to import an existing SQLite database so that I can inspect its schema and data.
Acceptance criteria:
- Users can pick a local SQLite file or `.sql` script.
- The file is validated before anything is stored (see §5.5).
- Import creates a new database entry and never overwrites an existing one without explicit confirmation.
- Tables, columns, constraints, and indexes appear in the explorer.
- Users can browse table records with paging.
- Users can export the modified database.

**US-03 — Analyze query performance**
As a developer, I want to inspect plans and timings so that I can understand how SQLite processes my queries.
Acceptance criteria:
- Users can run `EXPLAIN QUERY PLAN` for a query with one action.
- Plans are shown as a tree, with the raw SQLite output one click away.
- Scans, searches, and reported index usage are identified without labeling any as inherently good or bad.
- Users can pin a plan and compare it against a later plan for the same query.

**US-04 — Keep my work safe**
As a user, I want my databases to persist and be exportable so that a cleared browser or failed storage doesn't cost me my work.
Acceptance criteria:
- Databases survive reloads.
- Storage and quota errors are explained.
- The UI reminds users that browser storage is not a backup and offers one-click export.
- Query history can be cleared or disabled.

---

## 3. Feature Breakdown and MVP Scope

### Epic 1 — SQL Workspace

**MVP**
- SQL editor (CodeMirror 6) with syntax highlighting.
- Run all / run selection, with keyboard shortcuts.
- Multi-statement execution per the execution contract (§5.2).
- Per-statement result, error, and timing display.
- Cancel running query.
- Basic query history (last 100 entries, stored locally in IndexedDB) with a "Clear history" control and a setting to disable history.
- Open-transaction indicator (see §5.2).
- Statement policy: `ATTACH DATABASE` and `VACUUM INTO` are blocked with an explanatory message (see §5.2).

**Future:** autocomplete, multiple query tabs, history search, "run statement at cursor".

### Epic 2 — Database Explorer

**MVP**
- Create, rename, and delete databases.
- List tables and views.
- Inspect columns, types, constraints, and indexes.
- Browse table records with paging.
- Create/drop tables and insert/update/delete rows via SQL.
- Bundled sample database, created by running a bundled SQL script through the execution contract.

**Future:** visual table editor, schema designer, ER diagrams.

### Epic 3 — Database Import and Export

**MVP**
- Import `.db`, `.sqlite`, `.sqlite3` files (validated, staged, never overwriting by default).
- Import `.sql` scripts (executed via the execution contract into a chosen or new database).
- Export the current database as a `.sqlite` file.
- Clear errors for unsupported, encrypted, or corrupted files.

**Future:** export schema/data as SQL, drag-and-drop import, richer diagnostics.

### Epic 4 — Query Performance Analysis

**MVP**
- `EXPLAIN QUERY PLAN` for a statement, with raw output preserved.
- Plan parsed into a tree; scans, searches, and index usage identified.
- Short, neutral explanation text per operation type (useful for learners).
- Execution timing display.
- **Plan comparison (lite):** pin a plan, change schema (e.g., `CREATE INDEX`), re-run, view a node-level diff.

**Future:** repeated-run benchmarking, multi-query comparison, graphical plan visualization.

### Epic 5 — Browser Persistence

**MVP**
- Store databases via OPFS (VFS per ADR-001), using stable ID-based file names.
- Database list with metadata (name, created, last opened, size) in IndexedDB, with startup reconciliation against the files actually present (§5.6).
- Reopen and switch databases (one active connection at a time).
- Detect unavailable OPFS, quota errors, and storage failures, with clear messages.
- Tab-ownership guard using the Web Locks API (§5.6).
- Explicit export/backup prompts.

**Future:** multi-tab coordination, additional storage backends.

### Epic 6 — User Experience

**MVP**
- Desktop-first workspace: explorer sidebar, editor, results, analysis panel.
- Dark theme.
- Loading, empty, and error states.
- Accessibility designed in from the start (grid pattern decided in Week 4, audited in Week 9; see NFR-11).

**Future:** light/dark switching, resizable panels, result copy and filtering, learning mode, mobile layout.

### MVP release boundary

The first release includes:
1. SQL editor, multi-statement execution, results, errors, timing, cancellation.
2. Database creation, listing, switching, and schema exploration.
3. SQLite and `.sql` import; SQLite export.
4. OPFS persistence with failure handling and reconciliation.
5. `EXPLAIN QUERY PLAN` analysis, including plan comparison (lite).
6. Desktop-first, accessible workspace.

Explicitly excluded: user accounts, cloud sync, remote DB connections, backend APIs, collaboration, visual schema designer, advanced benchmarking dashboards, mobile layout.

---

## 4. Technology Stack

| Layer | Technology | Responsibility |
|-------|------------|----------------|
| UI | React + TypeScript | Application interface |
| Build | Vite | Dev server and bundling |
| Styling | Tailwind CSS + shadcn/ui | UI components |
| Editor | CodeMirror 6 | SQL editing and highlighting |
| Async data / UI state | TanStack Query + small store (Proposed) | Worker-backed reads, UI state |
| Database engine | `@sqlite.org/sqlite-wasm` (Proposed) | SQL execution and statement splitting |
| Rust/WASM | Rust + wasm-bindgen (PoC-gated) | Plan parsing and plan diff |
| Background execution | Dedicated Web Worker | Keep all database work off the UI thread |
| Persistence | OPFS via `opfs-sahpool` (Proposed) | Persistent database files |
| App metadata | IndexedDB (via a small wrapper such as `idb`), versioned schema | Database list, query history, preferences |
| Unit tests | Vitest, `cargo test` | TS and Rust logic |
| Browser tests | Playwright | End-to-end and integration |
| Deployment | Cloudflare Pages or equivalent | Static hosting |

**IndexedDB schema versioning:** the metadata store starts at version 1 with object stores `databases`, `history`, and `preferences`. Every schema change increments the version and ships a tested migration. Migrations never delete user databases or history without confirmation.

### ADR-001: OPFS VFS selection (Proposed)

| | `opfs` | `opfs-sahpool` |
|---|--------|----------------|
| COOP/COEP headers | Required (uses `SharedArrayBuffer`) | Not required |
| Multiple connections/tabs | Yes, with `SQLITE_BUSY` handling | One at a time |
| Performance | Good | Reported fastest of the OPFS options in SQLite's docs |
| Safari < 17 | Affected by sub-worker bug | Works |
| Files in OPFS | Normal file names | Stored in a pool; not browsable as normal files |
| Capacity | Grows as needed | Pool capacity must be managed deliberately |

**Proposed decision:** use `opfs-sahpool`. It removes the header requirement (simpler Cloudflare Pages and Playwright setup, and no risk of COEP breaking third-party assets), and the single-connection limit matches the single-writer model. The cost is no multi-tab access, which the tab-ownership guard handles.

**PoC must verify:**
- Install and reopen across reloads on Chrome, Firefox, and Safari 17+.
- Behavior when a second tab opens the app.
- Pool capacity needed for N databases, including journal files.
- Export of a database held in the pool.
- Behavior of WAL mode (if unsupported, enforce rollback-journal mode and document it).
- What happens to handles and locks when the worker is terminated (needed by ADR-004).

If any check fails, reconsider the default `opfs` VFS with COOP/COEP headers via a Cloudflare Pages `_headers` file.

**Content Security Policy:** if a CSP is added, WebAssembly compilation requires `'wasm-unsafe-eval'` in `script-src`, and `worker-src` must allow the worker origin. Test the CSP against a production build.

### ADR-002: Rust layer (PoC-gated, deliberately narrow)

SQLite already handles statement splitting and parsing, so Rust does not touch execution. The crate has one concrete scope: plan analysis.

| Component | Responsibility |
|-----------|----------------|
| `plan` | Parse SQLite plan rows (`id, parent, notused, detail`) into a tree; tag operations. |
| `plan_diff` | Compare two plan trees and produce a node-level diff for plan comparison. |

This is modest work, and the plan states it plainly. Including Rust is a deliberate portfolio decision to show a well-bounded Rust/WASM integration, and the case study says so rather than overstating the need. If the integration cost outweighs the benefit, the TypeScript fallback ships.

**Gate and fallback:** the crate is exposed through a TypeScript interface (`PlanToolkit`). The PoC passes if the wasm-bindgen module builds, loads inside the worker under Vite production builds, and round-trips typed data. If not, a TypeScript implementation of the same interface ships in the MVP and the Rust crate moves to Future. App code never depends on which implementation is behind the interface.

```ts
interface PlanToolkit {
  parsePlan(rows: RawPlanRow[], sqliteVersion: string): QueryPlan;
  diffPlans(before: QueryPlan, after: QueryPlan): PlanDiff;
}

interface RawPlanRow { id: number; parent: number; detail: string }

interface QueryPlanNode {
  id: number;
  parentId: number;                 // as reported by SQLite; 0 = root
  operation: "SCAN" | "SEARCH" | "OTHER";
  table?: string;
  index?: string;
  tags: string[];                   // e.g. "COVERING INDEX", "AUTOMATIC INDEX",
                                    // "TEMP B-TREE", "CO-ROUTINE", "MATERIALIZE"
  detail: string;                   // raw SQLite text, always preserved
}

interface QueryPlan { nodes: QueryPlanNode[]; raw: RawPlanRow[]; sqliteVersion: string }
interface PlanDiff {
  added: QueryPlanNode[];
  removed: QueryPlanNode[];
  changed: { before: QueryPlanNode; after: QueryPlanNode }[];
}
```

Plan text can vary between SQLite versions, so the parser is tested against fixtures from the selected SQLite version, and unknown forms degrade to `OTHER` with the raw `detail`, never an error.

**Rule:** do not label scans as bad or index searches as optimal. Neutral explanation text only.

---

## 5. Architecture and Contracts

### 5.1 Architecture overview

```text
┌──────────────────────────────────────────────┐
│                 Browser UI                   │
│  SQL Editor | Explorer | Results | Analysis  │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│              Application Layer               │
│  Database Service  · Import/Export Service   │
│  Query Analysis Service · Storage Service    │
│  Worker Manager (requests, cancel, recovery) │
│  Tab Guard (Web Locks)                       │
└──────────────────────┬───────────────────────┘
                       │ typed request/response messages
┌──────────────────────▼───────────────────────┐
│              Dedicated Web Worker            │
│  SQLite WASM  ·  PlanToolkit (Rust or TS)    │
│  OPFS VFS (opfs-sahpool)                     │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│     OPFS (database files)  ·  IndexedDB      │
│                          (app metadata)      │
└──────────────────────────────────────────────┘
```

| Module | Responsibility |
|--------|----------------|
| SQL Editor | Editing and submitting SQL |
| Database Explorer | Schema and table navigation, table browsing |
| Result Renderer | Accessible virtualized grid, truncation notice, errors |
| Query Analyzer UI | Plan tree, timing, plan comparison |
| Import/Export | File validation, staging, export |
| Storage Manager | Database lifecycle, reconciliation, quota |
| Tab Guard | Single-tab ownership via Web Locks |
| Worker Manager | Initialization, request correlation, cancellation, crash recovery |
| PlanToolkit | Plan parsing and plan diff |

### 5.2 Execution contract

1. **Statement splitting uses SQLite itself.** The worker walks the script with SQLite's own prepare loop (prepare one statement, execute it, finalize, continue from the remaining tail), for example via `sqlite3_prepare_multi` if exposed in the chosen build (verify in the PoC). Statements are not all prepared up front, because later statements can depend on tables created by earlier ones. The prepare tail also gives each statement's offsets for error highlighting.
2. **Sequential execution.** Statements run one at a time, in order.
3. **Statement policy.** Before executing each statement, the worker checks its leading keyword (after whitespace and comments). `ATTACH DATABASE` and `VACUUM INTO` are rejected with a `POLICY_BLOCKED` error and an explanation, because they would create or open additional files and consume pool capacity. This is a guardrail against confusing failures, not a security boundary. Extension loading is unavailable in the WASM build. Because policy is checked per statement, earlier statements in the same script may already have run, consistent with rule 5.
4. **Autocommit by default.** There is no implicit wrapping transaction. If the user writes `BEGIN`/`COMMIT`/`ROLLBACK`, those are honored.
5. **Stop on first error.** Execution stops at the first failing statement. Earlier statements keep their effects (unless rolled back by the user's own transaction). The response lists each statement's outcome.
6. **Transaction state is read from SQLite, never assumed.** After every statement and every error, the worker reads SQLite's real autocommit state. SQLite can roll back a transaction by itself on certain errors (for example disk-full or I/O errors). If the state changes from in-transaction to autocommit after an error, the UI says "SQLite rolled back your transaction." If a user-opened transaction remains open after an error, the UI shows an open-transaction indicator with Commit and Rollback actions, and nothing is rolled back silently.
7. **Row cap.** Each statement returns at most `maxRows` rows (default 1,000). If more exist, the result is marked `truncated: true`. The table browser uses separate paged queries (`LIMIT/OFFSET` for MVP).
8. **Timing.** `engineMs` is measured inside the worker with `performance.now()` around prepare + step + row collection. Because of the row cap, it is the time to produce the first N rows, and the UI labels it "engine time (first N rows)" when truncated. Transfer and render time are not included.
9. **Row counts.** `rowsAffected` is reported only for `INSERT`, `UPDATE`, `DELETE`, and `REPLACE`. For other statements (DDL, `PRAGMA`, etc.) it is omitted, because SQLite's change counter would otherwise report a stale value from an earlier statement.
10. **Plan requests.** `EXPLAIN QUERY PLAN` is requested explicitly for one statement and runs through the same worker request path.

### 5.3 Typed contracts

```ts
// Value model: no information loss across the worker boundary.
type SqlValue = null | number | bigint | string | Uint8Array;
// INTEGER values beyond 2^53 arrive as bigint; BLOBs as Uint8Array.
// The UI renders BLOBs as "<BLOB n bytes>" and NULL distinctly from the text "NULL".

interface StatementSpan { start: number; end: number; text: string }
interface ColumnInfo { name: string; declaredType?: string }

type StatementResult =
  | { kind: "rows"; sql: string; columns: ColumnInfo[]; rows: SqlValue[][];
      truncated: boolean; engineMs: number }
  | { kind: "change"; sql: string; rowsAffected?: number;   // DML only
      lastInsertRowId?: bigint; engineMs: number }
  | { kind: "error"; sql: string; error: DbError; span: StatementSpan };

interface ExecutionResponse {
  statements: StatementResult[];   // in order; stops after first error
  inTransaction: boolean;          // real SQLite autocommit state
  rolledBackBySqlite?: boolean;    // true if SQLite ended the transaction itself
  totalEngineMs: number;
}

interface DbError {
  code:
    | "SQL_ERROR" | "CONSTRAINT" | "CANCELLED" | "IO" | "QUOTA"
    | "POLICY_BLOCKED" | "UNSUPPORTED_FILE" | "CORRUPT_FILE"
    | "LOCKED_BY_OTHER_TAB" | "WORKER_CRASHED" | "STORAGE_UNAVAILABLE";
  message: string;
  sqliteCode?: number;
  offset?: number;                 // error position in statement, if SQLite reports it
}

type DatabaseStatus = "ok" | "missing-file" | "recovered";

interface DatabaseInfo {
  id: string;                      // stable; also determines the file name
  name: string;                    // display name, metadata only
  createdAt: number;
  lastOpenedAt: number;
  sizeBytes: number;
  status: DatabaseStatus;
}

interface DatabaseService {
  // lifecycle
  listDatabases(): Promise<DatabaseInfo[]>;
  createDatabase(name: string): Promise<DatabaseInfo>;
  createSampleDatabase(): Promise<DatabaseInfo>;   // runs bundled SQL script
  openDatabase(id: string): Promise<void>;         // closes any open DB first
  renameDatabase(id: string, name: string): Promise<void>;  // metadata only
  deleteDatabase(id: string): Promise<void>;       // UI requires explicit confirmation

  // import / export
  validateImport(file: File): Promise<ImportReport>;
  importDatabase(file: File, opts: { name: string }): Promise<DatabaseInfo>;
  importScript(file: File, targetId: string): Promise<ExecutionResponse>;
  exportDatabase(id: string): Promise<Blob>;

  // execution
  execute(sql: string, opts?: { maxRows?: number; requestId?: string }): Promise<ExecutionResponse>;
  cancel(requestId: string): Promise<void>;
  explain(sql: string): Promise<QueryPlan>;

  // schema
  getSchema(): Promise<DatabaseSchema>;
  browseTable(table: string, page: { limit: number; offset: number }): Promise<StatementResult>;
}
```

Errors that prevent execution altogether (worker crash, storage failure) reject the Promise with a `DbError`. SQL-level errors appear inside `ExecutionResponse` as an `error` statement result so earlier results are not lost.

### 5.4 Worker protocol and cancellation (ADR-003, ADR-004)

- Every message carries a `requestId`. Responses echo it. The Worker Manager keeps a map of pending requests.
- One request runs at a time (single-writer model); additional requests queue.
- A synchronous SQLite call inside a worker cannot be interrupted by a message sent to the same worker.

**Cancellation (Proposed):**
1. The UI calls `cancel(requestId)`.
2. The Worker Manager terminates the worker, rejects the pending request with `CANCELLED`, and starts a fresh worker.
3. The fresh worker reinstalls the VFS and reopens the active database. SQLite's journal recovery rolls back any incomplete write.
4. The UI shows "Query cancelled; database reopened."

**PoC must verify:** that terminating the worker releases OPFS handles and locks; that reopening after a mid-write termination leaves the database intact; how long the full restart takes (this sets the real cancel target, currently 5 s); and whether a progress-handler-based soft cancel is available in the chosen build (an alternative that avoids termination).

Also handled: worker initialization failure, unexpected worker crash (`WORKER_CRASHED`, with automatic restart and an actionable message), and long-running requests (visible running state and elapsed timer).

### 5.5 Import validation and data safety

Import flow: **select → validate (no storage touched) → stage → create new entry → open.**

Validation checks:
1. File header is `SQLite format 3\0`; otherwise `UNSUPPORTED_FILE`.
2. Page size and size sanity; reject truncated files.
3. Journal-mode bytes in the header: if the file is in WAL mode, warn that content in a separate `-wal` file is not part of the imported file, then import and convert to the supported journal mode (per PoC findings).
4. `PRAGMA quick_check` on the staged copy (full `integrity_check` offered as an option for large files).
5. Encrypted or non-SQLite files show a specific message.

**Untrusted files:** an imported database can contain views, triggers, and generated columns that run when queried. SQL inside the WASM sandbox has no filesystem or network access, so the realistic risks are resource exhaustion and crashes, which cancellation and recovery cover. As defense in depth, evaluate opening imported databases with `PRAGMA trusted_schema=OFF` (and SQLite's defensive mode, if exposed by the build) and record the outcome in ADR-001 and the case study.

Safety rules:
- Import never overwrites an existing database unless the user explicitly picks "replace" and confirms.
- The user's original file remains on their disk, so the app does not store a second copy.
- Database size: tested up to **100 MB**; warn above that and at **250 MB**, because export and import hold the file in memory. Enforce a hard stop only if the PoC shows instability.
- Quota: check `navigator.storage.estimate()` before import and show required vs. available space.
- Persistence request: call `navigator.storage.persist()` where available and explain the result.
- Destructive operations (delete database, replace on import, `DROP TABLE` / `DELETE` without `WHERE` in the editor) show a confirmation or warning.
- History can contain sensitive SQL: users can clear it or turn it off, and it never leaves the browser.

### 5.6 Tab ownership and database reconciliation (ADR-005)

**Tab guard.** At startup, before installing the VFS, the page requests an exclusive Web Lock (for example `sql-playground:owner`) with `ifAvailable: true` and holds it for the lifetime of the tab.
- If the lock is granted, the tab owns the databases and proceeds.
- If not, the tab shows a blocking "Already open in another tab" screen with a Retry action and never installs the VFS or opens a database.
- The lock is held by the page, not the worker, so closing the tab or a worker restart behaves predictably.
- Verify Web Locks behavior in the PoC across the browser matrix; if unavailable, fall back to a `BroadcastChannel` ping with the same blocking screen.

**Reconciliation.** Database files live in OPFS (the pool) and the database list lives in IndexedDB, so they can drift apart after a crash or interrupted delete.
- Files are named by stable ID (for example `db_<id>.sqlite3`); display names exist only in metadata, which also makes rename a metadata-only change.
- Delete is a two-phase operation: mark the entry `deleting` in metadata, delete the file, then remove the entry. Reconciliation completes any `deleting` entries.
- On startup the Storage Manager lists the files present and compares them with metadata.
  - A file with no metadata becomes a "Recovered database" entry the user can open, export, or delete.
  - Metadata with no file is marked `missing-file` and the user is offered removal.
- Reconciliation results are logged locally for the architecture docs, never transmitted.

---

## 6. Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-01 | Local execution | No database content leaves the browser (Playwright network assertion). |
| NFR-02 | Responsiveness | No main-thread long task > 100 ms during a ≥ 5 s query; cancel completes within 5 s (*unvalidated*). |
| NFR-03 | Persistence | Databases survive reloads; 50 MB database reopens in < 2 s (*unvalidated*). |
| NFR-04 | Reliability | Failed queries leave application state consistent; worker crash recovers without losing persisted data; the database list reconciles after interrupted operations. |
| NFR-05 | Data integrity | Modifications follow SQLite transaction semantics; exported files pass `integrity_check`. |
| NFR-06 | Compatibility | Browser matrix in §2 documented in README; unsupported browsers see a clear message. |
| NFR-07 | Error handling | Every `DbError.code` has a user-facing message with a next step. |
| NFR-08 | Large results | Default 1,000-row cap; grid virtualized; table browser paged. |
| NFR-09 | Maintainability | UI, database service, storage, and plan toolkit are separate modules; toolkit callable through one interface. |
| NFR-10 | Privacy | No telemetry or uploads containing SQL or data by default; query history can be cleared or disabled. |
| NFR-11 | Accessibility | App chrome targets WCAG 2.2 AA. The results grid uses an ARIA grid pattern designed in Week 4 (`aria-rowcount`/`aria-colcount` for virtualized rows, roving tabindex, arrow-key navigation); the explorer is fully keyboard navigable; CodeMirror accessibility features are enabled; focus is managed when panels change; color is never the only signal. |
| NFR-12 | Startup | Application interactive in < 3 s on broadband (cold cache), with a visible loading state while WASM initializes. |

### Data safety requirements

- OPFS is origin-private storage, not a guaranteed backup; the UI says so.
- Browser storage can be cleared or evicted; provide explicit export and periodic backup prompts.
- Handle quota errors (`QUOTA`) and unavailable storage (`STORAGE_UNAVAILABLE`).
- Validate imports before storing anything.
- Use the tab-ownership guard instead of assuming multi-tab safety.
- Reconcile database metadata and files at startup.
- Communicate destructive operations clearly.

---

## 7. Implementation Roadmap

Estimated duration: **11 weeks** at about 25 focused hours per week. Buffers are built in: PoC overflow in Week 2, slack in Week 7, and part of Week 11. Tests and CI are continuous: every week's Definition of Done includes tests for what was built that week.

### Weeks 1–2 — Proof of concept, ADRs, go/no-go

**Week 1**
- Vite + React + TypeScript set up; CI (lint, type-check, Vitest) running from day one.
- SQLite WASM in a worker; execute SQL; install `opfs-sahpool`; persist across reload.
- Verify the prepare-loop statement splitting approach and the transaction-state reading.
- Deploy the PoC to Cloudflare Pages to catch hosting and WASM issues early.

**Week 2**
- Rust crate builds with wasm-bindgen, loads in the worker under a **production** Vite build, round-trips typed data (ADR-002 gate).
- Run the PoC checks in ADR-001 and ADR-004 on Chrome, Firefox, and Safari 17+, including Web Locks behavior and worker-termination recovery with measured restart time.
- Write ADR-001 to ADR-005.

**Deliverable:** Working PoC and five ADRs.
**Go/no-go (end of Week 2):** all of the following must hold: SQLite executes in a worker; persistence works through OPFS; the plan toolkit (Rust or TS fallback) is callable from the worker; worker/React messaging with `requestId` is reliable; the tab guard works. If the gate fails, re-plan before proceeding.

### Week 3 — Foundation and persistence core

- Typed worker protocol and Worker Manager (requests, queue, errors, restart).
- Storage Service: database lifecycle (`create/open/list/rename/delete`), ID-based file names, IndexedDB metadata with versioned schema, startup reconciliation, Tab Guard, quota and availability detection.
- Error model (`DbError`) and error boundary.
- Workspace layout shell.

**Deliverable:** Persistent multi-database foundation with tests, including reconciliation tests.

### Week 4 — SQL workspace

- CodeMirror 6 integration.
- Execution contract: SQLite-driven statement splitting, sequential run, statement policy, stop on error, transaction-state indicator.
- Results grid (virtualized) with the ARIA grid pattern and keyboard navigation designed now; truncation notice; SQL error display with position.
- Engine timing display, keyboard shortcuts.

**Deliverable:** Working, keyboard-accessible SQL execution experience.

### Week 5 — Explorer, sample data, history

- Schema explorer: tables, views, columns, constraints, indexes.
- Table browser with paging.
- Bundled sample database created by running a bundled SQL script through the execution contract, plus demo queries.
- Query history (IndexedDB) with clear and disable controls.

**Deliverable:** Functional SQLite IDE (without import/export).

### Week 6 — Import and export

- Import validation pipeline (§5.5), staging, and new-entry creation; `trusted_schema` evaluation.
- `.sql` script import.
- Export and backup flows; backup reminders.
- Quota checks and size warnings.

**Deliverable:** Import/export with data-safety behavior tested against corrupted, encrypted, WAL, and oversized files.

### Week 7 — Reliability and cancellation (slack week)

- Cancel via worker termination and recovery (ADR-004); mid-write termination tests.
- Worker initialization and crash handling.
- Large-result handling and long-query UX.
- Multi-tab and storage failure paths.
- Slack for PoC fallout and slipped items.

**Deliverable:** Resilient execution layer.

### Week 8 — Query analysis

- Plan parsing, tagging, and tree (Rust or TS behind `PlanToolkit`).
- Raw plan view and neutral operation explanations.
- Plan pin and diff (plan comparison lite).

**Deliverable:** Query analysis feature with fixtures tested against the selected SQLite version.

### Week 9 — UX and accessibility audit

- Workspace polish, dark theme, empty/loading/error states.
- Accessibility audit (axe plus manual keyboard and screen-reader pass) of what Week 4 designed in.
- Desktop-first layout checks; unsupported-browser and unsupported-viewport messaging.

**Deliverable:** Polished, audited application.

### Week 10 — QA and benchmarks

- Full Playwright suite on the browser matrix, including the privacy network test (scenario 14).
- Benchmarks: reopen time, import/export times at 10/50/100 MB, 1,000-row render, long-task measurement during heavy queries, cancel restart time.
- Fix findings against NFR targets; finalize or adjust *unvalidated* targets.

**Deliverable:** Test and benchmark report.

### Week 11 — Documentation, deployment, buffer

- README (including browser matrix and limits), architecture diagram, case study draft.
- Production deployment, final regression pass.
- Remaining buffer for slipped items.

**Deliverable:** Public portfolio release.

---

## 8. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| SQLite WASM + OPFS integration | High | Weeks 1–2 PoC; ADR-001; fallback to `opfs` VFS with headers or to in-memory + export |
| `opfs-sahpool` pool capacity and single-connection limits | High | PoC capacity test; tab guard; statement policy blocking `ATTACH`/`VACUUM INTO`; clear user messaging |
| Query cancellation and restart time | High | Terminate-and-reopen design; PoC measurement; Week 7 testing; target relaxed to 5 s until validated |
| Database list and file drift | Medium | ID-based file names, two-phase delete, startup reconciliation (§5.6) |
| Rust/JS interoperability and build complexity | Medium | Narrow scope; TS fallback behind `PlanToolkit`; ADR-002 gate |
| Rust adds little user value for its cost | Low | Stated honestly in ADR-002 and the case study; fallback available |
| Browser storage limits and eviction | High | Quota checks, `persist()` request, export prompts |
| Large database performance and memory | High | 100 MB tested limit, warnings, benchmarks in Week 10 |
| Safari / private-mode OPFS differences | Medium | Browser matrix, feature detection, explicit non-persistent banner |
| WAL / journal-mode surprises on import | Medium | Header detection, warning, PoC verification |
| Untrusted imported schemas | Medium | Sandboxed execution, cancellation, `trusted_schema` evaluation |
| Plan-format variation across SQLite versions | Medium | Preserve raw output; version-pinned fixtures; unknown forms degrade to `OTHER` |
| Worker failures | Medium | Crash detection, auto-restart, user-visible recovery |
| Schedule pressure from part-time availability | Medium | Stated hours assumption; slack in Weeks 2, 7, 11; explicit go/no-go |
| Scope creep | Medium | MVP boundary in §3; weekly Definition of Done |

### Technical research checklist (status)

Answered by this plan:
- Is SharedArrayBuffer/cross-origin isolation required? Only for the default `opfs` VFS. `opfs-sahpool` avoids it (ADR-001).
- How are multiple statements handled? §5.2.
- How is duration measured? §5.2, item 8.
- How are corrupted or unsupported files handled? §5.5.
- How is cancellation done? §5.4 (to be verified in the PoC).
- How is multi-tab safety handled? §5.6.

Still to verify in the PoC:
- Exact `@sqlite.org/sqlite-wasm` version, and bundling with Vite (workers, `.wasm` loading in production builds).
- Whether `sqlite3_prepare_multi` (or an equivalent prepare loop) is exposed, and reading SQLite's autocommit state.
- Pool capacity and journal-file behavior, WAL support, export from the pool.
- Safari 17+ and private-window behavior.
- Web Locks behavior across the browser matrix.
- Whether `sqlite3_error_offset` (error position) is exposed in the chosen build.
- Whether a progress-handler soft cancel is available.
- Handle release on worker termination and full restart time.
- Effect of `PRAGMA trusted_schema=OFF` and defensive mode on imported databases.

---

## 9. Suggested Project Structure

```text
browser-sql-playground/
├── apps/
│   └── web/
│       ├── src/
│       │   ├── app/
│       │   ├── features/
│       │   │   ├── sql-editor/
│       │   │   ├── database-explorer/
│       │   │   ├── query-results/
│       │   │   ├── query-analysis/
│       │   │   ├── database-import/
│       │   │   └── database-export/
│       │   ├── services/
│       │   │   ├── database/
│       │   │   ├── storage/          # lifecycle, reconciliation, tab guard
│       │   │   ├── toolkit/          # PlanToolkit interface + TS fallback
│       │   │   └── worker/
│       │   ├── workers/
│       │   │   └── sqlite.worker.ts
│       │   └── shared/
│       └── package.json
├── crates/
│   └── query-analyzer/               # plan parser and plan diff
│       ├── src/
│       │   ├── plan.rs
│       │   ├── plan_diff.rs
│       │   └── lib.rs
│       └── Cargo.toml
├── docs/
│   ├── adr/                          # ADR-001 … ADR-005
│   ├── architecture.md
│   ├── requirements.md
│   ├── testing-strategy.md
│   └── browser-support.md
├── Cargo.toml
├── package.json
└── README.md
```

Adjust if the selected Rust/WASM tooling requires a different output layout.

---

## 10. Testing and Acceptance Scenarios

Tests are written alongside features. Rust logic is tested natively with `cargo test`; wasm glue with wasm-bindgen tests; fixtures cover the selected SQLite version.

The MVP must pass these scenarios on the browser matrix:

1. Create a database and a table.
2. Insert, update, and delete records.
3. Run SELECT queries and see results, including truncation at the row cap.
4. Import an existing SQLite database (valid file).
5. Modify and export the imported database; verify it opens in the `sqlite3` CLI.
6. Reload the browser and reopen the database.
7. Run a query that uses an index and inspect its plan.
8. Run a query that causes a table scan and inspect its plan.
9. Run invalid SQL and see an understandable error with position where available.
10. Run a heavy query without freezing the UI (no long tasks > 100 ms).
11. Handle OPFS storage failure and quota errors.
12. Handle worker initialization and execution failure with recovery.
13. Verify transaction behavior: explicit `BEGIN` / `ROLLBACK`; the open-transaction indicator after an error; and the "SQLite rolled back your transaction" message when SQLite ends a transaction itself.
14. Verify no database content is sent to a remote server (network assertion).
15. Cancel a runaway query (for example a recursive CTE); the database reopens intact and the UI returns to idle within the validated cancel target.
16. Import rejects non-SQLite, truncated, and encrypted files with specific messages.
17. Import of a WAL-mode file shows the documented warning.
18. A second tab opening the app shows the "Already open in another tab" screen and never opens a database or causes corruption.
19. Pin a plan, create an index, re-run, and see the plan diff.
20. BLOB, NULL, and 64-bit integer values display correctly.
21. Keyboard-only walkthrough: run a query, move through results, open the explorer, cancel a query.
22. Unsupported browser or private window shows a clear warning instead of silently losing data.
23. `ATTACH DATABASE` and `VACUUM INTO` are blocked with an explanatory `POLICY_BLOCKED` message; earlier statements in the same script behave per the stop-on-error rule.
24. Reconciliation: after a simulated crash, an orphan file appears as a "Recovered database," a missing file is flagged, and an interrupted delete is completed.
25. Query history can be cleared and disabled; nothing is recorded while disabled.
26. DDL and `PRAGMA` statements show no row count, and DML shows the correct count (no stale values).

### Definition of Done (per epic)

- Acceptance scenarios for the epic pass in CI.
- Unit/integration tests cover new logic; no failing or skipped tests.
- Error paths show user-facing messages.
- Keyboard and screen-reader basics verified for new UI.
- Notes added to docs (ADR or architecture) where a decision was made.

---

## 11. Portfolio Deliverables

| Deliverable | Purpose |
|-------------|---------|
| Live application | Demonstrate working functionality |
| GitHub repository | Demonstrate code quality and commit history |
| Architecture diagram and ADRs | Explain technical decisions and trade-offs |
| Technical case study | Explain engineering challenges |
| Rust WASM plan analyzer (if ADR-002 passes) | Demonstrate a well-bounded Rust/WASM integration |
| Performance benchmarks | Back optimization and limit claims with data |
| Automated tests and CI | Demonstrate reliability |
| Accessibility notes | Demonstrate inclusive UI engineering |
| README | Installation, usage, browser matrix, limits |
| Demo database and guided demo queries | Let visitors explore immediately |

### Case study outline

1. Project overview and positioning.
2. Problem statement and target users.
3. Requirements and MVP boundary.
4. Technology selection and ADRs.
5. System architecture.
6. SQLite WASM integration.
7. OPFS persistence, the VFS trade-off, and reconciliation.
8. Worker protocol and cancellation.
9. Rust plan analyzer (or why it was deferred), including an honest account of its scope.
10. Query plan analysis and comparison.
11. Security posture for untrusted imported databases.
12. Engineering challenges and failures.
13. Testing, accessibility, and benchmark results.
14. Screenshots and demo.
15. Lessons learned.

---

## 12. Technical References

- SQLite WASM documentation: https://sqlite.org/wasm/doc/trunk/index.md
- SQLite WASM persistence (VFS options, COOP/COEP, incognito notes): https://sqlite.org/wasm/doc/trunk/persistence.md
- SQLite WASM repository: https://github.com/sqlite/sqlite-wasm
- npm package: `@sqlite.org/sqlite-wasm`
- wasm-bindgen documentation: verify the current location (the former `rustwasm.github.io` docs site may be outdated; check the wasm-bindgen repository for the current guide)
- MDN OPFS: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
- MDN Web Locks API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
- MDN Web Workers: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API
- CodeMirror: https://codemirror.net/
- sql.js (fallback option): https://sql.js.org/
- wa-sqlite (fallback option): https://github.com/rhashimoto/wa-sqlite

---

## 13. Final Project Assessment

| Attribute | Assessment |
|-----------|------------|
| Project complexity | Intermediate–Advanced |
| Portfolio value | High, if the PoC gates pass and the plan-comparison feature ships |
| Technical depth | High |
| MVP estimate | 11 weeks at ~25 hours/week (with built-in buffers) |
| Architecture | Browser-only |
| Backend dependency | None |
| Primary technical differentiator | SQLite WASM + OPFS (+ narrow Rust plan analyzer if it passes its gate) |
| Primary user-facing differentiator | Query plan analysis and before/after comparison |
| Core engineering challenges | OPFS VFS behavior, worker cancellation and recovery, data safety on import/export |

### Recommendation

Keep the MVP focused on a reliable, accessible SQLite IDE whose standout feature is plan analysis. Treat the end of Week 2 as a genuine go/no-go gate: every **Proposed** decision above is replaced by a written ADR outcome before feature work begins. If the Rust gate fails, ship the TypeScript implementation and describe the decision honestly in the case study. That is a stronger engineering story than forcing the integration.

### Next phase — SRS and Technical Design

The next phase produces:

1. Functional requirements with unique IDs, plus a traceability matrix (success criterion → user story → acceptance scenario).
2. Final NFR values after PoC and benchmark data.
3. Implementation backlog derived from the epics and weekly plan.
4. Component architecture and the finalized worker contracts from §5.
5. `query-analyzer` module specification, including fixtures.
6. SQLite/OPFS integration specification from ADR-001, ADR-004, and ADR-005.
7. Testing strategy covering the 26 scenarios.
8. Per-epic Definition of Done checklists.
