# ADR-012: QA matrix and benchmark methodology

- Status: **Accepted** (Week 10)
- Date: 2026-11-23
- Related: plan §6 NFRs, §7 Week 10; ADR-001 (OPFS), ADR-002 (wasm gate),
  ADR-004 (cancel via restart), ADR-011 (accessibility audit); SC-09, SC-10,
  SC-12, SC-13, NFR-01, NFR-02, NFR-03, NFR-12; scenarios 10 and 14

## Context

Week 10 closes the plan's QA loop: run the full Playwright suite on the browser
matrix, prove scenario 14 (database content never leaves the browser), and
measure the *unvalidated* performance targets. Earlier ADRs recorded
point-in-time PoC measurements (ADR-004: 87 ms Chromium restart); Week 10 needs
repeatable numbers at 10/50/100 MB with the real import/export UI, plus an
honest statement about which browsers were actually verified.

Two constraints shaped the decision:

- CI has no macOS runner, so real Safari 17+ is unavailable. Playwright
  `webkit` on Windows is a proxy, not Safari.
- Playwright WebKit on Windows exposes no OPFS (it reports
  `in-memory (not persistent)`), so persistence, import/export, reopen, and
  cancel cannot execute there. Treating its failures as product failures would
  be misleading; silently skipping it would hide the gap.

## Decision

### Browser matrix

- **Chromium and Firefox gate CI.** The full 37-test suite runs against the
  production build (`E2E_PREVIEW=1`) on both. This includes the ADR-002 wasm
  gate, OPFS persistence, import/export, restart recovery, axe, and scenario 14.
- **WebKit runs as best effort** (`continue-on-error` in
  `.github/workflows/ci.yml`). Its report is uploaded even when the step fails,
  and failures are reported, not suppressed. WebKit is useful for catching
  non-OPFS regressions (the plan toolkit gate passes there), but it must not be
  cited as Safari verification.
- Safari 17+ and the manual NVDA/VoiceOver pass remain explicitly outstanding
  from ADR-001, ADR-002, ADR-005, and ADR-011. Nothing in this ADR claims them.

### Privacy test (scenario 14 / SC-09 / NFR-01)

`e2e/week10.spec.ts` creates a random sentinel value, writes it to a table,
selects it, and exports the database. It then inspects every outbound channel:

- Playwright `context.on("request")` for HTTP requests and POST bodies.
- Playwright `page.on("websocket")` `framesent` payloads.
- Init-script wrappers around `fetch`, `XMLHttpRequest`, `sendBeacon`, and
  `WebSocket.send`, because requests can bypass Playwright's network events.

The assertion is twofold: no request/frame/body contains the sentinel, and no
request leaves the app origin (excluding `blob:`/`data:` downloads). The export
check is conditional on OPFS, so WebKit still verifies the no-leak property.

### Benchmark harness

`apps/web/bench/week10.bench.ts` runs through `playwright.bench.config.ts`
against `vite preview` on port 4173, one worker, 15-minute timeout:

- **Startup**: first page load in a fresh context; time from navigation start to
  the `ready` test id.
- **Import/export/reopen at 10/50/100 MB**: seed real payload rows
  (`zeroblob(1048576)` in transactional batches), export through the UI to a
  download, re-import that same file through the import dialog, reload, and
  time until the active database is visible.
- **1,000-row render**: recursive CTE, time until `aria-rowcount` is 1001,
  recording the virtualized cell count and truncation notice.
- **Heavy query / long tasks**: observe `longtask` entries where supported, and
  always sample `requestAnimationFrame` gaps as the cross-browser fallback;
  run a 200 M-row recursive CTE, cancel it, and time cancel-to-idle plus the
  worker restart.
- Results are written to `docs/benchmarks/week10-<browser>.json`; unavailable
  capabilities produce `status: "partial"` with `skipReason` instead of fake
  numbers or a failed run.

