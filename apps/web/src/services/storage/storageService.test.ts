import { describe, expect, it, vi } from "vitest";
import type { DatabaseInfo } from "../../shared/contracts";
import { DbOperationError } from "../../shared/errors";
import { createMemoryMetadataStore } from "./metadataDb";
import { dbFileName } from "./reconcile";
import { StorageService } from "./storageService";
import { FakeStorageWorker } from "./storageTestSupport";

function makeService(
  worker = new FakeStorageWorker(),
  nowValue = 1000,
): {
  service: StorageService;
  worker: FakeStorageWorker;
  store: ReturnType<typeof createMemoryMetadataStore>;
} {
  const store = createMemoryMetadataStore();
  const service = new StorageService({ store, worker, now: () => nowValue });
  return { service, worker, store };
}

describe("StorageService lifecycle", () => {
  it("createDatabase writes metadata and creates the pool file", async () => {
    const { service, worker, store } = makeService();
    const info = await service.createDatabase("  orders  ");

    expect(info.name).toBe("orders");
    expect(info.status).toBe("ok");
    expect(info.sizeBytes).toBe(8192);
    expect(store.rows.has(info.id)).toBe(true);
    expect(worker.files.has(dbFileName(info.id))).toBe(true);
    expect(worker.activeFilename).toBe(dbFileName(info.id));
  });

  it("createDatabase rolls back metadata when the file cannot be created", async () => {
    const { service, worker, store } = makeService();
    worker.failOpen = true;

    await expect(service.createDatabase("doomed")).rejects.toThrow("cannot open");
    expect(store.rows.size).toBe(0);
    expect(worker.activeFilename).toBeNull();
  });

  it("openDatabase activates the file and refreshes metadata", async () => {
    const { service, worker } = makeService();
    const created = await service.createDatabase("first");
    const second = await service.createDatabase("second");
    expect(worker.activeFilename).toBe(dbFileName(second.id));

    const reopened = await service.openDatabase(created.id);
    expect(worker.activeFilename).toBe(dbFileName(created.id));
    expect(reopened.lastOpenedAt).toBe(1000);
    expect(reopened.sizeBytes).toBe(8192);
  });

  it("openDatabase refuses a missing-file entry instead of recreating it", async () => {
    const store = createMemoryMetadataStore();
    const worker = new FakeStorageWorker();
    const service = new StorageService({ store, worker });
    await store.putDatabase({
      id: "gone",
      name: "Gone",
      createdAt: 1,
      lastOpenedAt: 1,
      sizeBytes: 0,
      status: "missing-file",
    });

    await expect(service.openDatabase("gone")).rejects.toBeInstanceOf(DbOperationError);
    expect(worker.activeFilename).toBeNull();
    expect(store.rows.get("gone")?.status).toBe("missing-file");
  });

  it("openDatabase refuses a mid-delete entry", async () => {
    const store = createMemoryMetadataStore();
    const worker = new FakeStorageWorker();
    const service = new StorageService({ store, worker });
    await store.putDatabase({
      id: "bye",
      name: "Bye",
      createdAt: 1,
      lastOpenedAt: 1,
      sizeBytes: 0,
      status: "deleting",
    });

    await expect(service.openDatabase("bye")).rejects.toThrow(/being removed/);
  });

  it("renameDatabase is metadata-only", async () => {
    const { service, worker, store } = makeService();
    const created = await service.createDatabase("old");
    const fileBefore = [...worker.files];

    await service.renameDatabase(created.id, "  new name  ");

    expect(store.rows.get(created.id)?.name).toBe("new name");
    expect([...worker.files]).toEqual(fileBefore);
    expect(worker.activeFilename).toBe(dbFileName(created.id));
  });

  it("renameDatabase ignores empty names", async () => {
    const { service, store } = makeService();
    const created = await service.createDatabase("keep");
    await service.renameDatabase(created.id, "   ");
    expect(store.rows.get(created.id)?.name).toBe("keep");
  });

  it("deleteDatabase runs the three two-phase steps in order", async () => {
    const { service, worker, store } = makeService();
    const created = await service.createDatabase("doomed");

    await service.deleteDatabase(created.id);

    expect(store.rows.has(created.id)).toBe(false);
    expect(worker.files.has(dbFileName(created.id))).toBe(false);
    expect(worker.activeFilename).toBeNull();
  });

  it("deleteDatabase keeps the deleting marker when the file unlink fails", async () => {
    const { service, worker, store } = makeService();
    const created = await service.createDatabase("stuck");
    worker.failDelete = true;

    await expect(service.deleteDatabase(created.id)).rejects.toBeInstanceOf(DbOperationError);
    expect(store.rows.get(created.id)?.status).toBe("deleting");
  });

  it("listDatabases hides entries that are mid-delete", async () => {
    const { service, store } = makeService();
    const a = await service.createDatabase("a");
    await service.createDatabase("b");
    await store.putDatabase({ ...store.rows.get(a.id)!, status: "deleting" });

    const list = await service.listDatabases();
    expect(list.map((d) => d.name)).toEqual(["b"]);
  });
});

