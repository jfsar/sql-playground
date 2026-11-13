import type {
  DbError,
  ExecutionResponse,
  SqlValue,
  StatementResult,
  StatementSpan,
} from "../../shared/contracts";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { checkPolicy, isDmlKeyword, leadingKeyword } from "./policy";

export interface ExecuteOptions {
  maxRows?: number;
}

function classifySqliteRc(sqlite3: Sqlite3Static, rc: number): DbError["code"] {
  const base = rc & 0xff;
  const capi = sqlite3.capi;
  if (base === capi.SQLITE_CONSTRAINT) return "CONSTRAINT";
  if (base === capi.SQLITE_IOERR) return "IO";
  if (base === capi.SQLITE_FULL || base === capi.SQLITE_CANTOPEN) return "QUOTA";
  if (base === capi.SQLITE_CORRUPT || base === capi.SQLITE_NOTADB) return "CORRUPT_FILE";
  return "SQL_ERROR";
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function dbPtr(db: Database): number {
  if (db.pointer === undefined) throw new Error("Database connection is closed");
  return db.pointer;
}

/** Coerce sqlite3_column_js output into our SqlValue (Uint8Array-only). */
function toSqlValue(
  v: string | number | null | bigint | Uint8Array | Int8Array | ArrayBuffer | undefined,
): SqlValue {
  if (v === undefined || v === null) return null;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v instanceof Int8Array) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return v;
}

/**
 * Convert a UTF-8 byte offset in `sql` to a JS string index (UTF-16 code units).
 * Mid-character offsets map to the character that contains them.
 */
export function byteOffsetToJsIndex(sql: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const code = sql.charCodeAt(i);
    let charBytes: number;
    if (code < 0x80) charBytes = 1;
    else if (code < 0x800) charBytes = 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < sql.length) {
      charBytes = 4;
      // Surrogate pair: treat as one unit for offset math, advance past low surrogate.
      if (byteOffset < bytes + charBytes) return i;
      bytes += charBytes;
      i += 1;
      continue;
    } else charBytes = 3;

    if (byteOffset < bytes + charBytes) return i;
    bytes += charBytes;
  }
  return sql.length;
}

function spanFor(sql: string, startByte: number, endByte: number): StatementSpan {
  const start = byteOffsetToJsIndex(sql, startByte);
  const end = byteOffsetToJsIndex(sql, endByte);
  return { start, end, text: sql.slice(start, end) };
}

function collectColumns(sqlite3: Sqlite3Static, pStmt: number) {
  const capi = sqlite3.capi;
  const count = capi.sqlite3_column_count(pStmt);
  const columns: { name: string; declaredType?: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = capi.sqlite3_column_name(pStmt, i);
    const declared = capi.sqlite3_column_decltype(pStmt, i);
    columns.push(declared ? { name, declaredType: declared } : { name });
  }
  return columns;
}

function readAutocommit(sqlite3: Sqlite3Static, db: Database): boolean {
  // sqlite3_get_autocommit returns non-zero in autocommit mode.
  return sqlite3.capi.sqlite3_get_autocommit(dbPtr(db)) !== 0;
}

function makeError(sqlite3: Sqlite3Static, db: Database, rc: number): DbError {
  const capi = sqlite3.capi;
  const errOffset = capi.sqlite3_error_offset(dbPtr(db));
  return {
    code: classifySqliteRc(sqlite3, rc),
    message: capi.sqlite3_errmsg(dbPtr(db)),
    sqliteCode: capi.sqlite3_extended_errcode(dbPtr(db)),
    offset: errOffset >= 0 ? errOffset : undefined,
  };
}

/**
 * Walk `sql` with SQLite's own prepare loop (prepare one statement, execute,
 * finalize, continue from the remaining tail). Statements are not all prepared
 * up front because later statements can depend on tables created by earlier ones.
 *
 * Returns up to and including the first error; earlier statements keep effects.
 */
