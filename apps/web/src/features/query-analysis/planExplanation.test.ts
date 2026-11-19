import { describe, expect, it } from "vitest";
import type { QueryPlanNode } from "../../shared/contracts";
import { describePlanNode } from "./planExplanation";

function node(overrides: Partial<QueryPlanNode>): QueryPlanNode {
  return {
    id: 0,
    parentId: 0,
    operation: "OTHER",
    tags: [],
    detail: "",
    ...overrides,
  };
}

describe("describePlanNode", () => {
  it("describes a table scan without judging it", () => {
    const text = describePlanNode(
      node({ operation: "SCAN", table: "notes", detail: "SCAN notes" }),
    );
    expect(text).toContain("notes");
    expect(text).toMatch(/reads/i);
  });

  it("describes an index search and names the index", () => {
    const text = describePlanNode(
      node({
        operation: "SEARCH",
        table: "notes",
        index: "idx_body",
        detail: "SEARCH notes USING INDEX idx_body (body=?)",
      }),
    );
    expect(text).toContain("idx_body");
    expect(text).toContain("notes");
  });

  it("describes covering and automatic indexes as facts", () => {
    const covering = describePlanNode(
      node({
        operation: "SEARCH",
        table: "notes",
        index: "idx_body",
        tags: ["COVERING INDEX"],
        detail: "SEARCH notes USING COVERING INDEX idx_body (body=?)",
      }),
    );
    expect(covering).toContain("every column");

    const automatic = describePlanNode(
      node({
        operation: "SEARCH",
        table: "b",
        tags: ["AUTOMATIC INDEX", "COVERING INDEX"],
        detail: "SEARCH b USING AUTOMATIC COVERING INDEX (y=?)",
      }),
    );
    expect(automatic).toContain("temporary index");
    expect(automatic).toContain("every column");
  });

  it("describes integer primary key lookups", () => {
    const text = describePlanNode(
      node({
        operation: "SEARCH",
        table: "notes",
        tags: ["INTEGER PRIMARY KEY"],
        detail: "SEARCH notes USING INTEGER PRIMARY KEY (rowid=?)",
      }),
    );
    expect(text).toContain("integer primary key");
  });

  it("describes temporary b-trees by purpose", () => {
    const order = describePlanNode(
      node({ tags: ["TEMP B-TREE"], detail: "USE TEMP B-TREE FOR ORDER BY" }),
    );
    expect(order).toMatch(/sort/i);

    const group = describePlanNode(
      node({ tags: ["TEMP B-TREE"], detail: "USE TEMP B-TREE FOR GROUP BY" }),
    );
    expect(group).toMatch(/group/i);
  });

  it("describes co-routines, materialization, and bloom filters", () => {
    expect(describePlanNode(node({ tags: ["CO-ROUTINE"], detail: "CO-ROUTINE (x)" }))).toMatch(
      /co-routine/i,
    );
    expect(describePlanNode(node({ tags: ["MATERIALIZE"], detail: "MATERIALIZE x" }))).toMatch(
      /temporary table/i,
    );
    expect(describePlanNode(node({ tags: ["BLOOM FILTER"], detail: "BLOOM FILTER ON b" }))).toMatch(
      /bloom filter/i,
    );
  });

  it("falls back to the raw detail for unknown operations", () => {
    const text = describePlanNode(node({ detail: "SOMETHING NEW" }));
    expect(text).toMatch(/raw detail/i);
  });

  it("never labels an operation good, bad, fast, slow, or optimal", () => {
    const samples = [
      node({ operation: "SCAN", table: "t", detail: "SCAN t" }),
      node({ operation: "SEARCH", table: "t", index: "i", detail: "SEARCH t USING INDEX i" }),
      node({ tags: ["TEMP B-TREE"], detail: "USE TEMP B-TREE FOR ORDER BY" }),
      node({ tags: ["AUTOMATIC INDEX"], detail: "SEARCH t USING AUTOMATIC INDEX (a=?)" }),
      node({ detail: "UNKNOWN" }),
    ];
    for (const sample of samples) {
      expect(describePlanNode(sample)).not.toMatch(/\b(good|bad|fast|slow|optimal|inefficient)\b/i);
    }
  });
});
