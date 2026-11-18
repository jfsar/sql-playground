/// <reference lib="webworker" />
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { browseTable } from "../services/database/browse";
import { executeScript } from "../services/database/execute";
import { explainQuery } from "../services/database/explain";
import { readSchema } from "../services/database/schema";
import type { WorkerRequest, WorkerResponse } from "../services/worker/protocol";
import { createPlanToolkit } from "../services/toolkit";
import type { PlanToolkit } from "../services/toolkit/planToolkit";
import type { WorkerStatus } from "../shared/contracts";

const VFS_NAME = "sql-playground";
/** Pool must hold N databases + journals; grows deliberately on demand (ADR-001). */
const INITIAL_CAPACITY = 12;
/** Slots added when a new file is created and the pool is full. */
const CAPACITY_GROWTH = 8;

let sqlite3: Sqlite3Static | null = null;
let db: Database | null = null;
let poolUtil: SAHPoolUtil | null = null;
let persistent = false;
/** Pool file the connection is bound to; null = no database open. */
let activeFilename: string | null = null;
let toolkit: PlanToolkit | null = null;
let toolkitImpl: "rust" | "typescript" = "typescript";

function post(msg: WorkerResponse): void {
  (globalThis as unknown as Worker).postMessage(msg);
}

function fail(requestId: string, err: unknown, code = "WORKER_CRASHED"): void {
  const message = err instanceof Error ? err.message : String(err);
  post({
    type: "failed",
    requestId,
    error: { code, message },
  });
}

/** Live journal mode (ADR-001 PoC check: WAL support under opfs-sahpool). */
function readJournalMode(target: Database): string {
  try {
    const rows = target.exec("PRAGMA journal_mode", {
      rowMode: "array",
      returnValue: "resultRows",
    }) as unknown;
    // [[mode]] — one row, one column. ("scalar" rowMode is not accepted at runtime.)
    const first = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0][0] : rows;
    return typeof first === "string" ? first : String(first ?? "unknown");
  } catch {
    return "unknown";
  }
}

/** Cheap DB size: page_count × page_size (never loads the file). */
function readSizeBytes(target: Database): number {
  try {
    const read = (pragma: string): number => {
      const rows = target.exec(`PRAGMA ${pragma}`, {
        rowMode: "array",
        returnValue: "resultRows",
      }) as unknown;
      const first = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0][0] : rows;
      return typeof first === "number" ? first : Number(first ?? 0);
    };
    return read("page_count") * read("page_size");
  } catch {
    return 0;
  }
}

function buildStatus(): WorkerStatus {
  return {
    sqliteVersion: sqlite3 ? sqlite3.version.libVersion : "unknown",
    persistent,
    filename: activeFilename,
    vfsName: db ? (db.dbVfsName() ?? null) : (poolUtil?.vfsName ?? null),
    poolCapacity: poolUtil ? poolUtil.getCapacity() : null,
    poolFileCount: poolUtil ? poolUtil.getFileCount() : null,
    toolkit: toolkitImpl,
    journalMode: db ? readJournalMode(db) : "none",
  };
}

function closeActiveDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // Already closed or mid-crash; the fresh connection below supersedes it.
    }
    db = null;
  }
}

/**
 * Close any open connection and open `filename`, creating it if missing
 * (oo1 default flags are `c`). Returns the file's size in bytes.
 *
 * One connection at a time (ADR-001): the previous database is always closed
 * first. When the pool has no free slot for a *new* file, capacity is grown
 * deliberately rather than failing with a confusing I/O error.
 */
async function openDatabaseFile(filename: string): Promise<number> {
  if (!sqlite3) throw new Error("SQLite is not initialized");
  closeActiveDb();

  if (poolUtil) {
    const known = poolUtil.getFileNames().includes(filename);
    if (!known && poolUtil.getFileCount() >= poolUtil.getCapacity()) {
      await poolUtil.addCapacity(CAPACITY_GROWTH);
    }
    db = new poolUtil.OpfsSAHPoolDb(filename);
  } else {
    // Never silent: the UI shows the "not persistent" banner (plan §2).
    db = new sqlite3.oo1.DB(":memory:", "c");
  }

  activeFilename = filename;
  return readSizeBytes(db);
}

async function init(requestId: string, openFile?: string): Promise<void> {
  if (!sqlite3) {
    sqlite3 = await sqlite3InitModule();
    try {
      poolUtil = await sqlite3.installOpfsSAHPoolVfs({
        name: VFS_NAME,
        initialCapacity: INITIAL_CAPACITY,
      });
      persistent = true;
    } catch (opfsErr) {
      // Never silently fall back: UI must show "not persistent" (plan §2).
      console.warn("opfs-sahpool unavailable, falling back to in-memory:", opfsErr);
      poolUtil = null;
      persistent = false;
    }
  }

  if (!toolkit) {
    // Rust wasm first, TypeScript fallback — both behind PlanToolkit (ADR-002).
    const created = await createPlanToolkit();
    toolkit = created.toolkit;
    toolkitImpl = created.implementation;
  }

  // Idempotent: only (re)opens when the requested file is not already active.
  if (openFile !== undefined && (!db || activeFilename !== openFile)) {
    await openDatabaseFile(openFile);
  }

  post({ type: "ready", requestId, status: buildStatus() });
}

