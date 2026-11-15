import { describe, expect, it } from "vitest";
import type { ExecutionResponse, QueryPlan, WorkerStatus } from "../../shared/contracts";
import { DatabaseService, DEFAULT_DATABASE_NAME, type DatabaseBackend } from "./databaseService";
import { StorageService } from "../storage/storageService";
import { FakeStorageWorker, makeEntry, makeStore, dbFileName } from "../storage/storageTestSupport";

const FAKE_STATUS: WorkerStatus = {
  sqliteVersion: "3.54.1",
  persistent: true,
  filename: null,
  vfsName: "opfs-sahpool",
  poolCapacity: 12,
  poolFileCount: 0,
  toolkit: "rust",
  journalMode: "delete",
};

const FAKE_RESPONSE: ExecutionResponse = {
  statements: [],
  inTransaction: false,
  totalEngineMs: 1,
};

const FAKE_PLAN: QueryPlan = { nodes: [], raw: [], sqliteVersion: "3.54.1" };

function makeBackend(overrides: Partial<WorkerStatus> = {}) {
  const calls = { init: 0, status: 0, execute: 0, explain: 0 };
  const backend: DatabaseBackend = {
    init: async () => {
      calls.init += 1;
      return { ...FAKE_STATUS, ...overrides };
    },
    status: async () => {
      calls.status += 1;
      return { ...FAKE_STATUS, ...overrides };
    },
    execute: async () => {
      calls.execute += 1;
      return FAKE_RESPONSE;
    },
    explain: async () => {
      calls.explain += 1;
      return FAKE_PLAN;
    },
  };
  return { backend, calls };
}

function makeService(
  statusOverrides: Partial<WorkerStatus> = {},
  seedParameters: {
    seed?: ReturnType<typeof makeEntry>[];
    files?: string[];
  } = {},
) {
  const { backend, calls } = makeBackend(statusOverrides);
  const worker = new FakeStorageWorker();
  const store = makeStore(seedParameters.seed ?? []);
  for (const file of seedParameters.files ?? []) worker.files.add(file);
  const storage = new StorageService({ store, worker, now: () => 5000 });
  const service = new DatabaseService({ backend, storage });
  return { service, worker, store, calls, storage };
}

describe("DatabaseService.startup", () => {
  it("first run creates and opens a default database", async () => {
    const { service, worker, store, calls } = makeService();

    const result = await service.startup();

    expect(result.databases).toHaveLength(1);
    expect(result.databases[0]?.name).toBe(DEFAULT_DATABASE_NAME);
    expect(result.activeId).toBe(result.databases[0]?.id);
    expect(store.rows.get(result.activeId ?? "")?.status).toBe("ok");
    expect(worker.activeFilename).toBe(dbFileName(result.activeId ?? ""));
    expect(result.status.persistent).toBe(true);
    expect(calls.init).toBe(1);
  });

  it("caches the startup run (StrictMode double mount)", async () => {
    const { service, calls } = makeService();
    const [a, b] = await Promise.all([service.startup(), service.startup()]);
    const c = await service.startup();

    expect(calls.init).toBe(1);
    expect(a.activeId).toBe(b.activeId);
    expect(c.activeId).toBe(a.activeId);
  });

  it("opens the most recently used database when several exist", async () => {
    const older = makeEntry({ id: "old", name: "Old", lastOpenedAt: 100 });
    const newer = makeEntry({ id: "new", name: "New", lastOpenedAt: 900 });
    const { service, worker, store } = makeService(
      {},
      { seed: [older, newer], files: [dbFileName("old"), dbFileName("new")] },
    );

    const result = await service.startup();

    expect(result.activeId).toBe("new");
    expect(worker.activeFilename).toBe(dbFileName("new"));
    // lastOpenedAt refreshed by the open.
    expect(store.rows.get("new")?.lastOpenedAt).toBe(5000);
    expect(result.databases).toHaveLength(2);
  });

  it("adopts a recovered orphan instead of creating another database", async () => {
    const { service, worker, store } = makeService({}, { files: [dbFileName("orphan")] });

    const result = await service.startup();

    expect(result.databases).toHaveLength(1);
    expect(result.activeId).toBe("orphan");
    expect(store.rows.get("orphan")?.status).toBe("ok");
    expect(store.rows.get("orphan")?.name).toBe("Recovered database");
    expect(worker.activeFilename).toBe(dbFileName("orphan"));
  });

  it("creates a fresh default when every entry is missing-file", async () => {
    const broken = makeEntry({ id: "broken", status: "missing-file" });
    const { service, store } = makeService({}, { seed: [broken] });

    const result = await service.startup();

    expect(result.activeId).not.toBe("broken");
    expect(result.databases.map((d) => d.status)).toContain("ok");
    expect(result.databases).toHaveLength(2);
    expect(store.rows.get("broken")?.status).toBe("missing-file");
  });

  it("keeps entries as-is in the in-memory fallback (no missing-file storm)", async () => {
    const seed = makeEntry({ id: "mem", name: "Mem" });
    const { service, store } = makeService(
      { persistent: false, journalMode: "memory" },
      { seed: [seed] },
    );

    const result = await service.startup();

    expect(result.activeId).toBe("mem");
    expect(store.rows.get("mem")?.status).toBe("ok");
    expect(result.status.journalMode).toBe("memory");
  });
});

describe("DatabaseService lifecycle delegation", () => {
  it("delegates execute and explain to the backend", async () => {
    const { service, calls } = makeService();
    await service.startup();

    await service.execute("SELECT 1");
    await service.explain("SELECT 1");

    expect(calls.execute).toBe(1);
    expect(calls.explain).toBe(1);
  });

  it("switching databases opens the target file", async () => {
    const a = makeEntry({ id: "a", name: "A" });
    const b = makeEntry({ id: "b", name: "B" });
    const { service, worker } = makeService(
      {},
      { seed: [a, b], files: [dbFileName("a"), dbFileName("b")] },
    );
    await service.startup();

    await service.openDatabase("b");

    expect(worker.activeFilename).toBe(dbFileName("b"));
  });

  it("deleting the active database falls back to another one", async () => {
    const { service, worker } = makeService();
    const first = await service.createDatabase("first");
    const second = await service.createDatabase("second");
    expect(worker.activeFilename).toBe(dbFileName(second.id));

    await service.deleteDatabase(second.id);

    expect(worker.activeFilename).toBe(dbFileName(first.id));
    const list = await service.listDatabases();
    expect(list.map((d) => d.id)).toEqual([first.id]);
  });

  it("deleting the last database creates a fresh default", async () => {
    const { service, worker } = makeService();
    const only = await service.createDatabase("only");

    await service.deleteDatabase(only.id);

    const list = await service.listDatabases();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe(DEFAULT_DATABASE_NAME);
    expect(worker.activeFilename).toBe(dbFileName(list[0]?.id ?? ""));
  });

  it("deleting a non-active database leaves the connection alone", async () => {
    const { service, worker } = makeService();
    const first = await service.createDatabase("first");
    const second = await service.createDatabase("second");

    await service.deleteDatabase(first.id);

    expect(worker.activeFilename).toBe(dbFileName(second.id));
    const list = await service.listDatabases();
    expect(list.map((d) => d.id)).toEqual([second.id]);
  });
});
