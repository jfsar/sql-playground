import { describe, expect, it } from "vitest";
import { computeVirtualWindow } from "./virtualRows";

const base = { rowHeight: 30, viewportHeight: 300 };

describe("computeVirtualWindow", () => {
  it("returns an empty window for no rows", () => {
    expect(computeVirtualWindow({ ...base, rowCount: 0, scrollTop: 0 })).toEqual({
      startIndex: 0,
      endIndex: 0,
      offsetTop: 0,
      totalHeight: 0,
    });
  });

  it("renders everything when rows fit the viewport", () => {
    const w = computeVirtualWindow({ ...base, rowCount: 5, scrollTop: 0, overscan: 2 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(5);
    expect(w.offsetTop).toBe(0);
    expect(w.totalHeight).toBe(150);
  });

  it("windows large result sets at the top", () => {
    const w = computeVirtualWindow({ ...base, rowCount: 1000, scrollTop: 0, overscan: 4 });
    expect(w.startIndex).toBe(0);
    // 10 visible + 4 overscan below.
    expect(w.endIndex).toBe(14);
    expect(w.offsetTop).toBe(0);
    expect(w.totalHeight).toBe(30_000);
  });

  it("windows rows around the scroll position", () => {
    const w = computeVirtualWindow({ ...base, rowCount: 1000, scrollTop: 3000, overscan: 4 });
    expect(w.startIndex).toBe(96); // row 100 minus 4 overscan
    expect(w.endIndex).toBe(114); // row 100 + 10 visible + 4 overscan
    expect(w.offsetTop).toBe(96 * 30);
  });

  it("clamps scrolling past the end", () => {
    const w = computeVirtualWindow({
      ...base,
      rowCount: 1000,
      scrollTop: 999_999,
      overscan: 4,
    });
    expect(w.endIndex).toBe(1000);
    expect(w.startIndex).toBeLessThan(1000);
    expect(w.offsetTop).toBe(w.startIndex * 30);
    // The last rendered row reaches the bottom of the viewport.
    expect(w.totalHeight - (w.offsetTop + (w.endIndex - w.startIndex) * 30)).toBeLessThan(300);
  });

  it("ignores negative scroll offsets", () => {
    const w = computeVirtualWindow({ ...base, rowCount: 50, scrollTop: -120, overscan: 2 });
    expect(w.startIndex).toBe(0);
    expect(w.offsetTop).toBe(0);
  });
});
