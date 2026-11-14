import { describe, expect, it } from "vitest";
import type { QueryPlan, RawPlanRow } from "../../shared/contracts";
import { createTsToolkit, diffPlanTrees, parsePlanRows } from "./tsToolkit";

const toolkit = createTsToolkit();

function row(id: number, parent: number, detail: string): RawPlanRow {
  return { id, parent, detail };
}

describe("tsToolkit parsePlan", () => {
  it("parses a table scan", () => {
    const plan = toolkit.parsePlan([row(0, 0, "SCAN notes")], "3.54.1");
    expect(plan.nodes[0]).toEqual({
      id: 0,
      parentId: 0,
      operation: "SCAN",
      table: "notes",
      tags: [],
      detail: "SCAN notes",
    });
    expect(plan.sqliteVersion).toBe("3.54.1");
    expect(plan.raw).toEqual([row(0, 0, "SCAN notes")]);
  });

  it("parses covering-index scans and index searches", () => {
    const plan = toolkit.parsePlan(
      [
        row(0, 0, "SCAN notes USING COVERING INDEX idx_body"),
        row(1, 0, "SEARCH notes USING INDEX idx_body (body=?)"),
      ],
      "3.54.1",
    );
    expect(plan.nodes[0]?.index).toBe("idx_body");
    expect(plan.nodes[0]?.tags).toEqual(["COVERING INDEX"]);
    expect(plan.nodes[1]?.operation).toBe("SEARCH");
    expect(plan.nodes[1]?.index).toBe("idx_body");
    expect(plan.nodes[1]?.tags).toEqual([]);
  });

  it("parses automatic index and integer primary key searches", () => {
    const plan = toolkit.parsePlan(
      [
        row(0, 0, "SEARCH t USING AUTOMATIC INDEX (i0 (a=?))"),
        row(1, 0, "SEARCH t USING INTEGER PRIMARY KEY (rowid=?)"),
      ],
      "3.54.1",
    );
    expect(plan.nodes[0]?.tags).toEqual(["AUTOMATIC INDEX"]);
    expect(plan.nodes[0]?.index).toBe("i0");
    expect(plan.nodes[1]?.tags).toEqual(["INTEGER PRIMARY KEY"]);
    expect(plan.nodes[1]?.index).toBeUndefined();
  });

  it("tags temp b-tree, co-routine, and materialize details", () => {
    const plan = toolkit.parsePlan(
      [
        row(0, 0, "USE TEMP B-TREE FOR ORDER BY"),
        row(1, 0, "CO-ROUTINE (subquery-1)"),
        row(2, 0, "MATERIALIZE (subquery-2)"),
      ],
      "3.54.1",
    );
    expect(plan.nodes.map((n) => n.operation)).toEqual(["OTHER", "OTHER", "OTHER"]);
    expect(plan.nodes[0]?.tags).toEqual(["TEMP B-TREE"]);
    expect(plan.nodes[1]?.tags).toEqual(["CO-ROUTINE"]);
    expect(plan.nodes[2]?.tags).toEqual(["MATERIALIZE"]);
  });

  it("degrades unknown details to OTHER without throwing", () => {
    const plan = toolkit.parsePlan([row(7, 0, "SOMETHING WE NEVER SAW")], "3.54.1");
    expect(plan.nodes[0]?.operation).toBe("OTHER");
    expect(plan.nodes[0]?.detail).toBe("SOMETHING WE NEVER SAW");
  });

  it("parses quoted table names and rejects subquery pseudo-tables", () => {
    const plan = toolkit.parsePlan(
      [row(0, 0, 'SCAN "my table"'), row(1, 0, "SCAN (subquery-1)")],
      "3.54.1",
    );
    expect(plan.nodes[0]?.table).toBe("my table");
    expect(plan.nodes[1]?.table).toBeUndefined();
  });

  it("omits undefined optional fields (rust round-trip compatible)", () => {
    const plan = toolkit.parsePlan([row(0, 0, "SCAN t")], "1");
    expect("table" in plan.nodes[0]!).toBe(true);
    expect("index" in plan.nodes[0]!).toBe(false);
  });
});

describe("tsToolkit diffPlans", () => {
  const before = parsePlanRows([row(0, 0, "SCAN t")], "3.54.1");

  it("returns an empty diff for identical plans", () => {
    const after = parsePlanRows([row(0, 0, "SCAN t")], "3.54.1");
    const diff = toolkit.diffPlans(before, after);
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
  });

  it("detects a scan becoming a search", () => {
    const after = parsePlanRows([row(0, 0, "SEARCH t USING INDEX idx_a (a=?)")], "3.54.1");
    const diff = toolkit.diffPlans(before, after);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.before.operation).toBe("SCAN");
    expect(diff.changed[0]?.after.operation).toBe("SEARCH");
    expect(diff.changed[0]?.after.index).toBe("idx_a");
  });

  it("detects added and removed nodes", () => {
    const withRoutine = parsePlanRows(
      [row(0, 0, "SCAN t"), row(1, 0, "CO-ROUTINE (subquery-1)")],
      "3.54.1",
    );
    const diff = diffPlanTrees(withRoutine, before);
    expect(diff.removed.map((n) => n.id)).toEqual([1]);
    const rev = diffPlanTrees(before, withRoutine);
    expect(rev.added.map((n) => n.id)).toEqual([1]);
  });
});

describe("tsToolkit matches rust serde output shape", () => {
  it("produces camelCase keys and no null optionals", () => {
    const plan: QueryPlan = toolkit.parsePlan([row(0, 0, "SCAN t USING COVERING INDEX i")], "1");
    expect(Object.keys(plan)).toEqual(["nodes", "raw", "sqliteVersion"]);
    expect(Object.keys(plan.nodes[0]!).sort()).toEqual(
      ["detail", "id", "index", "operation", "parentId", "table", "tags"].sort(),
    );
    expect(plan.nodes[0]!.parentId).toBe(0);
  });
});
