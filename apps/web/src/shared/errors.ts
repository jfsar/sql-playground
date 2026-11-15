/**
 * Error model (plan §5.3, NFR-07): every `DbError.code` has a user-facing
 * message with a next step. `contracts.ts` imports the code union from here so
 * the guidance record can never drift out of sync with the type.
 */

export const DB_ERROR_CODES = [
  "SQL_ERROR",
  "CONSTRAINT",
  "CANCELLED",
  "IO",
  "QUOTA",
  "POLICY_BLOCKED",
  "UNSUPPORTED_FILE",
  "CORRUPT_FILE",
  "LOCKED_BY_OTHER_TAB",
  "WORKER_CRASHED",
  "STORAGE_UNAVAILABLE",
] as const;

export type DbErrorCode = (typeof DB_ERROR_CODES)[number];

export interface ErrorGuidance {
  /** Short label for the failure category. */
  title: string;
  /** Default explanation when the source error has no message of its own. */
  message: string;
  /** Concrete next step the user can take. */
  nextStep: string;
}

const GUIDANCE: Record<DbErrorCode, ErrorGuidance> = {
  SQL_ERROR: {
    title: "SQL error",
    message: "SQLite could not run the statement.",
    nextStep: "Check the SQL near the reported position and run it again.",
  },
  CONSTRAINT: {
    title: "Constraint violation",
    message: "The statement violated a table constraint.",
    nextStep:
      "Adjust the values to satisfy NOT NULL, UNIQUE, PRIMARY KEY, or FOREIGN KEY constraints.",
  },
  CANCELLED: {
    title: "Query cancelled",
    message: "The query was cancelled before it finished.",
    nextStep: "Run the query again if you still need the results.",
  },
  IO: {
    title: "Storage input/output error",
    message: "Reading or writing the database failed.",
    nextStep: "Try again; if it persists, export your database and reload the page.",
  },
  QUOTA: {
    title: "Browser storage is full",
    message: "There is not enough browser storage available for this operation.",
    nextStep: "Delete unused databases or export and remove some, then try again.",
  },
  POLICY_BLOCKED: {
    title: "Statement blocked by policy",
    message: "This statement is blocked because it would create or open extra files.",
    nextStep: "Remove ATTACH DATABASE or VACUUM INTO and run the script again.",
  },
  UNSUPPORTED_FILE: {
    title: "Not a SQLite database",
    message: "The selected file does not start with the SQLite 3 header.",
    nextStep: "Choose a .db, .sqlite, or .sqlite3 file created by SQLite.",
  },
  CORRUPT_FILE: {
    title: "Database file is damaged",
    message: "SQLite reported that the file is corrupt or not a database.",
    nextStep: "Restore the file from a backup or re-import a known-good copy.",
  },
  LOCKED_BY_OTHER_TAB: {
    title: "Open in another tab",
    message: "Another tab of this app is currently using the databases.",
    nextStep: "Close the other tab, then retry from this one.",
  },
  WORKER_CRASHED: {
    title: "Database worker crashed",
    message: "The background worker stopped unexpectedly.",
    nextStep: "Run your query again — the worker restarts automatically and saved data is intact.",
  },
  STORAGE_UNAVAILABLE: {
    title: "Browser storage unavailable",
    message: "Databases cannot be stored in this browser session.",
    nextStep:
      "Leave private browsing or allow site data for this origin, then reload. Nothing persists until storage works.",
  },
};

/** Guidance for a `DbError.code`, combining the category text with `detail`. */
export function describeDbError(code: DbErrorCode, detail?: string): ErrorGuidance {
  const base = GUIDANCE[code];
  return {
    title: base.title,
    message: detail && detail.trim().length > 0 ? detail : base.message,
    nextStep: base.nextStep,
  };
}

/**
 * Error that rejects `DatabaseService` promises which cannot produce an
 * `ExecutionResponse` (plan §5.3: errors that prevent execution altogether
 * reject with a `DbError`-shaped failure).
 */
export class DbOperationError extends Error {
  readonly code: DbErrorCode;

  constructor(code: DbErrorCode, message?: string) {
    super(message ?? GUIDANCE[code].message);
    this.name = "DbOperationError";
    this.code = code;
  }
}