export function executeScript(
  sqlite3: Sqlite3Static,
  db: Database,
  sql: string,
  opts: ExecuteOptions = {},
): ExecutionResponse {
  const maxRows = opts.maxRows ?? 1000;
  const capi = sqlite3.capi;
  const wasm = sqlite3.wasm;
  const statements: StatementResult[] = [];
  const pDb = dbPtr(db);

  const inTransactionAtStart = !readAutocommit(sqlite3, db);
  let rolledBackBySqlite = false;
  let sawError = false;

  const totalStart = performance.now();

  const sqlBytes = new TextEncoder().encode(sql);
  // SQLite WASM is wasm32: pointers are 4 bytes. (wasm.ptrSizeof is typed but
  // not always populated on the runtime object.)
  const ptrSize = 4;
  const pSql = wasm.allocFromTypedArray(sqlBytes);
  const ppStmt = wasm.alloc(ptrSize);
  const pzTail = wasm.alloc(ptrSize);

  try {
    let pCur = pSql;
    const pEnd = pSql + sqlBytes.length;

    while (pCur < pEnd && !sawError) {
      wasm.poke(ppStmt, 0, "*");
      wasm.poke(pzTail, 0, "*");
      const remaining = pEnd - pCur;
      const rc = capi.sqlite3_prepare_v3(pDb, pCur, remaining, 0, ppStmt, pzTail);

      if (rc !== capi.SQLITE_OK) {
        const startByte = pCur - pSql;
        const span = spanFor(sql, startByte, Math.min(startByte + remaining, sqlBytes.length));
        statements.push({
          kind: "error",
          sql: span.text,
          error: makeError(sqlite3, db, rc),
          span,
        });
        sawError = true;
        break;
      }

      const pStmt = Number(wasm.peekPtr(ppStmt));
      const pTail = Number(wasm.peekPtr(pzTail));

      if (!pStmt) {
        // Only whitespace/comments remain (or made no progress).
        if (pTail <= pCur) break;
        pCur = pTail;
        continue;
      }

      const stmtStartByte = pCur - pSql;
      const stmtEndByte = pTail - pSql;
      const stmtText = capi.sqlite3_sql(pStmt);
      // sqlite3_sql is a suffix of [pCur, pTail); align start to first token.
      const textBytes = byteLength(stmtText);
      const alignedStart = Math.max(stmtStartByte, stmtEndByte - textBytes);
      const span = spanFor(sql, alignedStart, stmtEndByte);
      const keyword = leadingKeyword(stmtText);

      try {
        const policy = checkPolicy(stmtText);
        if (policy.blocked) {
          statements.push({
            kind: "error",
            sql: stmtText,
            error: { code: "POLICY_BLOCKED", message: policy.message ?? "Statement blocked." },
            span,
          });
          sawError = true;
          break;
        }

        const engineStart = performance.now();
        const columnCount = capi.sqlite3_column_count(pStmt);

        if (columnCount > 0) {
          const columns = collectColumns(sqlite3, pStmt);
          const rows: SqlValue[][] = [];
          let truncated = false;
          let stepRc: number = capi.SQLITE_OK;

          for (;;) {
            stepRc = capi.sqlite3_step(pStmt);
            if (stepRc === capi.SQLITE_ROW) {
              if (rows.length >= maxRows) {
                truncated = true;
                break;
              }
              const row: SqlValue[] = [];
              for (let c = 0; c < columnCount; c += 1) {
                row.push(toSqlValue(capi.sqlite3_column_js(pStmt, c, false)));
              }
              rows.push(row);
              continue;
            }
            if (stepRc === capi.SQLITE_DONE) break;
            break; // error
          }

          const engineMs = performance.now() - engineStart;

          if (stepRc !== capi.SQLITE_ROW && stepRc !== capi.SQLITE_DONE) {
            statements.push({
              kind: "error",
              sql: stmtText,
              error: makeError(sqlite3, db, stepRc),
              span,
            });
            sawError = true;
          } else {
            statements.push({
              kind: "rows",
              sql: stmtText,
              columns,
              rows,
              truncated,
              engineMs,
            });
          }
        } else {
          const engineStart2 = performance.now();
          const stepRc = capi.sqlite3_step(pStmt);
          const engineMs = performance.now() - engineStart2;

          if (stepRc !== capi.SQLITE_DONE && stepRc !== capi.SQLITE_ROW) {
            statements.push({
              kind: "error",
              sql: stmtText,
              error: makeError(sqlite3, db, stepRc),
              span,
            });
            sawError = true;
          } else {
            const change: StatementResult = {
              kind: "change",
              sql: stmtText,
              engineMs,
            };
            if (isDmlKeyword(keyword)) {
              change.rowsAffected = capi.sqlite3_changes(pDb);
              if (keyword === "INSERT" || keyword === "REPLACE") {
                change.lastInsertRowId = capi.sqlite3_last_insert_rowid(pDb);
              }
            }
            statements.push(change);
          }
        }
      } finally {
        capi.sqlite3_finalize(pStmt);
      }

      if (sawError) break;
      if (pTail <= pCur) break;
      pCur = pTail;
    }

    // Rule 6: read real autocommit state after every script (and after errors).
    const inTransactionNow = !readAutocommit(sqlite3, db);
    if (sawError && inTransactionAtStart && !inTransactionNow) {
      rolledBackBySqlite = true;
    }

    return {
      statements,
      inTransaction: inTransactionNow,
      ...(rolledBackBySqlite ? { rolledBackBySqlite: true } : {}),
      totalEngineMs: performance.now() - totalStart,
    };
  } finally {
    wasm.dealloc(pzTail);
    wasm.dealloc(ppStmt);
    wasm.dealloc(pSql);
  }
}
