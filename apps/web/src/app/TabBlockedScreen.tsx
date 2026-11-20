/** Blocking screen shown when another tab holds the storage lock (ADR-005). */
export function TabBlockedScreen({ onRetry }: { onRetry: () => void }) {
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
        className="rounded bg-sky-800 px-4 py-2 font-medium text-white hover:bg-sky-700"
      >
        Retry
      </button>
    </div>
  );
}
