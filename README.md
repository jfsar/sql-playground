# Browser SQL Playground

A browser-based SQLite development environment: SQL editor, database explorer, query-plan analysis — running entirely client-side with SQLite WASM and OPFS persistence.

See [FINAL_PROJECT_PLAN.md](./FINAL_PROJECT_PLAN.md) for the full project plan.

## Getting started

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173 — the Week 1 PoC shows SQLite in a worker, multi-statement execution, and OPFS persistence across reload.

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start the Vite dev server |
| `pnpm build` | Production build |
| `pnpm typecheck` | TypeScript type-check |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest unit tests |
| `pnpm test:e2e` | Playwright end-to-end tests |
| `pnpm format` | Prettier write |

## Structure

```
apps/web/          React + TypeScript application
  src/shared/      Typed contracts (plan §5.3)
  src/services/    database (execute + policy), worker manager
  src/workers/     sqlite.worker.ts (WASM + opfs-sahpool)
  e2e/             Playwright specs
crates/            Rust/WASM crates (PoC-gated, Week 2)
docs/adr/          Architecture Decision Records
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push/PR:

- `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build`
- Playwright e2e (Chromium), including OPFS persistence across reload

## Deploy (Cloudflare Pages)

The app is a static SPA; SQLite runs in the browser. `opfs-sahpool` does **not** require COOP/COEP headers (ADR-001).

### Dashboard

1. Create a Pages project → **Import from Git**.
2. Build command: `pnpm install && pnpm build`
3. Build output directory: `apps/web/dist`
4. Root directory: `/` (repository root — needed for the pnpm workspace).
5. Deploy. Node 22+.

### Wrangler

```bash
pnpm build
pnpm exec wrangler pages deploy apps/web/dist --project-name sql-playground
```

`wrangler.toml` records `pages_build_output_dir` for local wrangler versions that support it.

## Browser support

See plan §2. Chrome/Edge/Firefox current, Safari 17+. Phones unsupported. If OPFS is unavailable the app falls back to an in-memory database with a visible **not persistent** banner — never a silent fallback.

## Week 1 PoC checklist

- [x] Vite + React + TypeScript; CI (lint, typecheck, Vitest) from day one
- [x] SQLite WASM in a worker; execute SQL
- [x] `opfs-sahpool` install; persist across reload (e2e)
- [x] Prepare-loop statement splitting verified (unit tests)
- [x] Transaction-state reading verified (`sqlite3_get_autocommit`)
- [x] Cloudflare Pages deploy config
