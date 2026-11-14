// Ensures the generated query-analyzer glue exists before `pnpm dev`.
// Full rebuilds (always fresh) run via `pnpm build:wasm`.
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const glue = fileURLToPath(
  new URL("../apps/web/src/generated/query-analyzer/query_analyzer.js", import.meta.url),
);

if (!existsSync(glue)) {
  console.log("[ensure-wasm] query-analyzer glue missing — running pnpm build:wasm …");
  execSync("pnpm build:wasm", { stdio: "inherit", cwd: root, shell: true });
} else {
  console.log("[ensure-wasm] query-analyzer glue present");
}
