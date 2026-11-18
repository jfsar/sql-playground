/**
 * Query history (FINAL_PROJECT_PLAN §3 Epic 1 / Week 5): the last 100 executed
 * scripts in IndexedDB, with a persisted disable switch. When history is
 * disabled nothing is written — not even the failed run.
 */

import type { HistoryEntry, QueryHistoryStore } from "../storage/metadataDb";

export const HISTORY_LIMIT = 100;
export const HISTORY_ENABLED_PREFERENCE = "history.enabled";

export interface HistoryRecordInput {
  ok: boolean;
  engineMs?: number;
}

export interface QueryHistoryServiceOptions {
  store: QueryHistoryStore;
  limit?: number;
  now?: () => number;
}

export class QueryHistoryService {
  private readonly store: QueryHistoryStore;
  private readonly limit: number;
  private readonly now: () => number;

  constructor(options: QueryHistoryServiceOptions) {
    this.store = options.store;
    this.limit = options.limit ?? HISTORY_LIMIT;
    this.now = options.now ?? (() => Date.now());
  }

  /** Default is enabled; only an explicit stored `false` disables recording. */
  async isEnabled(): Promise<boolean> {
    const stored = await this.store.getPreference<boolean>(HISTORY_ENABLED_PREFERENCE);
    return stored !== false;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.store.setPreference(HISTORY_ENABLED_PREFERENCE, enabled);
  }

  /** Returns true when an entry was actually stored. */
  async record(sql: string, input: HistoryRecordInput): Promise<boolean> {
    const trimmed = sql.trim();
    if (trimmed.length === 0) return false;
    if (!(await this.isEnabled())) return false;
    await this.store.add({
      sql: trimmed,
      at: this.now(),
      ok: input.ok,
      ...(input.engineMs !== undefined ? { engineMs: input.engineMs } : {}),
    });
    await this.store.trim(this.limit);
    return true;
  }

  list(): Promise<HistoryEntry[]> {
    return this.store.list(this.limit);
  }

  clear(): Promise<void> {
    return this.store.clear();
  }
}
