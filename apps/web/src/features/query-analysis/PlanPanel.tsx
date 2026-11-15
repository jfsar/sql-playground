import type { QueryPlan } from "../../shared/contracts";

/** Parsed plan tree plus the raw SQLite output, always preserved (plan §5.2). */
export function PlanPanel({ plan }: { plan: QueryPlan }) {
  return (
    <div
      data-testid="plan-result"
      className="rounded border border-violet-800 bg-violet-950/30 p-3 text-sm"
    >
      <div className="font-semibold text-violet-300">
        Query plan · {plan.nodes.length} node{plan.nodes.length === 1 ? "" : "s"} · SQLite{" "}
        {plan.sqliteVersion}
      </div>
      <div className="mt-1 text-neutral-400">raw output preserved below the tree</div>
      <ul className="mt-2 space-y-1 font-mono text-neutral-200">
        {plan.nodes.map((n) => (
          <li key={n.id} data-testid={`plan-node-${n.id}`}>
            <span className="text-violet-300">#{n.id}</span>{" "}
            <span className="text-sky-300">{n.operation}</span>
            {n.table ? <span className="text-neutral-100"> {n.table}</span> : null}
            {n.index ? <span className="text-emerald-300"> USING {n.index}</span> : null}
            {n.tags.length > 0 ? (
              <span className="text-amber-300"> [{n.tags.join(", ")}]</span>
            ) : null}
            <span className="text-neutral-500"> — {n.detail}</span>
          </li>
        ))}
      </ul>
      <pre className="mt-2 overflow-x-auto text-neutral-500">
        {plan.raw.map((r) => `${r.id}|${r.parent}|${r.detail}`).join("\n")}
      </pre>
    </div>
  );
}