describe("StorageService.reconcile", () => {
  it("applies drift repairs and returns the current list", async () => {
    const store = createMemoryMetadataStore();
    const worker = new FakeStorageWorker();
    const service = new StorageService({ store, worker, now: () => 42 });

    const keep: DatabaseInfo = {
      id: "keep",
      name: "Keep",
      createdAt: 1,
      lastOpenedAt: 1,
      sizeBytes: 0,
      status: "ok",
    };
    const vanished: DatabaseInfo = {
      id: "vanish",
      name: "Vanish",
      createdAt: 1,
      lastOpenedAt: 1,
      sizeBytes: 0,
      status: "ok",
    };
    const doomed: DatabaseInfo = {
      id: "doomed",
      name: "Doomed",
      createdAt: 1,
      lastOpenedAt: 1,
      sizeBytes: 0,
      status: "deleting",
    };
    await store.putDatabase(keep);
    await store.putDatabase(vanished);
    await store.putDatabase(doomed);

    worker.files.add(dbFileName("keep"));
    worker.files.add(dbFileName("doomed"));
    worker.files.add(dbFileName("orphan"));
    worker.files.add("/playground.sqlite3");

    const report = await service.reconcile(true);

    expect(report.recoveredIds).toEqual(["orphan"]);
    expect(report.missingIds).toEqual(["vanish"]);
    expect(report.removedIds).toEqual(["doomed"]);
    expect(report.ignoredFiles).toEqual(["/playground.sqlite3"]);

    const ids = report.databases.map((d) => d.id).sort();
    expect(ids).toEqual(["keep", "orphan", "vanish"]);
    expect(report.databases.find((d) => d.id === "orphan")?.status).toBe("recovered");
    expect(report.databases.find((d) => d.id === "vanish")?.status).toBe("missing-file");
    // The interrupted delete finished: file gone, entry gone.
    expect(worker.files.has(dbFileName("doomed"))).toBe(false);
    expect(store.rows.has("doomed")).toBe(false);
  });

  it("retries a failed file unlink on the next reconcile", async () => {
    const store = createMemoryMetadataStore();
    const worker = new FakeStorageWorker();
    const service = new StorageService({ store, worker });
    await store.putDatabase({
      id: "stuck",
      name: "Stuck",
      createdAt: 1,
      lastOpenedAt: 1,
      sizeBytes: 0,
      status: "deleting",
    });
    worker.files.add(dbFileName("stuck"));
    worker.failDelete = true;

    const first = await service.reconcile(true);
    expect(first.removedIds).toEqual(["stuck"]);
    expect(store.rows.has("stuck")).toBe(true); // marker survives the failure

    worker.failDelete = false;
    const second = await service.reconcile(true);
    expect(store.rows.has("stuck")).toBe(false);
    expect(worker.files.has(dbFileName("stuck"))).toBe(false);
    expect(second.removedIds).toEqual(["stuck"]);
  });

  it("skips file listing entirely in the in-memory fallback", async () => {
    const store = createMemoryMetadataStore();
    const worker = new FakeStorageWorker();
    const service = new StorageService({ store, worker });
    await store.putDatabase({
      id: "mem",
      name: "Mem",
      createdAt: 1,
      lastOpenedAt: 1,
      sizeBytes: 0,
      status: "ok",
    });
    const listFiles = vi.fn(worker.listFiles.bind(worker));
    worker.listFiles = listFiles;

    const report = await service.reconcile(false);

    expect(listFiles).not.toHaveBeenCalled();
    expect(report.databases[0]?.status).toBe("ok");
    expect(report.missingIds).toEqual([]);
  });
});

describe("StorageService imported databases", () => {
  it("registers metadata only when the staged file exists", async () => {
    const { service, worker, store } = makeService();
    const info: DatabaseInfo = {
      id: "imported-id",
      name: "Imported",
      createdAt: 10,
      lastOpenedAt: 10,
      sizeBytes: 4096,
      status: "ok",
    };
    await expect(service.registerImportedDatabase(info)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });

    worker.files.add(dbFileName(info.id));
    await service.registerImportedDatabase(info);
    expect(store.rows.get(info.id)).toEqual(info);
  });
});
