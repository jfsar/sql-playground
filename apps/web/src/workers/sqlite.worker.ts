/// <reference lib="webworker" />
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { executeScript } from "../services/database/execute";
import type { WorkerRequest, WorkerResponse } from "../services/worker/protocol";
import type { WorkerStatus } from "../shared/contracts";

const VFS_NAME = "sql-playground";
const DB_FILENAME = "/playground.sqlite3";
/** Pool must hold DBs + journals; default 6 is tight for multiple DBs. */
const INITIAL_CAPACITY = 12;

let sqlite3: Sqlite3Static | null = null;
let db: Database | null = null;
let poolUtil: SAHPoolUtil | null = null;
let persistent = false;
let status: WorkerStatus | null = null;

function post(msg: WorkerResponse): void {
  (globalThis as unknown as Worker).postMessage(msg);
}

function fail(requestId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  post({
    type: "failed",
    requestId,
    error: { code: "WORKER_CRASHED", message },
  });
}

async function init(requestId: string): Promise<void> {
  if (status && db) {
    post({ type: "ready", requestId, status });
    return;
  }

  sqlite3 = await sqlite3InitModule();

  try {
    poolUtil = await sqlite3.installOpfsSAHPoolVfs({
      name: VFS_NAME,
      initialCapacity: INITIAL_CAPACITY,
    });
    const PoolDb = poolUtil.OpfsSAHPoolDb;
    db = new PoolDb(DB_FILENAME);
    persistent = true;
  } catch (opfsErr) {
    // Never silently fall back: UI must show "not persistent" (plan §2).
    console.warn("opfs-sahpool unavailable, falling back to in-memory:", opfsErr);
    poolUtil = null;
    db = new sqlite3.oo1.DB(":memory:", "c");
    persistent = false;
  }

  status = {
    sqliteVersion: sqlite3.version.libVersion,
    persistent,
    filename: db.filename,
    vfsName: db.dbVfsName() ?? null,
    poolCapacity: poolUtil ? poolUtil.getCapacity() : null,
    poolFileCount: poolUtil ? poolUtil.getFileCount() : null,
  };

  post({ type: "ready", requestId, status });
}

function handleExecute(req: Extract<WorkerRequest, { type: "execute" }>): void {
  if (!sqlite3 || !db) {
    fail(req.requestId, new Error("Worker not initialized; send init first."));
    return;
  }
  try {
    const response = executeScript(sqlite3, db, req.sql, {
      maxRows: req.maxRows,
    });
    post({ type: "executed", requestId: req.requestId, response });
  } catch (err) {
    fail(req.requestId, err);
  }
}

function handleStatus(req: Extract<WorkerRequest, { type: "status" }>): void {
  if (!status) {
    fail(req.requestId, new Error("Worker not initialized; send init first."));
    return;
  }
  if (poolUtil) {
    status = {
      ...status,
      poolCapacity: poolUtil.getCapacity(),
      poolFileCount: poolUtil.getFileCount(),
    };
  }
  post({ type: "status-result", requestId: req.requestId, status });
}

globalThis.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  if (!req || typeof req.requestId !== "string") return;

  if (req.type === "init") {
    init(req.requestId).catch((err) => fail(req.requestId, err));
    return;
  }
  if (req.type === "execute") {
    handleExecute(req);
    return;
  }
  if (req.type === "status") {
    handleStatus(req);
  }
};
