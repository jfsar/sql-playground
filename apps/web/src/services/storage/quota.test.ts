// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBytes, getStorageInfo, isOpfsSupported, requestPersistentStorage } from "./quota";

type StorageMock = {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
  getDirectory?: () => Promise<unknown>;
};

function mockStorage(storage: StorageMock | undefined): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, "storage");
  if (storage === undefined) {
    Object.defineProperty(navigator, "storage", { value: undefined, configurable: true });
  } else {
    Object.defineProperty(navigator, "storage", { value: storage, configurable: true });
  }
  return () => {
    if (original) Object.defineProperty(navigator, "storage", original);
    else Reflect.deleteProperty(navigator, "storage");
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("quota and availability detection", () => {
  it("reports unsupported when navigator.storage is absent", async () => {
    const restore = mockStorage(undefined);
    try {
      const info = await getStorageInfo();
      expect(info).toEqual({
        estimateSupported: false,
        usageBytes: null,
        quotaBytes: null,
        persisted: false,
        opfsSupported: false,
      });
      expect(isOpfsSupported()).toBe(false);
      expect(await requestPersistentStorage()).toBe(false);
    } finally {
      restore();
    }
  });

  it("reports usage, quota, and persisted state", async () => {
    const restore = mockStorage({
      estimate: async () => ({ usage: 1024, quota: 4096 }),
      persisted: async () => true,
      getDirectory: async () => ({}),
    });
    try {
      const info = await getStorageInfo();
      expect(info.estimateSupported).toBe(true);
      expect(info.usageBytes).toBe(1024);
      expect(info.quotaBytes).toBe(4096);
      expect(info.persisted).toBe(true);
      expect(info.opfsSupported).toBe(true);
    } finally {
      restore();
    }
  });

  it("treats a throwing estimate as unsupported, not as zero", async () => {
    const restore = mockStorage({
      estimate: async () => {
        throw new Error("denied");
      },
      persisted: async () => false,
    });
    try {
      const info = await getStorageInfo();
      expect(info.estimateSupported).toBe(false);
      expect(info.usageBytes).toBeNull();
      expect(info.quotaBytes).toBeNull();
    } finally {
      restore();
    }
  });

  it("requestPersistentStorage forwards the browser's answer", async () => {
    const persist = vi.fn(async () => true);
    const restore = mockStorage({ persist });
    try {
      expect(await requestPersistentStorage()).toBe(true);
      expect(persist).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("requestPersistentStorage swallows browser errors as false", async () => {
    const restore = mockStorage({
      persist: async () => {
        throw new Error("nope");
      },
    });
    try {
      expect(await requestPersistentStorage()).toBe(false);
    } finally {
      restore();
    }
  });

  it("formatBytes renders human-readable sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(100 * 1024 * 1024)).toBe("100 MB");
    expect(formatBytes(-5)).toBe("unknown");
    expect(formatBytes(Number.NaN)).toBe("unknown");
  });
});
