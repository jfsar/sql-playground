# ADR-004: Query cancellation via worker termination and restart

- Status: **Accepted** (PoC verified; Week 7 adds per-request cancel and
  automatic crash recovery)
- Date: 2026-11-14 (Week 2 of FINAL_PROJECT_PLAN.md); Week 7 update
  2026-11-19
- Related: plan §5.3, §5.4, §7 Weeks 2 and 7; ADR-001 (handle release),
  ADR-003 (CancelledError)

## Context

A synchronous `sqlite3_step()` inside a worker cannot be interrupted by a
message sent to that same worker. Options:

1. **Terminate and re-initialize the worker** (plan default): reliable, but
   the full cost is terminate + WASM init + VFS install + database reopen.
2. **Progress-handler soft cancel**: SQLite's progress handler can abort a
   running statement without killing the worker, but availability in the
   chosen build was unverified at decision time.

The PoC must measure the real cost of option 1 to validate the 5 s cancel
target (SC-13) and confirm that terminating a worker releases OPFS handles
and leaves the database intact.

## Decision

Implement cancellation as **`WorkerManager.restart()`**:

1. Reject all pending requests with an `Error` named `CancelledError`
   ("Query cancelled; worker restarted.") and clear the single-writer queue.
2. `worker.terminate()` — even mid-`sqlite3_step`.
3. Spawn a fresh worker and run the normal `init` path: SQLite WASM load →
   `opfs-sahpool` install → database reopen → PlanToolkit load.
4. The UI shows the cancellation message from the rejected run and the
   measured restart time; journal recovery rolls back any incomplete write.

The lock/ownership of storage is held by the *page* (ADR-005), so worker
termination never releases or fights the tab lock. A progress-handler soft
cancel remains an option to evaluate in Week 7 if termination cost ever
matters (it does not at current measurements).

## PoC verification results (Week 2)

| Check (plan §4 ADR-004 / §5.4) | Result |
|---|---|
| Terminating the worker releases OPFS handles/locks | ✅ Fresh worker reinstalls the VFS and reopens the database on the same origin (e2e) |
| Mid-write / mid-query termination leaves the database intact | ✅ Data inserted before a cancelled 200 M-row recursive-CTE query is readable after restart (e2e, scenario 15) |
| Full restart time (terminate → ready) | ✅ **87 ms** Chromium production build; **103 ms** Chromium dev; **264 ms** Firefox dev — target is 5 s, so the target has ~50× headroom on this machine |
| In-flight request rejected with `CANCELLED` | ✅ `CancelledError` unit-tested; e2e asserts the run error text and that the UI returns to idle (run button enabled) |
| Worker crash path | ✅ `WorkerCrashError` rejects in-flight requests, tears down the worker; next request spawns a new one (unit tests) |

Measured values are from the Week 2 reference run (mid-range Windows laptop,
Playwright browsers). Week 10 benchmarks will re-measure on the final matrix
and may tighten SC-13's 5 s target.

## Consequences

- Cancel is O(worker restart), not O(query): cost is independent of how long
  the query had been running — a clean, predictable UX.
- The single-writer queue makes restart safe: no message can be in flight to
  a dead worker because the queue is reset with the worker.
- State caveat: a restart cancels *everything* in flight (including a
  concurrent `explain`/`export`), which matches the single-connection model.
- An open user transaction (`BEGIN` without `COMMIT`) is rolled back by
  SQLite when its connection dies — the UI must say so after a cancel if the
  pre-restart state had `inTransaction: true` (surfaced when Week 4 wires the
  indicator to restart flows).
- CI/e2e assert the < 5 s bound implicitly (15 s test timeout with the
  measurement annotated); the number is recorded per run in test annotations.

## Week 7 implementation (reliability and cancellation)

The cancellation contract is now exposed end to end:

- `DatabaseService.execute(sql, { requestId })` and
  `DatabaseService.cancel(requestId)` forward to the Worker Manager
  (plan §5.3). The app creates a UUID request id per run and cancels that id.
- `WorkerManager.cancel(requestId)` restarts only when the id is in flight;
  if the request is still queued it is rejected before being sent. Unknown or
  already-finished ids are a no-op, so a late click cannot kill unrelated work
  that has already started.
- The single-writer queue carries a generation counter. Restart and crash bump
  the generation, so work queued behind the terminated request is rejected
  with `CancelledError` instead of running on the fresh worker.
- `WorkerManager.handleCrash` rejects in-flight requests with a
  `DbOperationError("WORKER_CRASHED", …)`, bumps the generation, and — if the
  worker had completed init — starts a fresh worker automatically. A crash
  during init surfaces instead of retrying forever; the next request retries.
- The reopen still uses the tracked active pool file, so journal recovery
  applies exactly as in the Week 2 PoC.

Week 7 e2e coverage adds:

- A long recursive query displays a live elapsed timer while running; Cancel
  returns to idle, reports the cancellation, measures the restart under 5 s,
  and the reopened database accepts new SQL.
- A worker is terminated after `BEGIN; INSERT …; <runaway SELECT>`. The
  committed row survives, the uncommitted insert is rolled back by journal
  recovery, and the UI shows the open-transaction rollback notice.

### Transient OPFS handle release (Week 7 finding)

The mid-write e2e exposed a race the Week 2 PoC did not cover: when a worker is
terminated **during a synchronous `sqlite3_step`**, its OPFS sync access handles
are not released instantly. The fresh worker's first
`installOpfsSAHPoolVfs()` attempt failed with `NoModificationAllowedError`
("Access Handles cannot be created if there is another open Access Handle…")
and previously fell back to in-memory, losing the restart's persistence.

Fix:

- The worker retries pool installation only for transient handle-lock errors,
  with delays of 50, 100, 200, 400, 800, and 1200 ms (≈2.8 s total, inside the
  5 s cancel target).
- Retries use SQLite 3.54's `forceReinitIfPreviouslyFailed` to clear the cached
  rejected install, and `preserveOnInitFailure` so a transient lock cannot
  delete the pool directory.
- Permanent failures (missing OPFS APIs, etc.) still fail immediately and show
  the explicit in-memory fallback banner.

The Week 7 e2e now asserts persistence survives the mid-write termination; the
restart remains under 5 s. The Week 2 statement "handles are released on
termination" is therefore refined to "released shortly after termination; the
worker retries during that window."

Long-result handling is unchanged from Week 4 (1,000-row cap plus virtualized
grid); Week 7 verifies cancellation and elapsed-time UX around it rather than
adding a second result path.
