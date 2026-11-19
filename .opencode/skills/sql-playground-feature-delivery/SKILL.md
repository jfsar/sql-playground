---
name: sql-playground-feature-delivery
description: "Use when implementing or finishing a FINAL_PROJECT_PLAN.md week, epic, or multi-layer feature in sql-playground (React/TypeScript + SQLite WASM/OPFS) — read the spec and ADRs, follow contracts and worker/storage boundaries, add unit and Playwright coverage, update docs, and run the full verification gate."
---

# SQL Playground feature delivery

Use this workflow for any planned feature that spans more than one layer of this
repo. It is based on the Week 6 import/export delivery and applies to later
weeks in `FINAL_PROJECT_PLAN.md`.

## When to use

- The request names a plan week, epic, feature, or acceptance scenario.
- The change touches contracts, the worker, storage, services, UI, and tests.
- The change affects SQLite data safety, persistence, import/export, or recovery.

For a trivial one-file fix, use judgement; still respect the invariants below
whenever database or OPFS behavior is involved.

## Read before coding

1. `AGENTS.md` for commands, repo shape, and known gotchas.
2. The relevant `FINAL_PROJECT_PLAN.md` sections:
   - §5.2 execution contract
   - §5.3 typed worker contracts
   - §5.4 worker protocol and cancellation
   - §5.5 import validation and data safety
   - §5.6 tab ownership and reconciliation
   - §7 roadmap item for the week
   - §10 acceptance scenarios and Definition of Done
3. Related files in `docs/adr/`. Read ADR-001, ADR-004, and ADR-005 for
   storage/worker changes.
4. The existing implementation in the layer you are changing. Reuse patterns
   rather than inventing new ones.
5. `README.md` week checklists to see what previous weeks already promised.

Create a short checklist from the plan before editing. Ask only when a product
decision is genuinely ambiguous; do not invent scope.

## Architecture map

| Layer | Main paths | Responsibility |
| --- | --- | --- |
| Shared contracts | `apps/web/src/shared/contracts.ts`, `errors.ts` | Types shared by worker/UI and user-facing error codes |
| Worker protocol | `apps/web/src/services/worker/protocol.ts` | Request/response message unions |
| Worker | `apps/web/src/workers/sqlite.worker.ts` | SQLite WASM, OPFS, execution, schema, file operations |
| Worker facade | `apps/web/src/services/worker/workerManager.ts` | Request IDs, queueing, restart, typed errors |
| Storage | `apps/web/src/services/storage/` | Metadata, reconciliation, quota, tab guard, backups |
| Database facade | `apps/web/src/services/database/databaseService.ts` | Application-facing orchestration and rollback |
| Features | `apps/web/src/features/<feature>/` | Components, local UI state, `data-testid` hooks |
| App wiring | `apps/web/src/app/App.tsx` | State, callbacks, dialogs, downloads, layout |
| E2E | `apps/web/e2e/week<N>.spec.ts` | Browser-level acceptance coverage |

## Delivery sequence

### 1. Scope and design

- List the exact plan requirements, acceptance scenarios, and Definition of
  Done items for the change.
- Identify every layer in the table above that must change.
- Write down invariants and failure paths before implementation: invalid input,
  quota exhaustion, missing OPFS, worker crash, partial write, interrupted
  operation, and rollback.
- Prefer extending an existing service or component over adding a parallel path.

### 2. Contracts and errors first

- Add or extend types in `shared/contracts.ts`.
- Add worker request/response types in `services/worker/protocol.ts`.
- Add error codes in `shared/errors.ts` only when a new failure mode needs
  distinct guidance.
- Use `import type` for type-only imports; `verbatimModuleSyntax` is enabled.

### 3. Implement bottom-up

Recommended order:

1. Pure validation/helpers under `services/database/` or `services/storage/`.
2. Worker protocol and worker handling.
3. `WorkerManager` request methods and error propagation.
4. `StorageService` metadata/file operations.
5. `DatabaseService` orchestration and rollback.
6. Feature component and `App.tsx` wiring.
7. E2E spec for the week.

Keep all SQLite and OPFS work in the worker. The main thread only orchestrates,
renders, and handles browser APIs such as file input and downloads.

### 4. Preserve data-safety invariants

- Validate untrusted files in memory before touching storage.
- Never overwrite an existing database unless the plan explicitly requires a
  replace flow.
- Use fresh IDs and staged file names; write metadata only after file
  validation succeeds.
