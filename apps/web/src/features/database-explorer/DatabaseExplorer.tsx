import { useState } from "react";
import type { DatabaseInfo } from "../../shared/contracts";
import { formatBytes, type StorageInfo } from "../../services/storage/quota";

interface DatabaseExplorerProps {
  databases: DatabaseInfo[];
  activeId: string | null;
  /** True while a lifecycle operation is in flight. */
  busy: boolean;
  /** User-facing failure of the last lifecycle operation (NFR-07 text). */
  error: string | null;
  storageInfo: StorageInfo | null;
  onOpen: (id: string) => void;
  onCreate: (name: string) => void;
  onCreateSample: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onRequestPersistence: () => void;
}

function StatusBadge({ status }: { status: DatabaseInfo["status"] }) {
  if (status === "missing-file") {
    return (
      <span
        data-testid="db-status-missing"
        className="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
      >
        missing file
      </span>
    );
  }
  if (status === "recovered") {
    return (
      <span
        data-testid="db-status-recovered"
        className="rounded bg-sky-950 px-1.5 py-0.5 text-[10px] font-medium text-sky-300"
      >
        recovered
      </span>
    );
  }
  return null;
}

function StorageFooter({
  info,
  onRequestPersistence,
}: {
  info: StorageInfo | null;
  onRequestPersistence: () => void;
}) {
  if (!info) return null;
  const usage =
    info.estimateSupported && info.usageBytes !== null && info.quotaBytes !== null
      ? `${formatBytes(info.usageBytes)} of ${formatBytes(info.quotaBytes)} used`
      : "storage estimate unavailable";
  return (
    <div className="border-t border-neutral-800 p-3 text-[11px] text-neutral-500">
      <div data-testid="storage-usage">{usage}</div>
      <div className="mt-1" data-testid="storage-persisted">
        {info.persisted
          ? "protected from automatic eviction"
          : info.opfsSupported
            ? "not yet protected from eviction"
            : "OPFS unavailable"}
      </div>
      {!info.persisted && info.opfsSupported ? (
        <button
          type="button"
          data-testid="request-persistence"
          onClick={onRequestPersistence}
          className="mt-2 rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700"
        >
          Ask browser to keep storage
        </button>
      ) : null}
    </div>
  );
}

/**
 * Explorer sidebar (plan §9): database list with create / open / rename /
 * delete, status badges from reconciliation, and storage availability display.
 */
export function DatabaseExplorer({
  databases,
  activeId,
  busy,
  error,
  storageInfo,
  onOpen,
  onCreate,
  onCreateSample,
  onRename,
  onDelete,
  onRequestPersistence,
}: DatabaseExplorerProps) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const submitCreate = () => {
    onCreate(newName);
    setNewName("");
    setAdding(false);
  };

  const submitRename = (id: string) => {
    onRename(id, renameValue);
    setRenamingId(null);
    setRenameValue("");
  };

  return (
    <div className="flex min-h-0 flex-col" data-testid="database-explorer">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-xs font-medium text-neutral-400">Databases</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            data-testid="create-sample-database"
            onClick={onCreateSample}
            disabled={busy}
            title="Create the bundled sample database"
            className="rounded bg-sky-900 px-2 py-1 text-[11px] font-medium text-sky-100 hover:bg-sky-800 disabled:opacity-40"
          >
            Sample
          </button>
          <button
            type="button"
            data-testid="new-database"
            onClick={() => setAdding((v) => !v)}
            disabled={busy}
            className="rounded bg-neutral-800 px-2 py-1 text-[11px] font-medium text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          >
            {adding ? "Cancel" : "New"}
          </button>
        </span>
      </div>

      {adding ? (
        <div className="flex gap-2 border-b border-neutral-800 p-3">
          <input
            data-testid="database-name-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Database name"
            autoFocus
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 outline-none focus:border-sky-600"
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <button
            type="button"
            data-testid="confirm-create"
            onClick={submitCreate}
            disabled={busy}
            className="rounded bg-sky-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-600 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      ) : null}

      {error ? (
        <div
          data-testid="database-op-error"
          className="m-3 rounded border border-red-800 bg-red-950/40 p-2 text-[11px] text-red-300"
        >
          {error}
        </div>
      ) : null}

      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {databases.length === 0 ? (
          <li className="p-2 text-xs text-neutral-500">No databases yet.</li>
        ) : null}
        {databases.map((db) => {
          const isActive = db.id === activeId;
          const isRenaming = renamingId === db.id;
          const isDeleting = deletingId === db.id;
          return (
            <li
              key={db.id}
              data-testid="database-item"
              data-active={isActive ? "true" : "false"}
              className={`mb-1 rounded border ${
                isActive
                  ? "border-sky-700 bg-sky-950/30"
                  : "border-transparent hover:bg-neutral-900"
              }`}
            >
              {isRenaming ? (
                <div className="flex gap-1 p-2">
                  <input
                    data-testid="rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    autoFocus
                    className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 outline-none focus:border-sky-600"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRename(db.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                  <button
                    type="button"
                    data-testid="confirm-rename"
                    onClick={() => submitRename(db.id)}
                    disabled={busy}
                    className="rounded bg-sky-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-600 disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
              ) : isDeleting ? (
                <div className="p-2 text-[11px]">
                  <div className="text-neutral-300">
                    Delete <span className="font-medium text-neutral-100">“{db.name}”</span>?
                  </div>
                  <div className="mt-1.5 flex gap-2">
                    <button
                      type="button"
                      data-testid="confirm-delete"
                      onClick={() => {
                        setDeletingId(null);
                        onDelete(db.id);
                      }}
                      disabled={busy}
                      className="rounded bg-red-800 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-40"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      data-testid="cancel-delete"
                      onClick={() => setDeletingId(null)}
                      className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <button
                    type="button"
                    data-testid="open-database"
                    onClick={() => onOpen(db.id)}
                    disabled={busy}
                    aria-current={isActive ? "true" : undefined}
                    className="min-w-0 flex-1 truncate text-left text-sm text-neutral-200 hover:text-white disabled:opacity-50"
                  >
                    <span data-testid={isActive ? "active-database" : undefined}>{db.name}</span>
                    <StatusBadge status={db.status} />
                  </button>
                  <button
                    type="button"
                    data-testid="rename-database"
                    aria-label={`Rename ${db.name}`}
                    onClick={() => {
                      setRenamingId(db.id);
                      setRenameValue(db.name);
                      setDeletingId(null);
                    }}
                    disabled={busy}
                    className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    data-testid="delete-database"
                    aria-label={`Delete ${db.name}`}
                    onClick={() => {
                      setDeletingId(db.id);
                      setRenamingId(null);
                    }}
                    disabled={busy}
                    className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-800 hover:text-red-400 disabled:opacity-40"
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <StorageFooter info={storageInfo} onRequestPersistence={onRequestPersistence} />
    </div>
  );
}
