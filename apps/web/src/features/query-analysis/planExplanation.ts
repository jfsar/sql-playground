import type { QueryPlanNode } from "../../shared/contracts";

/**
 * Short, neutral explanation of a plan node (plan §4: never label a scan as
 * bad or an index search as optimal). The raw `detail` is always shown too, so
 * unknown forms still have an accurate description.
 */

function quote(name: string): string {
  return `"${name}"`;
}

function scanText(node: QueryPlanNode): string {
  const table = node.table ? quote(node.table) : null;
  if (node.index) {
    return table
      ? `Reads entries from index ${quote(node.index)} for ${table}.`
      : `Reads entries from index ${quote(node.index)}.`;
  }
  return table
    ? `Reads every row of ${table} in table order to find matches.`
    : "Reads rows in table order to find matches.";
}

function searchText(node: QueryPlanNode): string {
  const table = node.table ? quote(node.table) : null;
  if (node.tags.includes("INTEGER PRIMARY KEY")) {
    return table
      ? `Locates a row in ${table} by its integer primary key.`
      : "Locates a row by its integer primary key.";
  }
  if (node.tags.includes("AUTOMATIC INDEX")) {
    return table
      ? `Builds a temporary index for ${table} and uses it to locate matching rows.`
      : "Builds a temporary index and uses it to locate matching rows.";
  }
  if (node.index) {
    return table
      ? `Uses index ${quote(node.index)} to locate matching rows in ${table}.`
      : `Uses index ${quote(node.index)} to locate matching rows.`;
  }
  return table
    ? `Uses an index or rowid to locate matching rows in ${table}.`
    : "Uses an index or rowid to locate matching rows.";
}

function otherText(node: QueryPlanNode): string {
  if (node.tags.includes("TEMP B-TREE")) {
    if (/FOR ORDER BY/i.test(node.detail)) return "Builds a temporary B-tree to sort rows.";
    if (/FOR GROUP BY/i.test(node.detail)) return "Builds a temporary B-tree to group rows.";
    if (/FOR DISTINCT/i.test(node.detail)) {
      return "Builds a temporary B-tree to remove duplicate rows.";
    }
    return "Builds a temporary B-tree to sort or group rows.";
  }
  if (node.tags.includes("CO-ROUTINE")) {
    return "Runs a subquery as a co-routine, returning rows as they are needed.";
  }
  if (node.tags.includes("MATERIALIZE")) {
    return "Stores a subquery result in a temporary table.";
  }
  if (node.tags.includes("BLOOM FILTER")) {
    return "Uses a Bloom filter to skip rows that cannot match the join condition.";
  }
  return "SQLite reports an additional plan step; the raw detail names it.";
}

function tagNotes(node: QueryPlanNode, base: string): string[] {
  const notes: string[] = [];
  if (node.tags.includes("COVERING INDEX") && !/every column/i.test(base)) {
    notes.push("The index supplies every column the query needs.");
  }
  if (node.tags.includes("AUTOMATIC INDEX") && !/temporary index/i.test(base)) {
    notes.push("SQLite creates this index automatically for the current query.");
  }
  return notes;
}

export function describePlanNode(node: QueryPlanNode): string {
  const base =
    node.operation === "SCAN"
      ? scanText(node)
      : node.operation === "SEARCH"
        ? searchText(node)
        : otherText(node);
  const notes = tagNotes(node, base);
  return notes.length > 0 ? `${base} ${notes.join(" ")}` : base;
}
