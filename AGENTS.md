# AGENTS.md

## Repo shape

- Two workspaces rooted here: pnpm (`pnpm-workspace.yaml` → `apps/*`) and Cargo (`Cargo.toml` → `crates/*`). The only real package is `apps/web` (React 19 + TypeScript + Vite 8 + Tailwind 4).
- Root `package.json` scripts are thin `pnpm --filter web <script>` wrappers — run everything from the repo root. pnpm is pinned via `packageManager: pnpm@11.1.2`; do not use npm/yarn (lockfile is `pnpm-lock.yaml`).
- App entry: `apps/web/src/main.tsx` → `apps/web/src/app/App.tsx`. The `src/` subdirs (`features/`, `services/`, `workers/`, `shared/`) are `.gitkeep` placeholders that mirror the structure in `FINAL_PROJECT_PLAN.md` §9 — follow it rather than inventing layout.
- Architecture source of truth: `FINAL_PROJECT_PLAN.md`. Key sections: §5.2 execution contract, §5.3 typed worker contracts, §9 project structure. `docs/adr/` is empty; ADR-001…005 are expected to land there.

## Commands (run from repo root)

```bash
pnpm install
pnpm dev          # Vite dev server, port 5173
pnpm lint         # ESLint (flat config, apps/web)
pnpm typecheck    # tsc -b (project references, noEmit)
pnpm test         # vitest run
pnpm format       # prettier --write (printWidth 100, double quotes, semi)
pnpm build        # tsc -b && vite build
pnpm test:e2e     # Playwright, testDir apps/web/e2e
cargo test        # Rust workspace (crate is currently a stub)
```

Before finishing a change, run `pnpm lint`, `pnpm typecheck`, `pnpm test` (independent; no CI exists yet — `.github/` is absent).

## Gotchas

- `pnpm test` is `vitest run --passWithNoTests` and there are currently **zero tests** — a green run proves nothing.
- Vitest uses a separate `vitest.config.ts` (jsdom), matching only `src/**/*.{test,spec}.{ts,tsx}` in `apps/web`. Playwright's `webServer` auto-starts `pnpm dev` on 5173 and reuses an existing server outside CI.
- Browser-only by design: no backend, no telemetry, no SQL/data over the network (acceptance scenario 14). SQLite WASM runs in a dedicated Web Worker (`vite.config.ts` sets `worker.format: "es"`) — keep all DB/OPFS work off the main thread.
- `crates/query-analyzer` is PoC-gated (ADR-002) and is a stub (`lib.rs` is one doc line). App code must only reach it through the `PlanToolkit` TS interface (plan §4); a TypeScript fallback ships if the gate fails. Do not wire it in unconditionally.
- `tsconfig.app.json` is strict and sets `noUnusedLocals`, `noUnusedParameters`, and `verbatimModuleSyntax` — type-only imports must use `import type`.
- `pnpm format` only touches `apps/web` (and skips `dist/` via `.prettierignore`). There is no rustfmt/clippy config; `cargo test` is the only Rust check.
