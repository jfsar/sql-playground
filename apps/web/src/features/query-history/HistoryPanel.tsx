import { useState } from "react";
import type { HistoryEntry } from "../../services/storage/metadataDb";

export interface HistoryPanelProps {
  entries: HistoryEntry[];
  enabled: boolean;
  busy: boolean;
  error: string | null;
  onLoad: (sql: string) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onClear: () => void;
}

function preview(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Query history with clear and disable controls (plan §3 Epic 1, Week 5). */
export function HistoryPanel({
  entries,
  enabled,
  busy,
  error,
  onLoad,
  onToggleEnabled,
  onClear,
}: HistoryPanelProps) {
  const [confirmingClear, setConfirmingClear] = useState(false);

  return (
    <div className="space-y-3" data-testid="history-panel">
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
          <input
            type="checkbox"
            data-testid="history-toggle"
            checked={enabled}
            disabled={busy}
            onChange={(event) => onToggleEnabled(event.target.checked)}
            className="h-3 w-3 accent-sky-600"
          />
          Record history
        </label>
        {confirmingClear ? (
          <span className="flex items-center gap-1">
            <button
              type="button"
              data-testid="confirm-clear-history"
              onClick={() => {
                setConfirmingClear(false);
                onClear();
              }}
              disabled={busy}
              className="rounded bg-red-800 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-40"
            >
              Clear all
            </button>
            <button
              type="button"
              data-testid="cancel-clear-history"
              onClick={() => setConfirmingClear(false)}
              className="rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            data-testid="clear-history"
            onClick={() => setConfirmingClear(true)}
            disabled={busy || entries.length === 0}
            className="rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
          >
            Clear history
          </button>
        )}
      </div>

      {!enabled ? (
        <p
          className="rounded border border-amber-800 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-300"
          data-testid="history-disabled-notice"
        >
          History is off; runs are not recorded. Existing entries stay until you clear them.
        </p>
      ) : null}

      {error ? (
        <div
          role="alert"
          data-testid="history-error"
          className="rounded border border-red-800 bg-red-950/40 p-2 text-[11px] text-red-300"
        >
          {error}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p role="status" className="text-sm text-neutral-400" data-testid="history-empty">
          No runs recorded yet. Executed SQL appears here, newest first (last 100).
        </p>
      ) : (
        <ul className="space-y-1" data-testid="history-list">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <button
                type="button"
                data-testid={`history-entry-${index}`}
                onClick={() => onLoad(entry.sql)}
                className="w-full rounded border border-neutral-800 bg-neutral-900/60 p-2 text-left hover:border-neutral-700 hover:bg-neutral-900"
              >
                <div className="flex items-center gap-2 text-[10px] text-neutral-400">
                  <span
                    className={
                      entry.ok
                        ? "rounded bg-emerald-950 px-1 text-emerald-300"
                        : "rounded bg-red-950 px-1 text-red-300"
                    }
                  >
                    {entry.ok ? "ok" : "failed"}
                  </span>
                  <span>{new Date(entry.at).toLocaleTimeString()}</span>
                  {entry.engineMs !== undefined ? (
                    <span>{entry.engineMs.toFixed(2)} ms</span>
                  ) : null}
                </div>
                <div className="mt-1 max-h-12 overflow-hidden break-words font-mono text-[11px] text-neutral-300">
                  {preview(entry.sql)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
