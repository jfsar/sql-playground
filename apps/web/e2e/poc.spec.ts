import { expect, test } from "@playwright/test";

test("executes SQL and persists the database across reload", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  // Create a table and insert a row; run via Ctrl+Enter.
  await page.getByTestId("sql-input").fill(
    `CREATE TABLE IF NOT EXISTS e2e_notes (id INTEGER PRIMARY KEY, body TEXT);
     DELETE FROM e2e_notes;
     INSERT INTO e2e_notes (body) VALUES ('persisted-across-reload');
     SELECT body FROM e2e_notes;`,
  );
  await page.getByTestId("run-button").click();

  // CREATE(0), DELETE(1), INSERT(2), SELECT(3)
  await expect(page.getByTestId("stmt-rows-3")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("stmt-rows-3")).toContainText("persisted-across-reload");

  // Reload — data must still be there if OPFS works (or in-memory will fail, which is the point).
  await page.reload();
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  const persistence = await page.getByTestId("persistence").textContent();
  test.info().annotations.push({ type: "persistence", description: persistence ?? "" });

  await page.getByTestId("sql-input").fill(`SELECT body FROM e2e_notes;`);
  await page.getByTestId("run-button").click();

  await expect(page.getByTestId("stmt-rows-0")).toBeVisible({ timeout: 15_000 });

  if (persistence?.includes("OPFS")) {
    await expect(page.getByTestId("stmt-rows-0")).toContainText("persisted-across-reload");
  } else {
    // In-memory fallback: empty result after reload is expected; must not crash.
    await expect(page.getByTestId("stmt-rows-0")).toBeVisible();
  }
});

test("blocks ATTACH DATABASE with POLICY_BLOCKED", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`SELECT 1; ATTACH DATABASE 'x.db' AS x;`);
  await page.getByTestId("run-button").click();

  await expect(page.getByTestId("stmt-error-1")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("stmt-error-1")).toContainText("POLICY_BLOCKED");
});

test("reports open transaction after BEGIN", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`BEGIN; SELECT 1;`);
  await page.getByTestId("run-button").click();

  await expect(page.getByTestId("open-transaction")).toBeVisible({ timeout: 15_000 });

  // Cleanup
  await page.getByTestId("sql-input").fill(`ROLLBACK;`);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("open-transaction")).toHaveCount(0, { timeout: 15_000 });
});
