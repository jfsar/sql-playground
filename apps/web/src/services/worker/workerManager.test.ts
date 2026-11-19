import { describe, expect, it } from "vitest";
import { CANCELLED_ERROR_NAME, WorkerManager } from "./workerManager";
import type { WorkerRequest, WorkerResponse } from "./protocol";

const FAKE_STATUS = {
  sqliteVersion: "3.54.1",
  persistent: true,
  filename: "/playground.sqlite3",
  vfsName: "opfs-sahpool",
  poolCapacity: 12,
  poolFileCount: 1,
  toolkit: "rust" as const,
  journalMode: "delete",
};

class FakeWorker {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  readonly posted: WorkerRequest[] = [];
  readonly files = new Set<string>(["/db_seed.sqlite3"]);
  active: string | null = null;
  terminated = false;
  autoRespond = true;

  postMessage(data: WorkerRequest): void {
    this.posted.push(data);
    if (!this.autoRespond) return;
    queueMicrotask(() => this.respond(data));
  }

  respond(req: WorkerRequest): void {
    let res: WorkerResponse;
    if (req.type === "init") {
      res = { type: "ready", requestId: req.requestId, status: { ...FAKE_STATUS } };
    } else if (req.type === "execute") {
      res = {
        type: "executed",
        requestId: req.requestId,
        response: {
          statements: [
            {
              kind: "rows",
              sql: req.sql,
              columns: [{ name: "1" }],
              rows: [[1]],
              truncated: false,
              engineMs: 0.5,
            },
          ],
          inTransaction: false,
          totalEngineMs: 1,
        },
      };
    } else if (req.type === "explain") {
      res = {
        type: "explained",
        requestId: req.requestId,
        plan: {
          nodes: [
            {
              id: 0,
              parentId: 0,
              operation: "SCAN",
              table: "t",
              tags: [],
              detail: "SCAN t",
            },
          ],
          raw: [{ id: 0, parent: 0, detail: "SCAN t" }],
          sqliteVersion: "3.54.1",
        },
      };
    } else if (req.type === "diff-plans") {
      res = {
        type: "diffed",
        requestId: req.requestId,
        diff: {
          added: [],
          removed: [],
          changed: [{ before: req.before.nodes[0]!, after: req.after.nodes[0]! }],
        },
      };
    } else if (req.type === "open-db") {
      this.active = req.filename;
      this.files.add(req.filename);
      res = {
        type: "opened",
        requestId: req.requestId,
        filename: req.filename,
        sizeBytes: 4096,
      };
    } else if (req.type === "import-db") {
      this.active = req.filename;
      this.files.add(req.filename);
      res = {
        type: "imported",
        requestId: req.requestId,
        result: {
          filename: req.filename,
          sizeBytes: req.bytes.byteLength,
          pageSize: 4096,
          journalMode: "delete",
          quickCheck: "ok",
          trustedSchema: "off",
          defensiveMode: true,
        },
      };
    } else if (req.type === "list-files") {
      res = { type: "files", requestId: req.requestId, files: [...this.files] };
    } else if (req.type === "delete-file") {
      const existed = this.files.delete(req.filename);
      if (this.active === req.filename) this.active = null;
      res = {
        type: "deleted",
        requestId: req.requestId,
        filename: req.filename,
        existed,
      };
    } else if (req.type === "export") {
      res = {
        type: "exported",
        requestId: req.requestId,
        bytes: new Uint8Array([83, 81, 76, 105, 116, 101]),
        name: "playground.sqlite3",
      };
    } else if (req.type === "schema") {
      res = {
        type: "schema-result",
        requestId: req.requestId,
        schema: {
          tables: [
            {
              name: "t",
              type: "table",
              columns: [
                {
                  name: "id",
                  declaredType: "INTEGER",
                  notNull: false,
                  defaultValue: null,
                  primaryKey: true,
                  primaryKeyOrder: 1,
                },
              ],
              foreignKeys: [],
              indexes: [],
              checkConstraints: [],
              sql: "CREATE TABLE t(id INTEGER PRIMARY KEY)",
            },
          ],
          views: [],
        },
      };
    } else if (req.type === "browse-table") {
      res = {
        type: "table-page",
        requestId: req.requestId,
        page: {
          table: req.table,
          columns: [{ name: "id" }],
          rows: [[1]],
          totalRows: 1,
          limit: req.limit,
          offset: req.offset,
        },
      };
    } else {
      res = { type: "status-result", requestId: req.requestId, status: { ...FAKE_STATUS } };
    }
    this.onmessage?.({ data: res } as MessageEvent<unknown>);
  }

  crash(message = "boom"): void {
    this.onerror?.(new ErrorEvent("error", { message }));
  }

  terminate(): void {
    this.terminated = true;
  }

