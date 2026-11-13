import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  server: {
    headers: {
      // Not required for opfs-sahpool (ADR-001), but harmless locally and
      // useful if we ever switch to the default `opfs` VFS.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    target: "es2022",
    // SQLite WASM + worker assets must survive production builds (Week 1 PoC).
    assetsInlineLimit: 0,
  },
});
