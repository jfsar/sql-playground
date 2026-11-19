import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanDiff, QueryPlanNode } from "../../shared/contracts";
import { PlanDiffView } from "./PlanDiffView";

afterEach(cleanup);

function node(id: number, detail: string): QueryPlanNode {
  return { id, parentId: 0, operation: "OTHER", tags: [], detail };
}

describe("PlanDiffView", () => {
  it("reports an empty diff", () => {
    const diff: PlanDiff = { added: [], removed: [], changed: [] };
    render(<PlanDiffView diff={diff} />);
    expect(screen.getByTestId("plan-diff-summary").textContent).toContain("0 changed");
    expect(screen.getByTestId("plan-diff-empty")).toBeTruthy();
  });

  it("shows changed nodes as before and after", () => {
    const diff: PlanDiff = {
      added: [],
      removed: [],
      changed: [
        { before: node(0, "SCAN notes"), after: node(0, "SEARCH notes USING INDEX idx_body") },
      ],
    };
    render(<PlanDiffView diff={diff} />);
    const changed = screen.getByTestId("plan-diff-changed-0");
    expect(changed.textContent).toContain("SCAN notes");
    expect(changed.textContent).toContain("SEARCH notes USING INDEX idx_body");
    expect(screen.getByTestId("plan-diff-summary").textContent).toContain("1 changed");
    expect(screen.queryByTestId("plan-diff-empty")).toBeNull();
  });

  it("lists added and removed nodes", () => {
    const diff: PlanDiff = {
      added: [node(5, "SEARCH tags USING INDEX idx_tag")],
      removed: [node(3, "SCAN tags")],
      changed: [],
    };
    render(<PlanDiffView diff={diff} />);
    expect(screen.getByTestId("plan-diff-added-5").textContent).toContain("SEARCH tags");
    expect(screen.getByTestId("plan-diff-removed-3").textContent).toContain("SCAN tags");
    expect(screen.getByTestId("plan-diff-summary").textContent).toContain("1 added");
    expect(screen.getByTestId("plan-diff-summary").textContent).toContain("1 removed");
  });
});
