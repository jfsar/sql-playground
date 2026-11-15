/**
 * Storage Service (plan §7 Week 3, §5.6): database lifecycle over the
 * IndexedDB metadata store and the worker's OPFS pool.
 *
 * - `createDatabase` writes metadata first, then creates the pool file
 *   (metadata is rolled back if file creation fails, so no phantom entries).
 * - `deleteDatabase` is two-phase: mark `deleting` → unlink file → remove the
 *   entry. An interrupted delete is completed by `reconcile` on next startup.
 * - `renameDatabase` is metadata-only (files are named by stable id).
 * - `reconcile` compares files against metadata and repairs drift (ADR-005).
 */

import type { DatabaseInfo } from "../../shared/contracts";
import { DbOperationError } from "../../shared/errors";
import type { MetadataStore } from "./metadataDb";
import { dbFileName, reconcile, type ReconcileResult } from "./reconcile";

/** The subset of the Worker Manager the storage layer needs (plan §5.6). */
export interface StorageWorker {
  /** Pool file the worker currently has open, or null. */
  readonly activeFilename: string | null;
  listFiles(): Promise<string[]>;
  deleteFile(filename: string): Promise<{ existed: boolean }>;
  /** Opens (creating if needed) and activates the file; resolves to its size. */
  openFile(filename: string): Promise<number>;
}

export interface StorageServiceOptions {
  store: MetadataStore;
  worker: StorageWorker;
  now?: () => number;
}

export interface ReconcileReport extends ReconcileResult {
  /** Full, current database list after repairs were applied. */
  databases: DatabaseInfo[];
}

export class StorageService {
  private readonly store: MetadataStore;
  private readonly worker: StorageWorker;
  private readonly now: () => number;

  constructor(options: StorageServiceOptions) {
    this.store = options.store;
    this.worker = options.worker;
    this.now = options.now ?? (() => Date.now());
  }

  /** Pool file currently open (mirrors the worker). */
  get activeFile(): string | null {
    return this.worker.activeFilename;
  }

  /**
   * Complete interrupted deletes, flag missing files, adopt orphan files as
   * "Recovered database" entries (plan §5.6 / acceptance scenario 24).
   * Logged locally only — never transmitted (NFR-01).
   */
  async reconcile(persistent: boolean): Promise<ReconcileReport> {
    const metadata = await this.store.listDatabases();
    const files = persistent ? await this.worker.listFiles() : [];
    const result = reconcile({ metadata, files, persistent, now: this.now() });

    for (const entry of result.changed) {
      await this.store.putDatabase(entry);
    }

    const needsFileDelete = new Set(result.filesToDelete);
    for (const id of result.removedIds) {
      const filename = dbFileName(id);
      if (needsFileDelete.has(filename)) {
        try {
          await this.worker.deleteFile(filename);
        } catch (err) {
          // Keep the `deleting` marker; the next reconcile retries the file.
          console.warn("[storage] could not finish delete; retrying on next load:", err);
          continue;
        }
      }
      await this.store.deleteDatabase(id);
    }

    console.info("[storage] reconciliation", {
      persistent,
      recovered: result.recoveredIds.length,
      missing: result.missingIds.length,
      completedDeletes: result.removedIds.length,
      ignoredFiles: result.ignoredFiles.length,
    });

    return { ...result, databases: await this.store.listDatabases() };
  }

  /** All databases except entries mid-delete (they are disappearing). */
  async listDatabases(): Promise<DatabaseInfo[]> {
    const all = await this.store.listDatabases();
    return all.filter((d) => d.status !== "deleting");
  }

  /**
   * Create a database entry and its pool file, then open it — a newly created
   * database becomes the active connection (the natural "New database" flow).
   */
  async createDatabase(name: string): Promise<DatabaseInfo> {
    const trimmed = name.trim();
    const info: DatabaseInfo = {
      id: crypto.randomUUID(),
      name: trimmed.length > 0 ? trimmed : "Untitled database",
      createdAt: this.now(),
      lastOpenedAt: this.now(),
      sizeBytes: 0,
      status: "ok",
    };
    await this.store.putDatabase(info);
    try {
      info.sizeBytes = await this.worker.openFile(dbFileName(info.id));
    } catch (err) {
      // Roll back so a failed create leaves no phantom metadata behind.
      await this.store.deleteDatabase(info.id);
      throw err;
    }
    await this.store.putDatabase(info);
    return info;
  }

  /**
   * Open an existing database (closes the previous connection first — the
   * worker enforces one connection at a time, ADR-001).
   */
  async openDatabase(id: string): Promise<DatabaseInfo> {
    const entry = await this.requireEntry(id);
    if (entry.status === "deleting") {
      throw new DbOperationError("STORAGE_UNAVAILABLE", "That database is being removed.");
    }
    if (entry.status === "missing-file") {
      // Opening would silently recreate an empty file — refuse instead.
      throw new DbOperationError(
        "STORAGE_UNAVAILABLE",
        `"${entry.name}" has no stored file. Remove the entry or import the database again.`,
      );
    }
    const sizeBytes = await this.worker.openFile(dbFileName(id));
    const updated: DatabaseInfo = {
      ...entry,
      lastOpenedAt: this.now(),
      sizeBytes,
      status: "ok",
    };
    await this.store.putDatabase(updated);
    return updated;
  }

  /** Display-name change only; the pool file name is derived from the id. */
  async renameDatabase(id: string, name: string): Promise<void> {
    const entry = await this.requireEntry(id);
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    await this.store.putDatabase({ ...entry, name: trimmed });
  }

  /**
   * Two-phase delete (plan §5.6): mark `deleting`, unlink the file, then drop
   * the entry. If the file unlink throws, the marker stays and `reconcile`
   * finishes the job on the next startup.
   */
  async deleteDatabase(id: string): Promise<void> {
    const entry = await this.requireEntry(id);
    await this.store.putDatabase({ ...entry, status: "deleting" });
    try {
      await this.worker.deleteFile(dbFileName(id));
    } catch {
      throw new DbOperationError(
        "IO",
        `Could not remove the stored file for "${entry.name}". It will be removed on the next load.`,
      );
    }
    await this.store.deleteDatabase(id);
  }

  private async requireEntry(id: string): Promise<DatabaseInfo> {
    const all = await this.store.listDatabases();
    const entry = all.find((d) => d.id === id);
    if (!entry) {
      throw new DbOperationError(
        "STORAGE_UNAVAILABLE",
        "Database not found (it may have been removed).",
      );
    }
    return entry;
  }
}
