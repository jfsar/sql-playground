import type { TablePage } from "../../shared/contracts";
import { ResultsGrid } from "../query-results/ResultsGrid";

export interface TableBrowserProps {
  table: string;
  page: TablePage | null;
  loading: boolean;
  error: string | null;
  onPage: (offset: number) => void;
  onClose: () => void;
}

/** Paged table/view data browser for the explorer (plan §7 Week 5). */
export function TableBrowser({ table, page, loading, error, onPage, onClose }: TableBrowserProps) {
  const total = page?.totalRows ?? 0;
  const offset = page?.offset ?? 0;
  const rowCount = page?.rows.length ?? 0;
  const first = total === 0 || rowCount === 0 ? 0 : offset + 1;
  const last = total === 0 ? 0 : Math.min(offset + rowCount, total);
  const canPrev = offset > 0 && !loading;
  const canNext = offset + rowCount < total && !loading;

  return (
    <div className="flex min-h-0 flex-col" data-testid="table-browser">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
        <span>
          Table data
          <span className="ml-2 font-mono text-neutral-200" data-testid="table-browser-title">
            {table}
          </span>
          {page ? (
            <span className="ml-2 text-neutral-400" data-testid="table-page-status">
              rows {first}–{last} of {total}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            data-testid="table-prev"
            onClick={() => onPage(Math.max(0, offset - (page?.limit ?? rowCount)))}
            disabled={!canPrev}
            className="rounded bg-neutral-800 px-2 py-1 text-[11px] font-medium text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            data-testid="table-next"
            onClick={() => onPage(offset + (page?.limit ?? rowCount))}
            disabled={!canNext}
            className="rounded bg-neutral-800 px-2 py-1 text-[11px] font-medium text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          >
            Next
          </button>
          <button
            type="button"
            data-testid="table-close"
            onClick={onClose}
            className="rounded bg-neutral-800 px-2 py-1 text-[11px] font-medium text-neutral-200 hover:bg-neutral-700"
          >
            Close
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {error ? (
          <div
            role="alert"
            data-testid="table-browser-error"
            className="rounded border border-red-700 bg-red-950/40 p-3 text-sm text-red-200"
          >
            {error}
          </div>
        ) : null}
        {loading && !page ? (
          <p role="status" className="text-sm text-neutral-400" data-testid="table-browser-loading">
            Loading rows…
          </p>
        ) : null}
        {page && page.rows.length === 0 ? (
          <p className="text-sm text-neutral-400" data-testid="table-browser-empty">
            This {table} has no rows.
          </p>
        ) : null}
        {page && page.rows.length > 0 ? (
          <ResultsGrid columns={page.columns} rows={page.rows} label={`Table ${table} data`} />
        ) : null}
      </div>
    </div>
  );
}
