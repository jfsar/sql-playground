import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryPlan } from "../../shared/contracts";
import { PlanPanel } from "./PlanPanel";

afterEach(cleanup);

const PLAN: QueryPlan = {
  nodes: [
    { id: 1, parentId: 0, operation: "OTHER", tags: [], detail: "COMPOUND QUERY" },
    { id: 2, parentId: 1, operation: "OTHER", tags: [], detail: "LEFT-MOST SUBQUERY" },
    {
      id: 4,
      parentId: 2,
      operation: "SCAN",
      table: "notes",
      tags: [],
      detail: "SCAN notes",
    },
    {
      id: 9,
      parentId: 1,
      operation: "OTHER",
      tags: ["TEMP B-TREE"],
      detail: "USE TEMP B-TREE FOR ORDER BY",
    },
  ],
  raw: [
    { id: 1, parent: 0, detail: "COMPOUND QUERY" },
    { id: 2, parent: 1, detail: "LEFT-MOST SUBQUERY" },
    { id: 4, parent: 2, detail: "SCAN notes" },
    { id: 9, parent: 1, detail: "USE TEMP B-TREE FOR ORDER BY" },
  ],
  sqliteVersion: "3.54.1",
};

describe("PlanPanel", () => {
  it("renders the plan as a nested tree with levels", () => {
    render(<PlanPanel plan={PLAN} />);
    const result = screen.getByTestId("plan-result");
    expect(result.textContent).toContain("4 nodes");
    expect(result.textContent).toContain("SQLite 3.54.1");

    const tree = screen.getByRole("tree", { name: "Query plan tree" });
    expect(tree).toBeTruthy();
    const items = screen.getAllByRole("treeitem");
    expect(items).toHaveLength(4);
    expect(items[0]?.getAttribute("aria-level")).toBe("1");
    expect(items[1]?.getAttribute("aria-level")).toBe("2");
    expect(items[2]?.getAttribute("aria-level")).toBe("3");
  });

  it("shows a neutral explanation for each node", () => {
    render(<PlanPanel plan={PLAN} />);
    expect(screen.getByTestId("plan-node-explanation-4").textContent).toMatch(/reads every row/i);
    expect(screen.getByTestId("plan-node-explanation-9").textContent).toMatch(/sort/i);
    expect(screen.getByTestId("plan-neutral-note").textContent).toMatch(/neutral/i);
  });

  it("keeps the raw SQLite output one click away", () => {
    render(<PlanPanel plan={PLAN} />);
    const raw = screen.getByTestId("plan-raw") as HTMLDetailsElement;
    expect(raw.open).toBe(false);
    fireEvent.click(screen.getByText("Raw SQLite output"));
    expect(raw.open).toBe(true);
    expect(screen.getByTestId("plan-raw-output").textContent).toContain("1|0|COMPOUND QUERY");
  });

  it("handles a plan with no rows", () => {
    render(<PlanPanel plan={{ nodes: [], raw: [], sqliteVersion: "3.54.1" }} />);
    expect(screen.getByTestId("plan-result").textContent).toContain("no plan rows");
    expect(screen.queryByRole("tree")).toBeNull();
  });
});
