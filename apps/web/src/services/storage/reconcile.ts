/**
 * Startup reconciliation (plan §5.6, ADR-005): database files live in the
 * OPFS pool while the database list lives in IndexedDB, so the two can drift
 * apart after a crash or interrupted delete. This module is pure so the drift
 * rules are unit-testable without a browser (acceptance scenario 24).
 *
 * - Files are named by stable id: `/db_<id>.sqlite3` (rename is metadata-only).
 * - Two-phase delete: entries marked `deleting` are completed here (file
 *   unlinked, then entry removed).
 * - A managed file with no metadata becomes a "Recovered database" entry.
 * - Metadata with no file is marked `missing-file`.
 * - Foreign files (journals, anything not matching the id pattern) are
 *   ignored and logged, never adopted or removed.
 */

import type { DatabaseInfo } from "../../shared/contracts";

export const RECOVERED_DATABASE_NAME = "Recovered database";

/** Pool file name for a database id (plan §5.6). */
export function dbFileName(id: string): string {
  return `/db_${id}.sqlite3`;
}

const DB_FILE_RE = /^\/db_([A-Za-z0-9-]+)\.sqlite3$/;

/** Inverse of `dbFileName`; null for foreign files. */
export function idFromDbFileName(filename: string): string | null {
  const match = DB_FILE_RE.exec(filename);
  return match ? match[1] : null;
}

export interface ReconcileInput {
  /** Metadata entries as stored (including any `deleting` markers). */
  metadata: readonly DatabaseInfo[];
  /** File names currently allocated in the OPFS pool. */
  files: readonly string[];
  /** False in the in-memory fallback: no files exist to compare against. */
  persistent: boolean;
  /** Injected clock for deterministic tests. */
  now: number;
}

export interface ReconcileResult {
  /** Entries whose metadata changed and must be written back. */
  changed: DatabaseInfo[];
  /** `deleting` entries whose file (if any) was handled — remove them next. */
  removedIds: string[];
  /** Pool files that belonged to `deleting` entries and must be unlinked. */
  filesToDelete: string[];
  /** Ids of newly recovered orphan files. */
  recoveredIds: string[];
  /** Ids of entries whose file went missing. */
  missingIds: string[];
  /** Pool files that are not managed databases (ignored, logged only). */
  ignoredFiles: string[];
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const { metadata, files, persistent, now } = input;
  const result: ReconcileResult = {
    changed: [],
    removedIds: [],
    filesToDelete: [],
    recoveredIds: [],
    missingIds: [],
    ignoredFiles: [],
  };

  const fileSet = new Set(files);
  const managedIds = new Set<string>();
  for (const filename of files) {
    const id = idFromDbFileName(filename);
    if (id) managedIds.add(id);
    else result.ignoredFiles.push(filename);
  }

  const knownIds = new Set<string>();
  const deletingIds = new Set<string>();
  for (const entry of metadata) {
    if (entry.status === "deleting") {
      // Two-phase delete: finish what a crash interrupted (or re-attempt the
      // file removal; the caller skips removal when the delete throws).
      deletingIds.add(entry.id);
      result.removedIds.push(entry.id);
      const filename = dbFileName(entry.id);
      if (fileSet.has(filename)) result.filesToDelete.push(filename);
      continue;
    }

    knownIds.add(entry.id);
    if (!persistent) {
      // In-memory fallback: files do not exist; never mark entries missing.
      continue;
    }

    const hasFile = fileSet.has(dbFileName(entry.id));
    if (!hasFile && entry.status !== "missing-file") {
      result.missingIds.push(entry.id);
      result.changed.push({ ...entry, status: "missing-file" });
    } else if (hasFile && entry.status !== "ok") {
      // A recovered entry that now has metadata becomes a normal entry.
      result.changed.push({ ...entry, status: "ok" });
    }
  }

  if (persistent) {
    for (const id of managedIds) {
      // Entries already known (including mid-delete ones) are not orphans.
      if (knownIds.has(id) || deletingIds.has(id)) continue;
      const entry: DatabaseInfo = {
        id,
        name: RECOVERED_DATABASE_NAME,
        createdAt: now,
        lastOpenedAt: 0,
        sizeBytes: 0,
        status: "recovered",
      };
      result.recoveredIds.push(id);
      result.changed.push(entry);
    }
  }

  return result;
}
