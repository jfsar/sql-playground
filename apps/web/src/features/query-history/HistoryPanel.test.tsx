import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../services/storage/metadataDb";
import { HistoryPanel } from "./HistoryPanel";

afterEach(cleanup);

const entries: HistoryEntry[] = [
  { sql: "SELECT 2;", at: 2000, ok: true, engineMs: 1.25 },
  { sql: "SELECT broken;", at: 1000, ok: false },
];

function renderPanel(overrides: Partial<Parameters<typeof HistoryPanel>[0]> = {}) {
  const props = {
    entries,
    enabled: true,
    busy: false,
    error: null,
    onLoad: vi.fn(),
    onToggleEnabled: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  };
  render(<HistoryPanel {...props} />);
  return props;
}

describe("HistoryPanel", () => {
  it("lists newest entries with status and loads SQL on click", () => {
    const props = renderPanel();
    expect(screen.getAllByTestId(/history-entry-/)).toHaveLength(2);
    expect(screen.getByTestId("history-entry-0").textContent).toContain("ok");
    expect(screen.getByTestId("history-entry-0").textContent).toContain("1.25 ms");
    expect(screen.getByTestId("history-entry-1").textContent).toContain("failed");

    fireEvent.click(screen.getByTestId("history-entry-0"));
    expect(props.onLoad).toHaveBeenCalledWith("SELECT 2;");
  });

  it("toggles recording and confirms before clearing", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByTestId("history-toggle"));
    expect(props.onToggleEnabled).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByTestId("clear-history"));
    expect(props.onClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("cancel-clear-history"));
    expect(props.onClear).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("clear-history"));
    fireEvent.click(screen.getByTestId("confirm-clear-history"));
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it("explains the disabled state and the empty state", () => {
    renderPanel({ enabled: false });
    expect(screen.getByTestId("history-disabled-notice")).toBeTruthy();
    cleanup();

    renderPanel({ entries: [] });
    expect(screen.getByTestId("history-empty")).toBeTruthy();
    expect((screen.getByTestId("clear-history") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows storage errors", () => {
    renderPanel({ error: "IndexedDB unavailable" });
    expect(screen.getByTestId("history-error").textContent).toContain("IndexedDB unavailable");
  });
});
