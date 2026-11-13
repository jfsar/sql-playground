/**
 * Statement policy (plan §5.2 rule 3).
 * ATTACH DATABASE and VACUUM INTO are blocked: they create/open extra files
 * and would consume opfs-sahpool capacity. Guardrail, not a security boundary.
 */

export interface PolicyDecision {
  blocked: boolean;
  message?: string;
}

const ATTACH_MESSAGE =
  "ATTACH DATABASE is blocked: it would open additional files and consume storage pool capacity. " +
  "Import databases instead (Epic 3).";

const VACUUM_INTO_MESSAGE =
  "VACUUM INTO is blocked: it writes an additional database file and consumes storage pool capacity. " +
  "Export the database instead.";

/** Skip whitespace and SQL comments (line and block). Returns index of first significant char. */
export function skipTrivia(sql: string, from = 0): number {
  let i = from;
  while (i < sql.length) {
    const c = sql.charCodeAt(i);
    // whitespace
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) {
      i += 1;
      continue;
    }
    // -- line comment
    if (c === 45 && sql.charCodeAt(i + 1) === 45) {
      i += 2;
      while (i < sql.length && sql.charCodeAt(i) !== 10) i += 1;
      continue;
    }
    // /* block comment */
    if (c === 47 && sql.charCodeAt(i + 1) === 42) {
      i += 2;
      while (i < sql.length) {
        if (sql.charCodeAt(i) === 42 && sql.charCodeAt(i + 1) === 47) {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }
    break;
  }
  return i;
}

/** Leading keyword of a statement (after trivia), uppercased. Empty if none. */
export function leadingKeyword(sql: string): string {
  const start = skipTrivia(sql);
  let end = start;
  while (end < sql.length) {
    const c = sql.charCodeAt(end);
    const isIdent =
      (c >= 65 && c <= 90) || // A-Z
      (c >= 97 && c <= 122) || // a-z
      (c >= 48 && c <= 57 && end > start) || // 0-9 (not first)
      c === 95; // _
    if (!isIdent) break;
    end += 1;
  }
  return sql.slice(start, end).toUpperCase();
}

/** True if the statement begins with VACUUM followed by INTO (not bare VACUUM). */
export function isVacuumInto(sql: string): boolean {
  if (leadingKeyword(sql) !== "VACUUM") return false;
  const start = skipTrivia(sql);
  const afterVaccum = start + "VACUUM".length;
  const intoAt = skipTrivia(sql, afterVaccum);
  return sql.slice(intoAt, intoAt + 4).toUpperCase() === "INTO";
}

/** Check a single statement against the policy. */
export function checkPolicy(sql: string): PolicyDecision {
  const keyword = leadingKeyword(sql);
  if (keyword === "ATTACH") {
    return { blocked: true, message: ATTACH_MESSAGE };
  }
  if (isVacuumInto(sql)) {
    return { blocked: true, message: VACUUM_INTO_MESSAGE };
  }
  return { blocked: false };
}

/** Keywords whose successful execution reports rowsAffected. */
export function isDmlKeyword(keyword: string): boolean {
  return (
    keyword === "INSERT" || keyword === "UPDATE" || keyword === "DELETE" || keyword === "REPLACE"
  );
}
