import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { createIdbHistoryStore, METADATA_DB_NAME, resetMetadataDbForTests } from "./metadataDb";

function deleteMetadataDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(METADATA_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("delete blocked"));
  });
}

afterEach(async () => {
  await resetMetadataDbForTests();
  await deleteMetadataDb();
});

describe("IndexedDB query history store", () => {
  it("stores entries newest-first and trims the oldest", async () => {
    const store = createIdbHistoryStore();
    for (let i = 1; i <= 4; i += 1) {
      await store.add({ sql: `SELECT ${i};`, at: i, ok: i % 2 === 0 });
    }
    expect(await store.count()).toBe(4);
    expect((await store.list()).map((entry) => entry.sql)).toEqual([
      "SELECT 4;",
      "SELECT 3;",
      "SELECT 2;",
      "SELECT 1;",
    ]);
    expect((await store.list(2)).map((entry) => entry.sql)).toEqual(["SELECT 4;", "SELECT 3;"]);

    await store.trim(2);
    expect(await store.count()).toBe(2);
    expect((await store.list()).map((entry) => entry.sql)).toEqual(["SELECT 4;", "SELECT 3;"]);
  });

  it("round-trips preferences and clears history", async () => {
    const store = createIdbHistoryStore();
    expect(await store.getPreference<boolean>("history.enabled")).toBeUndefined();
    await store.setPreference("history.enabled", false);
    expect(await store.getPreference<boolean>("history.enabled")).toBe(false);

    await store.add({ sql: "SELECT 1;", at: 1, ok: true });
    await store.clear();
    expect(await store.count()).toBe(0);
  });
});
