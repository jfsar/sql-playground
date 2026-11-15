import { expect, test } from "@playwright/test";

/**
 * Week 3 foundation checks (FINAL_PROJECT_PLAN §7): multi-database storage
 * service — create/open/rename/delete, ID-based files, IndexedDB metadata
 * surviving reload, and explicit delete confirmation (plan §5.6, US-02).
 */

test("multi-database lifecycle persists across reload (Week 3)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  // First run: a default database exists and is active.
  await expect(page.getByTestId("database-item")).toHaveCount(1);
  await expect(page.getByTestId("active-database")).toHaveText("My database");

  // Create — the new database becomes the active connection.
  await page.getByTestId("new-database").click();
  await page.getByTestId("database-name-input").fill("orders-db");
  await page.getByTestId("confirm-create").click();
  await expect(page.getByTestId("database-item")).toHaveCount(2);
  await expect(page.getByTestId("active-database")).toHaveText("orders-db");

  // Rename is metadata-only and survives a reload (IndexedDB + OPFS both).
  // The rename form replaces the item's text, so scope only the trigger click
  // and use the singleton form controls afterwards.
  const orders = page.getByTestId("database-item").filter({ hasText: "orders-db" });
  await orders.getByTestId("rename-database").click();
  await page.getByTestId("rename-input").fill("renamed-db");
  await page.getByTestId("confirm-rename").click();
  await expect(page.getByTestId("database-item").filter({ hasText: "renamed-db" })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("database-item")).toHaveCount(2);
  await expect(page.getByTestId("database-item").filter({ hasText: "renamed-db" })).toBeVisible();

  // Delete requires an explicit confirmation and completes on next startup.
  const target = page.getByTestId("database-item").filter({ hasText: "renamed-db" });
  await target.getByTestId("delete-database").click();
  await target.getByTestId("cancel-delete").click(); // cancel first: confirmation is real
  await expect(page.getByTestId("database-item")).toHaveCount(2);

  await target.getByTestId("delete-database").click();
  await target.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("database-item")).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("database-item")).toHaveCount(1);
  await expect(page.getByTestId("active-database")).toHaveText("My database");
});

test("databases keep separate contents when switching (Week 3)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  // Create a table in the default database.
  await page.getByTestId("sql-input").fill(`CREATE TABLE iso_t (v TEXT);
INSERT INTO iso_t (v) VALUES ('only-in-default');`);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-change-1")).toBeVisible({ timeout: 15_000 });

  // A second database must not see that table.
  await page.getByTestId("new-database").click();
  await page.getByTestId("database-name-input").fill("second-db");
  await page.getByTestId("confirm-create").click();
  await expect(page.getByTestId("active-database")).toHaveText("second-db");

  await page.getByTestId("sql-input").fill(`SELECT v FROM iso_t;`);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-error-0")).toContainText("no such table", {
    timeout: 15_000,
  });

  // Switching back: the original data is intact (single active connection).
  const fallback = page.getByTestId("database-item").filter({ hasText: "My database" });
  await fallback.getByTestId("open-database").click();
  await expect(page.getByTestId("active-database")).toHaveText("My database");

  await page.getByTestId("sql-input").fill(`SELECT v FROM iso_t;`);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toContainText("only-in-default", {
    timeout: 15_000,
  });
});
