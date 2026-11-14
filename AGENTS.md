# AGENTS.md

## Repo shape

- Two workspaces rooted here: pnpm (`pnpm-workspace.yaml` → `apps/*`) and Cargo (`Cargo.toml` → `crates/*`). The only real package is `apps/web` (React 19 + TypeScript + Vite 8 + Tailwind 4).
- Root `package.json` scripts wrap `pnpm --filter web <script>`, except `build`/`dev` which also handle the Rust wasm step — run everything from the repo root. pnpm is pinned via `packageManager: pnpm@11.1.2`; do not use npm/yarn (lockfile is `pnpm-lock.yaml`).
- App entry: `apps/web/src/main.tsx` → `apps/web/src/app/App.tsx`. Follow the `FINAL_PROJECT_PLAN.md` §9 structure rather than inventing layout; `features/` subdirs are still `.gitkeep` placeholders.
- Architecture source of truth: `FINAL_PROJECT_PLAN.md`. Key sections: §5.2 execution contract, §5.3 typed worker contracts, §9 project structure. Decisions live in `docs/adr/` (ADR-001…005 written in Week 2).

## Commands (run from repo root)

```bash
pnpm install
pnpm build:wasm    # cargo wasm32 release + wasm-bindgen → apps/web/src/generated/
pnpm dev           # ensures wasm glue exists, then Vite dev server, port 5173
pnpm lint          # ESLint (flat config, apps/web)
pnpm typecheck     # tsc -b (project references, noEmit) — needs pnpm build:wasm first
pnpm test          # vitest run (62 tests; wasm round-trip skips if glue missing)
pnpm format        # prettier --write (printWidth 100, double quotes, semi)
pnpm build         # pnpm build:wasm && tsc -b && vite build
pnpm test:e2e      # Playwright, testDir apps/web/e2e (dev server by default)
cargo test         # Rust: plan parser + diff (16 tests)
```

E2E env vars: `E2E_PREVIEW=1` → suite runs against `vite preview` (production build; CI does this, and the ADR-002 gate requires it); `E2E_BROWSER=firefox` → Firefox.

Before finishing a change, run `pnpm lint`, `pnpm typecheck`, `pnpm test` (independent). CI (`.github/workflows/ci.yml`) runs `cargo test`, `pnpm build:wasm`, lint/typecheck/test/build, and production e2e on every push/PR.

## Gotchas

- **Rust/wasm is a hard build dependency:** `apps/web/src/generated/` (wasm-bindgen output) is git-ignored and must exist before `typecheck`, `test` (for the wasm round-trip tests), and `build`. Run `pnpm build:wasm`. The crate's `wasm-bindgen` dep and the CLI are both pinned to `0.2.130` — bump them together.
- Vitest uses a separate `vitest.config.ts` (jsdom), matching only `src/**/*.{test,spec}.{ts,tsx}` in `apps/web`; tests opt into node via `// @vitest-environment node`. Playwright `webServer`: `pnpm dev` on 5173 by default, `pnpm build && pnpm preview` on 4173 when `E2E_PREVIEW=1` (reuses an existing server outside CI).
- Browser-only by design: no backend, no telemetry, no SQL/data over the network (acceptance scenario 14). SQLite WASM runs in a dedicated Web Worker (`vite.config.ts` sets `worker.format: "es"`) — keep all DB/OPFS work off the main thread.
- `crates/query-analyzer` implements the plan parser + diff behind the `PlanToolkit` TS interface (`src/services/toolkit/`); the worker loads the Rust wasm first and falls back to the TS mirror (`status.toolkit`). Never import the generated wasm glue outside `toolkit/rustToolkit.ts`.
- The tab guard (`src/services/storage/tabGuard.ts`) must be acquired before the worker/VFS starts; its per-page promise cache exists so StrictMode remounts do not self-deadlock.
- `tsconfig.app.json` is strict and sets `noUnusedLocals`, `noUnusedParameters`, and `verbatimModuleSyntax` — type-only imports must use `import type`.
- `pnpm format` only touches `apps/web` (skips `dist/` and `src/generated/` via `.prettierignore`). There is no rustfmt/clippy config; `cargo test` is the only Rust check.
