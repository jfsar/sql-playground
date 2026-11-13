import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // execute.test.ts opts into node via `// @vitest-environment node` docblock
    // (SQLite WASM in-memory works in Node; OPFS does not).
  },
});
