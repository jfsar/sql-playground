import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TabBlockedScreen } from "./TabBlockedScreen";
import { DatabaseExplorer } from "../features/database-explorer/DatabaseExplorer";
import { PlanPanel } from "../features/query-analysis/PlanPanel";
import { StatementBlock } from "../features/query-results/StatementBlock";
import { SqlEditor, type SqlSelection } from "../features/sql-editor/SqlEditor";
import { DatabaseService, type StartupResult } from "../services/database/databaseService";
import {
  getStorageInfo,
  requestPersistentStorage,
  type StorageInfo,
} from "../services/storage/quota";
import { idFromDbFileName } from "../services/storage/reconcile";
import { StorageService } from "../services/storage/storageService";
import { createIdbMetadataStore } from "../services/storage/metadataDb";
import { acquireTabLock, retryTabLock } from "../services/storage/tabGuard";
import { DbOperationError, describeDbError } from "../shared/errors";
import {
  byteOffsetToJsIndex,
  computeErrorMark,
  indexToLineColumn,
  type LineColumn,
} from "../shared/textPosition";
import { WorkerManager } from "../services/worker/workerManager";
import type {
  DatabaseInfo,
  ExecutionResponse,
  QueryPlan,
  StatementResult,
  WorkerStatus,
} from "../shared/contracts";

const DEFAULT_SQL = `-- ⌘/Ctrl+Enter runs the selection or the whole script; ⇧⌘/Ctrl+Enter explains
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL
);
INSERT INTO notes (body) VALUES ('hello from OPFS');
SELECT id, body FROM notes;
`;

/** One manager per page: StrictMode remount must not re-create/kill the worker. */
let sharedManager: WorkerManager | null = null;
function getSharedManager(): WorkerManager {
  if (!sharedManager) sharedManager = new WorkerManager();
  return sharedManager;
}

let sharedDatabase: DatabaseService | null = null;
function getSharedDatabase(): DatabaseService {
  if (!sharedDatabase) {
    const manager = getSharedManager();
    const storage = new StorageService({ store: createIdbMetadataStore(), worker: manager });
    sharedDatabase = new DatabaseService({ backend: manager, storage });
  }
  return sharedDatabase;
}

interface ErrorPosition {
  index: number;
  position: LineColumn | null;
}

function StatementBlockList({
  statements,
  errorPosition,
}: {
  statements: StatementResult[];
  errorPosition: ErrorPosition | null;
}) {
  return (
    <>
      {statements.map((r, i) => (
        <StatementBlock
          key={i}
          result={r}
          index={i}
          position={errorPosition && errorPosition.index === i ? errorPosition.position : undefined}
        />
      ))}
    </>
  );
}

type TabLockState = "pending" | "owned" | "blocked";