function handleExecute(req: Extract<WorkerRequest, { type: "execute" }>): void {
  if (!sqlite3 || !db) {
    fail(
      req.requestId,
      new Error("No database is open; open a database before running SQL."),
      "STORAGE_UNAVAILABLE",
    );
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

function handleExplain(req: Extract<WorkerRequest, { type: "explain" }>): void {
  if (!sqlite3 || !db || !toolkit) {
    fail(
      req.requestId,
      new Error("No database is open; open a database before explaining SQL."),
      "STORAGE_UNAVAILABLE",
    );
    return;
  }
  try {
    const plan = explainQuery(sqlite3, db, toolkit, req.sql);
    post({ type: "explained", requestId: req.requestId, plan });
  } catch (err) {
    fail(req.requestId, err, "SQL_ERROR");
  }
}

function handleSchema(req: Extract<WorkerRequest, { type: "schema" }>): void {
  if (!db) {
    fail(
      req.requestId,
      new Error("No database is open; open a database before reading its schema."),
      "STORAGE_UNAVAILABLE",
    );
    return;
  }
  try {
    post({ type: "schema-result", requestId: req.requestId, schema: readSchema(db) });
  } catch (err) {
    fail(req.requestId, err, "SQL_ERROR");
  }
}

function handleBrowseTable(req: Extract<WorkerRequest, { type: "browse-table" }>): void {
  if (!sqlite3 || !db) {
    fail(
      req.requestId,
      new Error("No database is open; open a database before browsing tables."),
      "STORAGE_UNAVAILABLE",
    );
    return;
  }
  try {
    const page = browseTable(sqlite3, db, req.table, {
      limit: req.limit,
      offset: req.offset,
    });
    post({ type: "table-page", requestId: req.requestId, page });
  } catch (err) {
    fail(req.requestId, err, "SQL_ERROR");
  }
}

async function handleOpenDb(req: Extract<WorkerRequest, { type: "open-db" }>): Promise<void> {
  try {
    const sizeBytes = await openDatabaseFile(req.filename);
    post({ type: "opened", requestId: req.requestId, filename: req.filename, sizeBytes });
  } catch (err) {
    fail(req.requestId, err, "IO");
  }
}

function handleListFiles(req: Extract<WorkerRequest, { type: "list-files" }>): void {
  if (!poolUtil) {
    // In-memory fallback has no pool; the storage layer gates on `persistent`.
    post({ type: "files", requestId: req.requestId, files: [] });
    return;
  }
  post({ type: "files", requestId: req.requestId, files: [...poolUtil.getFileNames()] });
}

function handleDeleteFile(req: Extract<WorkerRequest, { type: "delete-file" }>): void {
  if (!poolUtil) {
    post({ type: "deleted", requestId: req.requestId, filename: req.filename, existed: false });
    return;
  }
  try {
    const existed = poolUtil.getFileNames().includes(req.filename);
    if (activeFilename === req.filename) {
      closeActiveDb();
      activeFilename = null;
    }
    if (existed) poolUtil.unlink(req.filename);
    post({ type: "deleted", requestId: req.requestId, filename: req.filename, existed });
  } catch (err) {
    fail(req.requestId, err, "IO");
  }
}

function handleExport(req: Extract<WorkerRequest, { type: "export" }>): void {
  const filename = req.filename ?? activeFilename;
  if (!poolUtil || !filename) {
    fail(
      req.requestId,
      new Error("Export unavailable: database is in-memory (browser storage not persistent)."),
      "STORAGE_UNAVAILABLE",
    );
    return;
  }
  try {
    const bytes = poolUtil.exportFile(filename);
    post({
      type: "exported",
      requestId: req.requestId,
      bytes,
      name: filename.replace(/^\//, ""),
    });
  } catch (err) {
    fail(req.requestId, err, "IO");
  }
}

function handleStatus(req: Extract<WorkerRequest, { type: "status" }>): void {
  post({ type: "status-result", requestId: req.requestId, status: buildStatus() });
}

globalThis.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  if (!req || typeof req.requestId !== "string") return;

  if (req.type === "init") {
    init(req.requestId, req.openFile).catch((err) => fail(req.requestId, err));
    return;
  }
  if (req.type === "execute") {
    handleExecute(req);
    return;
  }
  if (req.type === "explain") {
    handleExplain(req);
    return;
  }
  if (req.type === "open-db") {
    void handleOpenDb(req);
    return;
  }
  if (req.type === "schema") {
    handleSchema(req);
    return;
  }
  if (req.type === "browse-table") {
    handleBrowseTable(req);
    return;
  }
  if (req.type === "list-files") {
    handleListFiles(req);
    return;
  }
  if (req.type === "delete-file") {
    handleDeleteFile(req);
    return;
  }
  if (req.type === "export") {
    handleExport(req);
    return;
  }
  if (req.type === "status") {
    handleStatus(req);
  }
};
