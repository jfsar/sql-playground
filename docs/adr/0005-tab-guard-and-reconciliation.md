# ADR-005: Tab-ownership guard and database reconciliation

- Status: **Accepted** (tab guard PoC verified Week 2; reconciliation
  **implemented Week 3** — see ADR-006 for the multi-database foundation)
- Date: 2026-11-14 (Week 2 of FINAL_PROJECT_PLAN.md)
- Related: plan §5.6; ADR-001 (single-connection VFS); ADR-006

## Context

`opfs-sahpool` allows **one connection at a time** per pool directory
(ADR-001). Two tabs of the app racing to install the VFS would fail in
confusing ways or corrupt state. Separately, database *files* live in OPFS
while the database *list* lives in IndexedDB; the two can drift apart after a
crash or interrupted delete.

## Decision

### Tab guard (implemented Week 2)

- At startup — **before** the worker is created or the VFS installed — the
  page requests an exclusive Web Lock named `sql-playground:owner` with
  `ifAvailable: true`.
- **Granted:** the callback resolves immediately and then *holds* the lock by
  awaiting a promise that only `release()` resolves. The lock is held by the
  page (not the worker), so closing the tab releases it automatically and a
  worker restart (ADR-004) cannot drop it.
- **Not granted:** the app renders a blocking "Already open in another tab"
  screen with a Retry action. The worker is never created, `init` never runs,
  and no VFS handle is taken (e2e asserts no `ready` state in the blocked
  tab).
- The acquisition promise is cached per page so React StrictMode's double
  effect cannot deadlock against our own held lock.
- **Missing Web Locks API:** proceed with `unsupported: true` and show a
  visible "multi-tab guard unavailable" warning — never a silent degradation.
  A `BroadcastChannel` ping fallback (plan §5.6) was **not** implemented:
  Web Locks ships in every supported browser (Chrome 69+, Firefox 96+,
  Safari 15.4+), so the fallback would be dead code on the supported matrix.
  Revisit only if the matrix changes.

### Reconciliation (design decided Week 2, implemented Week 3)

- Files are named by stable id (`db_<id>.sqlite3`); display names exist only
  in IndexedDB metadata — rename is metadata-only.
- Delete is two-phase: mark `deleting` in metadata → delete the file →
  remove the entry. Startup reconciliation completes any `deleting` entries.
- On startup, files without metadata become "Recovered database" entries;
  metadata without a file is marked `missing-file` and offers removal.
- Reconciliation results are logged locally, never transmitted.

## PoC verification results (Week 2)

| Check | Result |
|---|---|
| Web Locks behavior on the browser matrix | ✅ Chromium and Firefox (Playwright, production + dev builds): grant/block/retry all correct. Safari 17+ pending macOS run; API availability there is known-good since Safari 15.4 |
| Second tab never opens a database (scenario 18) | ✅ E2E: tab 2 shows `tab-blocked`, no `ready`/`loading` states; tab 1 continues to execute queries while tab 2 is blocked |
| Retry after the owner closes | ✅ Unit-tested (blocked attempt is re-requested on retry; a cached *grant* is never re-requested) |
| Owner lifetime vs worker restart | ✅ Restart e2e passes with the lock held — the lock is page-scoped, worker-scoped state cannot release it |
| Lock request failure | ✅ Treated as blocked (conservative), unit-tested |
| Reconciliation behavior | ✅ Week 3: pure drift rules unit-tested (orphan file → "Recovered database", missing file → `missing-file`, interrupted two-phase delete completed, foreign files ignored — scenario 24) and exercised end-to-end by `e2e/week3.spec.ts` (create/rename/delete + reload persistence) |

## Consequences

- The guard is a hard startup dependency: a blocked tab does no database
  work at all, which is exactly what the single-connection VFS needs.
- Locks are invisible to users except the blocking screen; no polling, no
  heartbeat, no stale-lock expiry — browser semantics handle teardown.
- Week 3's Storage Service must acquire the lock before any OPFS or
  IndexedDB write and must keep metadata/file reconciliation strictly
  startup-scoped (plus after interrupted deletes).
- The unsupported-API path trades safety for availability with a loud
  warning; if field reports show real risk, the BroadcastChannel fallback
  becomes a follow-up.
