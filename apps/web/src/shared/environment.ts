/**
 * Browser capability and viewport rules for the Week 9 environment gate
 * (FINAL_PROJECT_PLAN §2 browser matrix, NFR-06/NFR-11).
 *
 * The app is desktop-first: ≥1024 px is supported, 768–1023 px is best effort,
 * and phone-sized viewports are unsupported. The database engine itself needs
 * WebAssembly, a Worker, and IndexedDB; OPFS and Web Locks are degraded modes
 * (in-memory fallback and "guard unavailable" messaging).
 */

export type CapabilityName = "webAssembly" | "worker" | "indexedDb" | "opfs" | "webLocks";

export interface BrowserCapabilities {
  webAssembly: boolean;
  worker: boolean;
  indexedDb: boolean;
  opfs: boolean;
  webLocks: boolean;
}

export interface BrowserSupportAssessment {
  /** False when a hard requirement is missing and the app cannot start. */
  supported: boolean;
  /** Hard requirements that are missing. */
  missing: CapabilityName[];
  /** Optional capabilities that are missing but have a visible fallback. */
  degraded: CapabilityName[];
}

/** Capabilities the database engine cannot work without. */
export const REQUIRED_CAPABILITIES: readonly CapabilityName[] = [
  "webAssembly",
  "worker",
  "indexedDb",
];

/** Capabilities with an explicit, user-visible degraded mode. */
export const OPTIONAL_CAPABILITIES: readonly CapabilityName[] = ["opfs", "webLocks"];

export const CAPABILITY_LABELS: Record<CapabilityName, string> = {
  webAssembly: "WebAssembly",
  worker: "Web Workers",
  indexedDb: "IndexedDB",
  opfs: "Origin Private File System (OPFS)",
  webLocks: "Web Locks",
};

export interface CapabilityScope {
  WebAssembly?: unknown;
  Worker?: unknown;
  indexedDB?: unknown;
  navigator?: {
    storage?: { getDirectory?: unknown };
    locks?: { request?: unknown };
  };
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

/** Read feature availability from a scope (defaults to the browser globals). */
export function detectBrowserCapabilities(
  scope: CapabilityScope = globalThis as CapabilityScope,
): BrowserCapabilities {
  return {
    webAssembly: isPresent(scope.WebAssembly),
    worker: isFunction(scope.Worker),
    indexedDb: isPresent(scope.indexedDB),
    opfs: isFunction(scope.navigator?.storage?.getDirectory),
    webLocks: isFunction(scope.navigator?.locks?.request),
  };
}

/** Split capabilities into hard failures and degraded-but-usable modes. */
export function assessBrowserCapabilities(
  capabilities: BrowserCapabilities,
): BrowserSupportAssessment {
  const missing = REQUIRED_CAPABILITIES.filter((name) => !capabilities[name]);
  const degraded = OPTIONAL_CAPABILITIES.filter((name) => !capabilities[name]);
  return { supported: missing.length === 0, missing, degraded };
}

export const SUPPORTED_VIEWPORT_MIN = 1024;
export const TABLET_VIEWPORT_MIN = 768;

export type ViewportClass = "desktop" | "tablet" | "phone";

/** Classify a viewport width using the documented desktop-first matrix. */
export function classifyViewport(width: number): ViewportClass {
  if (width >= SUPPORTED_VIEWPORT_MIN) return "desktop";
  if (width >= TABLET_VIEWPORT_MIN) return "tablet";
  return "phone";
}

/** Miss list rendered as readable browser requirement labels. */
export function missingCapabilityLabels(missing: readonly CapabilityName[]): string[] {
  return missing.map((name) => CAPABILITY_LABELS[name]);
}
