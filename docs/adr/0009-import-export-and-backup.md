# ADR-009: Import, export, and backup reminder pipeline

- Status: **Accepted** (Week 6)
- Date: 2026-11-18
- Related: ADR-001 (OPFS VFS), ADR-005 (reconciliation), plan §5.5

## Context

Week 6 adds `.db` / `.sqlite` / `.sqlite3` import, `.sql` script import,
SQLite export, quota/size warnings, and backup reminders. The plan requires
validation before storage is touched, staging, `quick_check`, WAL warnings,
`trusted_schema` evaluation, and clear errors for corrupted, encrypted, or
unsupported files. The VFS (`opfs-sahpool`) has a fixed pool and one active
connection.

## Decision

### SQLite imports

Flow: **read → validate in memory → stage → quick_check → create metadata → open**.

- Every import gets a fresh UUID and a new `db_<id>.sqlite3` file. Imports never
  overwrite an existing database and no "replace" flow is offered in the MVP.
- Memory validation checks the `SQLite format 3\0` header, the page-size field
  (power of two, 512–65536), and that the file length is a whole number of
  pages. Header version bytes at offsets 18/19 produce the WAL warning.
- The worker imports the bytes with `poolUtil.importDb`, which also rewrites the
  header to disable WAL (the `-wal` sidecar is never part of the import).
- "Staging" uses the final, not-yet-registered `db_<id>.sqlite3` file. This
  avoids copying a 100 MB payload twice while still keeping IndexedDB metadata
  untouched until `PRAGMA quick_check` returns `ok`. If any step fails, the
  partial file is unlinked and the previously active database is reopened.
- Metadata is written only after the staged file passes validation. If the
  metadata write fails, the staged file is removed and the previous database is
  restored.
- Files at or above 100 MB require explicit confirmation; files at or above
  250 MB show a stronger warning. No hard size stop is enforced until the
  Week 10 benchmarks show instability.

### Hardening

After opening a connection, the worker best-effort applies
`PRAGMA trusted_schema=OFF` and `PRAGMA defensive=ON`. Import results record
whether the schema passed the hardened probe or blocked it (in which case the
worker restores `trusted_schema=ON` for that connection). This is defense in
depth for untrusted imported schemas; SQL still runs only inside the WASM
sandbox.

### SQL script imports

- Scripts require valid UTF-8 text (no NUL bytes) and run through the existing
  execution contract, so statement splitting, policy, stop-on-error, and
  transaction state behave exactly as in the editor.
- New target: the script runs against a freshly created database. If any
  statement fails, that database is deleted and the previous active database is
  restored. This mirrors the sample-database rollback behaviour.
- Existing target: earlier statement effects are kept on failure, matching the
  execution contract.

### Export and backup reminders

- Export reads the named pool file with `poolUtil.exportFile` and downloads it
  as a Blob named from the display name (`<name>.sqlite3`). An empty database is
  initialized with `VACUUM` before export so the downloaded file always has a
  valid SQLite header.
- A local timestamp records the last successful export. The explorer shows a
  dismissible reminder when no export has ever been recorded or the last export
  is at least seven days old. Dismissal lasts until the reminder becomes due
  again. Nothing about backups is transmitted.

## Alternatives considered

- **Always reject files above 100 MB**: rejected — the plan wants warnings and
  a tested limit, not an arbitrary hard stop before benchmarks.
- **Import into a temporary file and import again into the final file**:
  rejected — doubles memory and I/O for large files without gaining safety over
  the unregistered-final-file staging approach.
- **Implement replace-on-import**: deferred — the MVP only requires that imports
  never overwrite by default; a confident replace flow needs more UI and crash
  testing.
- **Permanently set `trusted_schema=OFF` for all connections**: not adopted.
  The app applies it best-effort and records the probe result; blocking a schema
  falls back to normal mode rather than making the imported database unusable.
- **Store backup timestamps in IndexedDB**: rejected — a small local-storage
  value is sufficient and keeps the metadata schema stable.

## Consequences

- Import requires persistent OPFS; the in-memory fallback returns
  `STORAGE_UNAVAILABLE` and the Import button is disabled when OPFS is absent.
- A crash between staging and metadata registration leaves a managed file that
  startup reconciliation adopts as a "Recovered database". This is visible to
  the user and can be deleted or exported.
- Exported files should pass `integrity_check`; import rejects files whose
  `quick_check` fails.
- The 100/250 MB boundaries and the seven-day reminder are product policies,
  not storage guarantees.
