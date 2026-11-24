import { defineConfig } from "@playwright/test";

/**
 * Week 10 benchmark harness. Separate from the acceptance suite: it seeds
 * 10/50/100 MB databases, writes JSON results under docs/benchmarks/, and is
 * report-only (not a CI gate). Benchmarks always run against the production
 * preview so timings do not include a dev-server transform.
 */
const browser = (process.env.E2E_BROWSER ?? "chromium") as "chromium" | "firefox" | "webkit";

export default defineConfig({
  testDir: "./bench",
  testMatch: /.*\.bench\.ts$/,
  workers: 1,
  fullyParallel: false,
  timeout: 15 * 60_000,
  expect: { timeout: 120_000 },
  webServer: {
    command: "pnpm build && pnpm preview",
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  use: {
    baseURL: "http://localhost:4173",
    browserName: browser,
    acceptDownloads: true,
    actionTimeout: 120_000,
    navigationTimeout: 120_000,
  },
  reporter: [["list"]],
});
