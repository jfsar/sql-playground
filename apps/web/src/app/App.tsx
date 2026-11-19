import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TabBlockedScreen } from "./TabBlockedScreen";
import { DatabaseExplorer } from "../features/database-explorer/DatabaseExplorer";
import { SchemaExplorer } from "../features/database-explorer/SchemaExplorer";
import { TableBrowser } from "../features/database-explorer/TableBrowser";
import { ImportDatabaseDialog } from "../features/database-import/ImportDatabaseDialog";
import { BackupReminder } from "../features/database-export/BackupReminder";
import { HistoryPanel } from "../features/query-history/HistoryPanel";
import { PlanDiffView } from "../features/query-analysis/PlanDiffView";
import { PlanPanel } from "../features/query-analysis/PlanPanel";
import { StatementBlock } from "../features/query-results/StatementBlock";
import { SqlEditor, type SqlSelection } from "../features/sql-editor/SqlEditor";
import { DatabaseService, type StartupResult } from "../services/database/databaseService";
import { QueryHistoryService } from "../services/history/queryHistoryService";
import {
  getStorageInfo,
  requestPersistentStorage,
  type StorageInfo,
} from "../services/storage/quota";
import {
  dismissBackupReminder,
  getBackupStatus,
  recordBackup,
  type BackupStatus,
} from "../services/storage/backupReminder";
import { idFromDbFileName } from "../services/storage/reconcile";
import { StorageService } from "../services/storage/storageService";
import {
  createIdbHistoryStore,
  createIdbMetadataStore,
  type HistoryEntry,
} from "../services/storage/metadataDb";
import { acquireTabLock, retryTabLock } from "../services/storage/tabGuard";
import { DbOperationError, describeDbError } from "../shared/errors";
import {
  byteOffsetToJsIndex,
  computeErrorMark,
  indexToLineColumn,
  type LineColumn,
} from "../shared/textPosition";
import { WorkerManager } from "../services/worker/workerManager";
import {
  TABLE_PAGE_SIZE,
  type DatabaseInfo,
  type DatabaseSchema,
  type ExecutionResponse,
  type PlanDiff,
  type QueryPlan,
  type StatementResult,
  type TablePage,
  type WorkerStatus,
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

let sharedHistory: QueryHistoryService | null = null;
function getSharedHistory(): QueryHistoryService {
  if (!sharedHistory) {
    sharedHistory = new QueryHistoryService({ store: createIdbHistoryStore() });
  }
  return sharedHistory;
}

type RightTab = "analysis" | "history";

interface BrowseState {
  table: string;
  offset: number;
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

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportFileName(name: string): string {
  const safe = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ");
  return `${safe.length > 0 ? safe : "database"}.sqlite3`;
}

function formatElapsed(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

export default function App() {
  const managerRef = useRef<WorkerManager | null>(null);
  const databaseRef = useRef<DatabaseService | null>(null);
  const historyRef = useRef<QueryHistoryService | null>(null);
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
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runElapsedMs, setRunElapsedMs] = useState(0);
  const cancelRequestRef = useRef<string | null>(null);
  const [plan, setPlan] = useState<QueryPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [pinnedPlan, setPinnedPlan] = useState<{ plan: QueryPlan; sql: string } | null>(null);
  const [planDiff, setPlanDiff] = useState<PlanDiff | null>(null);
  const [planDiffError, setPlanDiffError] = useState<string | null>(null);
  const [diffing, setDiffing] = useState(false);
  const [restartMs, setRestartMs] = useState<number | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [exportInfo, setExportInfo] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [backupStatus, setBackupStatus] = useState<BackupStatus>(() => getBackupStatus(Date.now()));
  const [selection, setSelection] = useState<SqlSelection | null>(null);
  const [errorMark, setErrorMark] = useState<{ from: number; to: number } | null>(null);
  // Snapshot of what was executed, so error line/column stays anchored to the
  // document (or selection) that produced the results.
  const [runContext, setRunContext] = useState<{ doc: string; docStart: number } | null>(null);
  const [restartTxNotice, setRestartTxNotice] = useState(false);
  const [txBusy, setTxBusy] = useState(false);
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [schemaBusy, setSchemaBusy] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [browse, setBrowse] = useState<BrowseState | null>(null);
  const [tablePage, setTablePage] = useState<TablePage | null>(null);
  const [tableBusy, setTableBusy] = useState(false);
  const [tableError, setTableError] = useState<string | null>(null);
  const [tableVersion, setTableVersion] = useState(0);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyEnabled, setHistoryEnabled] = useState(true);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("analysis");

  if (!managerRef.current) managerRef.current = getSharedManager();
  if (!databaseRef.current) databaseRef.current = getSharedDatabase();
  if (!historyRef.current) historyRef.current = getSharedHistory();
  const manager = managerRef.current;
  const database = databaseRef.current;
  const history = historyRef.current;

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
    setBackupStatus(getBackupStatus(Date.now()));
    return () => {
      cancelled = true;
    };
  }, [tabLock]);

  // Long-query UX (plan §5.4): a visible elapsed timer while work is running.
  useEffect(() => {
    if (!running || runStartedAt === null) {
      setRunElapsedMs(0);
      return;
    }
    setRunElapsedMs(performance.now() - runStartedAt);
    const timer = setInterval(() => {
      setRunElapsedMs(performance.now() - runStartedAt);
    }, 100);
    return () => clearInterval(timer);
  }, [running, runStartedAt]);

  // Query history: load the opt-out preference and the newest entries once.
  useEffect(() => {
    if (tabLock !== "owned") return;
    let cancelled = false;
    Promise.all([history.isEnabled(), history.list()])
      .then(([enabled, entries]) => {
        if (cancelled) return;
        setHistoryEnabled(enabled);
        setHistoryEntries(entries);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setHistoryError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [history, tabLock]);

  // Schema follows the active database, and refreshes after runs (DDL) or the
  // explorer's explicit Refresh.
  useEffect(() => {
    if (tabLock !== "owned" || !activeId) {
      setSchema(null);
      return;
    }
    let cancelled = false;
    setSchemaBusy(true);
    setSchemaError(null);
    database
      .getSchema()
      .then((next) => {
        if (!cancelled) setSchema(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setSchemaError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setSchemaBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, database, schemaVersion, tabLock]);

  // Switching databases closes the table browser so it never shows stale data.
  useEffect(() => {
    setBrowse(null);
  }, [activeId]);

  // A plan belongs to the database it was explained against; never compare
  // plans across a database switch.
  useEffect(() => {
    setPlan(null);
    setPlanError(null);
    setPinnedPlan(null);
    setPlanDiff(null);
    setPlanDiffError(null);
  }, [activeId]);

  // One page at a time; a new table/offset cancels the previous result.
  useEffect(() => {
    if (!browse) {
      setTablePage(null);
      setTableError(null);
      return;
    }
    let cancelled = false;
    setTableBusy(true);
    setTableError(null);
    database
      .browseTable(browse.table, { limit: TABLE_PAGE_SIZE, offset: browse.offset })
      .then((page) => {
        if (!cancelled) setTablePage(page);
      })
      .catch((err: unknown) => {
        if (!cancelled) setTableError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setTableBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [browse, database, tableVersion]);

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

  const loadSql = useCallback(
    (next: string) => {
      handleSqlChange(next);
      setSelection(null);
    },
    [handleSqlChange],
  );

  const recordHistory = useCallback(
    async (script: string, ok: boolean, engineMs: number) => {
      try {
        const stored = await history.record(script, { ok, engineMs });
        if (stored) {
          setHistoryEntries(await history.list());
          setHistoryError(null);
        }
      } catch (err) {
        // History must never break execution.
        setHistoryError(err instanceof Error ? err.message : String(err));
      }
    },
    [history],
  );

  const run = useCallback(async () => {
    const sel = selection;
    const useSelection = sel !== null && sel.text.trim() !== "";
    const script = useSelection && sel ? sel.text : sql;
    const docStart = useSelection && sel ? sel.from : 0;
    const requestId = crypto.randomUUID();
    cancelRequestRef.current = requestId;
    setRunning(true);
    setRunStartedAt(performance.now());
    setRunError(null);
    setRestartTxNotice(false);
    try {
      const res = await database.execute(script, { requestId });
      setResponse(res);
      setRunContext({ doc: sql, docStart });
      const err = res.statements.find((s) => s.kind === "error");
      setErrorMark(
        err && err.kind === "error" && err.error.offset !== undefined
          ? computeErrorMark(script, docStart, err.span, err.error.offset)
          : null,
      );
      setSchemaVersion((version) => version + 1);
      setTableVersion((version) => version + 1);
      void recordHistory(script, !err, res.totalEngineMs);
    } catch (err) {
      setResponse(null);
      setRunContext(null);
      setErrorMark(null);
      if (err instanceof DbOperationError) {
        const guidance = describeDbError(err.code, err.message);
        setRunError(`${guidance.message} ${guidance.nextStep}`);
        if (err.code === "WORKER_CRASHED") {
          // Crash auto-recovery started in the manager; refresh the status so
          // the UI stops showing the pre-crash worker state.
          void manager
            .status()
            .then(setStatus)
            .catch(() => undefined);
        }
      } else {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (cancelRequestRef.current === requestId) cancelRequestRef.current = null;
      setRunning(false);
      setRunStartedAt(null);
    }
  }, [database, recordHistory, sql, selection, manager]);

  const explain = useCallback(async () => {
    const sel = selection;
    const script = sel !== null && sel.text.trim() !== "" ? sel.text : sql;
    setExplaining(true);
    setPlanError(null);
    setPlanDiffError(null);
    try {
      const p = await database.explain(script);
      setPlan(p);
      if (pinnedPlan) {
        setDiffing(true);
        try {
          setPlanDiff(await database.diffPlans(pinnedPlan.plan, p));
        } catch (err) {
          setPlanDiff(null);
          setPlanDiffError(err instanceof Error ? err.message : String(err));
        } finally {
          setDiffing(false);
        }
      } else {
        setPlanDiff(null);
      }
    } catch (err) {
      setPlan(null);
      setPlanDiff(null);
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setExplaining(false);
    }
  }, [database, sql, selection, pinnedPlan]);

  // Plan comparison lite (plan §4, scenario 19): the pin lives in page state
  // only; the diff itself runs in the worker's PlanToolkit.
  const togglePinPlan = useCallback(() => {
    if (pinnedPlan) {
      setPinnedPlan(null);
      setPlanDiff(null);
      setPlanDiffError(null);
      return;
    }
    if (!plan) return;
    const sel = selection;
    const script = sel !== null && sel.text.trim() !== "" ? sel.text : sql;
    setPinnedPlan({ plan, sql: script });
    setPlanDiff(null);
    setPlanDiffError(null);
  }, [pinnedPlan, plan, selection, sql]);

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

  const recoverWorker = useCallback(
    async (recover: () => Promise<unknown>) => {
      const hadOpenTransaction = response?.inTransaction ?? false;
      setRestarting(true);
      setInitError(null);
      setRestartMs(null); // reappearing = restart finished (e2e waits on it)
      const start = performance.now();
      try {
        await recover();
        setRestartMs(performance.now() - start);
        const s = await manager.status();
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
    },
    [manager, response],
  );

  const restartWorker = useCallback(
    () => recoverWorker(() => manager.restart()),
    [manager, recoverWorker],
  );

  // Plan §5.3/§5.4: cancel this run by id. The manager restarts only if the
  // request is in flight and reopens the database; queued work is rejected.
  const cancelRun = useCallback(() => {
    const requestId = cancelRequestRef.current;
    return recoverWorker(() => (requestId ? database.cancel(requestId) : manager.restart()));
  }, [database, manager, recoverWorker]);

  const exportActiveDatabase = useCallback(async () => {
    const target = databases.find((database) => database.id === activeId);
    if (!target) {
      setExportInfo("No database is open to export.");
      return;
    }
    setExporting(true);
    setExportInfo(null);
    try {
      const blob = await database.exportDatabase(target.id);
      const filename = exportFileName(target.name);
      downloadBlob(blob, filename);
      recordBackup(Date.now());
      setBackupStatus(getBackupStatus(Date.now()));
      setExportInfo(`exported ${filename} · ${blob.size} bytes`);
      if (!storageInfo || !storageInfo.persisted) {
        setStorageInfo(await getStorageInfo());
      }
    } catch (err) {
      setExportInfo(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [activeId, database, databases, storageInfo]);

  const handleImported = useCallback(() => {
    void refreshDatabases();
    setSchemaVersion((version) => version + 1);
    setTableVersion((version) => version + 1);
    setBackupStatus(getBackupStatus(Date.now()));
  }, [refreshDatabases]);

  const importDatabaseFile = useCallback(
    (file: File, opts: { name: string; storageInfo: StorageInfo | null }) =>
      database.importDatabase(file, {
        name: opts.name,
        storageInfo: opts.storageInfo ?? undefined,
      }),
    [database],
  );

  const importScriptFile = useCallback(
    (file: File, opts: { targetId?: string; name?: string }) => database.importScript(file, opts),
    [database],
  );

  const dismissBackup = useCallback(() => {
    const now = Date.now();
    dismissBackupReminder(now);
    setBackupStatus(getBackupStatus(now));
  }, []);

  const requestPersist = useCallback(async () => {
    await requestPersistentStorage();
    setStorageInfo(await getStorageInfo());
  }, []);

  const toggleHistory = useCallback(
    async (enabled: boolean) => {
      setHistoryBusy(true);
      setHistoryError(null);
      try {
        await history.setEnabled(enabled);
        setHistoryEnabled(enabled);
        setHistoryEntries(await history.list());
      } catch (err) {
        setHistoryError(err instanceof Error ? err.message : String(err));
      } finally {
        setHistoryBusy(false);
      }
    },
    [history],
  );

  const clearHistory = useCallback(async () => {
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      await history.clear();
      setHistoryEntries([]);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setHistoryBusy(false);
    }
  }, [history]);

  const refreshSchema = useCallback(() => {
    setSchemaVersion((version) => version + 1);
  }, []);

  const openTable = useCallback((table: string) => {
    setBrowse({ table, offset: 0 });
  }, []);

  const closeTable = useCallback(() => {
    setBrowse(null);
  }, []);

  const goToTablePage = useCallback((offset: number) => {
    setBrowse((current) => (current ? { ...current, offset: Math.max(0, offset) } : current));
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
        <aside className="flex min-h-0 flex-col border-r border-neutral-800">
          <BackupReminder
            status={backupStatus}
            onExport={() => void exportActiveDatabase()}
            onDismiss={dismissBackup}
          />
          <div className="flex min-h-0 basis-[45%] shrink-0 flex-col overflow-hidden">
            <DatabaseExplorer
              databases={databases}
              activeId={activeId}
              busy={dbBusy || tabLock !== "owned"}
              error={dbOpError}
              storageInfo={storageInfo}
              onOpen={(id) => void runDbOp(() => database.openDatabase(id))}
              onCreate={(name) => void runDbOp(() => database.createDatabase(name))}
              onCreateSample={() => void runDbOp(() => database.createSampleDatabase())}
              onImport={() => setImportOpen(true)}
              onRename={(id, name) => void runDbOp(() => database.renameDatabase(id, name))}
              onDelete={(id) => void runDbOp(() => database.deleteDatabase(id))}
              onRequestPersistence={() => void requestPersist()}
            />
          </div>
          <SchemaExplorer
            schema={schema}
            activeDatabase={activeDatabase}
            busy={schemaBusy}
            error={schemaError}
            onRefresh={refreshSchema}
            onBrowse={openTable}
            onLoadQuery={loadSql}
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
                  onClick={() => void exportActiveDatabase()}
                  disabled={exporting || !status || !activeId}
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
                  <>
                    <span
                      data-testid="run-elapsed"
                      aria-live="off"
                      className="text-xs tabular-nums text-neutral-400"
                    >
                      {formatElapsed(runElapsedMs)}
                    </span>
                    <button
                      type="button"
                      data-testid="cancel-button"
                      onClick={() => void cancelRun()}
                      disabled={restarting}
                      className="rounded bg-red-800 px-2 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-40"
                    >
                      Cancel
                    </button>
                  </>
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
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
              <div className="flex items-center gap-1" role="tablist" aria-label="Results view">
                <button
                  type="button"
                  role="tab"
                  data-testid="results-tab"
                  aria-selected={browse === null}
                  onClick={closeTable}
                  className={`rounded px-2 py-1 font-medium ${
                    browse === null
                      ? "bg-neutral-800 text-neutral-100"
                      : "text-neutral-400 hover:bg-neutral-900"
                  }`}
                >
                  Results
                </button>
                {browse ? (
                  <button
                    type="button"
                    role="tab"
                    data-testid="table-tab"
                    aria-selected="true"
                    className="rounded bg-neutral-800 px-2 py-1 font-medium text-neutral-100"
                  >
                    Table: {browse.table}
                  </button>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {restartMs !== null && (
                  <span className="text-emerald-400" data-testid="restart-ms">
                    {restartMs.toFixed(0)} ms
                  </span>
                )}
                {restartTxNotice && (
                  <span className="text-orange-300" data-testid="restart-transaction-notice">
                    SQLite rolled back your open transaction (worker restarted)
                  </span>
                )}
                {response && (
                  <span className="text-neutral-500">
                    {response.statements.length} statement
                    {response.statements.length === 1 ? "" : "s"} ·{" "}
                    {response.totalEngineMs.toFixed(2)} ms total
                  </span>
                )}
                {response?.inTransaction && (
                  <span className="inline-flex items-center gap-1.5" data-testid="open-transaction">
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
                  <span className="text-orange-400" data-testid="sqlite-rolled-back">
                    SQLite rolled back your transaction
                  </span>
                )}
                {exportInfo && (
                  <span className="text-neutral-500" data-testid="export-result">
                    {exportInfo}
                  </span>
                )}
              </div>
            </div>
            {browse ? (
              <TableBrowser
                table={browse.table}
                page={tablePage}
                loading={tableBusy}
                error={tableError}
                onPage={goToTablePage}
                onClose={closeTable}
              />
            ) : (
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
                    parses the query plan in the worker (Rust wasm or TS fallback). Databases
                    persist in OPFS across reloads when available.
                  </p>
                )}
                {response && (
                  <StatementBlockList
                    statements={response.statements}
                    errorPosition={errorPosition}
                  />
                )}
              </div>
            )}
          </section>
        </div>

        {/* Analysis / history panel */}
        <aside className="flex min-h-0 flex-col gap-3 border-l border-neutral-800 p-3">
          <div className="flex items-center gap-1" role="tablist" aria-label="Side panel">
            <button
              type="button"
              role="tab"
              data-testid="analysis-tab"
              aria-selected={rightTab === "analysis"}
              onClick={() => setRightTab("analysis")}
              className={`rounded px-2 py-1 text-xs font-medium ${
                rightTab === "analysis"
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-900"
              }`}
            >
              Analysis
            </button>
            <button
              type="button"
              role="tab"
              data-testid="history-tab"
              aria-selected={rightTab === "history"}
              onClick={() => setRightTab("history")}
              className={`rounded px-2 py-1 text-xs font-medium ${
                rightTab === "history"
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-900"
              }`}
            >
              History
              {historyEntries.length > 0 ? (
                <span className="ml-1 text-[10px] text-neutral-500">{historyEntries.length}</span>
              ) : null}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rightTab === "analysis" ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-neutral-500">
                    Pin a plan, change the schema, then Explain again to compare.
                  </span>
                  <button
                    type="button"
                    data-testid="pin-plan-button"
                    onClick={togglePinPlan}
                    disabled={!plan || explaining || diffing}
                    className="rounded bg-amber-800 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-40"
                  >
                    {pinnedPlan ? "Unpin plan" : "Pin plan"}
                  </button>
                </div>
                {pinnedPlan ? (
                  <div
                    data-testid="pinned-plan"
                    className="rounded border border-amber-900 bg-amber-950/20 p-2 text-xs"
                  >
                    <div className="font-semibold text-amber-300">
                      Pinned plan · SQLite {pinnedPlan.plan.sqliteVersion}
                    </div>
                    <div className="mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-neutral-400">
                      {pinnedPlan.sql}
                    </div>
                  </div>
                ) : null}
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
                    Run Explain to see how SQLite processes the query: scans, searches, and index
                    usage, with the raw plan output preserved.
                  </p>
                ) : null}
                {diffing ? (
                  <p className="text-xs text-neutral-400" data-testid="plan-diff-busy">
                    Comparing plans…
                  </p>
                ) : null}
                {planDiffError ? (
                  <div
                    className="rounded border border-red-700 bg-red-950/40 p-2 text-xs text-red-200"
                    data-testid="plan-diff-error"
                  >
                    plan comparison failed: {planDiffError}
                  </div>
                ) : null}
                {planDiff ? <PlanDiffView diff={planDiff} /> : null}
                {pinnedPlan && plan && !planDiff && !diffing && !planDiffError ? (
                  <p className="text-xs text-neutral-500" data-testid="plan-diff-hint">
                    The current plan is pinned. Change the schema and run Explain again to see a
                    node-level diff.
                  </p>
                ) : null}
              </div>
            ) : (
              <HistoryPanel
                entries={historyEntries}
                enabled={historyEnabled}
                busy={historyBusy}
                error={historyError}
                onLoad={loadSql}
                onToggleEnabled={(enabled) => void toggleHistory(enabled)}
                onClear={() => void clearHistory()}
              />
            )}
          </div>
        </aside>
      </div>

      <ImportDatabaseDialog
        open={importOpen}
        databases={databases}
        storageInfo={storageInfo}
        onClose={() => setImportOpen(false)}
        onImportDatabase={importDatabaseFile}
        onImportScript={importScriptFile}
        onImported={handleImported}
      />

      <footer className="border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-500">
        Browser-only SQLite · no server · statement policy blocks ATTACH and VACUUM INTO · tab guard
        holds the storage lock
      </footer>
    </div>
  );
}
