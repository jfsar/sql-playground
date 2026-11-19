import { useEffect, useMemo, useRef, useState } from "react";
import type { DatabaseInfo, ImportReport, ScriptImportResult } from "../../shared/contracts";
import { DbOperationError, describeDbError } from "../../shared/errors";
import { assessImportQuota, inspectImportFile } from "../../services/database/importValidation";
import { formatBytes, type StorageInfo } from "../../services/storage/quota";

interface ImportDatabaseDialogProps {
  open: boolean;
  databases: DatabaseInfo[];
  storageInfo: StorageInfo | null;
  onClose: () => void;
  onImportDatabase: (
    file: File,
    opts: { name: string; storageInfo: StorageInfo | null },
  ) => Promise<DatabaseInfo>;
  onImportScript: (
    file: File,
    opts: { targetId?: string; name?: string },
  ) => Promise<ScriptImportResult>;
  onImported: () => void;
}

function nameFromFile(fileName: string): string {
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return base.length > 0 ? base : "Imported database";
}

function errorText(err: unknown): string {
  if (err instanceof DbOperationError) {
    const guidance = describeDbError(err.code, err.message);
    return `${guidance.message} ${guidance.nextStep}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function ImportDatabaseDialog({
  open,
  databases,
  storageInfo,
  onClose,
  onImportDatabase,
  onImportScript,
  onImported,
}: ImportDatabaseDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [name, setName] = useState("");
  const [targetId, setTargetId] = useState("new");
  const [confirmLarge, setConfirmLarge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScriptImportResult | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setReport(null);
    setName("");
    setTargetId("new");
    setConfirmLarge(false);
    setBusy(false);
    setError(null);
    setResult(null);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, busy, onClose]);

  const quota = useMemo(() => {
    if (!report?.ok || !storageInfo) return null;
    return assessImportQuota(report.sizeBytes, storageInfo);
  }, [report, storageInfo]);

  const needsLargeConfirmation = useMemo(
    () =>
      report?.warnings.some(
        (warning) => warning.code === "LARGE_FILE" || warning.code === "VERY_LARGE_FILE",
      ) ?? false,
    [report],
  );

  const isScript = report?.kind === "sql";
  const targetExisting = isScript && targetId !== "new";
  const canSubmit =
    !!file &&
    !!report?.ok &&
    !busy &&
    (!needsLargeConfirmation || confirmLarge) &&
    (!quota || quota.ok) &&
    (!isScript || targetExisting || name.trim().length > 0);

  const chooseFile = async (chosen: File | null) => {
    setFile(chosen);
    setReport(null);
    setError(null);
    setResult(null);
    setConfirmLarge(false);
    if (!chosen) return;
    try {
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      const next = inspectImportFile(chosen.name, bytes);
      setReport(next);
      setName(nameFromFile(chosen.name));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const submit = async () => {
    if (!file || !report?.ok || !canSubmit) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (report.kind === "sqlite") {
        await onImportDatabase(file, { name, storageInfo });
        onImported();
        onClose();
        return;
      }

      const scriptResult = await onImportScript(file, targetExisting ? { targetId } : { name });
      setResult(scriptResult);
      onImported();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-dialog-title"
        data-testid="import-dialog"
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 id="import-dialog-title" className="text-sm font-semibold text-neutral-100">
            Import database
          </h2>
          <button
            type="button"
            data-testid="import-close"
            onClick={onClose}
            disabled={busy}
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
          >
            Close
          </button>
        </div>

        <p className="mt-2 text-xs text-neutral-500">
          Imports create a new database entry and never overwrite existing databases. SQLite files
          are validated and checked before anything is registered.
        </p>

        <label className="mt-4 flex flex-col gap-1 text-xs text-neutral-400">
          <span>File (.db, .sqlite, .sqlite3, .sql)</span>
          <input
            ref={inputRef}
            type="file"
            data-testid="import-file-input"
            accept=".db,.sqlite,.sqlite3,.sql,application/vnd.sqlite3,application/x-sqlite3,text/plain"
            disabled={busy}
            onChange={(event) => void chooseFile(event.target.files?.[0] ?? null)}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 file:mr-2 file:rounded file:border-0 file:bg-neutral-800 file:px-2 file:py-1 file:text-neutral-200"
          />
        </label>

        {report ? (
          <div
            data-testid="import-preview"
            className="mt-3 space-y-2 rounded border border-neutral-800 bg-neutral-950/60 p-3 text-xs text-neutral-300"
          >
            <div>
              <span className="text-neutral-500">Type: </span>
              {report.kind === "sqlite" ? "SQLite database" : "SQL script"} ·{" "}
              {formatBytes(report.sizeBytes)}
            </div>
            {report.pageSize ? (
              <div>
                <span className="text-neutral-500">Page size: </span>
                {report.pageSize} bytes · journal {report.journalMode ?? "unknown"}
              </div>
            ) : null}
            {report.warnings.map((warning) => (
              <div
                key={warning.code}
                data-testid={`import-warning-${warning.code.toLowerCase()}`}
                className="rounded border border-amber-800 bg-amber-950/40 p-2 text-amber-200"
              >
                {warning.message}
              </div>
            ))}
            {report.error ? (
              <div
                data-testid="import-validation-error"
                className="rounded border border-red-800 bg-red-950/40 p-2 text-red-200"
              >
                {describeDbError(report.error.code, report.error.message).message}{" "}
                {describeDbError(report.error.code, report.error.message).nextStep}
              </div>
            ) : null}
          </div>
        ) : null}

        {quota && !quota.ok ? (
          <div
            data-testid="import-quota-error"
            className="mt-3 rounded border border-red-800 bg-red-950/40 p-2 text-xs text-red-200"
          >
            {quota.message} Required {formatBytes(quota.requiredBytes)}
            {quota.availableBytes !== null
              ? `, available ${formatBytes(quota.availableBytes)}`
              : ""}
            .
          </div>
        ) : null}

        {needsLargeConfirmation ? (
          <label className="mt-3 flex items-start gap-2 text-xs text-amber-200">
            <input
              type="checkbox"
              data-testid="import-confirm-large"
              checked={confirmLarge}
              onChange={(event) => setConfirmLarge(event.target.checked)}
              disabled={busy}
              className="mt-0.5"
            />
            <span>
              I understand this file is large and may take a while, use significant memory, or fail
              if browser storage is full.
            </span>
          </label>
        ) : null}

        {report?.ok ? (
          <div className="mt-3 space-y-3">
            {isScript ? (
              <label className="flex flex-col gap-1 text-xs text-neutral-400">
                <span>Target</span>
                <select
                  data-testid="import-target"
                  value={targetId}
                  onChange={(event) => setTargetId(event.target.value)}
                  disabled={busy}
                  className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200"
                >
                  <option value="new">New database</option>
                  {databases
                    .filter(
                      (database) => database.status === "ok" || database.status === "recovered",
                    )
                    .map((database) => (
                      <option key={database.id} value={database.id}>
                        {database.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}

            {!targetExisting ? (
              <label className="flex flex-col gap-1 text-xs text-neutral-400">
                <span>Database name</span>
                <input
                  type="text"
                  data-testid="import-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                  className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-sky-600"
                />
              </label>
            ) : null}

            {isScript ? (
              <p className="text-[11px] text-neutral-500">
                Scripts run through the execution contract and stop at the first error. A new
                database is removed if any statement fails; an existing database keeps earlier
                statement effects.
              </p>
            ) : null}

            <button
              type="button"
              data-testid="import-confirm"
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="rounded bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-40"
            >
              {busy ? "Importing…" : isScript ? "Run script import" : "Import database"}
            </button>
          </div>
        ) : null}

        {error ? (
          <div
            data-testid="import-error"
            className="mt-3 rounded border border-red-800 bg-red-950/40 p-2 text-xs text-red-200"
          >
            {error}
          </div>
        ) : null}

        {result ? (
          <div
            data-testid="import-result"
            className="mt-3 rounded border border-neutral-700 bg-neutral-950/60 p-3 text-xs text-neutral-300"
          >
            <div>
              {result.response.statements.length} statement
              {result.response.statements.length === 1 ? "" : "s"} executed ·{" "}
              {result.response.totalEngineMs.toFixed(2)} ms
            </div>
            {result.rolledBack ? (
              <div className="mt-1 text-amber-300" data-testid="import-rolled-back">
                The script failed, so the new database was removed.
              </div>
            ) : null}
            {result.response.statements
              .filter((statement) => statement.kind === "error")
              .map((statement, index) => (
                <div key={index} className="mt-1 text-red-300">
                  {statement.kind === "error" ? statement.error.message : null}
                </div>
              ))}
            <button
              type="button"
              data-testid="import-done"
              onClick={onClose}
              className="mt-2 rounded bg-neutral-700 px-2 py-1 text-neutral-100 hover:bg-neutral-600"
            >
              Done
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
