# ADR-001: OPFS VFS selection and hosting headers

- Status: **Accepted** (PoC partially verified — see results)
- Date: 2026-11-14 (Week 2 of FINAL_PROJECT_PLAN.md)
- Related: ADR-004 (worker termination), ADR-005 (tab guard)

## Context

Databases must persist in the browser without a backend. Two OPFS VFS options
exist in `@sqlite.org/sqlite-wasm`:

| | `opfs` (default) | `opfs-sahpool` |
|---|---|---|
| COOP/COEP headers | Required (`SharedArrayBuffer`) | Not required |
| Multiple connections/tabs | Yes, with `SQLITE_BUSY` handling | One at a time |
| Performance | Good | Fastest of the OPFS options per SQLite docs |
| Safari < 17 | Affected by sub-worker bug | Works |
| Files in OPFS | Normal file names (browsable) | Pool slots (not browsable as files) |
| Capacity | Grows as needed | Fixed pool, managed deliberately |

The plan's default is `opfs-sahpool`, gated on PoC checks (plan §4 ADR-001,
§7 Week 2).

## Decision

Use **`opfs-sahpool`** with:

- No COOP/COEP headers anywhere (dev server sets them anyway as harmless
  insurance for a possible future switch; production/Cloudflare serves none).
- An explicit `initialCapacity: 12` pool (default 6 is tight for one database
  plus journals; capacity is surfaced in the UI status bar as `pool used/cap`).
- A single active connection per origin, enforced by the tab guard
  (ADR-005) rather than by `SQLITE_BUSY` retries.
- Rollback-journal mode only (WAL is not usable — PoC result below).

## PoC verification results (Week 2)

Environment: Windows 11; Playwright 1.65; Chromium (Playwright build) and
Firefox 159; production Vite build (`E2E_PREVIEW=1`) unless noted.

| Check (plan §4 ADR-001) | Result |
|---|---|
| Install and reopen across reloads | ✅ `e2e/poc.spec.ts` passes on Chromium + Firefox, dev and production builds |
| Behavior when a second tab opens the app | ✅ Second tab shows the blocking screen and never installs the VFS (ADR-005, e2e) |
| Pool capacity for N databases | ⚠️ Partial: capacity 12 confirmed in status; multi-database allocation is Week 3 work (PoC uses one DB). `pool used/cap` is visible in the status bar |
| Export of a database held in the pool | ✅ `poolUtil.exportFile()` returns the live file: 16,384 bytes, header `SQLite format 3` verified on Chromium and Firefox (e2e) |
| WAL mode behavior | ✅ `PRAGMA journal_mode=WAL` under sahpool **stays `delete`** — WAL is not supported by this VFS. Decision: enforce/document rollback-journal mode (e2e records the outcome each run) |
| Handles/locks released when the worker is terminated | ✅ Terminate → fresh worker → VFS reinstall → database reopens intact; restart measured at **87 ms** (Chromium, production), 103 ms (Chromium, dev), 264 ms (Firefox, dev) — see ADR-004 |
| Safari 17+ | ⏳ **Pending manual verification** (requires macOS; not runnable on this Windows machine). The suite is browser-agnostic; risk is limited to OPFS/Safari quirks |

**Week 7 refinement:** handle release after `terminate()` is not instantaneous
when the worker dies mid-`sqlite3_step`. The fresh worker can briefly see
`NoModificationAllowedError` while installing `opfs-sahpool`; it now retries
transient handle-lock errors before falling back to in-memory. See ADR-004.

## Consequences

- Static hosting needs no special headers; Cloudflare Pages/Workers static
  assets work as-is (no `_headers` file, no COEP breakage risk for third-party
  assets).
- The single-connection limit makes the tab guard (ADR-005) mandatory, not
  optional — it is part of the Week 2 go/no-go.
- Pool capacity must be sized and monitored as databases are added (Week 3
  storage service); `ATTACH DATABASE` and `VACUUM INTO` stay blocked by the
  statement policy because they would consume pool slots.
- WAL-mode imports (plan §5.5) must warn and convert to the supported journal
  mode; the imported file's `-wal` sidecar content is not part of the import.
- If Safari verification fails, the fallback is the default `opfs` VFS with
  COOP/COEP headers via a hosting `_headers` file (re-decide in a follow-up
  ADR).

## Week 6 `trusted_schema` evaluation

Imported databases are probed after `PRAGMA quick_check` with
`PRAGMA trusted_schema=OFF` (and `PRAGMA defensive=ON` where exposed). The
probe result is returned in the worker's `SqliteImportResult`:

- `off` — the staged schema loaded with hardened pragmas.
- `blocked` — the schema rejected `trusted_schema=OFF`; the connection falls
  back to `trusted_schema=ON` so the database stays usable.
- `unsupported` — the build does not expose the pragma.

The Week 6 e2e suite imports real exported databases and WAL-flagged copies
through this path, and the import path works with the probe enabled. The
hardened mode is defense in depth only; the primary containment remains the
WASM sandbox plus cancellation/recovery (ADR-004).
