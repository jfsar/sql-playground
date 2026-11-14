/**
 * Tab-ownership guard (plan §5.6, ADR-005): one tab owns the OPFS databases
 * at a time via an exclusive Web Lock held for the page lifetime.
 *
 * The lock is held by the page (not the worker), so closing the tab or a
 * worker restart releases it predictably. If the Web Locks API is missing the
 * guard reports `unsupported` and proceeds — the supported browser matrix has
 * Web Locks everywhere (recorded in ADR-005).
 */

export const TAB_LOCK_NAME = "sql-playground:owner";

export type TabLockResult =
  { granted: true; unsupported: boolean; release: () => void } | { granted: false };

let attempt: Promise<TabLockResult> | null = null;

async function requestLock(): Promise<TabLockResult> {
  const locks = navigator.locks;
  if (!locks || typeof locks.request !== "function") {
    return { granted: true, unsupported: true, release: () => {} };
  }

  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });

  const granted = await new Promise<boolean>((resolve) => {
    void locks
      .request(TAB_LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        // Signal acquisition immediately, then hold the lock until release()
        // (or tab close, which drops the lock automatically).
        resolve(true);
        await hold;
      })
      .catch(() => resolve(false));
  });

  if (!granted) return { granted: false };
  return { granted: true, unsupported: false, release: releaseHold };
}

/**
 * Acquire the tab lock. Cached per page so StrictMode remounts share one
 * attempt instead of deadlocking against ourselves.
 */
export function acquireTabLock(): Promise<TabLockResult> {
  if (!attempt) attempt = requestLock();
  return attempt;
}

/**
 * Re-attempt after a blocked result (Retry button). A cached grant is kept as
 *-is; only a cached failure is dropped.
 */
export async function retryTabLock(): Promise<TabLockResult> {
  const cached = await attempt?.catch(() => null);
  if (cached?.granted) return cached;
  attempt = null;
  return acquireTabLock();
}

/** Test hook: clear the per-page cache. */
export function resetTabLockForTests(): void {
  attempt = null;
}
