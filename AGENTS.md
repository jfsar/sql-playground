# AGENTS.md

## Repo shape

- Two workspaces rooted here: pnpm (`pnpm-workspace.yaml` → `apps/*`) and Cargo (`Cargo.toml` → `crates/*`). The only real package is `apps/web` (React 19 + TypeScript + Vite 8 + Tailwind 4).
- Root `package.json` scripts wrap `pnpm --filter web <script>`, except `build`/`dev` which also handle the Rust wasm step — run everything from the repo root. pnpm is pinned via `packageManager: pnpm@11.1.2`; do not use npm/yarn (lockfile is `pnpm-lock.yaml`).
- App entry: `apps/web/src/main.tsx` → `EnvironmentGate` → `ErrorBoundary` → `apps/web/src/app/App.tsx`. Follow the `FINAL_PROJECT_PLAN.md` §9 structure rather than inventing layout; `features/` holds `sql-editor` (CodeMirror 6), `database-explorer` (databases, schema, table browser), `database-import`, `database-export`, `query-results`, `query-analysis`, and `query-history` components.
- Architecture source of truth: `FINAL_PROJECT_PLAN.md`. Key sections: §5.2 execution contract, §5.3 typed worker contracts, §5.5 import/export, §9 project structure. Decisions live in `docs/adr/` (ADR-001…005 written in Week 2; ADR-006 multi-database storage foundation, Week 3; ADR-007 SQL workspace editor/results grid, Week 4; ADR-008 explorer/sample data/history, Week 5; ADR-009 import/export/backup, Week 6; ADR-010 query analysis/plan comparison, Week 8; ADR-011 UX/accessibility audit and environment gate, Week 9; ADR-012 QA matrix/benchmark methodology, Week 10). Week 10 artifacts: `apps/web/e2e/week10.spec.ts` (scenario 14 privacy), `apps/web/bench/week10.bench.ts` + `playwright.bench.config.ts`, raw results in `docs/benchmarks/`, report in `docs/benchmarks.md`.

## Commands (run from repo root)

```bash
pnpm install
pnpm build:wasm    # cargo wasm32 release + wasm-bindgen → apps/web/src/generated/
pnpm dev           # ensures wasm glue exists, then Vite dev server, port 5173
pnpm lint          # ESLint (flat config, apps/web)
pnpm typecheck     # tsc -b (src, configs, e2e, bench; noEmit) — needs pnpm build:wasm first
pnpm test          # vitest run (288 tests; wasm round-trip skips if glue missing)
pnpm format        # prettier --write (printWidth 100, double quotes, semi)
pnpm build         # pnpm build:wasm && tsc -b && vite build
pnpm test:e2e      # Playwright, testDir apps/web/e2e (dev server by default)
pnpm benchmark     # Week 10 bench config (preview 4173) → docs/benchmarks/week10-<browser>.json
cargo test         # Rust: plan parser + diff (19 tests)
```

E2E env vars: `E2E_PREVIEW=1` → suite runs against `vite preview` (production build; CI does this, and the ADR-002 gate requires it); `E2E_BROWSER=chromium|firefox|webkit` selects the browser (bench uses the same var). Current suite: 37 e2e tests.

Before finishing a change, run `pnpm lint`, `pnpm typecheck`, `pnpm test` (independent). CI (`.github/workflows/ci.yml`) runs `cargo test`, `pnpm build:wasm`, lint/typecheck/test/build, and production e2e on every push/PR — Chromium and Firefox gate; WebKit is best effort (`continue-on-error`) and its report is uploaded even on failure.

## Gotchas

- **Rust/wasm is a hard build dependency:** `apps/web/src/generated/` (wasm-bindgen output) is git-ignored and must exist before `typecheck`, `test` (for the wasm round-trip tests), and `build`. Run `pnpm build:wasm`. The crate's `wasm-bindgen` dep and the CLI are both pinned to `0.2.130` — bump them together.
- Vitest uses a separate `vitest.config.ts` (jsdom), matching only `src/**/*.{test,spec}.{ts,tsx}` in `apps/web`; tests opt into node via `// @vitest-environment node`. Playwright `webServer`: `pnpm dev` on 5173 by default, `pnpm build && pnpm preview` on 4173 when `E2E_PREVIEW=1` (reuses an existing server outside CI).
- Browser-only by design: no backend, no telemetry, no SQL/data over the network (acceptance scenario 14). SQLite WASM runs in a dedicated Web Worker (`vite.config.ts` sets `worker.format: "es"`) — keep all DB/OPFS work off the main thread. The privacy test is `e2e/week10.spec.ts`; keep its sentinel checks when adding network-facing code.
- Playwright WebKit on Windows has **no OPFS** (reports `in-memory (not persistent)`), so persistence/import/export/reopen/cancel tests and benchmarks fail/skip there. WebKit is a non-blocking proxy, not Safari 17+; report that limitation rather than weakening Chromium/Firefox coverage (ADR-012).
- `EnvironmentGate` (`main.tsx` → `app/EnvironmentGate.tsx`) blocks startup before the worker when WebAssembly/Workers/IndexedDB are missing, and gates phone-sized viewports; capability/viewport rules live in `shared/environment.ts`. Keep feature detection there rather than user-agent sniffing. The Week 9 axe + keyboard audit is `e2e/week9.spec.ts` (`@axe-core/playwright`).
- `crates/query-analyzer` implements the plan parser + diff behind the `PlanToolkit` TS interface (`src/services/toolkit/`); the worker loads the Rust wasm first and falls back to the TS mirror (`status.toolkit`). Never import the generated wasm glue outside `toolkit/rustToolkit.ts`.
- The tab guard (`src/services/storage/tabGuard.ts`) must be acquired before the worker/VFS starts; its per-page promise cache exists so StrictMode remounts do not self-deadlock.
- `tsconfig.app.json` is strict and sets `noUnusedLocals`, `noUnusedParameters`, and `verbatimModuleSyntax` — type-only imports must use `import type`.
- `pnpm format` only touches `apps/web` (skips `dist/` and `src/generated/` via `.prettierignore`). There is no rustfmt/clippy config; `cargo test` is the only Rust check.