- On failure, delete staged files and restore the previously active database.
- Handle both per-statement errors and rejected promises when rolling back a
  new database.
- Gate imports on persistent OPFS; keep the in-memory fallback explicit.
- Enforce one active SQLite connection at a time.
- Acquire the tab guard before starting the worker or VFS.
- Return user-facing messages through `DbOperationError` and the shared error
  guidance.
- Export real, valid SQLite bytes; normalize WAL-mode headers when importing and
  warn the user that a `-wal` sidecar is not included.
- Store backup timestamps locally only; never send database content anywhere.

### 5. Tests

Write tests with the implementation, not after it:

- Pure helpers: table-driven edge cases, boundaries, and error paths.
- Services: fake backend/storage, success, rejection, rollback, and restore.
- Worker manager: request wiring, transferables, error-code preservation.
- Components: validation messages, disabled states, confirmation, dismissal.
- E2E: one or more real browser flows per acceptance scenario.

Cover rejection cases explicitly: unsupported, truncated, corrupted, encrypted,
WAL-flagged, oversized/quota-limited, and failed imports. If a behavior change
breaks an older e2e test, update that test to assert the new behavior; do not
weaken it to hide the change.

### 6. Documentation

- Add a new ADR in `docs/adr/` when making a design or safety decision. Match
  the existing ADR style and numbered filename.
- Update the relevant existing ADR with measured results when the plan asks for
  a gate or evaluation.
- Add or update the week checklist in `README.md`.
- Update test counts and repo structure in `README.md` and `AGENTS.md` when they
  changed. Derive counts from the actual test run; do not guess.
- Update `FINAL_PROJECT_PLAN.md` only when the user asks.

### 7. Verify

Run from the repo root in PowerShell:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e

$env:E2E_PREVIEW="1"; pnpm test:e2e; Remove-Item Env:E2E_PREVIEW
```

Also run `cargo test` when the Rust crate changed.

Rules:

- Run commands independently; do not hide a failure behind `;`.
- Run `pnpm build:wasm` first when `apps/web/src/generated/` is missing.
- `pnpm typecheck`, `pnpm test`, and `pnpm build` need the wasm glue.
- Production-preview e2e is required for the ADR-002 gate.
- Fix failures; never leave skipped or weakened tests.
- Run `pnpm format` after edits that may affect formatting.

### 8. Finish

- Report the behavior delivered, decisions/ADRs, changed areas, and exact test
  results.
- Do not commit unless the user explicitly asks.
- If a new skill or config file was created, remind the user to restart
  opencode for it to load.

## Gotchas distilled from previous weeks

- Use pnpm, not npm or yarn.
- Use `pnpm --filter web ...` only when working inside the app; root scripts are
  preferred.
- PowerShell 5.1 does not support `&&`; use `; if ($?) { ... }` for dependent
  commands.
- `apps/web/src/generated/` is git-ignored wasm-bindgen output.
- Never import generated wasm glue outside `services/toolkit/`.
- `noUnusedLocals`, `noUnusedParameters`, and `verbatimModuleSyntax` are on.
- Keep worker message `requestId` correlation intact and preserve `DbErrorCode`
  across rejections.
- The tab guard's per-page promise cache exists to survive StrictMode remounts.
- Empty untouched databases can export as zero bytes; the worker runs `VACUUM`
  and re-exports.
- When testing corrupted files, corrupt bytes that SQLite actually reads; an
  untouched page may still pass `quick_check`.
- Component tests and JSdom are slower than service tests; keep pure logic in
  helpers where possible.

## Week 6 worked example

The import/export delivery is the reference implementation:

- Validation: `services/database/importValidation.ts` (header, page size,
  truncation, WAL bytes, UTF-8 script checks, size and quota assessment).
- Worker: `handleImportDb` imports into a fresh file, runs `PRAGMA quick_check`,
  applies `trusted_schema=OFF`/`defensive=ON` best-effort, and reports the
  outcome.
- Service: `DatabaseService.importDatabase` stages, registers metadata last,
  and restores the previous database on failure.
- Scripts: `DatabaseService.importScript` routes through the execution contract;
  a failed new database is deleted and the previous one is restored, including
  when execution rejects.
- Export: `DatabaseService.exportDatabase` returns a Blob; `App.tsx` sanitizes
  the display name and downloads it.
- Backup reminder: `services/storage/backupReminder.ts` stores timestamps in
  local storage and implements the seven-day policy.
- Docs: ADR-009 records the pipeline; ADR-001 records the `trusted_schema`
  result; the README week checklist records verification.
