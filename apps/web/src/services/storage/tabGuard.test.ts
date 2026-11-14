// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LockCallback = (lock: { name: string; mode: string } | null) => unknown;

interface FakeLocks {
  request: ReturnType<typeof vi.fn>;
}

function installLocks(available: boolean): FakeLocks {
  const held = new Set<string>();
  const locks: FakeLocks = {
    request: vi.fn((name: string, opts: { ifAvailable?: boolean }, cb: LockCallback) => {
      if (!available) return Promise.reject(new Error("no locks"));
      if (held.has(name)) {
        if (opts?.ifAvailable) return Promise.resolve(cb(null));
        // Not used by the guard, but keep the fake honest.
        return Promise.resolve(cb(null));
      }
      held.add(name);
      const result = cb({ name, mode: "exclusive" });
      return Promise.resolve(result).finally(() => {
        held.delete(name);
      });
    }),
  };
  vi.stubGlobal("navigator", { locks });
  return locks;
}

async function freshGuard(): Promise<typeof import("./tabGuard")> {
  vi.resetModules();
  return import("./tabGuard");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tabGuard", () => {
  it("grants the lock when it is available and holds it", async () => {
    const locks = installLocks(true);
    const guard = await freshGuard();
    const result = await guard.acquireTabLock();
    expect(result.granted).toBe(true);
    expect(locks.request).toHaveBeenCalledWith(
      "sql-playground:owner",
      { ifAvailable: true },
      expect.any(Function),
    );
    if (result.granted) {
      expect(result.unsupported).toBe(false);
      // Still held: a second acquisition attempt in this fake would conflict
      // only after release — release lets the holder finish.
      result.release();
    }
  });

  it("reports blocked when another tab holds the lock", async () => {
    installLocks(true);
    const guard = await freshGuard();
    // Simulate another tab already owning the lock.
    const locks = navigator.locks as unknown as FakeLocks;
    locks.request.mockImplementationOnce((_n: string, _o: unknown, cb: LockCallback) =>
      Promise.resolve(cb(null)),
    );
    const result = await guard.acquireTabLock();
    expect(result.granted).toBe(false);
  });

  it("caches a blocked attempt so StrictMode remounts stay consistent", async () => {
    installLocks(true);
    const guard = await freshGuard();
    const locks = navigator.locks as unknown as FakeLocks;
    locks.request.mockImplementationOnce((_n: string, _o: unknown, cb: LockCallback) =>
      Promise.resolve(cb(null)),
    );
    const first = await guard.acquireTabLock();
    const second = await guard.acquireTabLock();
    expect(first.granted).toBe(false);
    expect(second.granted).toBe(false);
    expect(locks.request).toHaveBeenCalledTimes(1);
  });

  it("retry re-requests after a blocked attempt", async () => {
    installLocks(true);
    const guard = await freshGuard();
    const locks = navigator.locks as unknown as FakeLocks;
    locks.request.mockImplementationOnce((_n: string, _o: unknown, cb: LockCallback) =>
      Promise.resolve(cb(null)),
    );
    expect((await guard.acquireTabLock()).granted).toBe(false);
    const retried = await guard.retryTabLock();
    expect(retried.granted).toBe(true);
    expect(locks.request).toHaveBeenCalledTimes(2);
  });

  it("proceeds with unsupported=true when Web Locks is missing", async () => {
    vi.stubGlobal("navigator", {});
    const guard = await freshGuard();
    const result = await guard.acquireTabLock();
    expect(result.granted).toBe(true);
    if (result.granted) expect(result.unsupported).toBe(true);
  });

  it("treats a lock request failure as blocked, not granted", async () => {
    installLocks(false);
    const guard = await freshGuard();
    const result = await guard.acquireTabLock();
    expect(result.granted).toBe(false);
  });
});
