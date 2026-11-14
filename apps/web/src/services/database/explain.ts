import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { QueryPlan, RawPlanRow } from "../../shared/contracts";
import type { PlanToolkit } from "../toolkit/planToolkit";

/** EQP output is small; a cap guards pathological inputs (plan §5.2 rule 7). */
const MAX_PLAN_ROWS = 1000;

/**
 * Run `EXPLAIN QUERY PLAN` on the first statement of `sql` and parse the rows
 * through the active PlanToolkit (plan §5.2 rule 10). Never executes `sql`.
 */
export function explainQuery(
  sqlite3: Sqlite3Static,
  db: Database,
  toolkit: PlanToolkit,
  sql: string,
): QueryPlan {
  const capi = sqlite3.capi;
  const wasm = sqlite3.wasm;
  if (db.pointer === undefined) throw new Error("Database connection is closed");
  const pDb = db.pointer;

  const explainSql = `EXPLAIN QUERY PLAN ${sql}`;
  const sqlBytes = new TextEncoder().encode(explainSql);
  const ptrSize = 4;
  const pSql = wasm.allocFromTypedArray(sqlBytes);
  const ppStmt = wasm.alloc(ptrSize);
  const pzTail = wasm.alloc(ptrSize);

  try {
    wasm.poke(ppStmt, 0, "*");
    wasm.poke(pzTail, 0, "*");
    const rc = capi.sqlite3_prepare_v3(pDb, pSql, sqlBytes.length, 0, ppStmt, pzTail);
    const pStmt = Number(wasm.peekPtr(ppStmt));
    if (rc !== capi.SQLITE_OK || !pStmt) {
      throw new Error(capi.sqlite3_errmsg(pDb));
    }
    try {
      const rows: RawPlanRow[] = [];
      for (;;) {
        const stepRc = capi.sqlite3_step(pStmt);
        if (stepRc !== capi.SQLITE_ROW) break;
        if (rows.length >= MAX_PLAN_ROWS) break;
        // Columns: id, parent, notused, detail (notused dropped at the boundary).
        rows.push({
          id: capi.sqlite3_column_int(pStmt, 0),
          parent: capi.sqlite3_column_int(pStmt, 1),
          detail: capi.sqlite3_column_text(pStmt, 3) ?? "",
        });
      }
      return toolkit.parsePlan(rows, sqlite3.version.libVersion);
    } finally {
      capi.sqlite3_finalize(pStmt);
    }
  } finally {
    wasm.dealloc(pzTail);
    wasm.dealloc(ppStmt);
    wasm.dealloc(pSql);
  }
}
