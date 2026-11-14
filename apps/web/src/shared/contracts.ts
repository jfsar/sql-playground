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

/** Plan toolkit contracts (plan §4) — Rust behind this, TS fallback. */

export interface RawPlanRow {
  id: number;
  parent: number;
  detail: string;
}

export type PlanOperation = "SCAN" | "SEARCH" | "OTHER";

export interface QueryPlanNode {
  id: number;
  /** As reported by SQLite; 0 = root. */
  parentId: number;
  operation: PlanOperation;
  table?: string;
  index?: string;
  /** e.g. "COVERING INDEX", "AUTOMATIC INDEX", "TEMP B-TREE". */
  tags: string[];
  /** Raw SQLite text, always preserved. */
  detail: string;
}

export interface QueryPlan {
  nodes: QueryPlanNode[];
  raw: RawPlanRow[];
  sqliteVersion: string;
}

export interface PlanDiff {
  added: QueryPlanNode[];
  removed: QueryPlanNode[];
  changed: { before: QueryPlanNode; after: QueryPlanNode }[];
}

export interface WorkerStatus {
  sqliteVersion: string;
  /** True when databases live in OPFS (opfs-sahpool), false for in-memory fallback. */
  persistent: boolean;
  filename: string;
  vfsName: string | null;
  poolCapacity: number | null;
  poolFileCount: number | null;
  /** Which PlanToolkit implementation loaded (ADR-002 gate). */
  toolkit: "rust" | "typescript";
  /** Live SQLite journal mode (ADR-001 PoC check). */
  journalMode: string;
}

export const DEFAULT_MAX_ROWS = 1000;
