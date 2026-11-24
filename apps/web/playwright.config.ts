import { defineConfig } from "@playwright/test";

/**
 * E2E runs against the dev server by default. Set E2E_PREVIEW=1 to run the
 * same suite against `vite preview` (production build) — required for the
 * ADR-002 gate, which must prove the wasm loads in a production Vite bundle.
 * E2E_BROWSER=chromium|firefox|webkit picks the browser. Playwright WebKit on
 * Windows is a proxy without OPFS, not Safari 17+ (ADR-002/ADR-012).
 */
const preview = process.env.E2E_PREVIEW === "1";
const browser = (process.env.E2E_BROWSER ?? "chromium") as "chromium" | "firefox" | "webkit";

export default defineConfig({
  testDir: "./e2e",
  // OPFS sahpool is exclusive per origin — parallel workers fight over the lock.
  workers: 1,
  webServer: preview
    ? {
        // Build on demand so the gate always tests fresh dist output.
        command: "pnpm build && pnpm preview",
        port: 4173,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      }
    : {
        command: "pnpm dev",
        port: 5173,
        reuseExistingServer: !process.env.CI,
      },
  use: {
    baseURL: preview ? "http://localhost:4173" : "http://localhost:5173",
    browserName: browser,
  },
});
