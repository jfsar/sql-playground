import { expect, test } from "@playwright/test";

/**
 * Week 5 explorer checks (FINAL_PROJECT_PLAN §7): the bundled sample database,
 * schema tree details, paged table browsing, and IndexedDB query history with
 * persistence, opt-out, and clear confirmation.
 */

test("sample database exposes schema details and paged table data (Week 5)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("create-sample-database").click();
  await expect(page.getByTestId("active-database")).toHaveText("Sample database");
  await expect(page.getByTestId("schema-item-tracks")).toBeVisible({ timeout: 15_000 });

  // Tables, views, constraints, and indexes come from PRAGMA introspection.
  const tracks = page.getByTestId("schema-item-tracks");
  await tracks.click();
  const details = page.getByTestId("schema-details-tracks");
  await expect(details).toContainText("album_id");
  await expect(details).toContainText("FOREIGN KEY album_id → albums(id)");
  await expect(details).toContainText("ON DELETE CASCADE");
  await expect(details).toContainText("UNIQUE (album_id, track_no)");
  await expect(details).toContainText("CHECK (seconds > 0)");
  await expect(details).toContainText("idx_tracks_rating");
  await expect(page.getByTestId("schema-item-album_track_counts")).toBeVisible();

  // Demo queries load into the editor without executing.
  await page.getByTestId("demo-query-0").click();
  await expect(page.locator(".cm-content")).toContainText("COUNT(albums.id)");

  // Browse the 120-track table one page at a time.
  await page.getByTestId("browse-tracks").click();
  await expect(page.getByTestId("table-tab")).toHaveText("Table: tracks");
  await expect(page.getByTestId("table-page-status")).toContainText("rows 1–50 of 120");
  await expect(page.getByTestId("table-prev")).toBeDisabled();

  await page.getByTestId("table-next").click();
  await expect(page.getByTestId("table-page-status")).toContainText("rows 51–100 of 120");
  await page.getByTestId("table-next").click();
  await expect(page.getByTestId("table-page-status")).toContainText("rows 101–120 of 120");
  await expect(page.getByTestId("table-next")).toBeDisabled();
  await expect(page.getByTestId("table-browser")).toContainText("Track 101");

  // Running new DDL refreshes the schema automatically.
  await page.getByTestId("results-tab").click();
  await page.getByTestId("sql-input").fill("CREATE TABLE w5_added (id INTEGER PRIMARY KEY);");
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-change-0")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("schema-item-w5_added")).toBeVisible({ timeout: 15_000 });
});

test("query history persists, can be disabled, and clears explicitly (Week 5)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill("SELECT 'history-marker' AS marker;");
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toContainText("history-marker", {
    timeout: 15_000,
  });

  await page.getByTestId("history-tab").click();
  await expect(page.getByTestId("history-entry-0")).toContainText("history-marker");
  await expect(page.getByTestId("history-entry-0")).toContainText("ok");

  // IndexedDB history survives a reload.
  await page.reload();
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("history-tab").click();
  await expect(page.getByTestId("history-entry-0")).toContainText("history-marker");
  await expect(page.getByTestId("history-entry-0")).toContainText("ok");

  // Loading an entry restores its SQL without running it.
  await page.getByTestId("history-entry-0").click();
  await expect(page.locator(".cm-content")).toContainText("history-marker");

  // Opting out stops recording but keeps existing entries.
  await page.getByTestId("history-toggle").click();
  await expect(page.getByTestId("history-toggle")).not.toBeChecked();
  await expect(page.getByTestId("history-disabled-notice")).toBeVisible();
  await page.getByTestId("sql-input").fill("SELECT 'not-recorded' AS marker;");
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toContainText("not-recorded", {
    timeout: 15_000,
  });
  await page.getByTestId("history-tab").click();
  await expect(page.getByTestId("history-entry-0")).toContainText("history-marker");
  await expect(page.getByTestId("history-entry-1")).toHaveCount(0);

  // Clear is confirmed, then the list is empty.
  await page.getByTestId("clear-history").click();
  await expect(page.getByTestId("confirm-clear-history")).toBeVisible();
  await page.getByTestId("cancel-clear-history").click();
  await expect(page.getByTestId("history-entry-0")).toBeVisible();
  await page.getByTestId("clear-history").click();
  await page.getByTestId("confirm-clear-history").click();
  await expect(page.getByTestId("history-empty")).toBeVisible();
});
