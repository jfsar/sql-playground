import { useCallback, useEffect, useRef, useState } from "react";
import { WorkerManager } from "../services/worker/workerManager";
import type { ExecutionResponse, StatementResult, WorkerStatus } from "../shared/contracts";

const DEFAULT_SQL = `-- Week 1 PoC: multi-statement script, prepare-loop split, transaction state
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

export default function App() {
  const managerRef = useRef<WorkerManager | null>(null);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [response, setResponse] = useState<ExecutionResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    // StrictMode double-invokes effects. A module-level manager survives the
    // remount so we never terminate a worker mid-init (OPFS pool install).
    if (!managerRef.current) {
      managerRef.current = getSharedManager();
    }
    const manager = managerRef.current;
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
        if (!cancelled) {
          setInitError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
      // Do not terminate: shared manager outlives StrictMode remounts.
      // Workers are torn down when the page unloads.
    };
  }, []);

  const run = useCallback(async () => {
    const manager = managerRef.current;
    if (!manager) return;
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
  }, [sql]);

  const runOnKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void run();
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h1 className="text-base font-semibold tracking-tight">SQL Playground · Week 1 PoC</h1>
        <div className="flex items-center gap-3 text-xs" data-testid="status-bar">
          {initError ? (
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
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" data-testid="results">
            {runError && (
              <div className="rounded border border-red-700 bg-red-950/40 p-3 text-sm text-red-200">
                {runError}
              </div>
            )}
            {!runError && !response && (
              <p className="text-sm text-neutral-500">
                Run SQL to see per-statement results, timing, and transaction state. Databases
                persist in OPFS across reloads when available.
              </p>
            )}
            {response?.statements.map((r, i) => (
              <StatementBlock key={i} result={r} index={i} />
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-500">
        Browser-only SQLite · no server · statement policy blocks ATTACH and VACUUM INTO
      </footer>
    </div>
  );
}
