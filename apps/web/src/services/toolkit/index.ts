/**
 * PlanToolkit factory (plan §4 / ADR-002): try the Rust wasm build, verify it
 * round-trips typed data, and fall back to the TypeScript implementation.
 * App code never depends on which implementation is active.
 */

import { loadRustToolkit } from "./rustToolkit";
import type { PlanToolkit } from "./planToolkit";
import { createTsToolkit } from "./tsToolkit";

export interface CreatedToolkit {
  toolkit: PlanToolkit;
  implementation: "rust" | "typescript";
}

/** Round-trip probe: parse must return the same shape it was given. */
function verify(toolkit: PlanToolkit): boolean {
  try {
    const probe = toolkit.parsePlan([{ id: 0, parent: 0, detail: "SCAN probe_t" }], "0.0.0");
    const node = probe.nodes[0];
    return (
      probe.nodes.length === 1 &&
      node.operation === "SCAN" &&
      node.table === "probe_t" &&
      probe.raw.length === 1 &&
      probe.sqliteVersion === "0.0.0"
    );
  } catch {
    return false;
  }
}

export async function createPlanToolkit(): Promise<CreatedToolkit> {
  try {
    const rust = await loadRustToolkit();
    if (verify(rust)) return { toolkit: rust, implementation: "rust" };
  } catch {
    // fall through to TypeScript
  }
  const ts = createTsToolkit();
  return { toolkit: ts, implementation: "typescript" };
}

export type { PlanToolkit };
