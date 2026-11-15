import type { StatementResult } from "../../shared/contracts";

function formatValue(v: unknown): string {
  if (v === null) return "NULL";
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength} bytes>`;
  if (typeof v === "bigint") return `${v}n`;
  return String(v);
}

/** One per-statement result: rows grid, change summary, or error (plan §5.2). */
export function StatementBlock({ result, index }: { result: StatementResult; index: number }) {
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
