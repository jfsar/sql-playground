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
    } else if (req.type === "open-db") {
      this.active = req.filename;
      this.files.add(req.filename);
      res = {
        type: "opened",
        requestId: req.requestId,
        filename: req.filename,
        sizeBytes: 4096,
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

  it("rejects in-flight requests on worker crash", async () => {
    const { manager, worker } = makeManager();
    await manager.init();
    worker.autoRespond = false;

    const p = manager.execute("SELECT 1");
    p.catch(() => undefined); // avoid unhandled rejection if crash races
    await worker.waitFor(() => worker.posted.some((m) => m.type === "execute"));
    worker.crash("unexpected");

    await expect(p).rejects.toThrow(/unexpected|crashed/i);
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

  it("exportDb returns bytes and a file name", async () => {
    const { manager } = makeManager();
    const exported = await manager.exportDb();
    expect(exported.name).toBe("playground.sqlite3");
    expect(exported.bytes.byteLength).toBeGreaterThan(0);
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
