/**
 * Database Service (plan §5.3): the application-facing facade over the
 * Worker Manager (execution) and the Storage Service (lifecycle).
 *
 * `startup()` is the Week 3 foundation entry point: it initializes the worker,
 * reconciles metadata against pool files, guarantees at least one usable
 * database, and opens the most recently used one. The promise is cached so
 * React StrictMode's double mount cannot run startup twice.
 */

import {
  MAX_TABLE_PAGE_SIZE,
  TABLE_PAGE_SIZE,
  type DatabaseInfo,
  type DatabaseSchema,
  type ExecutionResponse,
  type QueryPlan,
  type ScriptImportResult,
  type SqliteImportResult,
  type TablePage,
  type WorkerStatus,
} from "../../shared/contracts";
import { DbOperationError } from "../../shared/errors";
import { assessImportQuota, inspectImportFile, readSqlText } from "./importValidation";
import { dbFileName } from "../storage/reconcile";
import type { StorageInfo } from "../storage/quota";
import type { StorageService } from "../storage/storageService";
import { SAMPLE_DATABASE_NAME, SAMPLE_SCHEMA_SQL } from "./sampleDatabase";

export const DEFAULT_DATABASE_NAME = "My database";

/** The Worker Manager surface this service uses (structurally satisfied). */
export interface DatabaseBackend {
  init(): Promise<WorkerStatus>;
  status(): Promise<WorkerStatus>;
  execute(sql: string, opts?: { maxRows?: number; requestId?: string }): Promise<ExecutionResponse>;
  cancel(requestId: string): Promise<void>;
  explain(sql: string): Promise<QueryPlan>;
  getSchema(): Promise<DatabaseSchema>;
  browseTable(table: string, page: { limit: number; offset: number }): Promise<TablePage>;
  importDb(filename: string, bytes: ArrayBuffer): Promise<SqliteImportResult>;
  exportFile(filename: string): Promise<{ bytes: Uint8Array; name: string }>;
  openFile(filename: string): Promise<number>;
  deleteFile(filename: string): Promise<{ existed: boolean }>;
}

export interface ImportDatabaseOptions {
  name?: string;
  storageInfo?: StorageInfo;
  now?: number;
}

export interface ImportScriptOptions {
  targetId?: string;
  name?: string;
}

function databaseNameFromFile(fileName: string): string {
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return base.length > 0 ? base : "Imported database";
}

async function restoreActiveDatabase(
  backend: DatabaseBackend,
  filename: string | null,
): Promise<void> {
  if (!filename) return;
  try {
    await backend.openFile(filename);
  } catch {
    // Startup reconciliation/schema refresh will surface the failure.
  }
}

export interface StartupResult {
  status: WorkerStatus;
  databases: DatabaseInfo[];
  activeId: string | null;
}

export interface DatabaseServiceOptions {
  backend: DatabaseBackend;
  storage: StorageService;
}

export class DatabaseService {
  private readonly backend: DatabaseBackend;
  private readonly storage: StorageService;
  private startupPromise: Promise<StartupResult> | null = null;

  constructor(options: DatabaseServiceOptions) {
    this.backend = options.backend;
    this.storage = options.storage;
  }

  /**
   * Init worker → reconcile → ensure a database exists → open the most
   * recently used one. Cached: subsequent calls share the same run.
   */
  startup(): Promise<StartupResult> {
    if (!this.startupPromise) {
      this.startupPromise = this.doStartup().catch((err: unknown) => {
        // Allow a retry (e.g. after the user fixes storage permissions).
        this.startupPromise = null;
        throw err;
      });
    }
    return this.startupPromise;
  }

