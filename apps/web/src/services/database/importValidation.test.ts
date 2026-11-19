import { describe, expect, it } from "vitest";
import {
  SQLITE_HEADER,
  assessImportQuota,
  assessImportSize,
  detectImportKind,
  inspectImportFile,
  inspectSqlFile,
  inspectSqliteFile,
  readSqlText,
} from "./importValidation";
import { IMPORT_STRONG_WARN_BYTES, IMPORT_WARN_BYTES } from "../../shared/contracts";
import type { StorageInfo } from "../storage/quota";

function sqliteBytes(pages = 1, pageSize = 512): Uint8Array {
  const bytes = new Uint8Array(pageSize * pages);
  for (let i = 0; i < SQLITE_HEADER.length; i += 1) {
    bytes[i] = SQLITE_HEADER.charCodeAt(i);
  }
  bytes[16] = (pageSize >> 8) & 0xff;
  bytes[17] = pageSize & 0xff;
  bytes[18] = 1;
  bytes[19] = 1;
  return bytes;
}

const INFO: StorageInfo = {
  estimateSupported: true,
  usageBytes: 1000,
  quotaBytes: 5000,
  persisted: false,
  opfsSupported: true,
};

describe("SQLite import validation", () => {
  it("accepts a minimal rollback-journal database", () => {
    const report = inspectSqliteFile("good.db", sqliteBytes());
    expect(report.ok).toBe(true);
    expect(report.kind).toBe("sqlite");
    expect(report.pageSize).toBe(512);
    expect(report.journalMode).toBe("delete");
    expect(report.warnings).toEqual([]);
  });

  it("rejects a non-SQLite or encrypted-looking file with a specific message", () => {
    const report = inspectSqliteFile("secret.db", new Uint8Array([1, 2, 3, 4]));
    expect(report.ok).toBe(false);
    expect(report.error?.code).toBe("UNSUPPORTED_FILE");
    expect(report.error?.message).toMatch(/encrypted|different format/i);
  });

  it("rejects truncated files and invalid page sizes", () => {
    const truncated = inspectSqliteFile("cut.db", sqliteBytes().slice(0, 100));
    expect(truncated.ok).toBe(false);
    expect(truncated.error?.code).toBe("CORRUPT_FILE");

    const badPage = sqliteBytes();
    badPage[16] = 0;
    badPage[17] = 16;
    const invalid = inspectSqliteFile("pages.db", badPage);
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe("CORRUPT_FILE");
    expect(invalid.error?.message).toMatch(/page size/i);

    const partial = inspectSqliteFile("partial.db", sqliteBytes(2).slice(0, 600));
    expect(partial.ok).toBe(false);
    expect(partial.error?.message).toMatch(/truncated/i);
  });

  it("warns for WAL headers and large files", () => {
    const wal = sqliteBytes();
    wal[18] = 2;
    wal[19] = 2;
    const walReport = inspectSqliteFile("wal.db", wal);
    expect(walReport.ok).toBe(true);
    expect(walReport.journalMode).toBe("wal");
    expect(walReport.warnings.map((warning) => warning.code)).toContain("WAL_MODE");

    expect(assessImportSize(IMPORT_WARN_BYTES).map((warning) => warning.code)).toContain(
      "LARGE_FILE",
    );
    expect(assessImportSize(IMPORT_STRONG_WARN_BYTES).map((warning) => warning.code)).toContain(
      "VERY_LARGE_FILE",
    );
  });
});

describe("SQL script import validation", () => {
  it("accepts UTF-8 SQL and warns on empty scripts", () => {
    const bytes = new TextEncoder().encode("CREATE TABLE t (id INTEGER);");
    expect(inspectSqlFile("script.sql", bytes).ok).toBe(true);
    expect(detectImportKind("script.sql", bytes)).toBe("sql");
    const empty = inspectSqlFile("empty.sql", new Uint8Array());
    expect(empty.ok).toBe(true);
    expect(empty.warnings.map((warning) => warning.code)).toContain("EMPTY_SCRIPT");
  });

  it("rejects binary and invalid UTF-8 scripts", () => {
    const binary = inspectSqlFile("binary.sql", new Uint8Array([0x53, 0x00, 0x51]));
    expect(binary.ok).toBe(false);
    expect(binary.error?.code).toBe("UNSUPPORTED_FILE");

    const invalid = inspectSqlFile("bad.sql", new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe("UNSUPPORTED_FILE");
  });

  it("strips a UTF-8 BOM and dispatches by header", () => {
    const text = readSqlText(new Uint8Array([0xef, 0xbb, 0xbf, 0x53]));
    expect(text).toBe("S");
    const sqlite = sqliteBytes();
    expect(detectImportKind("script.sql", sqlite)).toBe("sqlite");
    expect(inspectImportFile("script.sql", sqlite).kind).toBe("sqlite");
  });
});

describe("import quota assessment", () => {
  it("allows imports that fit and blocks those that do not", () => {
    expect(assessImportQuota(4000, INFO)).toMatchObject({
      ok: true,
      availableBytes: 4000,
      message: null,
    });
    expect(assessImportQuota(4001, INFO)).toMatchObject({
      ok: false,
      availableBytes: 4000,
    });
  });

  it("does not block when storage estimates are unavailable", () => {
    const unknown: StorageInfo = {
      ...INFO,
      estimateSupported: false,
      usageBytes: null,
      quotaBytes: null,
    };
    expect(assessImportQuota(Number.MAX_SAFE_INTEGER, unknown).ok).toBe(true);
  });
});
