# Week 10 benchmarks

Results for `FINAL_PROJECT_PLAN.md` Week 10, produced by
`apps/web/bench/week10.bench.ts` against the production preview build. The
methodology and browser-matrix decisions are recorded in
[ADR-012](./adr/0012-qa-and-benchmark-methodology.md); raw output is kept in
[`docs/benchmarks/`](./benchmarks/).

## Reproduce

```bash
pnpm benchmark                              # Chromium (default)
$env:E2E_BROWSER="firefox"; pnpm benchmark  # PowerShell
$env:E2E_BROWSER="webkit"; pnpm benchmark   # partial on Windows (no OPFS)
```

`pnpm benchmark` builds the wasm + production bundle, starts `vite preview` on
port 4173, and rewrites `docs/benchmarks/week10-<browser>.json`. Benchmarks are
report-only and are not part of CI.

## Environment

| Item | Value |
|---|---|
| Date | 2026-11-23 |
| Machine | Windows 11 (10.0.26300) |
| CPU | 11th Gen Intel Core i5-11400H @ 2.70 GHz |
| RAM | 24 GiB |
| Chromium | 158.0.8127.18 (Playwright, headless) |
| Firefox | 159.0 (Playwright, headless) |
| WebKit | 27.2 (Playwright, headless; OPFS unavailable) |
| Build | `vite preview` production bundle, local origin |
| Persistence | OPFS persistent (Chromium, Firefox); in-memory (WebKit) |

Timings are single-run wall-clock measurements from the page
(`performance.now()`); they include UI-driven import/export, not just the raw
file copy. Startup is the first load in a fresh Playwright context — the preview
server and browser process are warm, so this is not a cold disk-cache test.

## Results

### Startup, persistence, and 50 MB target

| Metric | Target | Chromium | Firefox | Verdict |
|---|---|---|---|---|
| Startup to `ready` | < 3 s (NFR-12) | 354 ms | 2,808 ms | Pass |
| 50 MB database reopen | < 2 s (SC-10/NFR-03) | 190 ms | 1,617 ms | Pass |
| 100 MB database reopen | report | 166 ms | 2,307 ms | Reported |
| Scenario 14 privacy | zero leaks (SC-09/NFR-01) | pass | pass | Pass |

Firefox startup varied from 2.73 s to 3.09 s across runs; it meets the target but
sits at the boundary in headless Playwright. WebKit's 8.6 s startup is an
in-memory fallback and is not comparable.

### Import and export (10/50/100 MB)

Payload = `zeroblob(1048576)` rows inserted in 10 MB batches inside one
transaction. Export goes through the real download path; import re-imports that
same file as a new database (including the 100 MB confirmation checkbox).

| Size | Browser | Seed | Export | File size | Import | Reopen |
|---|---|---|---|---|---|---|
| 10 MiB | Chromium | 973 ms | 200 ms | 10,518,528 B | 383 ms | 158 ms |
| 50 MiB | Chromium | 2,553 ms | 299 ms | 52,502,528 B | 1,887 ms | 190 ms |
| 100 MiB | Chromium | 4,625 ms | 482 ms | 104,980,480 B | 2,920 ms | 166 ms |
| 10 MiB | Firefox | 449 ms | 108 ms | 10,518,528 B | 262 ms | 831 ms |
| 50 MiB | Firefox | 1,252 ms | 248 ms | 52,502,528 B | 880 ms | 1,617 ms |
| 100 MiB | Firefox | 1,761 ms | 315 ms | 104,980,480 B | 1,396 ms | 2,307 ms |

The exported file is slightly larger than the nominal target because the payload
is 10 × 1 MiB per batch plus table/page overhead. The 100 MiB export therefore
crosses the import dialog's 100 MB warning threshold and exercises that path.

Reopen is measured from `page.reload()` to `ready`; the active database is
restored during worker init and is asserted right after the measurement.

### Rendering and heavy-query responsiveness

| Metric | Target | Chromium | Firefox |
|---|---|---|---|
| 1,000-row result render | report | 62 ms | 46 ms |
| Rendered grid cells (virtualized) | < 1,001 | 16 | 16 |
| Truncation notice | none for 1,000 rows | none | none |
| Long Tasks API | — | supported | unsupported |
| Long tasks over 100 ms | none (SC-12/NFR-02) | 0 | n/a (API absent) |
| Max frame gap during query | fallback signal | 16.7 ms | 20.8 ms |
| Cancel → idle | < 5 s (SC-13) | 2,943 ms | 335 ms |
| Worker restart | report | 2,888 ms | 191 ms |

Both grids render only 16 cells for a 1,000-row result (the virtualized window),
so the 1,000-row cap does not imply rendering 1,000 rows. Chromium recorded no
long tasks during the 200 M-row recursive CTE; Firefox does not expose the Long
Tasks API in this version, so frame gaps (max 20.8 ms) are the fallback evidence.

Chromium cancel is dominated by the deliberate OPFS access-handle release
backoff from ADR-004 (50/100/200/400/800/1200 ms, ≈2.8 s budget). It is within
the 5 s target with roughly 2 s headroom. Firefox releases handles quickly
(191 ms restart).

### WebKit (partial, not Safari)

| Metric | Result |
|---|---|
| Persistence | `in-memory (not persistent)` |
| Startup to `ready` | 8,616 ms |
| 1,000-row render | 145 ms, 28 cells |
| Import/export/reopen/cancel | skipped — no OPFS |

Playwright WebKit on Windows has no OPFS SAH pool, so the persistence and
file-operation paths cannot run. The privacy spec still runs (export is skipped
with an annotation), and the ADR-002 plan-toolkit gate passes on the production
build. This is not Safari 17+ verification; that macOS run is still outstanding,
as are the NVDA/VoiceOver checks from ADR-011.

## NFR verdicts

| Requirement | Target | Verdict |
|---|---|---|
| NFR-01 / SC-09 / scenario 14 | No database content leaves the browser | Pass: Chromium, Firefox, WebKit dev; no sentinel in HTTP, WebSocket, fetch/XHR/beacon payloads and no cross-origin requests |
| NFR-02 / SC-12 | No main-thread long task > 100 ms; cancel < 5 s | Pass: 0 long tasks (Chromium), 16.7/20.8 ms max frame gap, cancel 2.9 s Chromium / 0.34 s Firefox |
| NFR-03 / SC-10 | 50 MB reopens in < 2 s | Pass: 190 ms Chromium, 1,617 ms Firefox |
| NFR-12 | Interactive in < 3 s | Pass on final run (354 ms Chromium, 2,808 ms Firefox); Firefox is at the boundary and should be rechecked on release hardware |
| NFR-11 | WCAG 2.2 AA + keyboard | Retained from Week 9: axe 0 violations; manual screen-reader/Safari pass still owed (ADR-011) |

## Known gaps

- Real Safari 17+ was not run (no macOS). Playwright WebKit on Windows is a
  proxy with no OPFS and must not be read as Safari support evidence.
- The NVDA/VoiceOver session from Week 9 remains outstanding.
- Firefox headless startup is near 3 s. If margin is required, defer the wasm
  toolkit load until plan analysis is used instead of loading it during worker
  init.
- Numbers come from one machine and one run per browser; treat small deltas
  (tens of ms) as noise.
