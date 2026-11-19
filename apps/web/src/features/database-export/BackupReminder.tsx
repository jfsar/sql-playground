import type { BackupStatus } from "../../services/storage/backupReminder";

interface BackupReminderProps {
  status: BackupStatus;
  onExport: () => void;
  onDismiss: () => void;
}

function describeLastBackup(lastBackupAt: number | null): string {
  if (lastBackupAt === null) return "This browser storage is not a backup.";
  const days = Math.floor((Date.now() - lastBackupAt) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "Last export was today.";
  return `Last export was ${days} day${days === 1 ? "" : "s"} ago.`;
}

export function BackupReminder({ status, onExport, onDismiss }: BackupReminderProps) {
  if (!status.show) return null;
  return (
    <div
      data-testid="backup-reminder"
      className="border-b border-amber-900 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200"
    >
      <div className="font-medium">
        {status.reason === "never" ? "No backup yet." : "Backup reminder."}
      </div>
      <div className="mt-0.5 text-amber-300/80">
        {describeLastBackup(status.lastBackupAt)} OPFS can be cleared or evicted by the browser;
        export a copy you control.
      </div>
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          data-testid="backup-now"
          onClick={onExport}
          className="rounded bg-amber-800 px-2 py-1 font-medium text-amber-50 hover:bg-amber-700"
        >
          Export now
        </button>
        <button
          type="button"
          data-testid="backup-dismiss"
          onClick={onDismiss}
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
