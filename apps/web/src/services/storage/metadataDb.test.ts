import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseInfo } from "../../shared/contracts";
import {
  createIdbMetadataStore,
  createMemoryMetadataStore,
  METADATA_DB_NAME,
  METADATA_DB_VERSION,
  resetMetadataDbForTests,
} from "./metadataDb";

function clearDatabasesStore(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(METADATA_DB_NAME);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("databases", "readwrite");
      tx.objectStore("databases").clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

afterEach(async () => {
  // fake-indexeddb persists across tests in this file; reset the data too.
  await clearDatabasesStore();
  await resetMetadataDbForTests();
});

function entry(id: string): DatabaseInfo {
  return {
    id,
    name: `db-${id}`,
    createdAt: 1,
    lastOpenedAt: 2,
    sizeBytes: 4096,
    status: "ok",
  };
}

function openRawDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(METADATA_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("IndexedDB metadata store (plan §4 schema v1)", () => {
  it("creates version 1 with databases, history, and preferences stores", async () => {
    const store = createIdbMetadataStore();
    await store.putDatabase(entry("one"));

    const db = await openRawDb();
    try {
      expect(db.version).toBe(METADATA_DB_VERSION);
      expect([...db.objectStoreNames].sort()).toEqual(["databases", "history", "preferences"]);
    } finally {
      db.close();
    }

    const list = await store.listDatabases();
    expect(list).toEqual([entry("one")]);
  });

  it("round-trips put → list → delete", async () => {
    const store = createIdbMetadataStore();
    await store.putDatabase(entry("a"));
    await store.putDatabase(entry("b"));
    expect((await store.listDatabases()).map((d) => d.id).sort()).toEqual(["a", "b"]);

    await store.putDatabase({ ...entry("a"), name: "renamed" });
    const list = await store.listDatabases();
    expect(list.find((d) => d.id === "a")?.name).toBe("renamed");

    await store.deleteDatabase("a");
    expect((await store.listDatabases()).map((d) => d.id)).toEqual(["b"]);
  });

  it("updates an existing row on put (keyed by id)", async () => {
    const store = createIdbMetadataStore();
    await store.putDatabase(entry("x"));
    await store.putDatabase({ ...entry("x"), status: "deleting" });
    const list = await store.listDatabases();
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("deleting");
  });
});

describe("memory metadata store (test double)", () => {
  it("matches the port semantics", async () => {
    const store = createMemoryMetadataStore([entry("seed")]);
    expect(await store.listDatabases()).toHaveLength(1);
    await store.putDatabase(entry("two"));
    await store.deleteDatabase("seed");
    expect((await store.listDatabases()).map((d) => d.id)).toEqual(["two"]);
  });
});