export default function App() {
  const managerRef = useRef<WorkerManager | null>(null);
  const databaseRef = useRef<DatabaseService | null>(null);
  const [tabLock, setTabLock] = useState<TabLockState>("pending");
  const [lockUnsupported, setLockUnsupported] = useState(false);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dbBusy, setDbBusy] = useState(false);
  const [dbOpError, setDbOpError] = useState<string | null>(null);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [response, setResponse] = useState<ExecutionResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [plan, setPlan] = useState<QueryPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [restartMs, setRestartMs] = useState<number | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [exportInfo, setExportInfo] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [selection, setSelection] = useState<SqlSelection | null>(null);
  const [errorMark, setErrorMark] = useState<{ from: number; to: number } | null>(null);
  // Snapshot of what was executed, so error line/column stays anchored to the
  // document (or selection) that produced the results.
  const [runContext, setRunContext] = useState<{ doc: string; docStart: number } | null>(null);
  const [restartTxNotice, setRestartTxNotice] = useState(false);
  const [txBusy, setTxBusy] = useState(false);

  if (!managerRef.current) managerRef.current = getSharedManager();
  if (!databaseRef.current) databaseRef.current = getSharedDatabase();
  const manager = managerRef.current;
  const database = databaseRef.current;

  // Tab guard first: never install the VFS or init the worker without the lock.
  useEffect(() => {
    let cancelled = false;
    acquireTabLock().then((res) => {
      if (cancelled) return;
      if (res.granted) {
        setLockUnsupported(res.unsupported);
        setTabLock("owned");
      } else {
        setTabLock("blocked");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Foundation startup: init → reconcile → ensure a database → open it.
  useEffect(() => {
    if (tabLock !== "owned") return;
    let cancelled = false;
    database
      .startup()
      .then((result: StartupResult) => {
        if (cancelled) return;
        setStatus(result.status);
        setDatabases(result.databases);
        setActiveId(result.activeId);
        setInitError(null);
      })
      .catch((err: unknown) => {
        // A restart may cancel the very first startup; restart() resolves its own.
        if (err instanceof Error && err.name === "CancelledError") return;
        if (!cancelled) {
          setInitError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tabLock, database]);

  // Quota / persistence display (plan §5.5).
  useEffect(() => {
    if (tabLock !== "owned") return;
    let cancelled = false;
    getStorageInfo().then((info) => {
      if (!cancelled) setStorageInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, [tabLock]);

  const refreshDatabases = useCallback(async () => {
    const [list, freshStatus] = await Promise.all([database.listDatabases(), manager.status()]);
    setDatabases(list);
    setStatus(freshStatus);
    setActiveId(manager.activeFilename ? idFromDbFileName(manager.activeFilename) : null);
  }, [database, manager]);

  const runDbOp = useCallback(
    async (op: () => Promise<unknown>) => {
      setDbBusy(true);
      setDbOpError(null);
      try {
        await op();
        await refreshDatabases();
      } catch (err) {
        if (err instanceof DbOperationError) {
          const guidance = describeDbError(err.code, err.message);
          setDbOpError(`${guidance.message} ${guidance.nextStep}`);
        } else {
          setDbOpError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setDbBusy(false);
      }
    },
    [refreshDatabases],
  );

  const retryLock = useCallback(async () => {
    setTabLock("pending");
    const res = await retryTabLock();
    if (res.granted) {
      setLockUnsupported(res.unsupported);
      setTabLock("owned");
    } else {
      setTabLock("blocked");
    }
  }, []);

  // Plan §5.2 rule 6: the failing statement's document position, derived from
  // the run snapshot (SQLite's offset is statement-relative, plan §5.2 rule 1).
  const errorPosition = useMemo<ErrorPosition | null>(() => {
    if (!response || !runContext) return null;
    for (let i = 0; i < response.statements.length; i += 1) {
      const s = response.statements[i];
      if (s.kind !== "error") continue;
      if (s.error.offset === undefined || s.error.offset < 0) return { index: i, position: null };
      const rel = byteOffsetToJsIndex(s.span.text, s.error.offset);
      const abs = runContext.docStart + s.span.start + rel;
      return { index: i, position: indexToLineColumn(runContext.doc, abs) };
    }
    return null;
  }, [response, runContext]);

  const handleSqlChange = useCallback((next: string) => {
    setSql(next);
    setErrorMark(null); // the mark tracks the last run; editing invalidates it.
  }, []);

  const run = useCallback(async () => {
    const sel = selection;
    const useSelection = sel !== null && sel.text.trim() !== "";
    const script = useSelection && sel ? sel.text : sql;
    const docStart = useSelection && sel ? sel.from : 0;
    setRunning(true);
    setRunError(null);
    setRestartTxNotice(false);
    try {
      const res = await database.execute(script);
      setResponse(res);
      setRunContext({ doc: sql, docStart });
      const err = res.statements.find((s) => s.kind === "error");
      setErrorMark(
        err && err.kind === "error" && err.error.offset !== undefined
          ? computeErrorMark(script, docStart, err.span, err.error.offset)
          : null,
      );
    } catch (err) {
      setResponse(null);
      setRunContext(null);
      setErrorMark(null);
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [database, sql, selection]);

  const explain = useCallback(async () => {
    const sel = selection;
    const script = sel !== null && sel.text.trim() !== "" ? sel.text : sql;
    setExplaining(true);
    setPlanError(null);
    try {
      const p = await database.explain(script);
      setPlan(p);
    } catch (err) {
      setPlan(null);
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setExplaining(false);
    }
  }, [database, sql, selection]);

  // Open-transaction actions (plan §5.2 rule 6): nothing rolls back silently.
  const runTransactionCommand = useCallback(
    async (command: "COMMIT" | "ROLLBACK") => {
      setTxBusy(true);
      setRunError(null);
      setRestartTxNotice(false);
      try {
        const script = `${command};`;
        const res = await database.execute(script);
        setResponse(res);
        setRunContext({ doc: script, docStart: 0 });
        setErrorMark(null); // synthetic script: never mark the editor with it.
      } catch (err) {
        setRunError(err instanceof Error ? err.message : String(err));
      } finally {
        setTxBusy(false);
      }
    },
    [database],
  );

  const restartWorker = useCallback(async () => {
    const hadOpenTransaction = response?.inTransaction ?? false;
    setRestarting(true);
    setInitError(null);
    setRestartMs(null); // reappearing = restart finished (e2e waits on it)
    const start = performance.now();
    try {
      const s = await manager.restart();
      setRestartMs(performance.now() - start);
      setStatus(s);
      setResponse(null);
      setRunContext(null);
      setErrorMark(null);
      // ADR-004: SQLite rolls back an open transaction when the connection
      // dies — say so instead of losing the indicator silently.
      setRestartTxNotice(hadOpenTransaction);
      // runError is kept: an in-flight run surfaces "Query cancelled; worker
      // restarted." here (ADR-004) and must not be swallowed by this restart.
    } catch (err) {
      setInitError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  }, [manager, response]);

  const exportDb = useCallback(async () => {
    setExporting(true);
    setExportInfo(null);
    try {
      const { bytes, name } = await manager.exportDb();
      const header = new TextDecoder().decode(bytes.slice(0, 16));
      const ok = header.startsWith("SQLite format 3");
      setExportInfo(
        `exported ${name} · ${bytes.byteLength} bytes · header ${ok ? "OK" : "INVALID"}`,
      );
    } catch (err) {
      setExportInfo(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [manager]);

  const requestPersist = useCallback(async () => {
    await requestPersistentStorage();
    setStorageInfo(await getStorageInfo());
  }, []);

  if (tabLock === "blocked") {
    return <TabBlockedScreen onRetry={() => void retryLock()} />;
  }

  const activeDatabase = databases.find((d) => d.id === activeId) ?? null;
  const hasSelection = selection !== null && selection.text.trim() !== "";

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h1 className="text-base font-semibold tracking-tight">SQL Playground</h1>
        <div className="flex items-center gap-3 text-xs" data-testid="status-bar">
          {tabLock === "pending" ? (
            <span data-testid="lock-pending" className="text-neutral-500">
              acquiring tab lock…
            </span>
          ) : initError ? (
            <span className="text-red-400" data-testid="init-error">
              init failed: {initError}
            </span>
          ) : status ? (
            <>
              <span data-testid="ready" className="text-emerald-400">
                ready
              </span>
              <span className="text-neutral-400" data-testid="sqlite-version">
                SQLite {status.sqliteVersion}
              </span>
              <span
                data-testid="persistence"
                className={status.persistent ? "text-emerald-400" : "text-amber-400"}
              >
                {status.persistent ? "OPFS persistent" : "in-memory (not persistent)"}
              </span>
              <span className="text-neutral-400" data-testid="toolkit">
                toolkit: {status.toolkit}
              </span>
              <span className="text-neutral-400" data-testid="journal">
                journal: {status.journalMode}
              </span>
              {status.persistent && status.poolCapacity !== null ? (
                <span className="text-neutral-500" data-testid="pool">
                  pool {status.poolFileCount}/{status.poolCapacity}
                </span>
              ) : null}
              {lockUnsupported ? (
                <span className="text-amber-300" data-testid="lock-unsupported">
                  multi-tab guard unavailable
                </span>
              ) : null}
              {!status.persistent && (
                <span className="text-amber-300">
                  Browser storage unavailable — data will not survive reload.
                </span>
              )}
            </>
          ) : (
            <span data-testid="loading" className="text-neutral-500">
              initializing SQLite…
            </span>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_320px] overflow-hidden">
        {/* Explorer sidebar (plan §5.1) */}
        <aside className="min-h-0 border-r border-neutral-800">
          <DatabaseExplorer
            databases={databases}
            activeId={activeId}
            busy={dbBusy || tabLock !== "owned"}
            error={dbOpError}
            storageInfo={storageInfo}
            onOpen={(id) => void runDbOp(() => database.openDatabase(id))}
            onCreate={(name) => void runDbOp(() => database.createDatabase(name))}
            onRename={(id, name) => void runDbOp(() => database.renameDatabase(id, name))}
            onDelete={(id) => void runDbOp(() => database.deleteDatabase(id))}
            onRequestPersistence={() => void requestPersist()}
          />
        </aside>

        {/* Center: editor over results */}
        <div className="grid min-h-0 grid-rows-2">
          <section className="flex min-h-0 flex-col border-b border-neutral-800">
            <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
              <span>
                SQL editor
                {activeDatabase ? (
                  <span className="ml-2 text-neutral-500">
                    · <span className="text-neutral-300">{activeDatabase.name}</span>
                  </span>
                ) : null}
                <span className="ml-2 text-neutral-600">
                  ⌘/Ctrl+Enter run · ⇧⌘/Ctrl+Enter explain
                </span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="restart-worker"
                  onClick={() => void restartWorker()}
                  disabled={restarting || tabLock !== "owned"}
                  className="rounded bg-neutral-700 px-2 py-1.5 font-medium text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
                >
                  {restarting ? "Restarting…" : "Restart worker"}
                </button>
                <button
                  type="button"
                  data-testid="export-button"
                  onClick={() => void exportDb()}
                  disabled={exporting || !status}
                  className="rounded bg-neutral-700 px-2 py-1.5 font-medium text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
                >
                  {exporting ? "Exporting…" : "Export"}
                </button>
                <button
                  type="button"
                  data-testid="explain-button"
                  onClick={() => void explain()}
                  disabled={explaining || running || !status}
                  className="rounded bg-violet-700 px-2 py-1.5 font-medium text-white hover:bg-violet-600 disabled:opacity-40"
                >
                  {explaining ? "Explaining…" : "Explain"}
                </button>
                {running && (
                  <button
                    type="button"
                    data-testid="cancel-button"
                    onClick={() => void restartWorker()}
                    disabled={restarting}
                    className="rounded bg-red-800 px-2 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  data-testid="run-button"
                  onClick={() => void run()}
                  disabled={running || !status}
                  className="rounded bg-sky-700 px-3 py-1.5 font-medium text-white hover:bg-sky-600 disabled:opacity-40"
                >
                  {running ? "Running…" : hasSelection ? "Run selection (⌘↵)" : "Run (⌘↵)"}
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <SqlEditor
                value={sql}
                onChange={handleSqlChange}
                onRun={() => void run()}
                onExplain={() => void explain()}
                onSelectionChange={setSelection}
                errorMark={errorMark}
              />
            </div>
          </section>

          <section className="flex min-h-0 flex-col overflow-hidden">
            <div className="border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
              Results
              {restartMs !== null && (
                <span className="ml-2 text-emerald-400" data-testid="restart-ms">
                  {restartMs.toFixed(0)} ms
                </span>
              )}
              {restartTxNotice && (
                <span className="ml-2 text-orange-300" data-testid="restart-transaction-notice">
                  SQLite rolled back your open transaction (worker restarted)
                </span>
              )}
              {response && (
                <span className="ml-2 text-neutral-500">
                  {response.statements.length} statement
                  {response.statements.length === 1 ? "" : "s"} ·{" "}
                  {response.totalEngineMs.toFixed(2)} ms total
                </span>
              )}
              {response?.inTransaction && (
                <span
                  className="ml-2 inline-flex items-center gap-1.5"
                  data-testid="open-transaction"
                >
                  <span className="text-amber-400">open transaction</span>
                  <button
                    type="button"
                    data-testid="commit-button"
                    onClick={() => void runTransactionCommand("COMMIT")}
                    disabled={running || txBusy}
                    className="rounded bg-amber-800 px-1.5 py-0.5 font-medium text-amber-100 hover:bg-amber-700 disabled:opacity-40"
                  >
                    Commit
                  </button>
                  <button
                    type="button"
                    data-testid="rollback-button"
                    onClick={() => void runTransactionCommand("ROLLBACK")}
                    disabled={running || txBusy}
                    className="rounded bg-neutral-700 px-1.5 py-0.5 font-medium text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
                  >
                    Rollback
                  </button>
                </span>
              )}
              {response?.rolledBackBySqlite && (
                <span className="ml-2 text-orange-400" data-testid="sqlite-rolled-back">
                  SQLite rolled back your transaction
                </span>
              )}
              {exportInfo && (
                <span className="ml-2 text-neutral-500" data-testid="export-result">
                  {exportInfo}
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" data-testid="results">
              {runError && (
                <div
                  className="rounded border border-red-700 bg-red-950/40 p-3 text-sm text-red-200"
                  data-testid="run-error"
                >
                  {runError}
                </div>
              )}
              {!runError && !response && (
                <p className="text-sm text-neutral-500">
                  Run SQL to see per-statement results, timing, and transaction state. Explain
                  parses the query plan in the worker (Rust wasm or TS fallback). Databases persist
                  in OPFS across reloads when available.
                </p>
              )}
              {response && (
                <StatementBlockList
                  statements={response.statements}
                  errorPosition={errorPosition}
                />
              )}
            </div>
          </section>
        </div>

        {/* Analysis panel */}
        <aside className="min-h-0 space-y-3 overflow-y-auto border-l border-neutral-800 p-3">
          <div className="text-xs font-medium text-neutral-400">Analysis</div>
          {planError && (
            <div
              className="rounded border border-red-700 bg-red-950/40 p-3 text-sm text-red-200"
              data-testid="plan-error"
            >
              explain failed: {planError}
            </div>
          )}
          {plan ? (
            <PlanPanel plan={plan} />
          ) : !planError ? (
            <p className="text-sm text-neutral-500">
              Run Explain to see how SQLite processes the query: scans, searches, and index usage,
              with the raw plan output preserved.
            </p>
          ) : null}
        </aside>
      </div>

      <footer className="border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-500">
        Browser-only SQLite · no server · statement policy blocks ATTACH and VACUUM INTO · tab guard
        holds the storage lock
      </footer>
    </div>
  );
}
