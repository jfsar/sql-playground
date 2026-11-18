/**
 * Schema introspection for the explorer (FINAL_PROJECT_PLAN Week 5).
 *
 * Tables and views come from `sqlite_master`; column, index, and foreign-key
 * details come from SQLite's table-valued PRAGMA functions with bound names
 * (no string interpolation). CHECK constraints are not exposed by any PRAGMA,
 * so they are parsed from the preserved CREATE statement.
 */

import type { Database } from "@sqlite.org/sqlite-wasm";
import type {
  ColumnSchema,
  DatabaseSchema,
  ForeignKeySchema,
  IndexOrigin,
  IndexSchema,
  TableSchema,
} from "../../shared/contracts";

type Row = Record<string, unknown>;
type BindValue = string | number | null;

function pickString(value: unknown): string {
  return typeof value === "string"
    ? value
    : value === null || value === undefined
      ? ""
      : String(value);
}

function pickNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : pickString(value);
}

function selectRows(db: Database, sql: string, bind?: BindValue[]): Row[] {
  return db.selectObjects(sql, bind) as unknown as Row[];
}

function readColumns(db: Database, table: string): ColumnSchema[] {
  return selectRows(db, "SELECT * FROM pragma_table_info(?)", [table]).map((row) => ({
    name: pickString(row.name),
    declaredType: pickString(row.type),
    notNull: pickNumber(row.notnull) !== 0,
    defaultValue: pickNullableString(row.dflt_value),
    primaryKey: pickNumber(row.pk) > 0,
    primaryKeyOrder: pickNumber(row.pk),
  }));
}

function readIndexes(db: Database, table: string): IndexSchema[] {
  return selectRows(db, "SELECT * FROM pragma_index_list(?)", [table]).map((row) => {
    const name = pickString(row.name);
    const originText = pickString(row.origin);
    const origin: IndexOrigin =
      originText === "c" || originText === "u" || originText === "pk" ? originText : "unknown";
    const columns = selectRows(db, "SELECT * FROM pragma_index_info(?)", [name])
      .sort((a, b) => pickNumber(a.seqno) - pickNumber(b.seqno))
      .map((info) => pickNullableString(info.name))
      .filter((column): column is string => column !== null);
    return {
      name,
      unique: pickNumber(row.unique) !== 0,
      origin,
      partial: pickNumber(row.partial) !== 0,
      columns,
    };
  });
}

function readForeignKeys(db: Database, table: string): ForeignKeySchema[] {
  return selectRows(db, "SELECT * FROM pragma_foreign_key_list(?)", [table]).map((row) => ({
    id: pickNumber(row.id),
    from: pickString(row.from),
    table: pickString(row.table),
    to: pickNullableString(row.to),
    onUpdate: pickString(row.on_update),
    onDelete: pickString(row.on_delete),
  }));
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      // SQL escapes a quote inside a quoted token by doubling it.
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

function skipBracket(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "]") {
      if (sql[i + 1] === "]") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

function skipLineComment(sql: string, start: number): number {
  const end = sql.indexOf("\n", start + 2);
  return end === -1 ? sql.length : end + 1;
}

function skipBlockComment(sql: string, start: number): number {
  const end = sql.indexOf("*/", start + 2);
  return end === -1 ? sql.length : end + 2;
}

function skipTrivia(sql: string, start: number): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      i = skipLineComment(sql, i);
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i);
      continue;
    }
    break;
  }
  return i;
}

/** Index just past the matching `)`, or -1 when unbalanced. */
function matchingParen(sql: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracket(sql, i);
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      i = skipLineComment(sql, i);
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i);
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/**
 * CHECK expressions from a CREATE TABLE statement, each including its outer
 * parentheses. Quoted strings, `[...]` identifiers, and comments are skipped so
 * the word CHECK inside them is not mistaken for a constraint.
 */
export function extractCheckConstraints(sql: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracket(sql, i);
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      i = skipLineComment(sql, i);
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      if (sql.slice(i, end).toUpperCase() === "CHECK") {
        const open = skipTrivia(sql, end);
        if (sql[open] === "(") {
          const after = matchingParen(sql, open);
          if (after !== -1) {
            found.push(sql.slice(open, after).trim());
            i = after;
            continue;
          }
        }
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return found;
}

function buildTable(
  db: Database,
  master: { name: string; type: string; sql: string | null },
): TableSchema {
  const isVirtual = /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(master.sql ?? "");
  return {
    name: master.name,
    type: master.type === "view" ? "view" : isVirtual ? "virtual" : "table",
    columns: readColumns(db, master.name),
    foreignKeys: master.type === "view" ? [] : readForeignKeys(db, master.name),
    indexes: master.type === "view" ? [] : readIndexes(db, master.name),
    checkConstraints:
      master.type === "view" || !master.sql ? [] : extractCheckConstraints(master.sql),
    sql: master.sql,
  };
}

/** Read the complete schema of the active database. */
export function readSchema(db: Database): DatabaseSchema {
  const master = selectRows(
    db,
    `SELECT name, type, sql FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name COLLATE NOCASE`,
  ).map((row) => ({
    name: pickString(row.name),
    type: pickString(row.type),
    sql: pickNullableString(row.sql),
  }));

  const tables: TableSchema[] = [];
  const views: TableSchema[] = [];
  for (const entry of master) {
    const table = buildTable(db, entry);
    if (table.type === "view") views.push(table);
    else tables.push(table);
  }
  return { tables, views };
}
