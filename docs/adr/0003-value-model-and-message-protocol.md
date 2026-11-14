# ADR-003: Value model and worker message protocol

- Status: **Accepted** (PoC verified via unit tests + e2e)
- Date: 2026-11-14 (Week 2 of FINAL_PROJECT_PLAN.md)
- Related: plan §5.3 (typed contracts), §5.4 (protocol)

## Context

All database work runs in a dedicated Web Worker. The boundary between the
React main thread and the worker must not lose information (64-bit integers,
BLOBs, NULL), must correlate responses to requests reliably, and must keep
one writer at a time against a single SQLite connection.

## Decision

**Value model** (`src/shared/contracts.ts`):

```ts
type SqlValue = null | number | bigint | string | Uint8Array;
```

- INTEGER values beyond 2^53 arrive as `bigint`; BLOBs as `Uint8Array`;
  NULL is `null` — distinct from the string `"NULL"`. The UI renders
  `<BLOB n bytes>` and `${v}n` for bigints (full display verification is
  acceptance scenario 20, Week 10).
- `StatementResult` is a discriminated union (`rows` | `change` | `error`);
  `ExecutionResponse` carries per-statement results in order plus the real
  SQLite autocommit state (`inTransaction`) and `rolledBackBySqlite`.

**Message protocol** (`src/services/worker/protocol.ts`):

- Every `WorkerRequest` carries a `requestId`; every `WorkerResponse` echoes
  it. The Worker Manager keeps a `Map<requestId, Pending>` and ignores
  responses with unknown ids.
- Requests: `init`, `execute`, `status`, `explain`, `export`.
  Responses: `ready`, `executed`, `status-result`, `explained`, `exported`,
  `failed`.
- **Single-writer queue:** one request runs at a time; additional requests
  queue in the manager (not the worker). `init` bypasses the queue so
  `execute`/`status` can await it without deadlocking.
- **Two error channels:** SQL-level errors arrive *inside* `ExecutionResponse`
  as an `error` statement result (earlier results are not lost); errors that
  prevent the request itself (worker not initialized, crash, policy on the
  whole request) arrive as `failed { code, message }` and reject the promise.
- Cancellation rejects the pending promise with an `Error` named
  `CancelledError` (ADR-004).

## PoC verification (Week 2)

- Unit tests (`workerManager.test.ts`): requestId correlation, queue
  serialization (second request not posted until the first responds),
  in-flight rejection on crash, init-failure retry, restart cancels in-flight
  work with `CancelledError` and re-inits a fresh worker.
- E2E (Chromium + Firefox, dev + production): multi-statement scripts produce
  ordered per-statement results; `explain`/`export` responses round-trip;
  restart mid-query rejects the run with the cancellation message while the
  UI returns to idle.
- The go/no-go item "worker/React messaging with `requestId` is reliable" is
  covered by the above.

## Consequences

- Structured clone carries `bigint`/`Uint8Array` natively — no custom
  serialization layer. Row caps (1,000) keep message sizes bounded.
- The queue lives on the main thread, so a terminated worker can never
  receive a queued message: restart simply replaces the queue head
  (ADR-004).
- New request types must be added to both unions and to `isWorkerResponse`'s
  type set; tests assert both happy-path and unexpected-response errors.
- `SqlValue` deliberately excludes `boolean`/`undefined`: everything crossing
  the boundary is a SQLite value or absent.
