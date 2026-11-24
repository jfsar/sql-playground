import { mkdir, stat, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Week 10 benchmark harness (FINAL_PROJECT_PLAN §7): cold startup, 50 MB
 * reopen, import/export at 10/50/100 MB, 1,000-row render, long tasks during a
 * heavy query, and cancel → idle. Results are written to docs/benchmarks/ and
 * are report-only; run with E2E_BROWSER=chromium|firefox|webkit.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "..", "..", "..", "docs", "benchmarks");
const MIB = 1024 * 1024;
const BROWSER_NAME = process.env.E2E_BROWSER ?? "chromium";

declare global {
  interface Window {
    __benchLongTasks?: { start: number; duration: number }[];
    __benchFrameGaps?: number[];
  }
}

const RUNAWAY = `WITH RECURSIVE c(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000000
) SELECT count(*) FROM c;`;

const RENDER_1000 = `WITH RECURSIVE c(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000
) SELECT x, 'row-' || x AS label FROM c;`;

interface SizeResult {
  targetMiB: number;
  seedMs: number;
  exportMs: number;
  exportBytes: number;
  importMs: number;
  reopenMs: number;
}

interface BenchmarkRun {
  generatedAt: string;
  browser: { name: string; version: string };
  system: { platform: string; release: string; cpu: string; memoryGiB: number };
  preview: true;
  status: "complete" | "partial";
  persistence: string;
  skipReason?: string;
  startupMs: number;
  sizes: Record<string, SizeResult>;
  render1000?: {
    renderMs: number;
    ariaRowCount: string | null;
    renderedCells: number;
    truncated: boolean;
  };
  heavyQuery?: {
    longTasksSupported: boolean;
    longTaskCount: number;
    maxLongTaskMs: number;
    maxFrameGapMs: number;
    cancelToIdleMs: number;
    restartMs: number;
  };
}

