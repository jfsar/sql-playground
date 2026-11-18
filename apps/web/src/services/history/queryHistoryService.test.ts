import { describe, expect, it } from "vitest";
import { createMemoryHistoryStore } from "../storage/metadataDb";
import { HISTORY_ENABLED_PREFERENCE, QueryHistoryService } from "./queryHistoryService";

function makeService(limit = 100) {
  const store = createMemoryHistoryStore();
  let now = 1000;
  const service = new QueryHistoryService({
    store,
    limit,
    now: () => {
      now += 1;
      return now;
    },
  });
  return { store, service };
}

describe("QueryHistoryService", () => {
  it("records trimmed SQL newest-first with ok and timing", async () => {
    const { service } = makeService();
    expect(await service.record("  SELECT 1;  ", { ok: true, engineMs: 1.5 })).toBe(true);
    await service.record("SELECT broken;", { ok: false });

    const entries = await service.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ sql: "SELECT broken;", ok: false });
    expect(entries[1]).toMatchObject({ sql: "SELECT 1;", ok: true, engineMs: 1.5 });
  });

  it("ignores empty scripts", async () => {
    const { service } = makeService();
    expect(await service.record("   \n\t ", { ok: true })).toBe(false);
    expect(await service.list()).toEqual([]);
  });

  it("keeps only the newest entries", async () => {
    const { service } = makeService(3);
    for (let i = 1; i <= 5; i += 1) {
      await service.record(`SELECT ${i};`, { ok: true });
    }
    const entries = await service.list();
    expect(entries.map((entry) => entry.sql)).toEqual(["SELECT 5;", "SELECT 4;", "SELECT 3;"]);
  });

  it("persists the disable switch and records nothing while disabled", async () => {
    const { store, service } = makeService();
    await service.setEnabled(false);
    expect(await store.getPreference(HISTORY_ENABLED_PREFERENCE)).toBe(false);
    expect(await service.record("SELECT 1;", { ok: true })).toBe(false);
    expect(await service.list()).toEqual([]);

    const reopened = new QueryHistoryService({ store });
    expect(await reopened.isEnabled()).toBe(false);
    await reopened.setEnabled(true);
    expect(await reopened.record("SELECT 2;", { ok: true })).toBe(true);
  });

  it("clears all entries", async () => {
    const { service } = makeService();
    await service.record("SELECT 1;", { ok: true });
    await service.record("SELECT 2;", { ok: true });
    await service.clear();
    expect(await service.list()).toEqual([]);
  });
});
