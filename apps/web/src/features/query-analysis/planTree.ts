import type { QueryPlanNode } from "../../shared/contracts";

/** One node of the rendered plan tree; SQLite reports a forest, not one root. */
export interface PlanTreeNode {
  node: QueryPlanNode;
  children: PlanTreeNode[];
}

/**
 * Build a forest from SQLite's flat EQP rows (plan §4). A node is a root when
 * it points at itself or at an id that is not present. Input order is kept, so
 * the display matches the raw output. Unknown or duplicate ids degrade to
 * roots instead of being dropped.
 */
export function buildPlanTree(nodes: QueryPlanNode[]): PlanTreeNode[] {
  const entries = nodes.map((node) => ({ node, children: [] as PlanTreeNode[] }));
  const byId = new Map<number, PlanTreeNode>();
  const roots = new Set<PlanTreeNode>();

  for (const entry of entries) {
    if (byId.has(entry.node.id)) {
      roots.add(entry);
    } else {
      byId.set(entry.node.id, entry);
    }
  }

  for (const entry of entries) {
    if (roots.has(entry)) continue;
    const { id, parentId } = entry.node;
    const parent = id === parentId ? undefined : byId.get(parentId);
    if (!parent || parent === entry) {
      roots.add(entry);
    } else {
      parent.children.push(entry);
    }
  }

  return entries.filter((entry) => roots.has(entry));
}
