import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlEditor } from "./SqlEditor";

afterEach(cleanup);

function renderEditor(overrides: Partial<Parameters<typeof SqlEditor>[0]> = {}) {
  const props = {
    value: "SELECT 1;",
    onChange: vi.fn(),
    onRun: vi.fn(),
    onExplain: vi.fn(),
    onSelectionChange: vi.fn(),
    ...overrides,
  };
  const view = render(<SqlEditor {...props} />);
  return { props, ...view };
}

describe("SqlEditor", () => {
  it("renders the document on the sql-input content element", () => {
    renderEditor();
    const content = screen.getByTestId("sql-input");
    expect(content.getAttribute("contenteditable")).toBe("true");
    expect(content.getAttribute("aria-label")).toBe("SQL editor");
    expect(content.textContent).toContain("SELECT 1;");
  });

  it("runs on Mod-Enter and explains on Mod-Shift-Enter", () => {
    const { props } = renderEditor();
    const content = screen.getByTestId("sql-input");

    content.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
    expect(props.onRun).toHaveBeenCalledTimes(1);

    content.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(props.onExplain).toHaveBeenCalledTimes(1);
    expect(props.onRun).toHaveBeenCalledTimes(1); // unchanged
  });

  it("adopts external value changes", () => {
    const { rerender, props } = renderEditor();
    rerender(<SqlEditor {...props} value="SELECT 2;" />);
    expect(screen.getByTestId("sql-input").textContent).toContain("SELECT 2;");
  });

  it("clears the previous error mark when the value changes externally", () => {
    const { rerender, props } = renderEditor({ errorMark: { from: 0, to: 6 } });
    expect(document.querySelector(".cm-error-mark")).not.toBeNull();
    rerender(<SqlEditor {...props} value="SELECT 9;" errorMark={null} />);
    expect(document.querySelector(".cm-error-mark")).toBeNull();
  });
});
