import { describe, expect, it } from "vitest";
import type { QueryPlanNode } from "../../shared/contracts";
import { buildPlanTree } from "./planTree";

function node(id: number, parentId: number, detail: string): QueryPlanNode {
  return { id, parentId, operation: "OTHER", tags: [], detail };
}

describe("buildPlanTree", () => {
  it("nests children under their reported parent", () => {
    const tree = buildPlanTree([
      node(1, 0, "COMPOUND QUERY"),
      node(2, 1, "LEFT-MOST SUBQUERY"),
      node(4, 2, "SCAN tags"),
      node(9, 1, "UNION ALL"),
      node(11, 9, "SCAN tags"),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.node.id).toBe(1);
    expect(tree[0]?.children.map((c) => c.node.id)).toEqual([2, 9]);
    expect(tree[0]?.children[0]?.children[0]?.node.id).toBe(4);
    expect(tree[0]?.children[1]?.children[0]?.node.id).toBe(11);
  });

  it("keeps multiple roots in input order", () => {
    const tree = buildPlanTree([
      node(3, 0, "SCAN notes"),
      node(11, 0, "USE TEMP B-TREE FOR ORDER BY"),
    ]);
    expect(tree.map((entry) => entry.node.id)).toEqual([3, 11]);
    expect(tree[0]?.children).toEqual([]);
  });

  it("treats self-parented nodes as roots", () => {
    const tree = buildPlanTree([node(0, 0, "SCAN t")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.node.id).toBe(0);
  });

  it("treats a missing parent as a root instead of dropping the node", () => {
    const tree = buildPlanTree([node(5, 99, "SCAN orphan")]);
    expect(tree.map((entry) => entry.node.id)).toEqual([5]);
  });

  it("keeps duplicate ids visible as roots", () => {
    const tree = buildPlanTree([node(1, 0, "first"), node(1, 0, "duplicate")]);
    expect(tree.map((entry) => entry.node.detail)).toEqual(["first", "duplicate"]);
  });

  it("returns an empty forest for no nodes", () => {
    expect(buildPlanTree([])).toEqual([]);
  });
});
