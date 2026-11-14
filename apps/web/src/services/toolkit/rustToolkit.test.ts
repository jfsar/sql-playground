// @vitest-environment node
/**
 * ADR-002 gate (native round-trip): the wasm-bindgen build of
 * `crates/query-analyzer` must load and round-trip typed data outside the
 * browser too. Skipped when `pnpm build:wasm` has not been run.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import init, {
  diffPlans,
  parsePlan,
  toolkitVersion,
} from "../../generated/query-analyzer/query_analyzer";
import type { QueryPlan, QueryPlanNode } from "../../shared/contracts";
import { createTsToolkit } from "./tsToolkit";

const wasmPath = fileURLToPath(
  new URL("../../generated/query-analyzer/query_analyzer_bg.wasm", import.meta.url),
);
const wasmAvailable = existsSync(wasmPath);

describe.skipIf(!wasmAvailable)("rust toolkit (wasm)", () => {
  it("round-trips typed plan data", async () => {
    await init(readFileSync(wasmPath));

    const rows = [
      { id: 0, parent: 0, detail: "SCAN notes" },
      { id: 1, parent: 0, detail: "SEARCH notes USING INDEX idx_body (body=?)" },
      { id: 2, parent: 1, detail: "USE TEMP B-TREE FOR ORDER BY" },
    ];
    const plan = parsePlan(rows, "3.54.1") as QueryPlan;

    expect(plan.sqliteVersion).toBe("3.54.1");
    expect(plan.raw).toHaveLength(3);
    expect(plan.nodes[0]?.operation).toBe("SCAN");
    expect(plan.nodes[0]?.table).toBe("notes");
    expect(plan.nodes[1]?.operation).toBe("SEARCH");
    expect(plan.nodes[1]?.index).toBe("idx_body");
    expect(plan.nodes[1]?.tags).toEqual([]);
    expect(plan.nodes[2]?.operation).toBe("OTHER");
    expect(plan.nodes[2]?.tags).toEqual(["TEMP B-TREE"]);
    expect(plan.nodes[1]?.parentId).toBe(0);
  });

  it("diffs two plans and reports changed nodes", async () => {
    await init(readFileSync(wasmPath));
    const before = parsePlan([{ id: 0, parent: 0, detail: "SCAN t" }], "3.54.1") as QueryPlan;
    const after = parsePlan(
      [{ id: 0, parent: 0, detail: "SEARCH t USING INDEX i (a=?)" }],
      "3.54.1",
    ) as QueryPlan;
    const diff = diffPlans(before, after) as {
      added: unknown[];
      removed: unknown[];
      changed: { before: QueryPlanNode; after: QueryPlanNode }[];
    };
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.before.operation).toBe("SCAN");
    expect(diff.changed[0]?.after.operation).toBe("SEARCH");
  });

  it("reports a toolkit version string", async () => {
    await init(readFileSync(wasmPath));
    expect(toolkitVersion()).toMatch(/^rust\/query-analyzer \d+\.\d+\.\d+$/);
  });

  it("produces the same parse output as the TypeScript fallback", async () => {
    await init(readFileSync(wasmPath));
    const rows = [
      { id: 0, parent: 0, detail: "SCAN t USING COVERING INDEX i" },
      { id: 1, parent: 0, detail: "SOMETHING UNKNOWN" },
    ];
    const rust = parsePlan(rows, "3.54.1") as QueryPlan;
    const ts = createTsToolkit().parsePlan(rows, "3.54.1");
    expect(rust).toEqual(ts);
  });
});
