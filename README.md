# Browser SQL Playground

A browser-based SQLite development environment: SQL editor, database explorer, query-plan analysis — running entirely client-side with SQLite WASM and OPFS persistence.

See [FINAL_PROJECT_PLAN.md](./FINAL_PROJECT_PLAN.md) for the full project plan.

## Getting started

Prerequisites: Node 22+, pnpm, and Rust with the wasm target + wasm-bindgen
CLI (both pinned to `0.2.130`, matching `crates/query-analyzer`):

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
pnpm install
pnpm dev          # builds the query-analyzer wasm first if missing
```

Open http://localhost:5173 — the PoC shows SQLite in a worker, multi-statement
execution, OPFS persistence, plan explain (Rust wasm), worker restart/cancel,
export, and the multi-tab guard.

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start the Vite dev server (builds wasm glue if missing) |
| `pnpm build:wasm` | Build `crates/query-analyzer` → `apps/web/src/generated/` |
| `pnpm build` | Production build (always rebuilds wasm first) |
| `pnpm typecheck` | TypeScript type-check |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest unit tests (incl. wasm round-trip; skips if wasm not built) |
| `pnpm test:e2e` | Playwright e2e — dev server by default |
| `pnpm format` | Prettier write |

E2E options (env vars): `E2E_PREVIEW=1` runs the suite against `vite preview`
(**required for the ADR-002 gate** — proves the wasm loads in a production
bundle); `E2E_BROWSER=firefox` selects the browser. CI runs
`E2E_PREVIEW=1` on Chromium.

## Structure

```
apps/web/          React + TypeScript application
  src/shared/      Typed contracts (plan §5.3) + error model (DB_ERROR_CODES)
  src/services/    database (DatabaseService, execute, explain, policy), worker
                   manager, toolkit (PlanToolkit: Rust wasm + TS fallback),
                   storage (metadata DB, reconcile, quota, tab guard)
  src/workers/     sqlite.worker.ts (WASM + opfs-sahpool + PlanToolkit + file ops)
  src/features/    sql-editor (CodeMirror 6), database-explorer, query-results,
                   query-analysis, query-history, database-import/export
  src/generated/   wasm-bindgen output (git-ignored, built by pnpm build:wasm)
  e2e/             Playwright specs (PoC + Weeks 2–8)
crates/query-analyzer/  Rust plan parser + diff (ADR-002, behind PlanToolkit)
docs/adr/          ADR-001 … ADR-010
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push/PR:

- `cargo test` (plan parser + diff) · `pnpm build:wasm`
- `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build`
- Playwright e2e against the **production build** (`E2E_PREVIEW=1`), Chromium

## Deploy (Cloudflare Pages)

The app is a static SPA served by Cloudflare Pages; SQLite runs in the browser.
`opfs-sahpool` does **not** require COOP/COEP headers (ADR-001).
`wrangler.toml` sets `pages_build_output_dir = "apps/web/dist"`.

### Dashboard (Pages Builds)

1. Workers & Pages → **Create** → **Pages** → **Connect to Git** (Pages, not
   Workers).
2. Root directory: `/` (repository root — needed for the pnpm workspace).
3. Build command:

   ```bash
   bash scripts/cloudflare-build.sh
   ```

   Pages runs the build command as a single `sh -c` line, so do not paste a
   multi-line command into the dashboard — newlines are flattened and the shell
   fails with `Syntax error: word unexpected`. The script bootstraps Rust +
   wasm-bindgen (Cloudflare's build image has neither, otherwise `pnpm build`
   fails with `sh: 1: cargo: not found`), then runs `pnpm install` and
   `pnpm build`.
4. Build output directory: `apps/web/dist`.
5. Node 22+.

### Wrangler

```bash
pnpm build   # requires Rust + wasm-bindgen 0.2.130 locally
pnpm exec wrangler pages deploy apps/web/dist --project-name sql-playground
```

`apps/web/public/_redirects` (`/* /index.html 200`) provides the SPA fallback
for client-side deep links.

## Browser support

