import { describe, expect, it } from "vitest";
import { byteOffsetToJsIndex, computeErrorMark, indexToLineColumn } from "./textPosition";
import type { StatementSpan } from "./contracts";

describe("byteOffsetToJsIndex", () => {
  it("maps ASCII offsets 1:1", () => {
    expect(byteOffsetToJsIndex("SELECT", 0)).toBe(0);
    expect(byteOffsetToJsIndex("SELECT", 3)).toBe(3);
    expect(byteOffsetToJsIndex("SELECT", 99)).toBe(6);
  });

  it("maps multi-byte UTF-8 characters", () => {
    expect(byteOffsetToJsIndex("aéb", 0)).toBe(0);
    expect(byteOffsetToJsIndex("aéb", 1)).toBe(1);
    expect(byteOffsetToJsIndex("aéb", 2)).toBe(1);
    expect(byteOffsetToJsIndex("aéb", 3)).toBe(2);
  });

  it("handles surrogate pairs as single code points", () => {
    // "😀" is 4 UTF-8 bytes at bytes [1,5) and 2 UTF-16 code units at [1,3).
    expect(byteOffsetToJsIndex("a😀b", 1)).toBe(1);
    expect(byteOffsetToJsIndex("a😀b", 4)).toBe(1); // mid-character → its start
    expect(byteOffsetToJsIndex("a😀b", 5)).toBe(3); // 'b' after the emoji
  });
});

describe("indexToLineColumn", () => {
  it("reports 1-based positions on the first line", () => {
    expect(indexToLineColumn("SELECT 1", 0)).toEqual({ line: 1, column: 1 });
    expect(indexToLineColumn("SELECT 1", 4)).toEqual({ line: 1, column: 5 });
  });

  it("counts lines after newlines", () => {
    const doc = "a\nbb\nccc";
    expect(indexToLineColumn(doc, 2)).toEqual({ line: 2, column: 1 });
    expect(indexToLineColumn(doc, 5)).toEqual({ line: 3, column: 1 });
    expect(indexToLineColumn(doc, 7)).toEqual({ line: 3, column: 3 });
  });

  it("clamps out-of-range indices", () => {
    expect(indexToLineColumn("abc", -5)).toEqual({ line: 1, column: 1 });
    expect(indexToLineColumn("abc", 99)).toEqual({ line: 1, column: 4 });
  });
});

describe("computeErrorMark", () => {
  const span = (text: string, start = 0): StatementSpan => ({
    start,
    end: start + text.length,
    text,
  });

  it("marks the token at the error offset", () => {
    const mark = computeErrorMark("SELECT * FORM t;", 0, span("SELECT * FORM t;"), 9);
    expect(mark).toEqual({ from: 9, to: 13 });
  });

  it("shifts marks by the selection start (docStart)", () => {
    const mark = computeErrorMark("FORM t;", 7, span("FORM t;"), 0);
    expect(mark).toEqual({ from: 7, to: 11 });
  });

  it("returns null when there is no offset", () => {
    expect(computeErrorMark("SELECT 1;", 0, span("SELECT 1;"), -1)).toBeNull();
  });

  it("returns null when the position is past the end of the script", () => {
    expect(computeErrorMark("SELECT 1;", 0, span("SELECT 1;"), 999)).toBeNull();
  });

  it("falls back to a single character when the offset sits on whitespace", () => {
    const mark = computeErrorMark("SELECT 1", 0, span("SELECT 1"), 6);
    expect(mark).toEqual({ from: 6, to: 7 });
  });
});
