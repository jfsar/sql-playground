# ADR-002: Rust plan-analysis layer (PoC gate)

- Status: **Accepted — gate PASSED** on Chromium and Firefox (Safari run pending)
- Date: 2026-11-14 (Week 2 of FINAL_PROJECT_PLAN.md)
- Related: plan §4 "ADR-002", §7 Week 2 go/no-go

## Context

SQLite handles statement splitting and execution, so Rust would contribute
nothing there. The only planned Rust scope is plan analysis: parse
`EXPLAIN QUERY PLAN` rows into a tree, and diff two trees for plan comparison
(plan §4). Including Rust is a deliberate portfolio decision to demonstrate a
well-bounded Rust/WASM integration; if integration cost outweighs the
benefit, a TypeScript implementation ships behind the same interface.

**Gate (plan §4):** the crate passes if it (1) builds with wasm-bindgen,
(2) loads inside the worker under a **production** Vite build, and (3)
round-trips typed data. If it fails, the TS implementation ships and the
crate moves to Future.

## Decision

- Implement `crates/query-analyzer` with wasm-bindgen (`=0.2.130`, pinned to
  match the CLI) exposing exactly three functions:
  `parsePlan(rows, sqliteVersion)`, `diffPlans(before, after)`,
  `toolkitVersion()`. Serde + serde-wasm-bindgen carry typed data across the
  boundary; optional fields are `skip_serializing_if = "Option::is_none"` so
  JS sees absent keys, never `null`.
- Expose everything through the TypeScript `PlanToolkit` interface
  (`services/toolkit/`). The worker calls `createPlanToolkit()`, which:
  1. loads the wasm build,
  2. runs a **round-trip probe** (`parsePlan` of a known row, shape-checked),
  3. falls back to the TypeScript implementation on any failure.
  `WorkerStatus.toolkit` reports which implementation is active.
- Ship the TypeScript fallback **now**, as a line-for-line mirror of the Rust
  semantics (unknown detail forms degrade to `OTHER` with raw text preserved;
  the parser never throws). A parity unit test asserts Rust and TS produce
  identical output for the same rows.
- Build via `pnpm build:wasm` (cargo `wasm32-unknown-unknown` release +
  `wasm-bindgen --target web` into `apps/web/src/generated/query-analyzer/`,
  git-ignored). Root `pnpm build` always rebuilds; `pnpm dev` builds only if
  the glue is missing.

## Gate results (Week 2)

| Criterion | Result |
|---|---|
| Builds with wasm-bindgen | ✅ `cargo test` (16 native tests pass) + `pnpm build:wasm` produces a 171 KB `.wasm` + JS glue |
| Loads in the worker under a **production** Vite build | ✅ `E2E_PREVIEW=1` e2e asserts `toolkit: rust` in the status bar — **Chromium ✅, Firefox ✅** (dev build ✅ as well) |
| Round-trips typed data | ✅ Unit tests: raw rows → nodes with `operation`/`table`/`index`/`tags`/`parentId`, `sqliteVersion` echo, `diffPlans` changed-pairs; browser e2e: `EXPLAIN QUERY PLAN` → parsed `SEARCH … USING gate_t_a` tree with raw `id\|parent\|detail` lines preserved |
| TS fallback parity | ✅ Same-rows Rust-vs-TS equality test; fallback also unit-tested standalone |
| App code independent of implementation | ✅ Worker/App only import `PlanToolkit`; `toolkit` is reported status, not a code path |

Not yet verified: the same production run on Safari 17+ (pending macOS). The
wasm load path is browser-independent; residual risk is low but the check
remains open until Week 10's matrix pass.

## Consequences

- The worker bundle carries ~171 KB of wasm (plus ~19 KB glue). Acceptable for
  a dev tool; no main-thread cost (loads inside the worker).
- CI installs Rust + `wasm-bindgen-cli v0.2.130` and runs `pnpm build:wasm`
  before typecheck/test/build; `cargo test` runs in CI.
- Version drift between the crate's `wasm-bindgen` dependency and the CLI is a
  known failure mode — both are pinned to `0.2.130` and must be bumped
  together.
- If a future browser blocks the wasm, the app keeps working on the TS
  implementation and `status.toolkit` shows `typescript` — the gate result is
  observable, not silent.
- Honest scoping: Rust adds no user-visible capability beyond what the TS
  fallback provides. The case study must present it as a portfolio-integration
  decision (per plan §8 risk "Rust adds little user value for its cost").
