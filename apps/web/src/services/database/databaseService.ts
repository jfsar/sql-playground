/**
 * Database Service (plan §5.3): the application-facing facade over the
 * Worker Manager (execution) and the Storage Service (lifecycle).
 *
 * `startup()` is the Week 3 foundation entry point: it initializes the worker,
 * reconciles metadata against pool files, guarantees at least one usable
 * database, and opens the most recently used one. The promise is cached so
 * React StrictMode's double mount cannot run startup twice.
 */

import type {
  DatabaseInfo,
  ExecutionResponse,
  QueryPlan,
  WorkerStatus,
} from "../../shared/contracts";
import { dbFileName } from "../storage/reconcile";
import type { StorageService } from "../storage/storageService";

export const DEFAULT_DATABASE_NAME = "My database";

/** The Worker Manager surface this service uses (structurally satisfied). */
export interface DatabaseBackend {
  init(): Promise<WorkerStatus>;
  status(): Promise<WorkerStatus>;
  execute(sql: string, opts?: { maxRows?: number }): Promise<ExecutionResponse>;
  explain(sql: string): Promise<QueryPlan>;
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
}
