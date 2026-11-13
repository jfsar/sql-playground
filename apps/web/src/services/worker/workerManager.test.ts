import { describe, expect, it } from "vitest";
import { WorkerManager } from "./workerManager";
import type { WorkerRequest, WorkerResponse } from "./protocol";

class FakeWorker {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  readonly posted: WorkerRequest[] = [];
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
      res = {
        type: "ready",
        requestId: req.requestId,
        status: {
          sqliteVersion: "3.54.1",
          persistent: true,
          filename: "/playground.sqlite3",
          vfsName: "opfs-sahpool",
          poolCapacity: 12,
          poolFileCount: 1,
        },
      };
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
    } else {
      res = {
        type: "status-result",
        requestId: req.requestId,
        status: {
          sqliteVersion: "3.54.1",
          persistent: true,
          filename: "/playground.sqlite3",
          vfsName: "opfs-sahpool",
          poolCapacity: 12,
          poolFileCount: 1,
        },
      };
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