  private async doStartup(): Promise<StartupResult> {
    const status = await this.backend.init();
    await this.storage.reconcile(status.persistent);

    let list = await this.storage.listDatabases();
    let active: DatabaseInfo | undefined;

    if (list.length === 0) {
      // First run: a ready-to-use database so the app is never empty.
      active = await this.storage.createDatabase(DEFAULT_DATABASE_NAME);
      list = await this.storage.listDatabases();
    } else {
      // Prefer live entries; recovered orphans are usable too (opening one
      // promotes it to `ok`). Missing-file entries are never opened — that
      // would silently recreate an empty file.
      const candidates = list.filter((d) => d.status === "ok" || d.status === "recovered");
      active = candidates.reduce<DatabaseInfo | undefined>(
        (best, d) => (!best || d.lastOpenedAt > best.lastOpenedAt ? d : best),
        undefined,
      );
      if (!active) {
        active = await this.storage.createDatabase(DEFAULT_DATABASE_NAME);
      } else if (this.storage.activeFile !== dbFileName(active.id)) {
        active = await this.storage.openDatabase(active.id);
      }
      list = await this.storage.listDatabases();
    }

    // Re-read status so the UI reflects the opened file (filename, journal
    // mode, pool counts) rather than the pre-open init snapshot.
    const finalStatus = await this.backend.status();
    return { status: finalStatus, databases: list, activeId: active?.id ?? null };
  }

  listDatabases(): Promise<DatabaseInfo[]> {
    return this.storage.listDatabases();
  }

  createDatabase(name: string): Promise<DatabaseInfo> {
    return this.storage.createDatabase(name);
  }

  /**
   * Create a fresh database and populate it by running the bundled script
   * through the execution contract (plan §7 Week 5). Any failing statement
   * rolls the new database back so the list never keeps a half-built sample.
   */
  async createSampleDatabase(): Promise<DatabaseInfo> {
    const info = await this.storage.createDatabase(SAMPLE_DATABASE_NAME, { sample: true });
    try {
      const response = await this.backend.execute(SAMPLE_SCHEMA_SQL);
      const failure = response.statements.find((statement) => statement.kind === "error");
      if (failure && failure.kind === "error") {
        throw new DbOperationError(failure.error.code, failure.error.message);
      }
      // Reopen so sizeBytes/lastOpenedAt reflect the populated file.
      return await this.storage.openDatabase(info.id);
    } catch (err) {
      try {
        await this.deleteDatabase(info.id);
      } catch (cleanupErr) {
        console.warn("[sample] could not roll back the failed sample database:", cleanupErr);
      }
      throw err;
    }
  }

  openDatabase(id: string): Promise<DatabaseInfo> {
    return this.storage.openDatabase(id);
  }

  renameDatabase(id: string, name: string): Promise<void> {
    return this.storage.renameDatabase(id, name);
  }

  /**
   * Delete with the active-database fallback: if the removed database was
   * open, switch to another one (or create a fresh default) so execution
   * never points at a deleted file.
   */
  async deleteDatabase(id: string): Promise<void> {
    const wasActive = this.storage.activeFile === dbFileName(id);
    await this.storage.deleteDatabase(id);
    if (!wasActive) return;

    const remaining = await this.storage.listDatabases();
    const next = remaining.find((d) => d.status === "ok");
    if (next) {
      await this.storage.openDatabase(next.id);
    } else {
      await this.storage.createDatabase(DEFAULT_DATABASE_NAME);
    }
  }

  execute(
    sql: string,
    opts?: { maxRows?: number; requestId?: string },
  ): Promise<ExecutionResponse> {
    return this.backend.execute(sql, opts);
  }

  /** Per-request cancellation (plan §5.3, ADR-004). */
  cancel(requestId: string): Promise<void> {
    return this.backend.cancel(requestId);
  }

  /** Validate, stage, quick-check, then register a new imported database. */
  async importDatabase(file: File, opts: ImportDatabaseOptions = {}): Promise<DatabaseInfo> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const report = inspectImportFile(file.name, bytes);
    if (!report.ok) {
      const error = report.error;
      throw new DbOperationError(
        error?.code ?? "CORRUPT_FILE",
        error?.message ?? "The selected file could not be validated.",
      );
    }
    if (report.kind !== "sqlite") {
      throw new DbOperationError(
        "UNSUPPORTED_FILE",
        "This is a SQL script. Choose a SQLite database file or use the script import option.",
      );
    }

    const quota = opts.storageInfo ? assessImportQuota(report.sizeBytes, opts.storageInfo) : null;
    if (quota && !quota.ok) {
      throw new DbOperationError("QUOTA", quota.message ?? undefined);
    }

    const previous = this.storage.activeFile;
    const id = crypto.randomUUID();
    const filename = dbFileName(id);
    const now = opts.now ?? Date.now();

