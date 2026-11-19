const LAST_BACKUP_KEY = "sql-playground:last-backup";
const DISMISSED_KEY = "sql-playground:backup-reminder-dismissed";
export const BACKUP_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

export type BackupReminderReason = "never" | "stale" | null;

export interface BackupStatus {
  lastBackupAt: number | null;
  due: boolean;
  reason: BackupReminderReason;
  show: boolean;
  dismissedAt: number | null;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readNumber(storage: Storage | null, key: string): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeNumber(storage: Storage | null, key: string, value: number): void {
  if (!storage) return;
  try {
    storage.setItem(key, String(value));
  } catch {
    // Storage can be denied; the reminder simply does not persist.
  }
}

export function getLastBackupAt(storage: Storage | null = defaultStorage()): number | null {
  return readNumber(storage, LAST_BACKUP_KEY);
}

export function recordBackup(at: number, storage: Storage | null = defaultStorage()): void {
  writeNumber(storage, LAST_BACKUP_KEY, at);
}

export function dismissBackupReminder(
  at: number,
  storage: Storage | null = defaultStorage(),
): void {
  writeNumber(storage, DISMISSED_KEY, at);
}

export function getBackupStatus(
  now: number,
  storage: Storage | null = defaultStorage(),
): BackupStatus {
  const lastBackupAt = getLastBackupAt(storage);
  const dismissedAt = readNumber(storage, DISMISSED_KEY);
  const reason: BackupReminderReason =
    lastBackupAt === null ? "never" : now - lastBackupAt >= BACKUP_REMINDER_MS ? "stale" : null;
  const due = reason !== null;
  const dismissed =
    dismissedAt !== null &&
    (lastBackupAt === null || dismissedAt >= lastBackupAt) &&
    now - dismissedAt < BACKUP_REMINDER_MS;

  return {
    lastBackupAt,
    due,
    reason,
    show: due && !dismissed,
    dismissedAt,
  };
}
