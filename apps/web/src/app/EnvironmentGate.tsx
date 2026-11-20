import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CAPABILITY_LABELS,
  SUPPORTED_VIEWPORT_MIN,
  TABLET_VIEWPORT_MIN,
  assessBrowserCapabilities,
  classifyViewport,
  detectBrowserCapabilities,
  type BrowserCapabilities,
  type CapabilityName,
} from "../shared/environment";

interface EnvironmentGateProps {
  children: ReactNode;
  /** Injected for tests; defaults to feature detection on the live globals. */
  capabilities?: BrowserCapabilities;
  /** Injected for tests; defaults to the live window width. */
  width?: number;
}

function useViewportWidth(override?: number): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? SUPPORTED_VIEWPORT_MIN : window.innerWidth,
  );

  useEffect(() => {
    if (override !== undefined || typeof window === "undefined") return;
    const onResize = () => setWidth(window.innerWidth);
    setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [override]);

  return override ?? width;
}

function EnvironmentShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-950 px-6 py-12 text-center text-neutral-100">
      {children}
    </div>
  );
}

/** Blocking screen for browsers missing a hard requirement (NFR-06). */
export function UnsupportedBrowserScreen({
  missing,
  onRetry,
}: {
  missing: readonly CapabilityName[];
  onRetry?: () => void;
}) {
  return (
    <EnvironmentShell>
      <main className="flex flex-col items-center gap-4" data-testid="unsupported-browser">
        <h1 className="text-lg font-semibold">This browser cannot run SQL Playground</h1>
        <p className="max-w-md text-sm text-neutral-300">
          The workspace runs SQLite locally and needs these browser features:
        </p>
        <ul className="list-inside list-disc text-sm text-red-300">
          {missing.map((name) => (
            <li key={name}>{CAPABILITY_LABELS[name]}</li>
          ))}
        </ul>
        <p className="max-w-md text-sm text-neutral-400">
          Use a current desktop version of Chrome, Edge, Firefox, or Safari 17+. Private windows may
          disable storage features; try a regular window. No data has been stored or changed.
        </p>
        <button
          type="button"
          data-testid="unsupported-browser-retry"
          onClick={onRetry ?? (() => window.location.reload())}
          className="rounded bg-sky-800 px-4 py-2 font-medium text-white hover:bg-sky-700"
        >
          Retry
        </button>
      </main>
    </EnvironmentShell>
  );
}

/** Blocking screen for phone-sized viewports, which the plan does not support. */
export function UnsupportedViewportScreen() {
  return (
    <EnvironmentShell>
      <main className="flex flex-col items-center gap-4" data-testid="unsupported-viewport">
        <h1 className="text-lg font-semibold">A desktop screen is required</h1>
        <p className="max-w-md text-sm text-neutral-300">
          SQL Playground is a desktop-first workspace and does not support phone-sized screens. Open
          it on a screen at least {SUPPORTED_VIEWPORT_MIN} px wide.
        </p>
        <p className="max-w-md text-sm text-neutral-400">
          Your browser storage is untouched; widen the window or move to a larger display.
        </p>
      </main>
    </EnvironmentShell>
  );
}

/** Persistent, non-blocking warning for the best-effort tablet range. */
export function ViewportNotice() {
  return (
    <div
      role="status"
      data-testid="viewport-notice"
      className="border-b border-amber-900 bg-amber-950/40 px-4 py-2 text-xs text-amber-200"
    >
      Tablet layout is best effort. This workspace is designed for screens {SUPPORTED_VIEWPORT_MIN}{" "}
      px and wider; some panels may be cramped at {TABLET_VIEWPORT_MIN}–{SUPPORTED_VIEWPORT_MIN - 1}{" "}
      px.
    </div>
  );
}

/**
 * Blocks startup when the browser cannot run the engine, and keeps phone-sized
 * viewports out of the desktop layout instead of letting it silently break
 * (FINAL_PROJECT_PLAN §2 / §7 Week 9, NFR-06).
 */
export function EnvironmentGate({ children, capabilities, width }: EnvironmentGateProps) {
  const detected = useMemo(() => capabilities ?? detectBrowserCapabilities(), [capabilities]);
  const support = useMemo(() => assessBrowserCapabilities(detected), [detected]);
  const effectiveWidth = useViewportWidth(width);

  if (!support.supported) {
    return <UnsupportedBrowserScreen missing={support.missing} />;
  }

  const viewport = classifyViewport(effectiveWidth);
  if (viewport === "phone") {
    return <UnsupportedViewportScreen />;
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      {viewport === "tablet" ? <ViewportNotice /> : null}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
