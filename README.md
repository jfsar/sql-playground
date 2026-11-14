# Browser SQL Playground

A browser-based SQLite development environment: SQL editor, database explorer, query-plan analysis — running entirely client-side with SQLite WASM and OPFS persistence.

See [FINAL_PROJECT_PLAN.md](./FINAL_PROJECT_PLAN.md) for the full project plan.

## Getting started

Prerequisites: Node 22+, pnpm, and Rust with the wasm target + wasm-bindgen
CLI (both pinned to `0.2.130`, matching `crates/query-analyzer`):

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
pnpm install
pnpm dev          # builds the query-analyzer wasm first if missing
```

Open http://localhost:5173 — the PoC shows SQLite in a worker, multi-statement
execution, OPFS persistence, plan explain (Rust wasm), worker restart/cancel,
export, and the multi-tab guard.

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start the Vite dev server (builds wasm glue if missing) |
| `pnpm build:wasm` | Build `crates/query-analyzer` → `apps/web/src/generated/` |
| `pnpm build` | Production build (always rebuilds wasm first) |
| `pnpm typecheck` | TypeScript type-check |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest unit tests (incl. wasm round-trip; skips if wasm not built) |
| `pnpm test:e2e` | Playwright e2e — dev server by default |
| `pnpm format` | Prettier write |

E2E options (env vars): `E2E_PREVIEW=1` runs the suite against `vite preview`
(**required for the ADR-002 gate** — proves the wasm loads in a production
bundle); `E2E_BROWSER=firefox` selects the browser. CI runs
`E2E_PREVIEW=1` on Chromium.

## Structure

```
apps/web/          React + TypeScript application
  src/shared/      Typed contracts (plan §5.3)
  src/services/    database (execute, explain, policy), worker manager,
                   toolkit (PlanToolkit: Rust wasm + TS fallback), storage (tab guard)
  src/workers/     sqlite.worker.ts (WASM + opfs-sahpool + PlanToolkit)
  src/generated/   wasm-bindgen output (git-ignored, built by pnpm build:wasm)
  e2e/             Playwright specs (PoC + Week 2)
crates/query-analyzer/  Rust plan parser + diff (ADR-002, behind PlanToolkit)
docs/adr/          ADR-001 … ADR-005
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push/PR:

- `cargo test` (plan parser + diff) · `pnpm build:wasm`
- `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build`
- Playwright e2e against the **production build** (`E2E_PREVIEW=1`), Chromium

## Deploy (Cloudflare Pages)

The app is a static SPA served by Cloudflare Pages; SQLite runs in the browser.
`opfs-sahpool` does **not** require COOP/COEP headers (ADR-001).
`wrangler.toml` sets `pages_build_output_dir = "apps/web/dist"`.

### Dashboard (Pages Builds)

1. Workers & Pages → **Create** → **Pages** → **Connect to Git** (Pages, not
   Workers).
2. Root directory: `/` (repository root — needed for the pnpm workspace).
3. Build command:

   ```bash
   bash scripts/cloudflare-build.sh
   ```

   Pages runs the build command as a single `sh -c` line, so do not paste a
   multi-line command into the dashboard — newlines are flattened and the shell
   fails with `Syntax error: word unexpected`. The script bootstraps Rust +
   wasm-bindgen (Cloudflare's build image has neither, otherwise `pnpm build`
   fails with `sh: 1: cargo: not found`), then runs `pnpm install` and
   `pnpm build`.
4. Build output directory: `apps/web/dist`.
5. Node 22+.

### Wrangler

```bash
pnpm build   # requires Rust + wasm-bindgen 0.2.130 locally
pnpm exec wrangler pages deploy apps/web/dist --project-name sql-playground
```

`apps/web/public/_redirects` (`/* /index.html 200`) provides the SPA fallback
for client-side deep links.

## Browser support

See plan §2. Chrome/Edge/Firefox current, Safari 17+. Phones unsupported. If
OPFS is unavailable the app falls back to an in-memory database with a visible
**not persistent** banner — never a silent fallback.

**PoC status (Week 2):** full e2e suite passes on **Chromium and Firefox**
(dev + production builds). Safari 17+ verification is pending a macOS run
(see `docs/adr/0001`).

## PoC checklists

### Week 1

- [x] Vite + React + TypeScript; CI (lint, typecheck, Vitest) from day one
- [x] SQLite WASM in a worker; execute SQL
- [x] `opfs-sahpool` install; persist across reload (e2e)
- [x] Prepare-loop statement splitting verified (unit tests)
- [x] Transaction-state reading verified (`sqlite3_get_autocommit`)
- [x] Cloudflare Pages deploy config

### Week 2

- [x] Rust crate builds with wasm-bindgen; loads in the worker under a
      **production** Vite build; round-trips typed data (**ADR-002 gate:
      PASSED** on Chromium + Firefox; `status.toolkit` shows `rust`)
- [x] ADR-001 checks: reload persistence, second-tab blocking, pool capacity
      visible, pool export (valid `SQLite format 3` header), WAL stays
      `delete`, worker-termination handle release — measured restart
      **87 ms** (Chromium prod) / **264 ms** (Firefox), target 5 s
- [x] ADR-004 checks: mid-query cancel via restart, database intact,
      UI returns to idle (scenario 15)
- [x] ADR-005 checks: Web Locks tab guard grants/blocks/retries correctly
- [x] ADR-001 … ADR-005 written (`docs/adr/`)
- [ ] Safari 17+ run (pending macOS; ADR-001/002/005 note it)

### Go/no-go (end of Week 2)

| Gate item | Status |
|-----------|--------|
| SQLite executes in a worker | ✅ |
| Persistence works through OPFS | ✅ (Chromium + Firefox, dev + production) |
| Plan toolkit (Rust or TS fallback) callable from the worker | ✅ Rust active in production builds; TS fallback tested |
| Worker/React messaging with `requestId` reliable | ✅ (unit + e2e) |
| Tab guard works | ✅ (e2e: second tab blocked, owner unaffected) |

**Result: GO** — proceed to Week 3 (foundation and persistence core), with
the Safari matrix run still owed before release.
