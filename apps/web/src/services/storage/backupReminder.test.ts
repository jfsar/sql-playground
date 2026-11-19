import { describe, expect, it } from "vitest";
import {
  BACKUP_REMINDER_MS,
  dismissBackupReminder,
  getBackupStatus,
  getLastBackupAt,
  recordBackup,
} from "./backupReminder";

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

const NOW = 10 * BACKUP_REMINDER_MS;

describe("backup reminders", () => {
  it("reminds when no backup has ever been recorded", () => {
    const storage = fakeStorage();
    const status = getBackupStatus(NOW, storage);
    expect(status).toMatchObject({ due: true, reason: "never", show: true, lastBackupAt: null });
  });

  it("tracks exports and stops reminding when fresh", () => {
    const storage = fakeStorage();
    recordBackup(NOW - 1000, storage);
    expect(getLastBackupAt(storage)).toBe(NOW - 1000);
    expect(getBackupStatus(NOW, storage)).toMatchObject({
      due: false,
      reason: null,
      show: false,
    });
  });

  it("reminds again after seven days", () => {
    const storage = fakeStorage();
    recordBackup(NOW - BACKUP_REMINDER_MS, storage);
    expect(getBackupStatus(NOW, storage)).toMatchObject({
      due: true,
      reason: "stale",
      show: true,
    });
  });

  it("honors dismissal until the reminder is due again", () => {
    const storage = fakeStorage();
    dismissBackupReminder(NOW - 1000, storage);
    expect(getBackupStatus(NOW, storage).show).toBe(false);
    expect(getBackupStatus(NOW + BACKUP_REMINDER_MS, storage).show).toBe(true);
  });

  it("shows again after a new export becomes stale even if an old dismissal exists", () => {
    const storage = fakeStorage();
    recordBackup(NOW + 1000, storage);
    dismissBackupReminder(NOW, storage);
    expect(getBackupStatus(NOW + 2000, storage).show).toBe(false);
    expect(getBackupStatus(NOW + BACKUP_REMINDER_MS + 2000, storage).show).toBe(true);
  });
});
