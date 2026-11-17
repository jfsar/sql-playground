import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatementBlock } from "./StatementBlock";
import type { StatementResult } from "../../shared/contracts";

afterEach(cleanup);

describe("StatementBlock", () => {
  it("renders a change card with rows affected for DML", () => {
    const result: StatementResult = {
      kind: "change",
      sql: "UPDATE t SET x = 1",
      rowsAffected: 3,
      engineMs: 0.5,
    };
    render(<StatementBlock result={result} index={0} />);
    const card = screen.getByTestId("stmt-change-0");
    expect(card.textContent).toContain("rows affected: 3");
    expect(card.textContent).toContain("0.50 ms");
  });

  it("omits the row count for DDL and PRAGMA statements", () => {
    const result: StatementResult = { kind: "change", sql: "CREATE TABLE t (x)", engineMs: 0.2 };
    render(<StatementBlock result={result} index={2} />);
    expect(screen.getByTestId("stmt-change-2").textContent).toContain("no row count (DDL/PRAGMA)");
  });

  it("shows timing and values for a rows result", () => {
    const result: StatementResult = {
      kind: "rows",
      sql: "SELECT 1;",
      columns: [{ name: "v" }],
      rows: [[1]],
      truncated: false,
      engineMs: 1.25,
    };
    render(<StatementBlock result={result} index={0} />);
    const card = screen.getByTestId("stmt-rows-0");
    expect(card.textContent).toContain("1 row");
    expect(card.textContent).toContain("1.25 ms");
    expect(card.textContent).toContain("engine time");
    expect(screen.queryByTestId("truncated-notice-0")).toBeNull();
  });

  it("shows a truncation notice when the row cap was hit", () => {
    const result: StatementResult = {
      kind: "rows",
      sql: "SELECT x FROM big;",
      columns: [{ name: "x" }],
      rows: Array.from({ length: 1000 }, (_, i) => [i]),
      truncated: true,
      engineMs: 12.5,
    };
    render(<StatementBlock result={result} index={1} />);
    const card = screen.getByTestId("stmt-rows-1");
    expect(card.textContent).toContain("(truncated)");
    expect(card.textContent).toContain("engine time (first 1000 rows)");
    const notice = screen.getByTestId("truncated-notice-1");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("first 1000 rows");
    expect(notice.textContent).toContain("row cap of 1000");
  });

  it("renders an error with a caret at the SQLite offset and line/column", () => {
    const result: StatementResult = {
      kind: "error",
      sql: "SELECT * FORM t;",
      error: { code: "SQL_ERROR", message: 'near "FORM": syntax error', offset: 9 },
      span: { start: 0, end: 16, text: "SELECT * FORM t;" },
    };
    render(<StatementBlock result={result} index={1} position={{ line: 2, column: 9 }} />);
    const card = screen.getByTestId("stmt-error-1");
    expect(card.textContent).toContain("SQL_ERROR");
    expect(card.textContent).toContain('near "FORM": syntax error');
    expect(card.textContent).toContain("line 2, column 9");
    // Caret sits under "F" (column 10 of the statement → 9 spaces).
    const pre = card.querySelector("pre");
    expect(pre?.textContent).toBe(`SELECT * FORM t;\n${" ".repeat(9)}^`);
  });

  it("omits the position when SQLite reported no offset (e.g. policy blocks)", () => {
    const result: StatementResult = {
      kind: "error",
      sql: "ATTACH DATABASE 'x.db' AS x;",
      error: { code: "POLICY_BLOCKED", message: "ATTACH DATABASE is not allowed." },
      span: { start: 0, end: 28, text: "ATTACH DATABASE 'x.db' AS x;" },
    };
    render(<StatementBlock result={result} index={0} />);
    const card = screen.getByTestId("stmt-error-0");
    expect(card.textContent).toContain("POLICY_BLOCKED");
    expect(screen.queryByTestId("stmt-error-position-0")).toBeNull();
    expect(card.querySelector("pre")?.textContent).not.toContain("^");
  });
});