See plan §2. Chrome/Edge/Firefox current, Safari 17+. Phones unsupported. If
OPFS is unavailable the app falls back to an in-memory database with a visible
**not persistent** banner — never a silent fallback.

**PoC status (Week 2):** full e2e suite passes on **Chromium and Firefox**
(dev + production builds). Safari 17+ verification is pending a macOS run
(see `docs/adr/0001`).

## PoC checklists

### Week 1

- [x] Vite + React + TypeScript; CI (lint, typecheck, Vitest) from day one
- [x] SQLite WASM in a worker; execute SQL
- [x] `opfs-sahpool` install; persist across reload (e2e)
- [x] Prepare-loop statement splitting verified (unit tests)
- [x] Transaction-state reading verified (`sqlite3_get_autocommit`)
- [x] Cloudflare Pages deploy config

### Week 2

- [x] Rust crate builds with wasm-bindgen; loads in the worker under a
      **production** Vite build; round-trips typed data (**ADR-002 gate:
      PASSED** on Chromium + Firefox; `status.toolkit` shows `rust`)
- [x] ADR-001 checks: reload persistence, second-tab blocking, pool capacity
      visible, pool export (valid `SQLite format 3` header), WAL stays
      `delete`, worker-termination handle release — measured restart
      **87 ms** (Chromium prod) / **264 ms** (Firefox), target 5 s
- [x] ADR-004 checks: mid-query cancel via restart, database intact,
      UI returns to idle (scenario 15)
- [x] ADR-005 checks: Web Locks tab guard grants/blocks/retries correctly
- [x] ADR-001 … ADR-005 written (`docs/adr/`)
- [ ] Safari 17+ run (pending macOS; ADR-001/002/005 note it)

### Go/no-go (end of Week 2)

| Gate item | Status |
|-----------|--------|
| SQLite executes in a worker | ✅ |
| Persistence works through OPFS | ✅ (Chromium + Firefox, dev + production) |
| Plan toolkit (Rust or TS fallback) callable from the worker | ✅ Rust active in production builds; TS fallback tested |
| Worker/React messaging with `requestId` reliable | ✅ (unit + e2e) |
| Tab guard works | ✅ (e2e: second tab blocked, owner unaffected) |

**Result: GO** — proceed to Week 3 (foundation and persistence core), with
the Safari matrix run still owed before release.

### Week 3

- [x] Multi-database worker protocol: `open-db`/`list-files`/`delete-file`,
      `init.openFile`; Worker Manager re-opens the active file after every
      restart/crash (ADR-003 + ADR-004 recovery)
- [x] Storage Service: IndexedDB metadata schema v1 (`databases`/`history`/
      `preferences`), database lifecycle (create/rename/two-phase delete with
      rollback on failure), startup reconciliation — orphan files →
      "Recovered database", missing files → `missing-file`, interrupted
      deletes completed, foreign files ignored (scenario 24, ADR-005/006)
- [x] Quota/availability detection: OPFS support, `navigator.storage`
      usage/persist, `requestPersistentStorage` (never silent)
- [x] Error model: `DB_ERROR_CODES` with title/message/nextStep guidance
      (NFR-07), `DbOperationError` rejections, React `ErrorBoundary` with
      dismiss/reload recovery actions
- [x] Workspace layout: 3-column shell — database explorer (create/rename/
      delete with confirm, status badges, storage footer) | editor + results |
      analysis panel; tab guard and existing testids preserved
- [x] ADR-006 written; ADR-005 reconciliation status updated
- [x] 118 unit tests + 12 e2e tests green (dev + production build)
- [ ] Safari 17+ run (pending macOS; ADR-001/002/005 note it)

### Week 4

- [x] CodeMirror 6 editor: SQL syntax highlighting, line numbers, wrapping;
      Mod-Enter runs the selection (or whole document), Mod-Shift-Enter
      explains; Run button label flips to "Run selection"; no autocomplete
      (plan Future) and Tab left unbound so keyboard users can exit (NFR-11)
- [x] Execution contract UI: sequential per-statement results with
      stop-on-error, engine timing per statement and in total, transaction-
      state indicator with Commit/Rollback actions, Cancel while running
