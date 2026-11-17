import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResultsGrid } from "./ResultsGrid";
import type { ColumnInfo, SqlValue } from "../../shared/contracts";

afterEach(cleanup);

const columns: ColumnInfo[] = [{ name: "v", declaredType: "INTEGER" }];

function makeRows(count: number): SqlValue[][] {
  return Array.from({ length: count }, (_, i) => [i + 1]);
}

describe("ResultsGrid", () => {
  it("exposes the ARIA grid pattern over the full result", () => {
    render(<ResultsGrid columns={columns} rows={makeRows(5)} />);
    const grid = screen.getByRole("grid", { name: "Query results" });
    expect(grid.getAttribute("aria-rowcount")).toBe("6"); // header + 5 rows
    expect(grid.getAttribute("aria-colcount")).toBe("1");
    expect(screen.getByRole("columnheader").textContent).toContain("v");
    expect(screen.getAllByRole("gridcell")).toHaveLength(5);
    // Row indices cover the whole result, not just the window.
    expect(screen.getByText("1").closest("tr")?.getAttribute("aria-rowindex")).toBe("2");
    expect(screen.getByText("5").closest("tr")?.getAttribute("aria-rowindex")).toBe("6");
  });

  it("uses a roving tabindex with arrow-key navigation", () => {
    render(<ResultsGrid columns={columns} rows={makeRows(5)} />);
    const cells = screen.getAllByRole("gridcell");
    expect(cells[0].getAttribute("tabindex")).toBe("0");
    expect(cells[1].getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(screen.getByTestId("results-grid"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(cells[1]);
    expect(cells[1].getAttribute("tabindex")).toBe("0");
    expect(cells[0].getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(screen.getByTestId("results-grid"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(cells[0]);
  });

  it("clamps navigation at the edges and jumps with Ctrl+End", () => {
    render(<ResultsGrid columns={columns} rows={makeRows(3)} />);
    fireEvent.keyDown(screen.getByTestId("results-grid"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getAllByRole("gridcell")[0]);

    fireEvent.keyDown(screen.getByTestId("results-grid"), { key: "End", ctrlKey: true });
    expect(document.activeElement).toBe(screen.getAllByRole("gridcell")[2]);
  });

  it("moves across columns with ArrowRight", () => {
    const twoCols: ColumnInfo[] = [{ name: "a" }, { name: "b" }];
    render(<ResultsGrid columns={twoCols} rows={[[1, 2]]} />);
    fireEvent.keyDown(screen.getByTestId("results-grid"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getAllByRole("gridcell")[1]);
    expect(document.activeElement?.getAttribute("aria-colindex")).toBe("2");
  });

  it("virtualizes large results while announcing the full row count", () => {
    render(<ResultsGrid columns={columns} rows={makeRows(1000)} />);
    const grid = screen.getByRole("grid");
    expect(grid.getAttribute("aria-rowcount")).toBe("1001");
    // Windowed: far fewer cells than the 1,000 data rows.
    expect(screen.getAllByRole("gridcell").length).toBeLessThan(30);
  });

  it("renders only the header when there are no rows", () => {
    render(<ResultsGrid columns={columns} rows={[]} />);
    expect(screen.getByRole("grid").getAttribute("aria-rowcount")).toBe("1");
    expect(screen.queryAllByRole("gridcell")).toHaveLength(0);
  });

  it("renders NULL, BLOB, and bigint values distinctly", () => {
    render(<ResultsGrid columns={[{ name: "v" }]} rows={[[null], [new Uint8Array(3)], [7n]]} />);
    expect(screen.getByText("NULL")).toBeTruthy();
    expect(screen.getByText("<BLOB 3 bytes>")).toBeTruthy();
    expect(screen.getByText("7n")).toBeTruthy();
  });
});
