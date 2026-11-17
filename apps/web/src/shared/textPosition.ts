import type { StatementSpan } from "./contracts";

/**
 * Convert a UTF-8 byte offset in `sql` to a JS string index (UTF-16 code units).
 * Mid-character offsets map to the character that contains them.
 *
 * SQLite reports `sqlite3_error_offset` and statement spans as UTF-8 byte
 * offsets; the editor and React work in UTF-16 indices (plan §5.3).
 */
export function byteOffsetToJsIndex(sql: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const code = sql.charCodeAt(i);
    let charBytes: number;
    if (code < 0x80) charBytes = 1;
    else if (code < 0x800) charBytes = 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < sql.length) {
      charBytes = 4;
      // Surrogate pair: treat as one unit for offset math, advance past low surrogate.
      if (byteOffset < bytes + charBytes) return i;
      bytes += charBytes;
      i += 1;
      continue;
    } else charBytes = 3;

    if (byteOffset < bytes + charBytes) return i;
    bytes += charBytes;
  }
  return sql.length;
}

export interface LineColumn {
  /** 1-based line number. */
  line: number;
  /** 1-based column, in UTF-16 code units. */
  column: number;
}

/** Map a string index to a 1-based line/column (lines split on `\n`). */
export function indexToLineColumn(doc: string, index: number): LineColumn {
  const clamped = Math.max(0, Math.min(index, doc.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (doc.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

/**
 * Editor range highlighting the token SQLite pointed at, as absolute indices
 * into the live document.
 *
 * `script` is the SQL that was executed (the whole document, or the selected
 * text) and `docStart` is where that script begins in the document (0 for a
 * whole-document run). `span`/`byteOffset` come back from the worker relative
 * to `script` (plan §5.2 rule 1: statement spans, and `sqlite3_error_offset`,
 * are both statement-relative).
 *
 * Returns null when there is no offset to mark or the position no longer fits
 * the document (the user edited after the run cleared the mark anyway).
 */
export function computeErrorMark(
  script: string,
  docStart: number,
  span: StatementSpan,
  byteOffset: number,
): { from: number; to: number } | null {
  if (byteOffset < 0) return null;
  const rel = span.start + byteOffsetToJsIndex(span.text, byteOffset);
  if (rel >= script.length) return null;
  let end = rel;
  while (end < script.length && !/\s/.test(script.charAt(end))) end += 1;
  if (end <= rel) end = rel + 1;
  return { from: docStart + rel, to: docStart + end };
}
