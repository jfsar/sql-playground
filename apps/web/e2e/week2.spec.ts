import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

/**
 * Week 2 PoC checks (FINAL_PROJECT_PLAN §7): ADR-001 / ADR-002 / ADR-004 /
 * ADR-005. Run once against the dev server and once with E2E_PREVIEW=1
 * against the production build (the ADR-002 gate requires the latter).
 */

test("plan toolkit is callable from the worker (ADR-002 gate)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  // The gate: wasm loads inside the worker and reports itself as active.
  await expect(page.getByTestId("toolkit")).toHaveText("toolkit: rust", { timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`CREATE TABLE IF NOT EXISTS gate_t (a, b);
CREATE INDEX IF NOT EXISTS gate_t_a ON gate_t(a);
SELECT a FROM gate_t WHERE a = 1;`);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-2")).toBeVisible({ timeout: 15_000 });

  // Explain runs on a single statement (plan §5.2 rule 10).
  await page.getByTestId("sql-input").fill(`SELECT a FROM gate_t WHERE a = 1;`);
  await page.getByTestId("explain-button").click();
  await expect(page.getByTestId("plan-result")).toBeVisible({ timeout: 15_000 });

  // Typed round-trip: parsed nodes carry operation/table/index, raw preserved.
  const planText = await page.getByTestId("plan-result").textContent();
  expect(planText).toContain("SEARCH");
  expect(planText).toContain("gate_t");
  expect(planText).toContain("gate_t_a");
  expect(planText).toContain("SQLite");
  // Raw EQP rows are shown as id|parent|detail lines.
  expect(planText).toMatch(/\d+\|\d+\|SEARCH/);
});

test("second tab is blocked and never opens a database (ADR-005)", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  const page2 = await context.newPage();
  await page2.goto("/");
  await expect(page2.getByTestId("tab-blocked")).toBeVisible({ timeout: 15_000 });
  await expect(page2.getByTestId("ready")).toHaveCount(0);
  await expect(page2.getByTestId("loading")).toHaveCount(0);

  // Owner tab keeps working while the other tab is blocked.
  await page.getByTestId("sql-input").fill(`SELECT 42 AS still_works;`);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("stmt-rows-0")).toContainText("42");

  await page2.close();
});

test("worker termination recovery reopens the database within 5 s (ADR-004)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`CREATE TABLE IF NOT EXISTS restart_t (body TEXT);
DELETE FROM restart_t;
INSERT INTO restart_t (body) VALUES ('survives-restart');
SELECT body FROM restart_t;`);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-3")).toContainText("survives-restart", {
    timeout: 15_000,
  });

  await page.getByTestId("restart-worker").click();
  await expect(page.getByTestId("restart-ms")).toBeVisible({ timeout: 15_000 });

  const msText = (await page.getByTestId("restart-ms").textContent()) ?? "";
  const ms = Number.parseInt(msText, 10);
  test.info().annotations.push({ type: "worker-restart-ms", description: msText });
  expect(Number.isFinite(ms)).toBe(true);
  expect(ms).toBeLessThan(5000);

  // OPFS handles were released and the database reopened intact.
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("sql-input").fill(`SELECT body FROM restart_t;`);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toContainText("survives-restart", {
    timeout: 15_000,
  });
});

test("cancel a runaway query via worker restart; UI returns to idle (scenario 15)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(
    `WITH RECURSIVE c(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000000
) SELECT count(*) FROM c;`,
  );
  await page.getByTestId("run-button").click();
  // Let the request reach the busy worker before cancelling.
  await page.waitForTimeout(300);

  await page.getByTestId("restart-worker").click();

  // The in-flight run is rejected with the cancellation message.
  await expect(page.getByTestId("run-error")).toContainText(/cancelled/i, { timeout: 15_000 });
  // Restart completes and the UI is idle again.
  await expect(page.getByTestId("restart-ms")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("run-button")).toBeEnabled();

  // The database reopens and accepts new work.
  await page.getByTestId("sql-input").fill(`SELECT 1 AS ok;`);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toContainText("1", { timeout: 15_000 });
});

test("export reads the database file out of the OPFS pool (ADR-001)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`CREATE TABLE IF NOT EXISTS export_t (x);
INSERT INTO export_t (x) VALUES (1);`);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-change-1")).toBeVisible({ timeout: 15_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-button").click();
  await expect(page.getByTestId("export-result")).toBeVisible({ timeout: 15_000 });
  const download = await downloadPromise;

  const persistence = await page.getByTestId("persistence").textContent();
  const exportText = await page.getByTestId("export-result").textContent();
  test.info().annotations.push({ type: "export", description: exportText ?? "" });

  if (persistence?.includes("OPFS")) {
    const path = await download.path();
    if (!path) throw new Error("export download has no path");
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0");
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(exportText).toContain(`${bytes.byteLength} bytes`);
  } else {
    expect(exportText).toMatch(/not persistent|unavailable/i);
  }
});

test("pool capacity and journal mode are visible (ADR-001)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  const journal = await page.getByTestId("journal").textContent();
  test.info().annotations.push({ type: "journal-mode", description: journal ?? "" });
  // Live SQLite mode; never crash. (opfs-sahpool: "delete"; in-memory: "memory".)
  expect(journal).toMatch(/journal: (delete|wal|truncate|persist|memory)/);

  const persistence = await page.getByTestId("persistence").textContent();
  if (persistence?.includes("OPFS")) {
    const pool = await page.getByTestId("pool").textContent();
    expect(pool).toMatch(/pool \d+\/\d+/);
    const [, used, capacity] = (pool ?? "").match(/pool (\d+)\/(\d+)/) ?? [];
    expect(Number(capacity)).toBeGreaterThanOrEqual(12);
    expect(Number(used)).toBeGreaterThanOrEqual(1);
  }
});

test("WAL mode attempt under opfs-sahpool is recorded, not fatal (ADR-001)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("sql-input").fill(`PRAGMA journal_mode=WAL;`);
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toBeVisible({ timeout: 15_000 });

  // The pragma returns the resulting mode as a single-cell row.
  const value = (
    await page.getByTestId("stmt-rows-0").locator("tbody td").first().textContent()
  )?.trim();
  test.info().annotations.push({ type: "wal-attempt", description: value ?? "" });
  // "wal" if the VFS supports it; otherwise the unchanged current mode.
  expect(value?.toLowerCase()).toMatch(/^(wal|delete|truncate|persist|memory)$/);
});