async function save(run: BenchmarkRun): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `week10-${BROWSER_NAME}.json`);
  await writeFile(file, `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="ready"]')), null, {
    timeout: 120_000,
  });
}

async function runSqlAndWait(page: Page, sql: string, testId: string): Promise<void> {
  await page.getByTestId("sql-input").fill(sql);
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId(testId)).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('[data-testid^="stmt-error-"]')).toHaveCount(0);
}

function seedSql(batches: number): { sql: string; lastIndex: number } {
  const insert = `INSERT INTO bench_payload (payload)
SELECT zeroblob(1048576)
FROM (
  WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10)
  SELECT x FROM c
);`;
  const statements = [
    "CREATE TABLE bench_payload (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);",
    "BEGIN;",
    ...Array.from({ length: batches }, () => insert),
    "COMMIT;",
  ];
  return { sql: statements.join("\n"), lastIndex: batches + 2 };
}

async function seed(page: Page, targetMiB: number): Promise<number> {
  const batches = targetMiB / 10;
  const { sql, lastIndex } = seedSql(batches);
  const start = await page.evaluate(() => performance.now());
  await runSqlAndWait(page, sql, `stmt-change-${lastIndex}`);
  return page.evaluate((t) => performance.now() - t, start);
}

async function exportActive(
  page: Page,
): Promise<{ path: string; sizeBytes: number; exportMs: number }> {
  const downloadPromise = page.waitForEvent("download");
  const start = await page.evaluate(() => performance.now());
  await page.getByTestId("export-button").click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("export download has no path");
  const sizeBytes = (await stat(path)).size;
  const exportMs = await page.evaluate((t) => performance.now() - t, start);
  return { path, sizeBytes, exportMs };
}

async function importActive(page: Page, path: string, name: string): Promise<number> {
  await page.getByTestId("import-database").click();
  await expect(page.getByTestId("import-dialog")).toBeVisible();
  await page.getByTestId("import-file-input").setInputFiles(path);
  await expect(page.getByTestId("import-preview")).toContainText("SQLite database", {
    timeout: 180_000,
  });
  await page.getByTestId("import-name").fill(name);
  const large = page.getByTestId("import-confirm-large");
  if ((await large.count()) > 0) await large.check();

  const start = await page.evaluate(() => performance.now());
  await page.getByTestId("import-confirm").click();
  await expect(page.getByTestId("import-dialog")).toHaveCount(0, { timeout: 180_000 });
  const importMs = await page.evaluate((t) => performance.now() - t, start);
  await expect(page.getByTestId("active-database")).toHaveText(name, { timeout: 120_000 });
  return importMs;
}

async function reopen(page: Page, name: string): Promise<number> {
  await page.reload();
  await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="ready"]')), null, {
    timeout: 120_000,
  });
  const reopenMs = await page.evaluate(() => performance.now());
  await expect(page.getByTestId("active-database")).toHaveText(name, { timeout: 120_000 });
  return reopenMs;
}

async function withContext(
  browser: Browser,
  baseURL: string,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({ baseURL, acceptDownloads: true });
  const page = await context.newPage();
  try {
    await run(page);
  } finally {
    await context.close();
  }
}

async function readPersistence(browser: Browser, baseURL: string): Promise<string> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await page.waitForFunction(
      () =>
        Boolean(
          document.querySelector('[data-testid="ready"]') ||
          document.querySelector('[data-testid="init-error"]'),
        ),
      null,
      { timeout: 120_000 },
    );
    return (await page.getByTestId("persistence").textContent()) ?? "unknown";
  } finally {
    await context.close();
  }
}

test("Week 10 benchmarks", async ({ browser, baseURL }) => {
  const origin = baseURL ?? "http://localhost:4173";
  const run: BenchmarkRun = {
    generatedAt: new Date().toISOString(),
    browser: { name: browser.browserType().name(), version: browser.version() },
    system: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model ?? "unknown",
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
    },
    preview: true,
    status: "complete",
    persistence: "unknown",
    startupMs: 0,
    sizes: {},
  };

  await withContext(browser, origin, async (page) => {
    await ready(page);
    run.startupMs = await page.evaluate(() => performance.now());
  });

  const persistence = await readPersistence(browser, origin);
  run.persistence = persistence;
  await save(run);

  const hasOpfs = persistence.includes("OPFS");
  if (!hasOpfs) {
    run.status = "partial";
    run.skipReason = `OPFS unavailable (${persistence}); skipping import/export/reopen and cancel benchmarks`;
    await save(run);
  } else {
    for (const targetMiB of [10, 50, 100] as const) {
      await withContext(browser, origin, async (page) => {
        await ready(page);
        const seedMs = await seed(page, targetMiB);
        const exported = await exportActive(page);
        const importMs = await importActive(page, exported.path, `Bench ${targetMiB} MB copy`);
        const reopenMs = await reopen(page, `Bench ${targetMiB} MB copy`);

        run.sizes[String(targetMiB)] = {
          targetMiB,
          seedMs,
          exportMs: exported.exportMs,
          exportBytes: exported.sizeBytes,
          importMs,
          reopenMs,
        };
        await save(run);

        expect(exported.sizeBytes).toBeGreaterThanOrEqual(targetMiB * MIB);
        if (targetMiB === 50) expect(reopenMs).toBeLessThan(2000);
      });
    }
  }

  await withContext(browser, origin, async (page) => {
    await ready(page);
    await page.getByTestId("sql-input").fill(RENDER_1000);
    await page.getByTestId("sql-input").click();
    const start = await page.evaluate(() => performance.now());
    await page.getByTestId("run-button").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="grid"][aria-label="Query results"]')
          ?.getAttribute("aria-rowcount") === "1001",
      null,
      { timeout: 60_000 },
    );
    const renderMs = await page.evaluate((t) => performance.now() - t, start);
    const ariaRowCount = await page
      .getByRole("grid", { name: "Query results" })
      .getAttribute("aria-rowcount");
    const renderedCells = await page.locator('[role="gridcell"]').count();
    const truncated = (await page.locator('[data-testid^="truncated-notice-"]').count()) > 0;

    run.render1000 = { renderMs, ariaRowCount, renderedCells, truncated };
    await save(run);

    expect(ariaRowCount).toBe("1001");
    expect(truncated).toBe(false);
    expect(renderedCells).toBeGreaterThan(0);
    expect(renderedCells).toBeLessThan(1001);
  });

  if (hasOpfs)
    await withContext(browser, origin, async (page) => {
      await page.addInitScript(() => {
        window.__benchLongTasks = [];
        window.__benchFrameGaps = [];
        try {
          if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                window.__benchLongTasks?.push({ start: entry.startTime, duration: entry.duration });
              }
            }).observe({ entryTypes: ["longtask"] });
          }
        } catch {
          // The rAF sampler below is the cross-browser fallback.
        }
        let last = performance.now();
        const tick = (now: number) => {
          window.__benchFrameGaps?.push(now - last);
          last = now;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      await ready(page);
      const longTasksSupported = await page.evaluate(
        () => PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false,
      );
      await page.evaluate(() => {
        window.__benchLongTasks = [];
        window.__benchFrameGaps = [];
      });

      await page.getByTestId("sql-input").fill(RUNAWAY);
      await page.getByTestId("sql-input").click();
      await page.getByTestId("run-button").click();
      await expect(page.getByTestId("cancel-button")).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1000);

      const cancelStart = await page.evaluate(() => performance.now());
      await page.getByTestId("cancel-button").click();
      await expect(page.getByTestId("run-error")).toContainText(/cancelled/i, { timeout: 30_000 });
      await expect(page.getByTestId("restart-ms")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("run-button")).toBeEnabled();
      const cancelToIdleMs = await page.evaluate((t) => performance.now() - t, cancelStart);

      const restartText = (await page.getByTestId("restart-ms").textContent()) ?? "";
      const restartMs = Number.parseInt(restartText, 10);
      const { maxLongTaskMs, longTaskCount, maxFrameGapMs } = await page.evaluate(() => {
        const tasks = window.__benchLongTasks ?? [];
        const gaps = window.__benchFrameGaps ?? [];
        return {
          maxLongTaskMs: tasks.reduce((max, task) => Math.max(max, task.duration), 0),
          longTaskCount: tasks.length,
          maxFrameGapMs: gaps.reduce((max, gap) => Math.max(max, gap), 0),
        };
      });

      run.heavyQuery = {
        longTasksSupported,
        longTaskCount,
        maxLongTaskMs,
        maxFrameGapMs,
        cancelToIdleMs,
        restartMs,
      };
      await save(run);

      expect(restartMs).toBeLessThan(5000);
      expect(cancelToIdleMs).toBeLessThan(5000);
      if (longTasksSupported) expect(maxLongTaskMs).toBeLessThan(100);
    });
});
