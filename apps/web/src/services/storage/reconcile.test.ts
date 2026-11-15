import { describe, expect, it } from "vitest";
import type { DatabaseInfo } from "../../shared/contracts";
import { dbFileName, idFromDbFileName, reconcile, RECOVERED_DATABASE_NAME } from "./reconcile";

function entry(overrides: Partial<DatabaseInfo> = {}): DatabaseInfo {
  return {
    id: "a1b2c3d4",
    name: "My database",
    createdAt: 1000,
    lastOpenedAt: 2000,
    sizeBytes: 8192,
    status: "ok",
    ...overrides,
  };
}

describe("file naming (plan §5.6)", () => {
  it("round-trips id ↔ pool file name", () => {
    expect(dbFileName("abc-123")).toBe("/db_abc-123.sqlite3");
    expect(idFromDbFileName("/db_abc-123.sqlite3")).toBe("abc-123");
  });

  it("rejects foreign files", () => {
    expect(idFromDbFileName("/playground.sqlite3")).toBeNull();
    expect(idFromDbFileName("/db_x.sqlite3-journal")).toBeNull();
    expect(idFromDbFileName("/db_.sqlite3")).toBeNull();
  });
});

describe("reconcile (acceptance scenario 24)", () => {
  const now = 1_700_000_000_000;

  it("leaves a consistent state untouched", () => {
    const meta = [entry({ id: "one" }), entry({ id: "two", name: "Other" })];
    const files = [dbFileName("one"), dbFileName("two")];
    const result = reconcile({ metadata: meta, files, persistent: true, now });

    expect(result.changed).toEqual([]);
    expect(result.removedIds).toEqual([]);
    expect(result.recoveredIds).toEqual([]);
    expect(result.missingIds).toEqual([]);
    expect(result.ignoredFiles).toEqual([]);
  });

  it("adopts an orphan file as a Recovered database entry", () => {
    const result = reconcile({
      metadata: [],
      files: [dbFileName("orphan-1")],
      persistent: true,
      now,
    });

    expect(result.recoveredIds).toEqual(["orphan-1"]);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject({
      id: "orphan-1",
      name: RECOVERED_DATABASE_NAME,
      status: "recovered",
    });
  });

  it("marks metadata without a file as missing-file", () => {
    const meta = [entry({ id: "gone" })];
    const result = reconcile({ metadata: meta, files: [], persistent: true, now });

    expect(result.missingIds).toEqual(["gone"]);
    expect(result.changed).toEqual([{ ...meta[0], status: "missing-file" }]);
  });

  it("promotes a recovered entry back to ok once it has a file", () => {
    const meta = [entry({ id: "r1", status: "recovered" })];
    const result = reconcile({
      metadata: meta,
      files: [dbFileName("r1")],
      persistent: true,
      now,
    });

    expect(result.changed).toEqual([{ ...meta[0], status: "ok" }]);
    expect(result.recoveredIds).toEqual([]);
  });

  it("completes an interrupted two-phase delete", () => {
    const meta = [entry({ id: "keep" }), entry({ id: "doomed", status: "deleting" })];
    const files = [dbFileName("keep"), dbFileName("doomed")];
    const result = reconcile({ metadata: meta, files, persistent: true, now });

    expect(result.removedIds).toEqual(["doomed"]);
    expect(result.filesToDelete).toEqual([dbFileName("doomed")]);
    // The kept entry is untouched, and the doomed file is not "recovered".
    expect(result.changed).toEqual([]);
    expect(result.recoveredIds).toEqual([]);
  });

  it("completes a delete whose file already vanished", () => {
    const meta = [entry({ id: "doomed", status: "deleting" })];
    const result = reconcile({ metadata: meta, files: [], persistent: true, now });

    expect(result.removedIds).toEqual(["doomed"]);
    expect(result.filesToDelete).toEqual([]);
  });

  it("ignores foreign pool files (journals, legacy names)", () => {
    const files = ["/playground.sqlite3", "/db_x.sqlite3-journal", "/notes.txt"];
    const result = reconcile({ metadata: [], files, persistent: true, now });

    expect(result.ignoredFiles).toEqual(files);
    expect(result.recoveredIds).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it("skips file checks in the in-memory fallback (persistent: false)", () => {
    const meta = [entry({ id: "any" }), entry({ id: "del", status: "deleting" })];
    const result = reconcile({ metadata: meta, files: [], persistent: false, now });

    // No missing-file flags, no recovered entries — only deletes complete.
    expect(result.changed).toEqual([]);
    expect(result.missingIds).toEqual([]);
    expect(result.recoveredIds).toEqual([]);
    expect(result.removedIds).toEqual(["del"]);
  });
});
