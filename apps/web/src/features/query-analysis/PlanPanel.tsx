import type { QueryPlan, QueryPlanNode } from "../../shared/contracts";
import { describePlanNode } from "./planExplanation";
import { buildPlanTree, type PlanTreeNode } from "./planTree";

function OperationBadge({ node }: { node: QueryPlanNode }) {
  return (
    <>
      <span className="text-violet-300">#{node.id}</span>{" "}
      <span className="font-semibold text-sky-300">{node.operation}</span>
      {node.table ? <span className="text-neutral-100"> {node.table}</span> : null}
      {node.index ? <span className="text-emerald-300"> USING {node.index}</span> : null}
      {node.tags.length > 0 ? (
        <span className="text-amber-300"> [{node.tags.join(", ")}]</span>
      ) : null}
    </>
  );
}

function PlanNodeItem({ entry, level }: { entry: PlanTreeNode; level: number }) {
  const { node, children } = entry;
  return (
    <li
      role="treeitem"
      aria-level={level}
      aria-expanded={children.length > 0 ? true : undefined}
      data-testid={`plan-node-${node.id}`}
      className="rounded border border-violet-900/60 bg-violet-950/20 px-2 py-1.5"
    >
      <div className="font-mono text-neutral-200">
        <OperationBadge node={node} />
      </div>
      <p className="mt-1 text-xs text-neutral-400" data-testid={`plan-node-explanation-${node.id}`}>
        {describePlanNode(node)}
      </p>
      {children.length > 0 ? (
        <ul role="group" className="mt-2 space-y-1 border-l border-violet-900 pl-3">
          {children.map((child, index) => (
            <PlanNodeItem key={`${child.node.id}-${index}`} entry={child} level={level + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Parsed plan tree plus the raw SQLite output, always preserved (plan §5.2). */
export function PlanPanel({ plan }: { plan: QueryPlan }) {
  const tree = buildPlanTree(plan.nodes);
  return (
    <div
      data-testid="plan-result"
      className="rounded border border-violet-800 bg-violet-950/30 p-3 text-sm"
    >
      <div className="font-semibold text-violet-300">
        Query plan · {plan.nodes.length} node{plan.nodes.length === 1 ? "" : "s"} · SQLite{" "}
        {plan.sqliteVersion}
      </div>
      <p className="mt-1 text-xs text-neutral-400" data-testid="plan-neutral-note">
        Descriptions are neutral: a scan is not automatically a problem, and an index search is not
        automatically optimal.
      </p>
      {tree.length > 0 ? (
        <ul
          role="tree"
          aria-label="Query plan tree"
          className="mt-3 space-y-1"
          data-testid="plan-tree"
        >
          {tree.map((entry, index) => (
            <PlanNodeItem key={`${entry.node.id}-${index}`} entry={entry} level={1} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-neutral-400">SQLite returned no plan rows.</p>
      )}
      <details className="mt-3" data-testid="plan-raw">
        <summary className="cursor-pointer text-xs text-neutral-400">Raw SQLite output</summary>
        <pre data-testid="plan-raw-output" className="mt-1 overflow-x-auto text-neutral-400">
          {plan.raw.map((r) => `${r.id}|${r.parent}|${r.detail}`).join("\n")}
        </pre>
      </details>
    </div>
  );
}