  async waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("waitFor timed out");
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

function makeManager(): { manager: WorkerManager; worker: FakeWorker } {
  const worker = new FakeWorker();
  const manager = new WorkerManager({ createWorker: () => worker as unknown as Worker });
  return { manager, worker };
}

function makeSeqManager(): { manager: WorkerManager; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const manager = new WorkerManager({
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    },
  });
  return { manager, workers };
}

describe("WorkerManager", () => {
  it("initializes once and returns status", async () => {
    const { manager, worker } = makeManager();
    const a = await manager.init();
    const b = await manager.init();
    expect(a.persistent).toBe(true);
    expect(b).toEqual(a);
    expect(worker.posted.filter((m) => m.type === "init")).toHaveLength(1);
    manager.terminate();
  });

  it("correlates execute responses by requestId", async () => {
    const { manager, worker } = makeManager();
    await manager.init();
    const res = await manager.execute("SELECT 1");
    expect(res.statements).toHaveLength(1);
    const execReq = worker.posted.find((m) => m.type === "execute");
    expect(execReq).toBeDefined();
    expect(execReq?.requestId).toMatch(/^req-/);
    manager.terminate();
  });

  it("serializes requests (single-writer queue)", async () => {
    const { manager, worker } = makeManager();
    await manager.init();
    worker.autoRespond = false;

    const p1 = manager.execute("SELECT 1");
    const p2 = manager.execute("SELECT 2");

    // Only the first execute may be in flight until it completes.
    await worker.waitFor(() => worker.posted.filter((m) => m.type === "execute").length === 1);
    // Give p2 a chance to incorrectly post if the queue is broken.
    await new Promise((r) => setTimeout(r, 20));
    expect(worker.posted.filter((m) => m.type === "execute")).toHaveLength(1);

    const exec1 = worker.posted.find((m) => m.type === "execute");
    if (exec1) worker.respond(exec1);
    await p1;

    await worker.waitFor(() => worker.posted.filter((m) => m.type === "execute").length === 2);
    const execs = worker.posted.filter((m) => m.type === "execute");
    worker.respond(execs[1]!);
    await p2;

    expect(worker.posted.filter((m) => m.type === "execute")).toHaveLength(2);
    manager.terminate();
  });

  it("rejects in-flight requests and auto-restarts after a worker crash", async () => {
    const { manager, workers } = makeSeqManager();
    await manager.init();
    workers[0]!.autoRespond = false;

    const p = manager.execute("SELECT 1");
    p.catch(() => undefined); // avoid unhandled rejection if crash races
    await workers[0]!.waitFor(() => workers[0]!.posted.some((m) => m.type === "execute"));
    workers[0]!.crash("unexpected");

    await expect(p).rejects.toMatchObject({ code: "WORKER_CRASHED" });

    // Plan §5.4: the manager starts a fresh worker without waiting for a retry.
    await workers[1]!.waitFor(() => workers[1]!.posted.some((m) => m.type === "init"));
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);

    const res = await manager.execute("SELECT 1");
    expect(res.statements).toHaveLength(1);
    manager.terminate();
  });

  it("throws after terminate", async () => {
    const { manager } = makeManager();
    await manager.init();
    manager.terminate();
    await expect(manager.execute("SELECT 1")).rejects.toThrow(/terminated/i);
  });

  it("init failure clears initialized state for retry", async () => {
    const worker = new FakeWorker();
    const manager = new WorkerManager({ createWorker: () => worker as unknown as Worker });
    const origPost = worker.postMessage.bind(worker);
    let failNext = true;
    worker.postMessage = (data: WorkerRequest) => {
      if (failNext && data.type === "init") {
        failNext = false;
        queueMicrotask(() => {
          worker.onmessage?.({
            data: {
              type: "failed",
              requestId: data.requestId,
              error: { code: "STORAGE_UNAVAILABLE", message: "no OPFS" },
            },
          } as MessageEvent<unknown>);
        });
        return;
      }
      origPost(data);
    };

    await expect(manager.init()).rejects.toThrow("no OPFS");
    const status = await manager.init();
    expect(status.persistent).toBe(true);
    manager.terminate();
  });

  it("explain round-trips a parsed plan", async () => {
    const { manager, worker } = makeManager();
    const plan = await manager.explain("SELECT * FROM t");
    expect(plan.nodes[0]?.operation).toBe("SCAN");
    expect(plan.raw[0]?.detail).toBe("SCAN t");
    expect(worker.posted.some((m) => m.type === "explain")).toBe(true);
    manager.terminate();
  });

  it("diffs two plans through the worker toolkit", async () => {
    const { manager, worker } = makeManager();
    const before = await manager.explain("SELECT * FROM t");
    const after = {
      ...before,
      nodes: before.nodes.map((node) => ({
        ...node,
        operation: "SEARCH" as const,
        index: "idx_t",
      })),
    };
    const diff = await manager.diffPlans(before, after);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.before.operation).toBe("SCAN");
    expect(diff.changed[0]?.after.operation).toBe("SEARCH");
    const request = worker.posted.find((message) => message.type === "diff-plans");
    expect(request).toMatchObject({ before, after });
    manager.terminate();
  });

  it("exportDb returns bytes and a file name", async () => {
    const { manager } = makeManager();
    await manager.openFile("/db_seed.sqlite3");
    const exported = await manager.exportDb();
    expect(exported.name).toBe("playground.sqlite3");
    expect(exported.bytes.byteLength).toBeGreaterThan(0);
    manager.terminate();
  });

  it("requests the schema and paged table data", async () => {
    const { manager, worker } = makeManager();
    const schema = await manager.getSchema();
    expect(schema.tables[0]?.name).toBe("t");

    const page = await manager.browseTable("t", { limit: 25, offset: 50 });
    expect(page).toMatchObject({ table: "t", limit: 25, offset: 50, totalRows: 1 });
    expect(worker.posted.map((message) => message.type)).toEqual(
      expect.arrayContaining(["schema", "browse-table"]),
    );
    manager.terminate();
  });

  it("restart terminates the worker, cancels in-flight work, and re-inits (ADR-004)", async () => {
    const { manager, workers } = makeSeqManager();
    await manager.init();
    expect(workers).toHaveLength(1);

    workers[0]!.autoRespond = false;
    const inflight = manager.execute("SELECT 1");
    inflight.catch(() => undefined); // rejection asserted below
    await workers[0]!.waitFor(() => workers[0]!.posted.some((m) => m.type === "execute"));

    const status = await manager.restart();

    // Old worker is gone, a fresh one initialized with real status.
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted.some((m) => m.type === "init")).toBe(true);
    expect(status.toolkit).toBe("rust");

    // The in-flight request was rejected with the cancellation error.
    await expect(inflight).rejects.toMatchObject({ name: CANCELLED_ERROR_NAME });

    // The queue works again on the new worker.
    const res = await manager.execute("SELECT 1");
    expect(res.statements).toHaveLength(1);
    manager.terminate();
  });

  it("restart before init completes still yields a working manager", async () => {
    const { manager } = makeSeqManager();
    const first = manager.init();
    first.catch(() => undefined);
    const status = await manager.restart();
    expect(status.persistent).toBe(true);
    const res = await manager.execute("SELECT 1");
    expect(res.statements).toHaveLength(1);
    manager.terminate();
  });

  it("cancels an in-flight request by id and reopens the active database", async () => {
    const { manager, workers } = makeSeqManager();
    await manager.openFile("/db_abc.sqlite3");
    workers[0]!.autoRespond = false;

    const p = manager.execute("SELECT 1", { requestId: "run-1" });
    p.catch(() => undefined);
    await workers[0]!.waitFor(() => workers[0]!.posted.some((m) => m.type === "execute"));
    const request = workers[0]!.posted.find((m) => m.type === "execute");
    expect(request?.requestId).toBe("run-1");

    const cancelled = manager.cancel("run-1");
    await expect(p).rejects.toMatchObject({ name: CANCELLED_ERROR_NAME });

    await cancelled;
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[1]!.posted.find((m) => m.type === "init")).toMatchObject({
      openFile: "/db_abc.sqlite3",
    });
    expect(manager.activeFilename).toBe("/db_abc.sqlite3");

    const res = await manager.execute("SELECT 1");
    expect(res.statements).toHaveLength(1);
    manager.terminate();
  });

  it("cancels a queued request before it is sent", async () => {
    const { manager, worker } = makeManager();
    await manager.init();
    worker.autoRespond = false;

    const first = manager.execute("SELECT 1");
    first.catch(() => undefined);
    const second = manager.execute("SELECT 2", { requestId: "queued-2" });
    second.catch(() => undefined);
    await worker.waitFor(() => worker.posted.filter((m) => m.type === "execute").length === 1);

    await manager.cancel("queued-2");

    const firstRequest = worker.posted.find((m) => m.type === "execute");
    if (firstRequest) worker.respond(firstRequest);
    await first;
    await expect(second).rejects.toMatchObject({ name: CANCELLED_ERROR_NAME });

    // The cancelled request never reached the worker and no restart was needed.
    expect(worker.posted.filter((m) => m.type === "execute")).toHaveLength(1);
    expect(worker.terminated).toBe(false);
    manager.terminate();
  });

  it("ignores cancel for an unknown request id", async () => {
    const { manager, workers } = makeSeqManager();
    await manager.init();

    await manager.cancel("never-existed");

    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
    const res = await manager.execute("SELECT 1");
    expect(res.statements).toHaveLength(1);
    manager.terminate();
  });

  it("restart rejects queued work instead of running it on the new worker", async () => {
    const { manager, workers } = makeSeqManager();
    await manager.init();
    workers[0]!.autoRespond = false;

    const first = manager.execute("SELECT 1");
    first.catch(() => undefined);
    const second = manager.execute("SELECT 2");
    second.catch(() => undefined);
    await workers[0]!.waitFor(() => workers[0]!.posted.some((m) => m.type === "execute"));

    await manager.restart();

    await expect(first).rejects.toMatchObject({ name: CANCELLED_ERROR_NAME });
    await expect(second).rejects.toMatchObject({ name: CANCELLED_ERROR_NAME });
    expect(workers[1]!.posted.filter((m) => m.type === "execute")).toHaveLength(0);
    manager.terminate();
  });
});

