import { expect, test, type Page } from "@playwright/test";

/**
 * Week 4 SQL workspace checks (FINAL_PROJECT_PLAN §7): CodeMirror 6
 * integration (Mod-Enter run, Mod-Shift-Enter explain, run-selection),
 * SQL error display with line/column and editor mark, truncation notice,
 * the virtualized ARIA results grid with keyboard navigation, the
 * transaction indicator's Commit/Rollback actions, the ADR-004
 * open-transaction restart notice, and the Cancel button.
 */

interface ActiveCell {
  text: string;
  row: string;
  col: string;
}

/** The focused grid cell: its text plus the ARIA indices of its row/column. */
function activeCell(page: Page): Promise<ActiveCell> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      text: el?.textContent ?? "",
      row: el?.closest("tr")?.getAttribute("aria-rowindex") ?? "",
      col: el?.getAttribute("aria-colindex") ?? "",
    };
  });
}

test("editor shortcuts run and explain; a selection runs alone (Week 4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`CREATE TABLE w4_demo (v TEXT);
INSERT INTO w4_demo (v) VALUES ('alpha');
SELECT 'beta' AS tag;
SELECT v FROM w4_demo;`);
  // A click inside the editor guarantees an empty selection → whole-document run.
  await page.getByTestId("sql-input").click();
  await expect(page.getByTestId("sql-input")).toHaveAttribute(
    "aria-keyshortcuts",
    /Control\+Enter/,
  );
  await expect(page.getByTestId("run-button")).toHaveText("Run (⌘↵)");

  // Mod-Enter runs the whole document without touching the Run button.
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("stmt-rows-3")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("stmt-rows-2")).toContainText("beta");
  await expect(page.getByTestId("stmt-rows-3")).toContainText("alpha");
  // Per-statement engine timing (plan §7 Week 4).
  await expect(page.getByTestId("stmt-rows-3")).toContainText(/\d+\.\d{2} ms/);

  // Select the last line: the Run button label flips to the selection mode.
  await page.getByTestId("sql-input").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await expect(page.getByTestId("run-button")).toHaveText("Run selection (⌘↵)");

  // Mod-Shift-Enter explains the selection (never executes it).
  await page.keyboard.press("Control+Shift+Enter");
  await expect(page.getByTestId("plan-result")).toContainText("w4_demo", { timeout: 15_000 });

  // Running executes the selection only — one statement, not the document.
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toContainText("alpha", { timeout: 15_000 });
  await expect(page.getByTestId("stmt-rows-1")).toHaveCount(0);
});

test("SQL errors show line/column and underline the token (Week 4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`SELECT 1 AS ok;
SELECT * FORM somewhere;`);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();

  await expect(page.getByTestId("stmt-error-1")).toContainText("syntax error", {
    timeout: 15_000,
  });
  // Statement-relative offset mapped back to the document (plan §5.2 rule 6).
  await expect(page.getByTestId("stmt-error-position-1")).toContainText(/line 2, column \d+/);
  // The same position underlines the offending token in the editor…
  expect(await page.locator(".cm-error-mark").count()).toBeGreaterThan(0);
  // …and editing invalidates the mark.
  await page.getByTestId("sql-input").fill("SELECT 1 AS fixed;");
  await expect(page.locator(".cm-error-mark")).toHaveCount(0);
});

test("large results truncate with a notice and render virtualized (Week 4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`WITH RECURSIVE c(x) AS (
  SELECT 1
  UNION ALL
  SELECT x + 1 FROM c WHERE x < 1500
)
SELECT x FROM c;`);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();

  await expect(page.getByTestId("stmt-rows-0")).toContainText("1000 rows (truncated)", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("stmt-rows-0")).toContainText(/\d+\.\d{2} ms/);
  await expect(page.getByTestId("truncated-notice-0")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("truncated-notice-0")).toContainText("row cap of 1000");

  // ARIA grid reports the full result while only a window is in the DOM.
  const grid = page.getByRole("grid", { name: "Query results" });
  await expect(grid).toHaveAttribute("aria-rowcount", "1001");
  const cells = page.locator('[data-testid="results-grid"] [role="gridcell"]');
  expect(await cells.count()).toBeLessThan(50);
  await expect(page.locator('[title="1"]')).toHaveCount(1);

  // Ctrl+End jumps to the last row; the window and focus move together.
  await cells.first().click();
  await page.keyboard.press("Control+End");
  await expect.poll(() => activeCell(page)).toEqual({ text: "1000", row: "1001", col: "1" });
  await expect(page.locator('[title="1"]')).toHaveCount(0);
  expect(await cells.count()).toBeLessThan(50);
});

test("results grid is an ARIA grid with keyboard navigation (Week 4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(
    `SELECT 1 AS a, 2 AS b
UNION ALL
SELECT 3, 4;`,
  );
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toBeVisible({ timeout: 15_000 });

  const grid = page.getByRole("grid", { name: "Query results" });
  await expect(grid).toHaveAttribute("aria-rowcount", "3");
  await expect(grid).toHaveAttribute("aria-colcount", "2");
  // Roving tabindex: exactly one tab stop inside the grid.
  await expect(page.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);

  await page.locator('[role="gridcell"]').first().click();
  await expect.poll(() => activeCell(page)).toEqual({ text: "1", row: "2", col: "1" });

  await page.keyboard.press("ArrowRight");
  await expect.poll(() => activeCell(page)).toEqual({ text: "2", row: "2", col: "2" });

  await page.keyboard.press("ArrowDown");
  await expect.poll(() => activeCell(page)).toEqual({ text: "4", row: "3", col: "2" });

  await page.keyboard.press("Home");
  await expect.poll(() => activeCell(page)).toEqual({ text: "3", row: "3", col: "1" });

  await page.keyboard.press("ArrowUp");
  await expect.poll(() => activeCell(page)).toEqual({ text: "1", row: "2", col: "1" });

  await page.keyboard.press("End");
  await expect.poll(() => activeCell(page)).toEqual({ text: "2", row: "2", col: "2" });

  await page.keyboard.press("Control+End");
  await expect.poll(() => activeCell(page)).toEqual({ text: "4", row: "3", col: "2" });

  await page.keyboard.press("Control+Home");
  await expect.poll(() => activeCell(page)).toEqual({ text: "1", row: "2", col: "1" });
});

test("transaction indicator offers Commit and Rollback (Week 4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`CREATE TABLE w4_tx (v TEXT);
INSERT INTO w4_tx (v) VALUES ('kept');`);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-change-1")).toBeVisible({ timeout: 15_000 });

  // An explicit BEGIN leaves the transaction open after the run.
  await page.getByTestId("sql-input").fill(`BEGIN;
INSERT INTO w4_tx (v) VALUES ('pending');`);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("open-transaction")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("commit-button")).toBeVisible();
  await expect(page.getByTestId("rollback-button")).toBeVisible();

  // Rollback discards the pending insert — nothing rolls back silently.
  await page.getByTestId("rollback-button").click();
  await expect(page.getByTestId("open-transaction")).toHaveCount(0, { timeout: 15_000 });

  await page.getByTestId("sql-input").fill(`SELECT v FROM w4_tx;`);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toContainText("kept", { timeout: 15_000 });
  await expect(page.getByTestId("stmt-rows-0")).not.toContainText("pending");

  // Commit keeps the pending insert.
  await page.getByTestId("sql-input").fill(`BEGIN;
INSERT INTO w4_tx (v) VALUES ('committed');`);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("open-transaction")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("commit-button").click();
  await expect(page.getByTestId("open-transaction")).toHaveCount(0, { timeout: 15_000 });

  await page.getByTestId("sql-input").fill(`SELECT v FROM w4_tx;`);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toContainText("committed", { timeout: 15_000 });
  await expect(page.getByTestId("stmt-rows-0")).toContainText("kept");
});

test("restarting with an open transaction shows the rollback notice (Week 4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`BEGIN;
SELECT 1 AS x;`);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("open-transaction")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("restart-worker").click();
  // ADR-004: the pre-restart transaction is rolled back — and said out loud.
  await expect(page.getByTestId("restart-transaction-notice")).toContainText("rolled back", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("restart-ms")).toBeVisible();
  await expect(page.getByTestId("open-transaction")).toHaveCount(0);
});

test("Cancel button aborts a running query and returns to idle (Week 4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`WITH RECURSIVE c(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000000
) SELECT count(*) FROM c;`);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();

  // The Cancel button exists only while a run is in flight.
  await expect(page.getByTestId("cancel-button")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("run-button")).toBeDisabled();
  await page.waitForTimeout(300); // let the request reach the busy worker

  await page.getByTestId("cancel-button").click();
  await expect(page.getByTestId("run-error")).toContainText(/cancelled/i, { timeout: 15_000 });
  await expect(page.getByTestId("restart-ms")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("run-button")).toBeEnabled();
  await expect(page.getByTestId("cancel-button")).toHaveCount(0);
});

test("a single result fills the panel with one scrollbar (Week 4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`WITH RECURSIVE c(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 25
) SELECT x FROM c;`);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toBeVisible({ timeout: 15_000 });

  // The grid fills the pane and scrolls; the results panel itself does not,
  // so only one vertical scrollbar is visible.
  const grid = page.getByTestId("results-grid");
  const results = page.getByTestId("results");
  await expect.poll(() => grid.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect
    .poll(() => results.evaluate((el) => el.scrollHeight <= el.clientHeight + 1))
    .toBe(true);
});

test("multiple statements still scroll the results panel (Week 4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`WITH RECURSIVE c(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 25
) SELECT x FROM c;
WITH RECURSIVE d(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM d WHERE x < 25
) SELECT x FROM d;`);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-1")).toBeVisible({ timeout: 15_000 });

  const results = page.getByTestId("results");
  await expect.poll(() => results.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
});
