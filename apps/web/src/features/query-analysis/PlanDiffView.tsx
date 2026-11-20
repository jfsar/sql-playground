import type { PlanDiff, QueryPlanNode } from "../../shared/contracts";

function nodeText(node: QueryPlanNode): string {
  return `#${node.id} ${node.detail}`;
}

function NodeList({ nodes, label }: { nodes: QueryPlanNode[]; label: string }) {
  if (nodes.length === 0) return null;
  return (
    <div data-testid={`plan-diff-${label}`}>
      <div className="font-semibold text-neutral-300">
        {label === "added" ? "Added" : "Removed"} · {nodes.length}
      </div>
      <ul className="mt-1 space-y-1 font-mono text-xs text-neutral-400">
        {nodes.map((node) => (
          <li key={node.id} data-testid={`plan-diff-${label}-${node.id}`}>
            {nodeText(node)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Node-level comparison of a pinned plan against the current plan (plan §4). */
export function PlanDiffView({ diff }: { diff: PlanDiff }) {
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  return (
    <section
      data-testid="plan-diff"
      aria-label="Plan diff"
      className="rounded border border-amber-800 bg-amber-950/20 p-3 text-sm"
    >
      <div className="font-semibold text-amber-300" data-testid="plan-diff-summary">
        Plan diff · {diff.changed.length} changed · {diff.added.length} added ·{" "}
        {diff.removed.length} removed
      </div>
      {total === 0 ? (
        <p className="mt-1 text-xs text-neutral-400" data-testid="plan-diff-empty">
          No node-level differences between the pinned plan and the current plan.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {diff.changed.length > 0 ? (
            <div data-testid="plan-diff-changed">
              <div className="font-semibold text-neutral-300">Changed · {diff.changed.length}</div>
              <ul className="mt-1 space-y-1 font-mono text-xs">
                {diff.changed.map(({ before, after }) => (
                  <li
                    key={before.id}
                    data-testid={`plan-diff-changed-${before.id}`}
                    className="text-neutral-400"
                  >
                    <span className="text-neutral-400">
                      <span className="sr-only">before: </span>
                      {nodeText(before)}
                    </span>
                    <span className="text-amber-400" aria-hidden="true">
                      {" "}
                      →{" "}
                    </span>
                    <span className="text-neutral-200">
                      <span className="sr-only">after: </span>
                      {nodeText(after)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <NodeList nodes={diff.added} label="added" />
          <NodeList nodes={diff.removed} label="removed" />
        </div>
      )}
    </section>
  );
}
