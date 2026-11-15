/**
 * Storage availability and quota detection (plan §5.5 safety rules).
 *
 * `navigator.storage.estimate()` drives the "required vs available" display
 * before imports (Week 6); `persist()` requests best-effort eviction
 * protection. Everything degrades to explicit "unsupported" signals — never a
 * silent assumption that storage works.
 */

export interface StorageInfo {
  /** `navigator.storage.estimate` exists and did not throw. */
  estimateSupported: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
  /** True once `navigator.storage.persisted()` reports granted protection. */
  persisted: boolean;
  /** True when the Origin Private File System API is present. */
  opfsSupported: boolean;
}

function getStorage(): StorageManager | undefined {
  return typeof navigator !== "undefined" ? navigator.storage : undefined;
}

export function isOpfsSupported(): boolean {
  const storage = getStorage();
  return !!storage && typeof storage.getDirectory === "function";
}

export async function getStorageInfo(): Promise<StorageInfo> {
  const storage = getStorage();
  let estimateSupported = false;
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  let persisted = false;

  if (storage && typeof storage.estimate === "function") {
    try {
      const estimate = await storage.estimate();
      estimateSupported = true;
      usageBytes = estimate.usage ?? null;
      quotaBytes = estimate.quota ?? null;
    } catch {
      // Estimate can be denied by the browser; report unsupported.
    }
  }
  if (storage && typeof storage.persisted === "function") {
    try {
      persisted = await storage.persisted();
    } catch {
      persisted = false;
    }
  }

  return {
    estimateSupported,
    usageBytes,
    quotaBytes,
    persisted,
    opfsSupported: isOpfsSupported(),
  };
}

/** Ask the browser to mark origin storage as persistent (best effort). */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = getStorage();
  if (!storage || typeof storage.persist !== "function") return false;
  try {
    return await storage.persist();
  } catch {
    return false;
  }
}

/** Human-readable byte size for the storage display. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
