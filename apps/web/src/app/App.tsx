import { useCallback, useEffect, useRef, useState } from "react";
import { acquireTabLock, retryTabLock } from "../services/storage/tabGuard";
import { WorkerManager } from "../services/worker/workerManager";
import type {
  ExecutionResponse,
  QueryPlan,
  StatementResult,
  WorkerStatus,
} from "../shared/contracts";

const DEFAULT_SQL = `-- Week 2 PoC: run SQL, then Explain / Restart worker / Export
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

function formatValue(v: unknown): string {
  if (v === null) return "NULL";
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength} bytes>`;
  if (typeof v === "bigint") return `${v}n`;
  return String(v);
}

function StatementBlock({ result, index }: { result: StatementResult; index: number }) {
  if (result.kind === "error") {
    return (
      <div
        data-testid={`stmt-error-${index}`}
        className="rounded border border-red-700 bg-red-950/40 p-3 text-sm"
      >
        <div className="font-semibold text-red-300">
          Statement {index + 1} failed · {result.error.code}
        </div>
        <div className="mt-1 text-red-200">{result.error.message}</div>
        <pre className="mt-2 overflow-x-auto rounded bg-black/30 p-2 text-red-100">
          {result.span.text}
        </pre>
        {result.error.offset !== undefined && (
          <div className="mt-1 text-red-300/80">offset: {result.error.offset}</div>
        )}
      </div>
    );
  }

  if (result.kind === "change") {
    return (
      <div
        data-testid={`stmt-change-${index}`}
        className="rounded border border-neutral-700 bg-neutral-900 p-3 text-sm"
      >
        <div className="font-semibold text-emerald-300">
          Statement {index + 1} · change · {result.engineMs.toFixed(2)} ms
        </div>
        <div className="mt-1 text-neutral-300">
          {result.rowsAffected !== undefined
            ? `rows affected: ${result.rowsAffected}`
            : "no row count (DDL/PRAGMA)"}
        </div>
        <pre className="mt-2 overflow-x-auto text-neutral-400">{result.sql}</pre>
      </div>
    );
  }

  return (
    <div
      data-testid={`stmt-rows-${index}`}
      className="rounded border border-neutral-700 bg-neutral-900 p-3 text-sm"
    >
      <div className="font-semibold text-sky-300">
        Statement {index + 1} · {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
        {result.truncated ? " (truncated)" : ""} · {result.engineMs.toFixed(2)} ms
      </div>
      <div className="mt-1 text-neutral-400">engine time (first {result.rows.length} rows)</div>
      <div className="mt-2 overflow-x-auto">
        <table className="min-w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-neutral-700">
              {result.columns.map((c) => (
                <th key={c.name} className="px-2 py-1 font-medium text-neutral-200">
                  {c.name}
                  {c.declaredType ? (
                    <span className="ml-1 font-normal text-neutral-500">{c.declaredType}</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, ri) => (
              <tr key={ri} className="border-b border-neutral-800/60">
                {row.map((cell, ci) => (
                  <td key={ci} className="px-2 py-1 font-mono text-neutral-100">
                    {formatValue(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <pre className="mt-2 overflow-x-auto text-neutral-500">{result.sql}</pre>
    </div>
  );
}

function PlanBlock({ plan }: { plan: QueryPlan }) {
  return (
    <div
      data-testid="plan-result"
      className="rounded border border-violet-800 bg-violet-950/30 p-3 text-sm"
    >
      <div className="font-semibold text-violet-300">
        Query plan · {plan.nodes.length} node{plan.nodes.length === 1 ? "" : "s"} · SQLite{" "}
        {plan.sqliteVersion}
      </div>
      <div className="mt-1 text-neutral-400">raw output preserved below the tree</div>
      <ul className="mt-2 space-y-1 font-mono text-neutral-200">
        {plan.nodes.map((n) => (
          <li key={n.id} data-testid={`plan-node-${n.id}`}>
            <span className="text-violet-300">#{n.id}</span>{" "}
            <span className="text-sky-300">{n.operation}</span>
            {n.table ? <span className="text-neutral-100"> {n.table}</span> : null}
            {n.index ? <span className="text-emerald-300"> USING {n.index}</span> : null}
            {n.tags.length > 0 ? (
              <span className="text-amber-300"> [{n.tags.join(", ")}]</span>
            ) : null}
            <span className="text-neutral-500"> — {n.detail}</span>
          </li>
        ))}
      </ul>
      <pre className="mt-2 overflow-x-auto text-neutral-500">
        {plan.raw.map((r) => `${r.id}|${r.parent}|${r.detail}`).join("\n")}
      </pre>
    </div>
  );
}

function TabBlockedScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-center text-neutral-100"
      data-testid="tab-blocked"
    >
      <h1 className="text-lg font-semibold">Already open in another tab</h1>
      <p className="max-w-md text-sm text-neutral-400">
        SQL Playground keeps databases in browser storage that only one tab may use at a time. Close
        the other tab, then retry.
      </p>
      <button
        type="button"
        data-testid="tab-retry"
        onClick={onRetry}
        className="rounded bg-sky-700 px-4 py-2 font-medium text-white hover:bg-sky-600"
      >
        Retry
      </button>
    </div>
  );
}

type TabLockState = "pending" | "owned" | "blocked";

export default function App() {
  const managerRef = useRef<WorkerManager | null>(null);
  const [tabLock, setTabLock] = useState<TabLockState>("pending");
  const [lockUnsupported, setLockUnsupported] = useState(false);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
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

  if (!managerRef.current) {
    managerRef.current = getSharedManager();
  }
  const manager = managerRef.current;

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

  // Init only once the tab owns the storage.
  useEffect(() => {
    if (tabLock !== "owned") return;
    let cancelled = false;
    manager
      .init()
      .then((s) => {
        if (!cancelled) {
          setStatus(s);
          setInitError(null);
        }
      })
      .catch((err: unknown) => {
        // A restart may cancel the very first init; its own restart() resolves status.
        if (err instanceof Error && err.name === "CancelledError") return;
        if (!cancelled) {
          setInitError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tabLock, manager]);

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

  const run = useCallback(async () => {
    setRunning(true);
    setRunError(null);
    try {
      const res = await manager.execute(sql);
      setResponse(res);
    } catch (err) {
      setResponse(null);
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [manager, sql]);

  const explain = useCallback(async () => {
    setExplaining(true);
    setPlanError(null);
    try {
      const p = await manager.explain(sql);
      setPlan(p);
    } catch (err) {
      setPlan(null);
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setExplaining(false);
    }
  }, [manager, sql]);

  const restartWorker = useCallback(async () => {
    setRestarting(true);
    setInitError(null);
    setRestartMs(null); // reappearing = restart finished (e2e waits on it)
    const start = performance.now();
    try {
      const s = await manager.restart();
      setRestartMs(performance.now() - start);
      setStatus(s);
      setResponse(null);
      // runError is kept: an in-flight run surfaces "Query cancelled; worker
      // restarted." here (ADR-004) and must not be swallowed by this restart.
    } catch (err) {
      setInitError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  }, [manager]);

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

  const runOnKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void run();
    }
  };

  if (tabLock === "blocked") {
    return <TabBlockedScreen onRetry={() => void retryLock()} />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h1 className="text-base font-semibold tracking-tight">SQL Playground · Week 2 PoC</h1>
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

      <main className="grid flex-1 grid-cols-2 gap-0 overflow-hidden">
        <section className="flex min-h-0 flex-col border-r border-neutral-800">
          <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
            <span>SQL editor</span>
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
              <button
                type="button"
                data-testid="run-button"
                onClick={() => void run()}
                disabled={running || !status}
                className="rounded bg-sky-700 px-3 py-1.5 font-medium text-white hover:bg-sky-600 disabled:opacity-40"
              >
                {running ? "Running…" : "Run (⌘↵)"}
              </button>
            </div>
          </div>
          <textarea
            data-testid="sql-input"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={runOnKeyDown}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-neutral-950 p-3 font-mono text-sm text-neutral-100 outline-none"
          />
        </section>

        <section className="flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
            Results
            {restartMs !== null && (
              <span className="ml-2 text-emerald-400" data-testid="restart-ms">
                {restartMs.toFixed(0)} ms
              </span>
            )}
            {response && (
              <span className="ml-2 text-neutral-500">
                {response.statements.length} statement
                {response.statements.length === 1 ? "" : "s"} · {response.totalEngineMs.toFixed(2)}{" "}
                ms total
                {response.inTransaction ? (
                  <span className="ml-2 text-amber-400" data-testid="open-transaction">
                    open transaction
                  </span>
                ) : null}
                {response.rolledBackBySqlite ? (
                  <span className="ml-2 text-orange-400" data-testid="sqlite-rolled-back">
                    SQLite rolled back your transaction
                  </span>
                ) : null}
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
            {planError && (
              <div
                className="rounded border border-red-700 bg-red-950/40 p-3 text-sm text-red-200"
                data-testid="plan-error"
              >
                explain failed: {planError}
              </div>
            )}
            {plan && <PlanBlock plan={plan} />}
            {!runError && !plan && !response && (
              <p className="text-sm text-neutral-500">
                Run SQL to see per-statement results, timing, and transaction state. Explain parses
                the query plan in the worker (Rust wasm or TS fallback). Databases persist in OPFS
                across reloads when available.
              </p>
            )}
            {response?.statements.map((r, i) => (
              <StatementBlock key={i} result={r} index={i} />
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-500">
        Browser-only SQLite · no server · statement policy blocks ATTACH and VACUUM INTO · tab guard
        holds the storage lock
      </footer>
    </div>
  );
}
