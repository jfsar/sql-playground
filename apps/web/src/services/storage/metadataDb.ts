/**
 * App metadata store (plan §4): IndexedDB via `idb`, schema version 1 with
 * object stores `databases`, `history`, and `preferences`. Every schema change
 * must increment the version and ship a migration that never deletes user
 * databases or history without confirmation.
 *
 * Database *files* live in the OPFS pool; this store holds the list, display
 * names, and status that reconciliation compares against files (plan §5.6).
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { DatabaseInfo } from "../../shared/contracts";

export const METADATA_DB_NAME = "sql-playground";
export const METADATA_DB_VERSION = 1;

/** One query-history entry (written by the history feature, Week 5). */
export interface HistoryEntry {
  sql: string;
  at: number;
  ok: boolean;
  engineMs?: number;
}

interface MetadataDbSchema extends DBSchema {
  databases: {
    key: string;
    value: DatabaseInfo;
  };
  history: {
    key: number;
    value: HistoryEntry;
  };
  preferences: {
    key: string;
    value: { key: string; value: unknown };
  };
}

/** Persistence port used by the Storage Service; faked in unit tests. */
export interface MetadataStore {
  listDatabases(): Promise<DatabaseInfo[]>;
  putDatabase(info: DatabaseInfo): Promise<void>;
  deleteDatabase(id: string): Promise<void>;
}

let dbPromise: Promise<IDBPDatabase<MetadataDbSchema>> | null = null;

function openMetadataDb(): Promise<IDBPDatabase<MetadataDbSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<MetadataDbSchema>(METADATA_DB_NAME, METADATA_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("databases")) {
          db.createObjectStore("databases", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("history")) {
          db.createObjectStore("history", { autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("preferences")) {
          db.createObjectStore("preferences", { keyPath: "key" });
        }
      },
    }).catch((err: unknown) => {
      dbPromise = null; // allow retry after a failed open
      throw err;
    });
  }
  return dbPromise;
}

export function createIdbMetadataStore(): MetadataStore {
  return {
    async listDatabases() {
      const db = await openMetadataDb();
      return db.getAll("databases");
    },
    async putDatabase(info) {
      const db = await openMetadataDb();
      await db.put("databases", info);
    },
    async deleteDatabase(id) {
      const db = await openMetadataDb();
      await db.delete("databases", id);
    },
  };
}

/** In-memory store for unit tests (and a reference for the port's semantics). */
export function createMemoryMetadataStore(
  seed: DatabaseInfo[] = [],
): MetadataStore & { readonly rows: Map<string, DatabaseInfo> } {
  const rows = new Map<string, DatabaseInfo>(seed.map((d) => [d.id, d]));
  return {
    rows,
    async listDatabases() {
      return [...rows.values()].map((d) => ({ ...d }));
    },
    async putDatabase(info) {
      rows.set(info.id, { ...info });
    },
    async deleteDatabase(id) {
      rows.delete(id);
    },
  };
}

/** Test hook: close and forget the cached connection. */
export async function resetMetadataDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    db?.close();
  }
  dbPromise = null;
}
