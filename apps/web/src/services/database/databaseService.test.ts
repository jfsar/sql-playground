import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DatabaseSchema,
  ExecutionResponse,
  QueryPlan,
  SqliteImportResult,
  TablePage,
  WorkerStatus,
} from "../../shared/contracts";
import { DbOperationError } from "../../shared/errors";
import { DatabaseService, DEFAULT_DATABASE_NAME, type DatabaseBackend } from "./databaseService";
import { SAMPLE_DATABASE_NAME } from "./sampleDatabase";
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
const FAKE_SCHEMA: DatabaseSchema = { tables: [], views: [] };
const FAKE_TABLE_PAGE: TablePage = {
  table: "t",
  columns: [{ name: "id" }],
  rows: [[1]],
  totalRows: 1,
  limit: 50,
  offset: 0,
};

const FAKE_IMPORT_RESULT: SqliteImportResult = {
  filename: "/db_imported.sqlite3",
  sizeBytes: 4096,
  pageSize: 4096,
  journalMode: "delete",
  quickCheck: "ok",
  trustedSchema: "off",
  defensiveMode: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function makeBackend(
  overrides: Partial<WorkerStatus> = {},
  executeResponse: ExecutionResponse = FAKE_RESPONSE,
) {
  const calls = {
    init: 0,
    status: 0,
    execute: 0,
    cancel: 0,
    explain: 0,
    schema: 0,
    browse: 0,
    import: 0,
    export: 0,
    open: 0,
    delete: 0,
  };
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
      return executeResponse;
    },
    cancel: async () => {
      calls.cancel += 1;
    },
    explain: async () => {
      calls.explain += 1;
      return FAKE_PLAN;
    },
    getSchema: async () => {
      calls.schema += 1;
      return FAKE_SCHEMA;
    },
    browseTable: async (table, page) => {
      calls.browse += 1;
      return { ...FAKE_TABLE_PAGE, table, limit: page.limit, offset: page.offset };
    },
    importDb: async (filename, bytes) => {
      calls.import += 1;
      return { ...FAKE_IMPORT_RESULT, filename, sizeBytes: bytes.byteLength };
    },
    exportFile: async (filename) => {
      calls.export += 1;
      return { bytes: new Uint8Array([1, 2, 3]), name: filename.replace(/^\//, "") };
    },
    openFile: async () => {
      calls.open += 1;
      return 4096;
    },
    deleteFile: async () => {
      calls.delete += 1;
      return { existed: true };
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
  return { service, backend, worker, store, calls, storage };
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

  it("forwards execute options and cancels by request id", async () => {
    const { service, backend, calls } = makeService();
    const execute = vi.spyOn(backend, "execute");
    await service.startup();

    await service.execute("SELECT 1", { requestId: "run-1", maxRows: 5 });
    await service.cancel("run-1");

    expect(execute).toHaveBeenCalledWith("SELECT 1", { requestId: "run-1", maxRows: 5 });
    expect(calls.cancel).toBe(1);
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

describe("DatabaseService sample database and explorer delegation", () => {
  it("creates the sample database by running the bundled script", async () => {
    const { service, calls, worker, store } = makeService();

    const info = await service.createSampleDatabase();

    expect(info.name).toBe(SAMPLE_DATABASE_NAME);
    expect(info.sample).toBe(true);
    expect(calls.execute).toBe(1);
    expect(worker.activeFilename).toBe(dbFileName(info.id));
    expect(store.rows.get(info.id)?.sample).toBe(true);
  });

  it("rolls back a sample database when the script fails", async () => {
    const failing: ExecutionResponse = {
      statements: [
        {
          kind: "error",
          sql: "SELECT broken;",
          error: { code: "SQL_ERROR", message: "syntax error" },
          span: { start: 0, end: 15, text: "SELECT broken;" },
        },
      ],
      inTransaction: false,
      totalEngineMs: 1,
    };
    const { backend, calls } = makeBackend({}, failing);
    const worker = new FakeStorageWorker();
    const store = makeStore();
    const storage = new StorageService({ store, worker, now: () => 5000 });
    const service = new DatabaseService({ backend, storage });

    await expect(service.createSampleDatabase()).rejects.toThrow("syntax error");

    expect(calls.execute).toBe(1);
    expect((await service.listDatabases()).map((database) => database.sample)).not.toContain(true);
  });

  it("delegates schema reads and clamps table page values", async () => {
    const { service, calls } = makeService();
    await service.startup();

    await service.getSchema();
    const page = await service.browseTable("t", { limit: 9999, offset: -4 });

    expect(calls.schema).toBe(1);
    expect(calls.browse).toBe(1);
    expect(page).toMatchObject({ limit: 500, offset: 0 });
  });
});

const IMPORT_ID = "11111111-1111-4111-8111-111111111111";

function sqliteBytes(pageSize = 512): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(pageSize);
  const header = "SQLite format 3\0";
  for (let i = 0; i < header.length; i += 1) bytes[i] = header.charCodeAt(i);
  bytes[16] = (pageSize >> 8) & 0xff;
  bytes[17] = pageSize & 0xff;
  bytes[18] = 1;
  bytes[19] = 1;
  return bytes;
}

function makeImportService(executeResponse: ExecutionResponse = FAKE_RESPONSE) {
  const { backend, calls } = makeBackend({}, executeResponse);
  const worker = new FakeStorageWorker();
  const store = makeStore();
  backend.importDb = async (filename, bytes) => {
    calls.import += 1;
    worker.files.add(filename);
    worker.activeFilename = filename;
    return { ...FAKE_IMPORT_RESULT, filename, sizeBytes: bytes.byteLength };
  };
  backend.openFile = async (filename) => {
    calls.open += 1;
    worker.files.add(filename);
    worker.activeFilename = filename;
    return 4096;
  };
  backend.deleteFile = async (filename) => {
    calls.delete += 1;
    const existed = worker.files.delete(filename);
    if (worker.activeFilename === filename) worker.activeFilename = null;
    return { existed };
  };
  const storage = new StorageService({ store, worker, now: () => 5000 });
  const service = new DatabaseService({ backend, storage });
  return { service, backend, calls, worker, store, storage };
}

describe("DatabaseService imports and exports", () => {
  it("stages a new database, registers metadata, and keeps existing entries", async () => {
    const { service, worker, store, calls } = makeImportService();
    const previous = await service.createDatabase("Previous");
    vi.spyOn(crypto, "randomUUID").mockReturnValue(IMPORT_ID);

    const info = await service.importDatabase(new File([sqliteBytes()], "my-import.db"), {
      name: "Imported",
      now: 123,
    });

    expect(calls.import).toBe(1);
    expect(info).toMatchObject({
      id: IMPORT_ID,
      name: "Imported",
      sizeBytes: 512,
      createdAt: 123,
      lastOpenedAt: 123,
      status: "ok",
    });
    expect(worker.files.has(dbFileName(IMPORT_ID))).toBe(true);
    expect(worker.files.has(dbFileName(previous.id))).toBe(true);
    expect(store.rows.get(IMPORT_ID)?.name).toBe("Imported");
  });

  it("rejects invalid files before touching storage", async () => {
    const { service, calls } = makeImportService();

    await expect(
      service.importDatabase(new File([new Uint8Array([1, 2, 3])], "bad.db")),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
    expect(calls.import).toBe(0);
    expect(calls.delete).toBe(0);
  });

  it("blocks imports that exceed the storage estimate", async () => {
    const { service, calls } = makeImportService();
    const storageInfo = {
      estimateSupported: true,
      usageBytes: 900,
      quotaBytes: 1000,
      persisted: false,
      opfsSupported: true,
    };

    await expect(
      service.importDatabase(new File([sqliteBytes()], "large.db"), {
        storageInfo,
      }),
    ).rejects.toMatchObject({ code: "QUOTA" });
    expect(calls.import).toBe(0);
  });

  it("cleans up and restores the previous database when import fails", async () => {
    const { service, backend, worker, calls } = makeImportService();
    const previous = await service.createDatabase("Previous");
    vi.spyOn(crypto, "randomUUID").mockReturnValue(IMPORT_ID);
    backend.importDb = async () => {
      calls.import += 1;
      throw new DbOperationError("CORRUPT_FILE", "quick_check failed");
    };

    await expect(
      service.importDatabase(new File([sqliteBytes()], "broken.db")),
    ).rejects.toMatchObject({ code: "CORRUPT_FILE" });

    expect(calls.delete).toBe(1);
    expect(calls.open).toBe(1);
    expect(worker.activeFilename).toBe(dbFileName(previous.id));
  });

  it("removes the staged file when metadata registration fails", async () => {
    const { service, storage, calls } = makeImportService();
    const previous = await service.createDatabase("Previous");
    vi.spyOn(crypto, "randomUUID").mockReturnValue(IMPORT_ID);
    vi.spyOn(storage, "registerImportedDatabase").mockRejectedValue(
      new DbOperationError("STORAGE_UNAVAILABLE", "metadata failed"),
    );

    await expect(service.importDatabase(new File([sqliteBytes()], "valid.db"))).rejects.toThrow(
      "metadata failed",
    );

    expect(calls.delete).toBe(1);
    expect(calls.open).toBe(1);
    expect((await service.listDatabases()).map((database) => database.id)).toEqual([previous.id]);
  });

  it("imports a script into a new database and rolls it back on failure", async () => {
    const { service, calls } = makeImportService();
    const sql = new File([new TextEncoder().encode("SELECT 1;")], "ok.sql");

    const ok = await service.importScript(sql, { name: "Imported script" });
    expect(ok.rolledBack).toBe(false);
    expect(ok.database?.name).toBe("Imported script");
    expect(calls.execute).toBe(1);

    const failing: ExecutionResponse = {
      statements: [
        {
          kind: "error",
          sql: "SELECT broken;",
          error: { code: "SQL_ERROR", message: "syntax error" },
          span: { start: 0, end: 15, text: "SELECT broken;" },
        },
      ],
      inTransaction: false,
      totalEngineMs: 1,
    };
    const failingService = makeImportService(failing);
    const before = await failingService.service.createDatabase("Previous failure");
    const result = await failingService.service.importScript(
      new File([new TextEncoder().encode("SELECT broken;")], "bad.sql"),
      { name: "Broken script" },
    );

    expect(result.rolledBack).toBe(true);
    expect(result.database).toBeNull();
    const ids = (await failingService.service.listDatabases()).map((database) => database.id);
    expect(ids).toEqual([before.id]);
    expect(failingService.worker.activeFilename).toBe(dbFileName(before.id));
  });

  it("rolls back a new script target when execution rejects", async () => {
    const { service, backend, worker, calls } = makeImportService();
    const before = await service.createDatabase("Previous");
    backend.execute = async () => {
      calls.execute += 1;
      throw new DbOperationError("IO", "worker lost");
    };

    await expect(
      service.importScript(new File([new TextEncoder().encode("SELECT 1;")], "lost.sql"), {
        name: "Lost script",
      }),
    ).rejects.toThrow("worker lost");

    expect((await service.listDatabases()).map((database) => database.id)).toEqual([before.id]);
    expect(worker.activeFilename).toBe(dbFileName(before.id));
  });

  it("runs a script against an existing database without rolling it back", async () => {
    const failing: ExecutionResponse = {
      statements: [
        {
          kind: "error",
          sql: "SELECT broken;",
          error: { code: "SQL_ERROR", message: "syntax error" },
          span: { start: 0, end: 15, text: "SELECT broken;" },
        },
      ],
      inTransaction: false,
      totalEngineMs: 1,
    };
    const { service } = makeImportService(failing);
    const target = await service.createDatabase("Target");

    const result = await service.importScript(
      new File([new TextEncoder().encode("SELECT broken;")], "bad.sql"),
      { targetId: target.id },
    );

    expect(result.rolledBack).toBe(false);
    expect(result.database?.id).toBe(target.id);
    expect((await service.listDatabases()).map((database) => database.id)).toContain(target.id);
  });

  it("exports a named database as a blob", async () => {
    const { service, calls } = makeImportService();
    const database = await service.createDatabase("Export me");

    const blob = await service.exportDatabase(database.id);

    expect(blob.size).toBe(3);
    expect(calls.export).toBe(1);
    await expect(service.exportDatabase("missing")).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });
});
