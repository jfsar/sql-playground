import type { ExecutionResponse, QueryPlan, WorkerStatus } from "../../shared/contracts";

/** Every message carries a requestId; responses echo it (plan §5.4). */

export type WorkerRequest =
  | { type: "init"; requestId: string }
  | { type: "execute"; requestId: string; sql: string; maxRows?: number }
  | { type: "status"; requestId: string }
  | { type: "explain"; requestId: string; sql: string }
  | { type: "export"; requestId: string };

export type WorkerResponse =
  | { type: "ready"; requestId: string; status: WorkerStatus }
  | { type: "executed"; requestId: string; response: ExecutionResponse }
  | { type: "status-result"; requestId: string; status: WorkerStatus }
  | { type: "explained"; requestId: string; plan: QueryPlan }
  | { type: "exported"; requestId: string; bytes: Uint8Array; name: string }
  | { type: "failed"; requestId: string; error: { code: string; message: string } };

const RESPONSE_TYPES = new Set([
  "ready",
  "executed",
  "status-result",
  "explained",
  "exported",
  "failed",
]);

export function isWorkerResponse(data: unknown): data is WorkerResponse {
  if (typeof data !== "object" || data === null) return false;
  const t = (data as { type?: unknown }).type;
  return typeof t === "string" && RESPONSE_TYPES.has(t);
}