    try {
      const result = await this.backend.importDb(filename, bytes.buffer as ArrayBuffer);
      const info: DatabaseInfo = {
        id,
        name: opts.name?.trim() || databaseNameFromFile(file.name),
        createdAt: now,
        lastOpenedAt: now,
        sizeBytes: result.sizeBytes,
        status: "ok",
      };
      await this.storage.registerImportedDatabase(info);
      return info;
    } catch (err) {
      try {
        await this.backend.deleteFile(filename);
      } catch {
        // The next reconciliation adopts or ignores the orphan file.
      }
      await restoreActiveDatabase(this.backend, previous);
      throw err;
    }
  }

  /** Import a `.sql` script into a new or existing database (plan §5.5). */
  async importScript(file: File, opts: ImportScriptOptions = {}): Promise<ScriptImportResult> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const report = inspectImportFile(file.name, bytes);
    if (!report.ok) {
      const error = report.error;
      throw new DbOperationError(
        error?.code ?? "UNSUPPORTED_FILE",
        error?.message ?? "The selected script could not be validated.",
      );
    }
    if (report.kind !== "sql") {
      throw new DbOperationError(
        "UNSUPPORTED_FILE",
        "This is a SQLite database file, not a SQL script.",
      );
    }

    const sql = readSqlText(bytes);
    if (sql === null) {
      throw new DbOperationError("UNSUPPORTED_FILE", "The script is not valid UTF-8 text.");
    }

    if (opts.targetId) {
      const target = await this.storage.openDatabase(opts.targetId);
      const response = await this.backend.execute(sql);
      const refreshed = await this.refreshDatabaseSize(target.id).catch(() => target);
      return { response, database: refreshed, rolledBack: false };
    }

    const previous = this.storage.activeFile;
    const info = await this.storage.createDatabase(
      opts.name?.trim() || databaseNameFromFile(file.name),
    );
    let response: ExecutionResponse;
    try {
      response = await this.backend.execute(sql);
    } catch (err) {
      try {
        await this.storage.deleteDatabase(info.id);
      } catch {
        // Reconciliation cleans up a file that could not be removed here.
      }
      await restoreActiveDatabase(this.backend, previous);
      throw err;
    }
    const failed = response.statements.some((statement) => statement.kind === "error");

    if (failed) {
      let rolledBack: boolean;
      try {
        await this.storage.deleteDatabase(info.id);
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
      await restoreActiveDatabase(this.backend, previous);
      return { response, database: rolledBack ? null : info, rolledBack };
    }

    const refreshed = await this.refreshDatabaseSize(info.id).catch(() => info);
    return { response, database: refreshed, rolledBack: false };
  }

  /** Export one database file as a blob (plan §5.3). */
  async exportDatabase(id: string): Promise<Blob> {
    const entries = await this.storage.listDatabases();
    if (!entries.some((entry) => entry.id === id)) {
      throw new DbOperationError(
        "STORAGE_UNAVAILABLE",
        "Database not found; it may have been removed.",
      );
    }
    const { bytes } = await this.backend.exportFile(dbFileName(id));
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Blob([buffer], { type: "application/vnd.sqlite3" });
  }

  private async refreshDatabaseSize(id: string): Promise<DatabaseInfo> {
    return this.storage.openDatabase(id);
  }

  explain(sql: string): Promise<QueryPlan> {
    return this.backend.explain(sql);
  }

  /** Tables, views, columns, constraints, and indexes of the active database. */
  getSchema(): Promise<DatabaseSchema> {
    return this.backend.getSchema();
  }

  /** One LIMIT/OFFSET page of a table or view. */
  browseTable(table: string, page: { limit?: number; offset?: number } = {}): Promise<TablePage> {
    const requested = page.limit ?? TABLE_PAGE_SIZE;
    const limit = Math.min(
      MAX_TABLE_PAGE_SIZE,
      Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : TABLE_PAGE_SIZE),
    );
    const requestedOffset = page.offset ?? 0;
    const offset = Math.max(0, Number.isFinite(requestedOffset) ? Math.trunc(requestedOffset) : 0);
    return this.backend.browseTable(table, { limit, offset });
  }
}
