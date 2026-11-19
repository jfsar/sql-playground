import type {
  DatabaseSchema,
  ExecutionResponse,
  QueryPlan,
  SqliteImportResult,
  TablePage,
  WorkerStatus,
} from "../../shared/contracts";
import type { DbErrorCode } from "../../shared/errors";

/** Every message carries a requestId; responses echo it (plan §5.4). */

export type WorkerRequest =
  | { type: "init"; requestId: string; openFile?: string }
  | { type: "execute"; requestId: string; sql: string; maxRows?: number }
  | { type: "status"; requestId: string }
  | { type: "explain"; requestId: string; sql: string }
  | { type: "export"; requestId: string; filename?: string }
  | { type: "import-db"; requestId: string; filename: string; bytes: ArrayBuffer }
  | { type: "open-db"; requestId: string; filename: string }
  | { type: "list-files"; requestId: string }
  | { type: "delete-file"; requestId: string; filename: string }
  | { type: "schema"; requestId: string }
  | { type: "browse-table"; requestId: string; table: string; limit: number; offset: number };

export type WorkerResponse =
  | { type: "ready"; requestId: string; status: WorkerStatus }
  | { type: "executed"; requestId: string; response: ExecutionResponse }
  | { type: "status-result"; requestId: string; status: WorkerStatus }
  | { type: "explained"; requestId: string; plan: QueryPlan }
  | { type: "exported"; requestId: string; bytes: Uint8Array; name: string }
  | { type: "imported"; requestId: string; result: SqliteImportResult }
  | { type: "opened"; requestId: string; filename: string; sizeBytes: number }
  | { type: "files"; requestId: string; files: string[] }
  | { type: "deleted"; requestId: string; filename: string; existed: boolean }
  | { type: "schema-result"; requestId: string; schema: DatabaseSchema }
  | { type: "table-page"; requestId: string; page: TablePage }
  | { type: "failed"; requestId: string; error: { code: DbErrorCode; message: string } };

const RESPONSE_TYPES = new Set([
  "ready",
  "executed",
  "status-result",
  "explained",
  "exported",
  "imported",
  "opened",
  "files",
  "deleted",
  "schema-result",
  "table-page",
  "failed",
]);

export function isWorkerResponse(data: unknown): data is WorkerResponse {
  if (typeof data !== "object" || data === null) return false;
  const t = (data as { type?: unknown }).type;
  return typeof t === "string" && RESPONSE_TYPES.has(t);
}
