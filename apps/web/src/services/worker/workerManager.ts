import type {
  DatabaseSchema,
  ExecutionResponse,
  QueryPlan,
  TablePage,
  WorkerStatus,
} from "../../shared/contracts";
import { isWorkerResponse, type WorkerRequest, type WorkerResponse } from "./protocol";

interface Pending {
  resolve: (value: WorkerResponse) => void;
  reject: (reason: Error) => void;
}

export interface WorkerManagerOptions {
  /** Injected for tests; defaults to a module worker. */
  createWorker?: () => Worker;
}

export interface ExportedDatabase {
  bytes: Uint8Array;
  name: string;
}

function defaultCreateWorker(): Worker {
  return new Worker(new URL("../../workers/sqlite.worker.ts", import.meta.url), {
    type: "module",
  });
}

/** Error name used when a request is cancelled by a worker restart (ADR-004). */
export const CANCELLED_ERROR_NAME = "CancelledError";

function cancelledError(): Error {
  const error = new Error("Query cancelled; worker restarted.");
  error.name = CANCELLED_ERROR_NAME;
  return error;
}

/**
 * Main-thread Worker Manager: request correlation via requestId, single-writer
 * queue (one request runs at a time), crash → rejection of in-flight requests,
 * and terminate-and-restart cancellation (ADR-004).
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
  /** Pool file the worker should have open; re-sent with every init (restart/crash). */
  private activeFile: string | null = null;

  constructor(options: WorkerManagerOptions = {}) {
    this.createWorker = options.createWorker ?? defaultCreateWorker;
  }

  /** Pool file currently open (null = none). */
  get activeFilename(): string | null {
    return this.activeFile;
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
      const request: WorkerRequest = {
        type: "init",
        requestId: this.nextRequestId(),
        ...(this.activeFile ? { openFile: this.activeFile } : {}),
      };
      const p: Promise<WorkerStatus> = this.send(request)
        .then((res) => {
          if (res.type !== "ready") {
            throw new Error(`Unexpected init response: ${res.type}`);
          }
          return res.status;
        })
        .catch((err: unknown) => {
          // Only clear if a restart has not already replaced this attempt.
          if (this.initialized === p) this.initialized = null;
          throw err;
        });
      this.initialized = p;
    }
    return this.initialized;
  }

  /**
   * Open (creating if needed) a pool file and make it the active database.
   * Returns the file size in bytes as reported by SQLite.
   */
  async openFile(filename: string): Promise<number> {
    if (this.terminated) {
      throw new Error("WorkerManager has been terminated");
    }
    await this.init();
    const sizeBytes = await this.enqueue(async () => {
      const res = await this.send({
        type: "open-db",
        requestId: this.nextRequestId(),
        filename,
      });
      if (res.type !== "opened") {
        throw new Error(`Unexpected open-db response: ${res.type}`);
      }
      return res.sizeBytes;
    });
    // Track only after success so a failed open does not poison restart recovery.
    this.activeFile = filename;
    return sizeBytes;
  }

  /** Names of the files currently allocated in the OPFS pool. */
  async listFiles(): Promise<string[]> {
    if (this.terminated) {
      throw new Error("WorkerManager has been terminated");
    }
    await this.init();
    return this.enqueue(async () => {
      const res = await this.send({ type: "list-files", requestId: this.nextRequestId() });
      if (res.type !== "files") {
        throw new Error(`Unexpected list-files response: ${res.type}`);
      }
      return res.files;
    });
  }

  /** Unlink a pool file; clears the active file if it is the one removed. */
  async deleteFile(filename: string): Promise<{ existed: boolean }> {
    if (this.terminated) {
      throw new Error("WorkerManager has been terminated");
    }
    await this.init();
    const result = await this.enqueue(async () => {
      const res = await this.send({
        type: "delete-file",
        requestId: this.nextRequestId(),
        filename,
      });
      if (res.type !== "deleted") {
        throw new Error(`Unexpected delete-file response: ${res.type}`);
      }
      return { existed: res.existed };
    });
    if (this.activeFile === filename) this.activeFile = null;
    return result;
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

  /** Complete schema of the active database (plan §5.3). */
  async getSchema(): Promise<DatabaseSchema> {
    if (this.terminated) {
      throw new Error("WorkerManager has been terminated");
    }
    await this.init();
    return this.enqueue(async () => {
      const res = await this.send({ type: "schema", requestId: this.nextRequestId() });
      if (res.type !== "schema-result") {
        throw new Error(`Unexpected schema response: ${res.type}`);
      }
      return res.schema;
    });
  }

  /** One paged read of a table or view (plan §5.3). */
  async browseTable(table: string, page: { limit: number; offset: number }): Promise<TablePage> {
    if (this.terminated) {
      throw new Error("WorkerManager has been terminated");
    }
    await this.init();
    return this.enqueue(async () => {
      const res = await this.send({
        type: "browse-table",
        requestId: this.nextRequestId(),
        table,
        limit: page.limit,
        offset: page.offset,
      });
      if (res.type !== "table-page") {
        throw new Error(`Unexpected browse-table response: ${res.type}`);
      }
      return res.page;
    });
  }

  /** EXPLAIN QUERY PLAN for one statement, parsed by the worker's PlanToolkit. */
  async explain(sql: string): Promise<QueryPlan> {
    if (this.terminated) {
      throw new Error("WorkerManager has been terminated");
    }
    await this.init();
    return this.enqueue(async () => {
      const res = await this.send({ type: "explain", requestId: this.nextRequestId(), sql });
      if (res.type !== "explained") {
        throw new Error(`Unexpected explain response: ${res.type}`);
      }
      return res.plan;
    });
  }

  /** Export the active database file from the OPFS pool (ADR-001 check). */
  async exportDb(): Promise<ExportedDatabase> {
    if (this.terminated) {
      throw new Error("WorkerManager has been terminated");
    }
    await this.init();
    return this.enqueue(async () => {
      const res = await this.send({ type: "export", requestId: this.nextRequestId() });
      if (res.type !== "exported") {
        throw new Error(`Unexpected export response: ${res.type}`);
      }
      return { bytes: res.bytes, name: res.name };
    });
  }

  /**
   * ADR-004 cancellation: terminate the worker, reject in-flight requests
   * with `CancelledError`, and start a fresh worker that reopens the database.
   * Resolves with the fresh worker's status once it is ready again.
   */
  async restart(): Promise<WorkerStatus> {
    if (this.terminated) {
      throw new Error("WorkerManager has been terminated");
    }
    for (const [, entry] of this.pending) {
      entry.reject(cancelledError());
    }
    this.pending.clear();
    this.queue = Promise.resolve();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initialized = null;
    return this.init();
  }

  /** Permanently stop the manager (used by tests / page teardown). */
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
