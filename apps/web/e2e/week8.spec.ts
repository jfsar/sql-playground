import { expect, test, type Page } from "@playwright/test";

/**
 * Week 8 query analysis (FINAL_PROJECT_PLAN §7, scenarios 7, 8, and 19):
 * plan tree with neutral explanations, raw output one click away, and
 * pin → schema change → Explain → node-level diff.
 */

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });
}

async function runSql(page: Page, sql: string): Promise<void> {
  await page.getByTestId("sql-input").fill(sql);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
}

async function explain(page: Page, sql: string): Promise<void> {
  await page.getByTestId("sql-input").fill(sql);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("explain-button").click();
  await expect(page.getByTestId("plan-result")).toBeVisible({ timeout: 15_000 });
}

test("plan tree identifies scans, searches, and index usage (scenarios 7 and 8)", async ({
  page,
}) => {
  await ready(page);

  await runSql(
    page,
    `CREATE TABLE w8_notes (id INTEGER PRIMARY KEY, body TEXT);
CREATE INDEX w8_notes_body ON w8_notes(body);
WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200)
INSERT INTO w8_notes (body) SELECT 'row-' || x FROM c;`,
  );
  await expect(page.getByTestId("stmt-change-2")).toBeVisible({ timeout: 15_000 });

  // Scenario 8: a full-table query reports a scan.
  await explain(page, "SELECT * FROM w8_notes;");
  await expect(page.getByTestId("plan-tree")).toBeVisible();
  await expect(page.getByTestId("plan-result")).toContainText("SCAN");
  await expect(page.getByTestId("plan-result")).toContainText("w8_notes");
  await expect(page.getByTestId("plan-result")).toContainText("Reads every row");
  await expect(page.getByTestId("plan-neutral-note")).toContainText("neutral");

  // Scenario 7: an indexed lookup reports a search and the index name.
  await explain(page, "SELECT * FROM w8_notes WHERE body = 'row-100';");
  await expect(page.getByTestId("plan-result")).toContainText("SEARCH", { timeout: 15_000 });
  await expect(page.getByTestId("plan-result")).toContainText("w8_notes_body");
  await expect(page.getByTestId("plan-result")).toContainText("Uses index");

  // Raw SQLite output stays one click away.
  const raw = page.getByTestId("plan-raw");
  await expect(raw).toBeVisible();
  await expect(page.getByTestId("plan-raw-output")).toBeHidden();
  await raw.locator("summary").click();
  await expect(page.getByTestId("plan-raw-output")).toBeVisible();
  await expect(page.getByTestId("plan-raw-output")).toContainText(/\d+\|\d+\|SEARCH/);
});

test("pin a plan, create an index, re-run, and see the diff (scenario 19)", async ({ page }) => {
  await ready(page);

  await runSql(
    page,
    `CREATE TABLE w8_pin (id INTEGER PRIMARY KEY, body TEXT);
WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200)
INSERT INTO w8_pin (body) SELECT 'row-' || x FROM c;`,
  );
  await expect(page.getByTestId("stmt-change-1")).toBeVisible({ timeout: 15_000 });

  await explain(page, "SELECT * FROM w8_pin WHERE body = 'row-100';");
  await expect(page.getByTestId("plan-result")).toContainText("SCAN");

  await page.getByTestId("pin-plan-button").click();
  await expect(page.getByTestId("pinned-plan")).toContainText("Pinned plan");
  await expect(page.getByTestId("plan-diff-hint")).toBeVisible();

  await runSql(page, "CREATE INDEX w8_pin_body ON w8_pin(body);");
  await expect(page.getByTestId("stmt-change-0")).toBeVisible({ timeout: 15_000 });

  await explain(page, "SELECT * FROM w8_pin WHERE body = 'row-100';");
  await expect(page.getByTestId("plan-diff")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("plan-diff-summary")).toContainText("1 changed");
  await expect(page.getByTestId("plan-diff-changed")).toContainText("SCAN");
  await expect(page.getByTestId("plan-diff-changed")).toContainText("SEARCH");
  await expect(page.getByTestId("plan-diff-changed")).toContainText("w8_pin_body");
  await expect(page.getByTestId("plan-result")).toContainText("SEARCH");

  await page.getByTestId("pin-plan-button").click();
  await expect(page.getByTestId("pinned-plan")).toHaveCount(0);
  await expect(page.getByTestId("plan-diff")).toHaveCount(0);
});