- [x] SQL error display: statement-relative `sqlite3_error_offset` mapped to
      document line/column, caret under the token, `.cm-error-mark` underline
      cleared on edit (plan §5.2 rule 6)
- [x] Results grid: virtualized window over the 1,000-row cap — fills the pane
      for a single statement (one scrollbar) and keeps a 10-row window in
      multi-statement lists — with the ARIA grid pattern (`aria-rowcount`/
      `aria-colcount`, roving tabindex, arrow/Page/Home/End navigation) plus the
      `role="status"` truncation notice (NFR-11, audited Week 9)
- [x] ADR-004 restart with an open transaction surfaces the rollback notice
- [x] ADR-007 written; 152 unit tests + 19 e2e tests green
- [ ] Safari 17+ run (pending macOS; ADR-001/002/005 note it)

### Week 6

- [x] SQLite import pipeline: in-memory header/page/truncation validation,
      WAL-header warning, UUID-named staging, `quick_check` before metadata,
      cleanup and previous-database recovery on failure (plan §5.5)
- [x] `.sql` script import through the execution contract into a new or
      existing database; failed new imports are rolled back and removed
- [x] Export as a real `.sqlite3` download (empty databases initialized so the
      file always has a valid SQLite header)
- [x] 100 MB confirmation / 250 MB strong warning; quota check before import;
      import disabled when OPFS is unavailable
- [x] `trusted_schema=OFF` + defensive-mode probe recorded per import;
      security decision documented in ADR-009
- [x] Dismissible backup reminder: never-exported or seven-day-overdue, with
      export timestamp stored locally only
- [x] ADR-009 written; ADR-001 has the Week 6 trusted-schema result
- [x] 223 unit tests + 25 e2e tests green (dev + production build)
- [ ] Safari 17+ run (pending macOS; ADR-001/002/005 note it)

### Week 7

- [x] Per-request cancellation: `execute({ requestId })` + `cancel(requestId)`
      through `DatabaseService` and the Worker Manager; in-flight requests
      terminate/restart, queued requests are rejected before they are sent
- [x] Queue generations reject work waiting behind a cancelled/crashed request
      instead of running it on the fresh worker
- [x] Worker crash handling: in-flight requests reject with
      `DbOperationError("WORKER_CRASHED")` and the worker restarts automatically
      (init failures surface instead of looping)
- [x] Long-query UX: live elapsed timer and Cancel while a query is running
- [x] Mid-write termination e2e: committed rows survive, the uncommitted
      transaction is rolled back by journal recovery, and the rollback notice
      is shown
- [x] Transient OPFS handle-release retry (≈2.8 s budget) so a worker killed
      mid-step does not silently fall back to in-memory (ADR-004/ADR-001)
- [x] ADR-004 updated with the Week 7 implementation, finding, and measurements
- [x] 228 unit tests + 27 e2e tests green (dev + production build)
- [ ] Safari 17+ run (pending macOS; ADR-001/002/005 note it)

### Week 8

- [x] Plan tree built from SQLite EQP rows (forest roots, input order,
      duplicate/missing parents degrade safely) with nested `tree` semantics
- [x] Neutral per-node explanations (scan, search, covering/automatic index,
      integer primary key, temp B-tree, co-routine, materialize, Bloom filter);
      no good/bad/optimal labels; unknown forms fall back to raw detail
- [x] Raw `id|parent|detail` output kept one click away in a collapsed
      `<details>` element
- [x] Plan comparison lite: pin the current plan, change the schema, Explain
      again, and see node-level added/removed/changed rows (scenario 19);
      the diff runs in the worker through `PlanToolkit`
- [x] Parser updated for SQLite 3.54 automatic-covering-index and Bloom-filter
      forms; version-pinned fixtures assert the live engine still emits them
- [x] ADR-010 written; 271 unit tests + 29 e2e tests green (dev + production
      build), 19 Rust tests
- [ ] Safari 17+ run (pending macOS; ADR-001/002/005 note it)
