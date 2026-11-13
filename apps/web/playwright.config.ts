import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // OPFS sahpool is exclusive per origin — parallel workers fight over the lock.
  workers: 1,
  webServer: {
    command: "pnpm dev",
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: "http://localhost:5173",
  },
});
