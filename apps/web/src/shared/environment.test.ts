import { describe, expect, it } from "vitest";
import {
  assessBrowserCapabilities,
  classifyViewport,
  detectBrowserCapabilities,
  missingCapabilityLabels,
  type CapabilityScope,
} from "./environment";

const fullScope: CapabilityScope = {
  WebAssembly: {},
  Worker: function Worker() {},
  indexedDB: {},
  navigator: {
    storage: { getDirectory: () => undefined },
    locks: { request: () => Promise.resolve() },
  },
};

describe("detectBrowserCapabilities", () => {
  it("reports every capability when the browser has them", () => {
    expect(detectBrowserCapabilities(fullScope)).toEqual({
      webAssembly: true,
      worker: true,
      indexedDb: true,
      opfs: true,
      webLocks: true,
    });
  });

  it("treats missing or non-function capabilities as unavailable", () => {
    expect(
      detectBrowserCapabilities({
        WebAssembly: null,
        Worker: {},
        indexedDB: undefined,
        navigator: undefined,
      }),
    ).toEqual({
      webAssembly: false,
      worker: false,
      indexedDb: false,
      opfs: false,
      webLocks: false,
    });
  });

  it("reads capability APIs from the live globals by default", () => {
    // Vitest runs in Node/jsdom; WebAssembly is always present there.
    expect(detectBrowserCapabilities().webAssembly).toBe(true);
  });
});

describe("assessBrowserCapabilities", () => {
  it("is supported with no missing or degraded capabilities", () => {
    const result = assessBrowserCapabilities(detectBrowserCapabilities(fullScope));
    expect(result).toEqual({ supported: true, missing: [], degraded: [] });
  });

  it("is unsupported when a hard requirement is missing", () => {
    const result = assessBrowserCapabilities({
      webAssembly: true,
      worker: false,
      indexedDb: true,
      opfs: true,
      webLocks: true,
    });
    expect(result.supported).toBe(false);
    expect(result.missing).toEqual(["worker"]);
  });

  it("stays usable but degraded without OPFS and Web Locks", () => {
    const result = assessBrowserCapabilities({
      webAssembly: true,
      worker: true,
      indexedDb: true,
      opfs: false,
      webLocks: false,
    });
    expect(result.supported).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.degraded).toEqual(["opfs", "webLocks"]);
  });
});

describe("missingCapabilityLabels", () => {
  it("maps capability names to user-facing labels", () => {
    expect(missingCapabilityLabels(["webAssembly", "worker"])).toEqual([
      "WebAssembly",
      "Web Workers",
    ]);
  });
});

describe("classifyViewport", () => {
  it("supports desktop widths at 1024 px and above", () => {
    expect(classifyViewport(1024)).toBe("desktop");
    expect(classifyViewport(1440)).toBe("desktop");
  });

  it("treats 768–1023 px as best-effort tablet", () => {
    expect(classifyViewport(768)).toBe("tablet");
    expect(classifyViewport(1023)).toBe("tablet");
  });

  it("rejects phone-sized viewports below 768 px", () => {
    expect(classifyViewport(767)).toBe("phone");
    expect(classifyViewport(375)).toBe("phone");
  });
});
