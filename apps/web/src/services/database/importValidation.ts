import {
  IMPORT_STRONG_WARN_BYTES,
  IMPORT_WARN_BYTES,
  type ImportKind,
  type ImportReport,
  type ImportWarning,
} from "../../shared/contracts";
import type { StorageInfo } from "../storage/quota";

export const SQLITE_HEADER = "SQLite format 3\0";

const HEADER_BYTES = 100;
const PAGE_SIZE_OFFSET = 16;
const WRITE_VERSION_OFFSET = 18;
const READ_VERSION_OFFSET = 19;

export interface QuotaAssessment {
  ok: boolean;
  requiredBytes: number;
  availableBytes: number | null;
  message: string | null;
}

function hasSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_HEADER.length) return false;
  for (let i = 0; i < SQLITE_HEADER.length; i += 1) {
    if (bytes[i] !== SQLITE_HEADER.charCodeAt(i)) return false;
  }
  return true;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function validPageSize(raw: number): number | null {
  if (raw === 1) return 65536;
  if (raw < 512 || raw > 32768) return null;
  if ((raw & (raw - 1)) !== 0) return null;
  return raw;
}

export function detectImportKind(fileName: string, bytes: Uint8Array): ImportKind {
  if (hasSqliteHeader(bytes)) return "sqlite";
  return /\.sql$/i.test(fileName) ? "sql" : "sqlite";
}

function sizeWarnings(sizeBytes: number): ImportWarning[] {
  if (sizeBytes >= IMPORT_STRONG_WARN_BYTES) {
    return [
      {
        code: "VERY_LARGE_FILE",
        message:
          "This file is very large (250 MB or more). Import, export, and backup may be slow or run out of browser storage.",
      },
    ];
  }
  if (sizeBytes >= IMPORT_WARN_BYTES) {
    return [
      {
        code: "LARGE_FILE",
        message:
          "This file is larger than 100 MB. The import holds the file in memory and may take a while.",
      },
    ];
  }
  return [];
}

export function inspectSqliteFile(fileName: string, bytes: Uint8Array): ImportReport {
  const warnings = sizeWarnings(bytes.byteLength);
  const base = {
    kind: "sqlite" as const,
    fileName,
    sizeBytes: bytes.byteLength,
    warnings,
  };

  if (!hasSqliteHeader(bytes)) {
    return {
      ...base,
      ok: false,
      error: {
        code: "UNSUPPORTED_FILE",
        message:
          "This file is not a SQLite database. It may be encrypted, compressed, or use a different format.",
      },
    };
  }

  if (bytes.byteLength < HEADER_BYTES) {
    return {
      ...base,
      ok: false,
      error: {
        code: "CORRUPT_FILE",
        message: "The SQLite header is incomplete; the file is truncated.",
      },
    };
  }

  const pageSize = validPageSize(readUint16BE(bytes, PAGE_SIZE_OFFSET));
  if (pageSize === null) {
    return {
      ...base,
      ok: false,
      error: {
        code: "CORRUPT_FILE",
        message: "The SQLite header reports an invalid page size.",
      },
    };
  }

  if (bytes.byteLength % pageSize !== 0) {
    return {
      ...base,
      ok: false,
      error: {
        code: "CORRUPT_FILE",
        message: `The file is truncated: its size (${bytes.byteLength} bytes) is not a whole number of ${pageSize}-byte pages.`,
      },
    };
  }

  const writeVersion = bytes[WRITE_VERSION_OFFSET]!;
  const readVersion = bytes[READ_VERSION_OFFSET]!;
  const isWal = writeVersion === 2 || readVersion === 2;
  if (isWal) {
    warnings.push({
      code: "WAL_MODE",
      message:
        "This database uses WAL mode. Content still in a separate -wal file is not part of this import; the copy will be converted to the supported rollback-journal mode.",
    });
  }

  return {
    ...base,
    ok: true,
    pageSize,
    journalMode: isWal ? "wal" : "delete",
  };
}

export function readSqlText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

export function inspectSqlFile(fileName: string, bytes: Uint8Array): ImportReport {
  const warnings = sizeWarnings(bytes.byteLength);
  const base = {
    kind: "sql" as const,
    fileName,
    sizeBytes: bytes.byteLength,
    warnings,
  };

  if (bytes.includes(0)) {
    return {
      ...base,
      ok: false,
      error: {
        code: "UNSUPPORTED_FILE",
        message: "The script contains binary data (NUL bytes) and is not valid UTF-8 SQL text.",
      },
    };
  }

  const text = readSqlText(bytes);
  if (text === null) {
    return {
      ...base,
      ok: false,
      error: {
        code: "UNSUPPORTED_FILE",
        message: "The script is not valid UTF-8 text.",
      },
    };
  }

  if (text.trim().length === 0) {
    warnings.push({ code: "EMPTY_SCRIPT", message: "This script is empty." });
  }

  return { ...base, ok: true };
}

export function inspectImportFile(fileName: string, bytes: Uint8Array): ImportReport {
  const kind = detectImportKind(fileName, bytes);
  return kind === "sql" ? inspectSqlFile(fileName, bytes) : inspectSqliteFile(fileName, bytes);
}

export function assessImportSize(sizeBytes: number): ImportWarning[] {
  return sizeWarnings(sizeBytes);
}

export function assessImportQuota(sizeBytes: number, info: StorageInfo): QuotaAssessment {
  if (!info.estimateSupported || info.usageBytes === null || info.quotaBytes === null) {
    return {
      ok: true,
      requiredBytes: sizeBytes,
      availableBytes: null,
      message: null,
    };
  }

  const availableBytes = Math.max(0, info.quotaBytes - info.usageBytes);
  if (sizeBytes <= availableBytes) {
    return {
      ok: true,
      requiredBytes: sizeBytes,
      availableBytes,
      message: null,
    };
  }

  return {
    ok: false,
    requiredBytes: sizeBytes,
    availableBytes,
    message:
      "Browser storage does not have enough free space for this import. Delete unused databases or export and remove some, then try again.",
  };
}