describe("WorkerManager multi-database", () => {
  it("openFile activates a pool file and reports its size", async () => {
    const { manager, worker } = makeManager();
    const size = await manager.openFile("/db_abc.sqlite3");

    expect(size).toBe(4096);
    expect(manager.activeFilename).toBe("/db_abc.sqlite3");
    const openReq = worker.posted.find((m) => m.type === "open-db");
    expect(openReq).toMatchObject({ filename: "/db_abc.sqlite3" });
    manager.terminate();
  });

  it("re-sends the active file with init after a restart (recovery)", async () => {
    const { manager, workers } = makeSeqManager();
    await manager.init();
    await manager.openFile("/db_abc.sqlite3");

    await manager.restart();

    const initReq = workers[1]!.posted.find((m) => m.type === "init");
    expect(initReq).toMatchObject({ openFile: "/db_abc.sqlite3" });
    // The manager's view of the active file survives the restart.
    expect(manager.activeFilename).toBe("/db_abc.sqlite3");
    manager.terminate();
  });

  it("init carries no openFile before any database is opened", async () => {
    const { manager, worker } = makeManager();
    await manager.init();
    const initReq = worker.posted.find((m) => m.type === "init");
    expect(initReq).toBeDefined();
    expect(initReq && "openFile" in initReq ? initReq.openFile : undefined).toBeUndefined();
    manager.terminate();
  });

  it("deleteFile clears the active file only when it matches", async () => {
    const { manager, worker } = makeManager();
    await manager.openFile("/db_one.sqlite3");

    await manager.deleteFile("/db_other.sqlite3");
    expect(manager.activeFilename).toBe("/db_one.sqlite3");

    const result = await manager.deleteFile("/db_one.sqlite3");
    expect(result.existed).toBe(true);
    expect(manager.activeFilename).toBeNull();
    expect(worker.files.has("/db_one.sqlite3")).toBe(false);
    manager.terminate();
  });

  it("listFiles returns the pool's file names", async () => {
    const { manager } = makeManager();
    const files = await manager.listFiles();
    expect(files).toContain("/db_seed.sqlite3");
    manager.terminate();
  });

  it("imports bytes into a new active pool file", async () => {
    const { manager, worker } = makeManager();
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;

    const result = await manager.importDb("/db_imported.sqlite3", buffer);

    expect(result).toMatchObject({
      filename: "/db_imported.sqlite3",
      sizeBytes: 4,
      quickCheck: "ok",
    });
    expect(manager.activeFilename).toBe("/db_imported.sqlite3");
    expect(worker.files.has("/db_imported.sqlite3")).toBe(true);
    manager.terminate();
  });

  it("exports a named database file", async () => {
    const { manager } = makeManager();
    const exported = await manager.exportFile("/db_seed.sqlite3");
    expect(exported.bytes.byteLength).toBeGreaterThan(0);
    manager.terminate();
  });

  it("preserves the worker's DbError code on failure", async () => {
    const { manager, worker } = makeManager();
    await manager.init();
    worker.autoRespond = false;

    const pending = manager.importDb("/db_bad.sqlite3", new ArrayBuffer(8));
    pending.catch(() => undefined);
    await worker.waitFor(() => worker.posted.some((m) => m.type === "import-db"));
    const request = worker.posted.find((m) => m.type === "import-db");
    worker.onmessage?.({
      data: {
        type: "failed",
        requestId: request?.requestId,
        error: { code: "CORRUPT_FILE", message: "quick_check failed" },
      },
    } as MessageEvent<unknown>);

    await expect(pending).rejects.toMatchObject({
      code: "CORRUPT_FILE",
      message: "quick_check failed",
    });
    manager.terminate();
  });
});

describe("protocol helpers", () => {
  it("isWorkerResponse filters junk", async () => {
    const { isWorkerResponse } = await import("./protocol");
    expect(isWorkerResponse({ type: "ready", requestId: "x", status: {} })).toBe(true);
    expect(isWorkerResponse({ type: "nope" })).toBe(false);
    expect(isWorkerResponse(null)).toBe(false);
    expect(isWorkerResponse("ready")).toBe(false);
  });
});
