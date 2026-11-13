/** Typed contracts from FINAL_PROJECT_PLAN.md §5.3. */

/** No information loss across the worker boundary. */
export type SqlValue = null | number | bigint | string | Uint8Array;

export interface StatementSpan {
  start: number;
  end: number;
  text: string;
}

export interface ColumnInfo {
  name: string;
  declaredType?: string;
}

export type StatementResult =
  | {
      kind: "rows";
      sql: string;
      columns: ColumnInfo[];
      rows: SqlValue[][];
      truncated: boolean;
      engineMs: number;
    }
  | {
      kind: "change";
      sql: string;
      /** DML only (INSERT, UPDATE, DELETE, REPLACE). */
      rowsAffected?: number;
      lastInsertRowId?: bigint;
      engineMs: number;
    }
  | {
      kind: "error";
      sql: string;
      error: DbError;
      span: StatementSpan;
    };

export interface ExecutionResponse {
  /** In order; stops after first error. */
  statements: StatementResult[];
  /** Real SQLite autocommit state: true = not in a transaction. */
  inTransaction: boolean;
  /** True if SQLite ended the transaction itself after an error. */
  rolledBackBySqlite?: boolean;
  totalEngineMs: number;
}

export interface DbError {
  code:
    | "SQL_ERROR"
    | "CONSTRAINT"
    | "CANCELLED"
    | "IO"
    | "QUOTA"
    | "POLICY_BLOCKED"
    | "UNSUPPORTED_FILE"
    | "CORRUPT_FILE"
    | "LOCKED_BY_OTHER_TAB"
    | "WORKER_CRASHED"
    | "STORAGE_UNAVAILABLE";
  message: string;
  sqliteCode?: number;
  /** Error position in statement, if SQLite reports it (UTF-8 byte offset). */
  offset?: number;
}

export type DatabaseStatus = "ok" | "missing-file" | "recovered";

export interface DatabaseInfo {
  id: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
  sizeBytes: number;
  status: DatabaseStatus;
}

export interface WorkerStatus {
  sqliteVersion: string;
  /** True when databases live in OPFS (opfs-sahpool), false for in-memory fallback. */
  persistent: boolean;
  filename: string;
  vfsName: string | null;
  poolCapacity: number | null;
  poolFileCount: number | null;
}

export const DEFAULT_MAX_ROWS = 1000;
