import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TablePage } from "../../shared/contracts";
import { TableBrowser } from "./TableBrowser";

afterEach(cleanup);

function makePage(overrides: Partial<TablePage> = {}): TablePage {
  return {
    table: "tracks",
    columns: [
      { name: "id", declaredType: "INTEGER" },
      { name: "title", declaredType: "TEXT" },
    ],
    rows: Array.from({ length: 50 }, (_, i) => [i + 1, `Track ${i + 1}`]),
    totalRows: 120,
    limit: 50,
    offset: 0,
    ...overrides,
  };
}

function renderBrowser(overrides: Partial<Parameters<typeof TableBrowser>[0]> = {}) {
  const props = {
    table: "tracks",
    page: makePage(),
    loading: false,
    error: null,
    onPage: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<TableBrowser {...props} />);
  return props;
}

describe("TableBrowser", () => {
  it("shows row ranges and pages forward", () => {
    const props = renderBrowser();
    expect(screen.getByTestId("table-browser-title").textContent).toBe("tracks");
    expect(screen.getByTestId("table-page-status").textContent).toContain("rows 1–50 of 120");
    expect((screen.getByTestId("table-prev") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("table-next"));
    expect(props.onPage).toHaveBeenCalledWith(50);
    expect(screen.getByRole("grid", { name: "Table tracks data" })).toBeTruthy();
  });

  it("disables Next on the last page and pages backward", () => {
    const props = renderBrowser({
      page: makePage({
        rows: Array.from({ length: 20 }, (_, i) => [i + 101, `Track ${i + 101}`]),
        offset: 100,
      }),
    });
    expect(screen.getByTestId("table-page-status").textContent).toContain("rows 101–120 of 120");
    expect((screen.getByTestId("table-next") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("table-prev"));
    expect(props.onPage).toHaveBeenCalledWith(50);
  });

  it("shows empty, loading, error, and close states", () => {
    const empty = renderBrowser({ page: makePage({ rows: [], totalRows: 0 }) });
    expect(screen.getByTestId("table-browser-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("table-close"));
    expect(empty.onClose).toHaveBeenCalled();
    cleanup();

    renderBrowser({ page: null, loading: true });
    expect(screen.getByTestId("table-browser-loading")).toBeTruthy();
    cleanup();

    renderBrowser({ error: "no such table" });
    expect(screen.getByTestId("table-browser-error").textContent).toContain("no such table");
  });
});
