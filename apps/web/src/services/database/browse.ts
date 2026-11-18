/**
 * Table browser reads (FINAL_PROJECT_PLAN Week 5): a total count plus one
 * LIMIT/OFFSET page for tables and views. SQL runs through the same execution
 * contract as user SQL, so value conversion, error reporting, and the row cap
 * stay identical.
 */

import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { MAX_TABLE_PAGE_SIZE, TABLE_PAGE_SIZE, type TablePage } from "../../shared/contracts";
import { executeScript } from "./execute";

export { MAX_TABLE_PAGE_SIZE, TABLE_PAGE_SIZE };

export interface BrowsePage {
  limit?: number;
  offset?: number;
}

/** Double-quote an SQLite identifier, escaping embedded quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return TABLE_PAGE_SIZE;
  return Math.min(MAX_TABLE_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.trunc(offset));
}

function firstValue(result: ReturnType<typeof executeScript>): number {
  if (result.statements.length !== 1) throw new Error("Unexpected table count result");
  const statement = result.statements[0];
  if (statement.kind === "error") throw new Error(statement.error.message);
  if (statement.kind !== "rows" || statement.rows.length === 0) return 0;
  const value = statement.rows[0]?.[0];
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return Number(value ?? 0);
}

/** One page of a table or view, with the unpaged total row count. */
export function browseTable(
  sqlite3: Sqlite3Static,
  db: Database,
  table: string,
  page: BrowsePage = {},
): TablePage {
  if (table.trim().length === 0) throw new Error("A table name is required.");
  const limit = normalizeLimit(page.limit);
  const offset = normalizeOffset(page.offset);
  const ident = quoteIdent(table);

  const count = executeScript(sqlite3, db, `SELECT count(*) FROM ${ident};`);
  const totalRows = firstValue(count);

  const rowsResult = executeScript(
    sqlite3,
    db,
    `SELECT * FROM ${ident} LIMIT ${limit} OFFSET ${offset};`,
    {
      maxRows: limit,
    },
  );
  if (rowsResult.statements.length !== 1) throw new Error("Unexpected table page result");
  const statement = rowsResult.statements[0];
  if (statement.kind === "error") throw new Error(statement.error.message);
  if (statement.kind !== "rows") throw new Error("Table browse did not return rows.");

  return {
    table,
    columns: statement.columns,
    rows: statement.rows,
    totalRows,
    limit,
    offset,
  };
}
