import type { ExecutionResponse, WorkerStatus } from "../../shared/contracts";
import { isWorkerResponse, type WorkerRequest, type WorkerResponse } from "./protocol";

interface Pending {
  resolve: (value: WorkerResponse) => void;
  reject: (reason: Error) => void;
}

export interface WorkerManagerOptions {
  /** Injected for tests; defaults to a module worker. */
  createWorker?: () => Worker;
}

function defaultCreateWorker(): Worker {
  return new Worker(new URL("../../workers/sqlite.worker.ts", import.meta.url), {
    type: "module",
  });
}

/**
 * Main-thread Worker Manager: request correlation via requestId, single-writer
 * queue (one request runs at a time), crash → rejection of in-flight requests.
 *
 * `init()` is independent of the queue so `execute`/`status` can await it
 * without deadlocking against themselves.
 */
export class WorkerManager {
  private worker: Worker | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly createWorker: () => Worker;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private initialized: Promise<WorkerStatus> | null = null;
  private terminated = false;

  constructor(options: WorkerManagerOptions = {}) {
    this.createWorker = options.createWorker ?? defaultCreateWorker;
  }

  private ensureWorker(): Worker {
    if (this.terminated) {
      throw new Error("WorkerManager has been terminated");
    }
    if (!this.worker) {
      const worker = this.createWorker();
      worker.onmessage = (event: MessageEvent<unknown>) => this.handleMessage(event);
      worker.onerror = (event: ErrorEvent) => this.handleCrash(event.message || "worker error");
      worker.onmessageerror = () => this.handleCrash("messageerror");
      this.worker = worker;
    }
    return this.worker;
  }

  private handleCrash(message: string): void {
    const error = new Error(message || "SQLite worker crashed unexpectedly");
    error.name = "WorkerCrashError";
    for (const [, entry] of this.pending) {
      entry.reject(error);
    }
    this.pending.clear();
    this.initialized = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  private handleMessage(event: MessageEvent<unknown>): void {
    const data = event.data;
    if (!isWorkerResponse(data)) return;
    const entry = this.pending.get(data.requestId);
    if (!entry) return;
    this.pending.delete(data.requestId);
    if (data.type === "failed") {
      entry.reject(new Error(data.error.message));
    } else {
      entry.resolve(data);
    }
  }

  private send(request: WorkerRequest): Promise<WorkerResponse> {
    const worker = this.ensureWorker();
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject });
      worker.postMessage(request);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Keep the chain alive even if this request fails.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private nextRequestId(): string {
    this.nextId += 1;
    return `req-${this.nextId}`;
  }

  /** Initialize SQLite + opfs-sahpool. Safe to call multiple times. */
  init(): Promise<WorkerStatus> {
    if (this.terminated) {
      return Promise.reject(new Error("WorkerManager has been terminated"));
    }
    if (!this.initialized) {
      this.initialized = this.send({ type: "init", requestId: this.nextRequestId() })
        .then((res) => {
          if (res.type !== "ready") {
            throw new Error(`Unexpected init response: ${res.type}`);
          }
          return res.status;
        })
        .catch((err: unknown) => {
          this.initialized = null;
          throw err;
        });
    }
    return this.initialized;
  }

  async execute(sql: string, opts: { maxRows?: number } = {}): Promise<ExecutionResponse> {
    if (this.terminated) {
      throw new Error("WorkerManager has been terminated");
    }
    // Await init outside the queue: init uses send() directly, not enqueue().
    await this.init();
    return this.enqueue(async () => {
      const requestId = this.nextRequestId();
      const res = await this.send({
        type: "execute",
        requestId,
        sql,
        ...(opts.maxRows !== undefined ? { maxRows: opts.maxRows } : {}),
      });
      if (res.type !== "executed") {
        throw new Error(`Unexpected execute response: ${res.type}`);
      }
      return res.response;
    });
  }

  async status(): Promise<WorkerStatus> {
    if (this.terminated) {
      throw new Error("WorkerManager has been terminated");
    }
    await this.init();
    return this.enqueue(async () => {
      const res = await this.send({ type: "status", requestId: this.nextRequestId() });
      if (res.type !== "status-result") {
        throw new Error(`Unexpected status response: ${res.type}`);
      }
      return res.status;
    });
  }

  /** Terminate the worker (used by cancel/recovery paths in later weeks). */
  terminate(): void {
    this.terminated = true;
    for (const [, entry] of this.pending) {
      entry.reject(new Error("Worker terminated"));
    }
    this.pending.clear();
    this.initialized = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
