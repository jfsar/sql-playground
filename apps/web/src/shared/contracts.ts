/** Typed contracts from FINAL_PROJECT_PLAN.md §5.3. */

import type { DbErrorCode } from "./errors";

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
  code: DbErrorCode;
  message: string;
  sqliteCode?: number;
  /** Error position in statement, if SQLite reports it (UTF-8 byte offset). */
  offset?: number;
}

/**
 * `deleting` is the in-progress phase of the two-phase delete (plan §5.6,
 * ADR-005): metadata is marked first, the file is removed next, and the entry
 * is dropped last. Startup reconciliation completes interrupted deletes.
 */
export type DatabaseStatus = "ok" | "missing-file" | "recovered" | "deleting";

export interface DatabaseInfo {
  id: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
  sizeBytes: number;
  status: DatabaseStatus;
  /** Set for databases created by `createSampleDatabase` (drives demo queries). */
  sample?: boolean;
}

/** Schema explorer contracts (plan §7 Week 5). */

export interface ColumnSchema {
  name: string;
  declaredType: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  /** 1-based position within a composite primary key; 0 when not part of it. */
  primaryKeyOrder: number;
}

export interface ForeignKeySchema {
  id: number;
  from: string;
  table: string;
  to: string | null;
  onUpdate: string;
  onDelete: string;
}

export type IndexOrigin = "c" | "u" | "pk" | "unknown";

export interface IndexSchema {
  name: string;
  unique: boolean;
  /** c = CREATE INDEX, u = UNIQUE constraint, pk = PRIMARY KEY. */
  origin: IndexOrigin;
  partial: boolean;
  columns: string[];
}

export interface TableSchema {
  name: string;
  type: "table" | "view" | "virtual";
  columns: ColumnSchema[];
  foreignKeys: ForeignKeySchema[];
  indexes: IndexSchema[];
  /** CHECK expressions parsed from the CREATE statement (best effort). */
  checkConstraints: string[];
  /** Original CREATE statement from sqlite_master, when available. */
  sql: string | null;
}

export interface DatabaseSchema {
  tables: TableSchema[];
  views: TableSchema[];
}

/** One page of table/view data for the explorer's table browser. */
export interface TablePage {
  table: string;
  columns: ColumnInfo[];
  rows: SqlValue[][];
  totalRows: number;
  limit: number;
  offset: number;
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
  /** Pool file currently open, or null when no database is open. */
  filename: string | null;
  vfsName: string | null;
  poolCapacity: number | null;
  poolFileCount: number | null;
  /** Which PlanToolkit implementation loaded (ADR-002 gate). */
  toolkit: "rust" | "typescript";
  /** Live SQLite journal mode (ADR-001 PoC check). */
  journalMode: string;
}

/** Import/export contracts (plan §5.5, §7 Week 6). */

export type ImportKind = "sqlite" | "sql";

export type ImportWarningCode = "WAL_MODE" | "LARGE_FILE" | "VERY_LARGE_FILE" | "EMPTY_SCRIPT";

export interface ImportWarning {
  code: ImportWarningCode;
  message: string;
}

export interface ImportReport {
  kind: ImportKind;
  fileName: string;
  sizeBytes: number;
  /** True when the file can be imported (warnings do not block). */
  ok: boolean;
  /** Present when `ok` is false. */
  error?: DbError;
  pageSize?: number;
  /** Journal mode detected from the file header ("delete", "wal", "unknown"). */
  journalMode?: string;
  warnings: ImportWarning[];
}

/** Result of staging and checking a SQLite database in the worker. */
export interface SqliteImportResult {
  filename: string;
  sizeBytes: number;
  pageSize: number;
  journalMode: string;
  quickCheck: string;
  /** "off" when the hardened probe succeeded, "blocked" when the schema rejected it. */
  trustedSchema: "off" | "blocked" | "unsupported";
  defensiveMode: boolean;
}

export interface ScriptImportResult {
  response: ExecutionResponse;
  /** The target database, or null when a new database was rolled back. */
  database: DatabaseInfo | null;
  rolledBack: boolean;
}

export const DEFAULT_MAX_ROWS = 1000;

/** Table browser page size (plan §7 Week 5: LIMIT/OFFSET paging for MVP). */
export const TABLE_PAGE_SIZE = 50;
export const MAX_TABLE_PAGE_SIZE = 500;

/** Import size policy (plan §5.5). */
export const IMPORT_WARN_BYTES = 100 * 1024 * 1024;
export const IMPORT_STRONG_WARN_BYTES = 250 * 1024 * 1024;
