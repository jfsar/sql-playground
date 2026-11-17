import type { StatementResult } from "../../shared/contracts";
import { DEFAULT_MAX_ROWS } from "../../shared/contracts";
import { byteOffsetToJsIndex, type LineColumn } from "../../shared/textPosition";
import { ResultsGrid } from "./ResultsGrid";

/** Insert a caret line under the error position within the statement text. */
function withCaret(text: string, relOffset: number): string {
  const lines = text.split("\n");
  const clamped = Math.max(0, Math.min(relOffset, text.length));
  let pos = 0;
  let lineIdx = 0;
  let col = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (clamped <= pos + lines[i].length) {
      lineIdx = i;
      col = clamped - pos;
      break;
    }
    pos += lines[i].length + 1;
    lineIdx = i;
    col = lines[i].length;
  }
  const expanded = lines.map((l) => l.replace(/\t/g, "    "));
  const caretCol = lines[lineIdx].slice(0, col).replace(/\t/g, "    ").length;
  const caret = `${" ".repeat(caretCol)}^`;
  return [...expanded.slice(0, lineIdx + 1), caret, ...expanded.slice(lineIdx + 1)].join("\n");
}

export interface StatementBlockProps {
  result: StatementResult;
  index: number;
  /** Document line/column of the error, when SQLite reported an offset. */
  position?: LineColumn | null;
}

/** One per-statement result: rows grid, change summary, or error (plan §5.2). */
export function StatementBlock({ result, index, position }: StatementBlockProps) {
  if (result.kind === "error") {
    const relOffset =
      result.error.offset !== undefined && result.error.offset >= 0
        ? byteOffsetToJsIndex(result.span.text, result.error.offset)
        : undefined;
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
          {relOffset !== undefined ? withCaret(result.span.text, relOffset) : result.span.text}
        </pre>
        {position ? (
          <div className="mt-1 text-red-300/80" data-testid={`stmt-error-position-${index}`}>
            line {position.line}, column {position.column}
          </div>
        ) : null}
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
      <div className="mt-1 text-neutral-400">
        {result.truncated ? `engine time (first ${result.rows.length} rows)` : "engine time"}
      </div>
      {result.truncated ? (
        <div
          role="status"
          data-testid={`truncated-notice-${index}`}
          className="mt-2 rounded border border-amber-800 bg-amber-950/40 px-2 py-1 text-xs text-amber-300"
        >
          Truncated: showing the first {result.rows.length} rows (row cap of {DEFAULT_MAX_ROWS}).
          Refine the query to see the full result.
        </div>
      ) : null}
      <div className="mt-2">
        <ResultsGrid columns={result.columns} rows={result.rows} />
      </div>
      <pre className="mt-2 overflow-x-auto text-neutral-500">{result.sql}</pre>
    </div>
  );
}
