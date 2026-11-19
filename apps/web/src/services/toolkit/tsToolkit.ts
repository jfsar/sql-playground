/**
 * TypeScript implementation of PlanToolkit (plan §4 fallback).
 * Mirrors crates/query-analyzer semantics: unknown detail forms degrade to
 * OTHER with raw text preserved; the parser never throws.
 */

import type {
  PlanDiff,
  PlanOperation,
  QueryPlan,
  QueryPlanNode,
  RawPlanRow,
} from "../../shared/contracts";
import type { PlanToolkit } from "./planToolkit";

/** If `s` starts with `kw` as a whole word, return the remainder after it. */
function stripKeyword(s: string, kw: string): string | null {
  if (!s.startsWith(kw)) return null;
  const rest = s.slice(kw.length);
  if (rest.length === 0 || /^\s/.test(rest)) return rest;
  return null;
}

/** First token: quoted identifier (`"…"`, `` `…` ``, `[…]`) or non-whitespace run. */
function firstToken(s: string): [token: string, rest: string] {
  const t = s.trimStart();
  if (t.length === 0) return ["", ""];
  const c = t[0];
  if (c === '"' || c === "`" || c === "[") {
    const close = c === "[" ? "]" : c;
    const idx = t.indexOf(close, 1);
    if (idx === -1) return [t.slice(1), ""];
    return [t.slice(1, idx), t.slice(idx + 1)];
  }
  const end = t.search(/\s/);
  return end === -1 ? [t, ""] : [t.slice(0, end), t.slice(end)];
}

function pushTag(tags: string[], tag: string): void {
  if (!tags.includes(tag)) tags.push(tag);
}

function indexName(s: string): string | undefined {
  const [name0] = firstToken(s);
  const name = name0.split("(")[0]?.trim() ?? "";
  return name.length > 0 ? name : undefined;
}

/**
 * Name of an automatic index, when SQLite reports one. Older builds use
 * `(i0 (a=?))`; 3.54 reports `(a=?)` with no name, so the name is optional.
 */
function automaticIndexName(s: string): string | undefined {
  const inner = s.trimStart();
  if (!inner.startsWith("(")) return undefined;
  const [name, rest] = firstToken(inner.slice(1));
  return name.length > 0 && rest.trimStart().startsWith("(") ? name : undefined;
}

/** Parse the `USING …` suffix of a SCAN/SEARCH detail (may be empty). */
function parseUsing(s: string, tags: string[]): string | undefined {
  const afterUsing = stripKeyword(s.trimStart(), "USING");
  if (afterUsing === null) return undefined;
  const rest = afterUsing.trimStart();

  // 3.54 can report "AUTOMATIC COVERING INDEX"; match the longer form first.
  const automaticCovering = stripKeyword(rest, "AUTOMATIC COVERING INDEX");
  if (automaticCovering !== null) {
    pushTag(tags, "AUTOMATIC INDEX");
    pushTag(tags, "COVERING INDEX");
    return automaticIndexName(automaticCovering);
  }
  const covering = stripKeyword(rest, "COVERING INDEX");
  if (covering !== null) {
    pushTag(tags, "COVERING INDEX");
    return indexName(covering);
  }
  const plain = stripKeyword(rest, "INDEX");
  if (plain !== null) return indexName(plain);
  const automatic = stripKeyword(rest, "AUTOMATIC INDEX");
  if (automatic !== null) {
    pushTag(tags, "AUTOMATIC INDEX");
    return automaticIndexName(automatic);
  }
  if (rest.startsWith("INTEGER PRIMARY KEY")) pushTag(tags, "INTEGER PRIMARY KEY");
  return undefined;
}

/** Subquery pseudo-tables like `(subquery-1)` are not tables. */
function sanitizeTable(table: string): string | undefined {
  const t = table.trim();
  if (t.length === 0 || t.startsWith("(")) return undefined;
  return t;
}

function collectCommonTags(detail: string, tags: string[]): void {
  if (detail.includes("TEMP B-TREE")) pushTag(tags, "TEMP B-TREE");
  if (detail.includes("CO-ROUTINE")) pushTag(tags, "CO-ROUTINE");
  if (detail.includes("MATERIALIZE")) pushTag(tags, "MATERIALIZE");
  if (detail.includes("BLOOM FILTER")) pushTag(tags, "BLOOM FILTER");
}

export function parseNode(row: RawPlanRow): QueryPlanNode {
  const detail = row.detail.trim();
  const tags: string[] = [];
  let operation: PlanOperation = "OTHER";
  let table: string | undefined;
  let index: string | undefined;

  const scan = stripKeyword(detail, "SCAN");
  const search = scan === null ? stripKeyword(detail, "SEARCH") : null;
  if (scan !== null) {
    operation = "SCAN";
    const [tbl, after] = firstToken(scan);
    table = sanitizeTable(tbl);
    index = parseUsing(after, tags);
  } else if (search !== null) {
    operation = "SEARCH";
    const [tbl, after] = firstToken(search);
    table = sanitizeTable(tbl);
    index = parseUsing(after, tags);
  }
  collectCommonTags(detail, tags);

  return {
    id: row.id,
    parentId: row.parent,
    operation,
    ...(table !== undefined ? { table } : {}),
    ...(index !== undefined ? { index } : {}),
    tags,
    detail,
  };
}

function copyRaw(rows: RawPlanRow[]): RawPlanRow[] {
  return rows.map((r) => ({ id: r.id, parent: r.parent, detail: r.detail }));
}

export function parsePlanRows(rows: RawPlanRow[], sqliteVersion: string): QueryPlan {
  return { nodes: rows.map(parseNode), raw: copyRaw(rows), sqliteVersion };
}

function nodesEqual(a: QueryPlanNode, b: QueryPlanNode): boolean {
  return (
    a.id === b.id &&
    a.parentId === b.parentId &&
    a.operation === b.operation &&
    a.table === b.table &&
    a.index === b.index &&
    a.detail === b.detail &&
    a.tags.length === b.tags.length &&
    a.tags.every((t, i) => t === b.tags[i])
  );
}

/** Node-level diff matched by SQLite EQP id (mirrors plan_diff.rs). */
export function diffPlanTrees(before: QueryPlan, after: QueryPlan): PlanDiff {
  const beforeById = new Map(before.nodes.map((n) => [n.id, n]));
  const afterById = new Map(after.nodes.map((n) => [n.id, n]));
  const added: QueryPlanNode[] = [];
  const removed: QueryPlanNode[] = [];
  const changed: { before: QueryPlanNode; after: QueryPlanNode }[] = [];

  for (const node of after.nodes) {
    const prev = beforeById.get(node.id);
    if (prev === undefined) added.push(node);
    else if (!nodesEqual(prev, node)) changed.push({ before: prev, after: node });
  }
  for (const node of before.nodes) {
    if (!afterById.has(node.id)) removed.push(node);
  }
  return { added, removed, changed };
}

export function createTsToolkit(): PlanToolkit {
  return {
    parsePlan: parsePlanRows,
    diffPlans: diffPlanTrees,
  };
}
