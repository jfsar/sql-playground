import type { ExecutionResponse, WorkerStatus } from "../../shared/contracts";

/** Every message carries a requestId; responses echo it (plan §5.4). */

export type WorkerRequest =
  | { type: "init"; requestId: string }
  | { type: "execute"; requestId: string; sql: string; maxRows?: number }
  | { type: "status"; requestId: string };

export type WorkerResponse =
  | { type: "ready"; requestId: string; status: WorkerStatus }
  | { type: "executed"; requestId: string; response: ExecutionResponse }
  | { type: "status-result"; requestId: string; status: WorkerStatus }
  | { type: "failed"; requestId: string; error: { code: string; message: string } };

export function isWorkerResponse(data: unknown): data is WorkerResponse {
  if (typeof data !== "object" || data === null) return false;
  const t = (data as { type?: unknown }).type;
  return (
    t === "ready" || t === "executed" || t === "status-result" || t === "failed"
  );
}