The only hard assertions are contractual: exported size covers the target,
50 MB reopen is under 2 s, restart and cancel-to-idle are under 5 s, and no long
task exceeds 100 ms when the Long Tasks API exists. Other values are reported,
not asserted, so one noisy run cannot fail CI (benchmarks are not part of CI).

## Results (2026-11-23)

Environment: Windows 11 (10.0.26300), Intel Core i5-11400H, 24 GiB RAM;
headless Playwright browsers; local production preview. Raw JSON is in
`docs/benchmarks/`; the report table is in `docs/benchmarks.md`.

| Check | Target | Chromium 158 | Firefox 159 | Verdict |
|---|---|---|---|---|
| Startup to ready | < 3 s (NFR-12) | 354 ms | 2,808 ms | Pass (Firefox at the boundary) |
| 50 MB reopen | < 2 s (SC-10/NFR-03) | 190 ms | 1,617 ms | Pass |
| 100 MB reopen | report | 166 ms | 2,307 ms | Reported |
| 10/50/100 MB export | report | 200/299/482 ms | 108/248/315 ms | Reported |
| 10/50/100 MB import | report | 383/1,887/2,920 ms | 262/880/1,396 ms | Reported |
| 1,000-row render | report | 62 ms, 16 cells | 46 ms, 16 cells | Reported |
| Long task during heavy query | none > 100 ms (SC-12/NFR-02) | 0 tasks, 16.7 ms max frame gap | API unsupported, 20.8 ms max frame gap | Pass by API/fallback |
| Cancel → idle | < 5 s (SC-13) | 2,943 ms | 335 ms | Pass |
| Restart time | report | 2,888 ms | 191 ms | Reported |
| Scenario 14 privacy | zero leaks | pass | pass | Pass |

Firefox startup varied across runs (2.73–3.09 s); the table reports 2.81 s from
the final run. It meets the target on this run but should be described as
sitting at the 3 s boundary in headless Playwright, not as comfortable
headroom. Chromium cancel is dominated by the deliberate OPFS handle-release
backoff from ADR-004 (≈2.8 s budget); the 5 s target still passes with ~2 s
headroom.

Playwright WebKit 27.2 on Windows reports `in-memory (not persistent)`. Its
benchmark is `partial`: startup 8.6 s and render 145 ms/28 cells are recorded,
while import/export/reopen/cancel are skipped. These numbers are not a Safari
17+ result and must not be compared with the persistent rows above.

## Alternatives considered

- **Gate all three engines**: rejected. WebKit on Windows lacks OPFS, so the
  failures would be environmental, not actionable, and would hide real
  Chromium/Firefox regressions under noise.
- **Skip WebKit entirely**: rejected. It still validates wasm loading and
  non-OPFS UI paths, and a best-effort run gives early warning without blocking
  releases.
- **Mock OPFS in WebKit**: rejected. A mock would not measure persistence or
  handle-release behavior and could create false confidence about Safari.
- **Run benchmarks inside CI**: rejected. Timing on shared runners is noisy;
  the harness records machine metadata and is run locally for the report.
- **Assert every benchmark number**: rejected. Absolute timings vary by machine;
  only plan-derived targets are hard assertions.

## Consequences

- The browser-support statement is precise: Chromium and Firefox are verified on
  the production build; WebKit is a proxy only; Safari 17+ remains pending.
- Scenario 14 is enforced on all three engines, and the export half is skipped
  (with an annotation) where OPFS is absent.
- Benchmark results are reproducible with `pnpm benchmark` and contain the
  browser version, OS, and CPU so future comparisons are not anonymous.
- The OPFS-dependent portion of the WebKit suite will keep failing on Windows
  until WebKit gains OPFS or a macOS runner is available; CI keeps that visible
  as a non-blocking job with an uploaded report.
- NFR-12 has a known boundary: Firefox headless startup is close to 3 s. If the
  target must hold with margin, the next lever is deferring the wasm toolkit
  load out of the startup path (and reporting it asynchronously), not relaxing
  the target.
