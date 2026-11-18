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
  type TablePage,
  type WorkerStatus,
} from "../../shared/contracts";
import { DbOperationError } from "../../shared/errors";
import { dbFileName } from "../storage/reconcile";
import type { StorageService } from "../storage/storageService";
import { SAMPLE_DATABASE_NAME, SAMPLE_SCHEMA_SQL } from "./sampleDatabase";

export const DEFAULT_DATABASE_NAME = "My database";

/** The Worker Manager surface this service uses (structurally satisfied). */
export interface DatabaseBackend {
  init(): Promise<WorkerStatus>;
  status(): Promise<WorkerStatus>;
  execute(sql: string, opts?: { maxRows?: number }): Promise<ExecutionResponse>;
  explain(sql: string): Promise<QueryPlan>;
  getSchema(): Promise<DatabaseSchema>;
  browseTable(table: string, page: { limit: number; offset: number }): Promise<TablePage>;
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

  execute(sql: string, opts?: { maxRows?: number }): Promise<ExecutionResponse> {
    return this.backend.execute(sql, opts);
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
