import { expect, test, type Page } from "@playwright/test";

/**
 * Week 7 reliability checks (FINAL_PROJECT_PLAN §7): long-query UX,
 * per-request cancellation using the ADR-004 restart path, and recovery after
 * terminating a worker that is mid-write (SQLite journal rollback).
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

const RUNAWAY = `WITH RECURSIVE c(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000000
) SELECT count(*) FROM c;`;

test("long query shows an elapsed timer and Cancel aborts by request id (Week 7)", async ({
  page,
}) => {
  await ready(page);
  await runSql(page, RUNAWAY);

  await expect(page.getByTestId("cancel-button")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("run-button")).toBeDisabled();

  // The elapsed timer is live, not a static "running" label (plan §5.4).
  await expect
    .poll(async () => (await page.getByTestId("run-elapsed").textContent()) ?? "", {
      timeout: 5_000,
    })
    .not.toBe("0.0 s");

  await page.waitForTimeout(300); // let the request reach the busy worker
  await page.getByTestId("cancel-button").click();

  await expect(page.getByTestId("run-error")).toContainText(/cancelled/i, { timeout: 15_000 });
  await expect(page.getByTestId("restart-ms")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("run-button")).toBeEnabled();
  await expect(page.getByTestId("cancel-button")).toHaveCount(0);
  await expect(page.getByTestId("run-elapsed")).toHaveCount(0);

  const msText = (await page.getByTestId("restart-ms").textContent()) ?? "";
  test.info().annotations.push({ type: "cancel-restart-ms", description: msText });
  expect(Number.parseInt(msText, 10)).toBeLessThan(5000);

  // The database reopened and accepts new work (ADR-004).
  await runSql(page, "SELECT 1 AS recovered;");
  await expect(page.getByTestId("stmt-rows-0")).toContainText("1", { timeout: 15_000 });
});

test("mid-write cancellation keeps committed data and rolls back the open transaction (Week 7)", async ({
  page,
}) => {
  await ready(page);

  await runSql(
    page,
    `CREATE TABLE IF NOT EXISTS week7_live (v TEXT);
DELETE FROM week7_live;
INSERT INTO week7_live (v) VALUES ('committed');`,
  );
  await expect(page.getByTestId("stmt-change-2")).toContainText("rows affected: 1", {
    timeout: 15_000,
  });

  // Open a transaction and leave it open, so the cancel notice has something to
  // report (ADR-004 caveat).
  await runSql(page, "BEGIN;");
  await expect(page.getByTestId("open-transaction")).toBeVisible({ timeout: 15_000 });

  // Terminate the worker while an INSERT and a runaway SELECT are in flight.
  await runSql(
    page,
    `INSERT INTO week7_live (v) VALUES ('pending');
${RUNAWAY}`,
  );
  await expect(page.getByTestId("cancel-button")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.getByTestId("cancel-button").click();

  await expect(page.getByTestId("run-error")).toContainText(/cancelled/i, { timeout: 15_000 });
  await expect(page.getByTestId("restart-ms")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("restart-transaction-notice")).toContainText(/rolled back/i);
  await expect(page.getByTestId("open-transaction")).toHaveCount(0);

  const msText = (await page.getByTestId("restart-ms").textContent()) ?? "";
  test.info().annotations.push({ type: "mid-write-restart-ms", description: msText });
  expect(Number.parseInt(msText, 10)).toBeLessThan(5000);

  // Journal recovery: the committed row survives; the uncommitted INSERT does not.
  await runSql(page, "SELECT v FROM week7_live;");
  await expect(page.getByTestId("stmt-rows-0")).toContainText("committed", { timeout: 15_000 });
  await expect(page.getByTestId("stmt-rows-0")).not.toContainText("pending");
});
