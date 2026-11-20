import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Week 9 UX and accessibility audit (FINAL_PROJECT_PLAN §7, NFR-06/NFR-11,
 * scenarios 21 and 22): automated axe checks over the real app states, a
 * keyboard-only walkthrough including focus management, and the desktop-first
 * viewport / unsupported-browser messaging.
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });
}

async function axeViolations(page: Page, selector?: string) {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (selector) builder = builder.include(selector);
  const results = await builder.analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

test("workspace passes an automated axe audit in its main states (NFR-11)", async ({ page }) => {
  await ready(page);

  expect(await axeViolations(page)).toEqual([]);

  await page.getByTestId("sql-input").fill("SELECT 1 AS a, 'two' AS b UNION ALL SELECT 3, 'four';");
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toBeVisible({ timeout: 15_000 });
  expect(await axeViolations(page)).toEqual([]);

  await page.getByTestId("history-tab").click();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByTestId("analysis-tab").click();
  await page.getByTestId("explain-button").click();
  await expect(page.getByTestId("plan-result")).toBeVisible({ timeout: 15_000 });
  expect(await axeViolations(page)).toEqual([]);

  await page.getByTestId("import-database").click();
  await expect(page.getByTestId("import-dialog")).toBeVisible();
  expect(await axeViolations(page, '[data-testid="import-dialog"]')).toEqual([]);
});

test("keyboard-only walkthrough: skip link, landmarks, and dialog focus (scenario 21)", async ({
  page,
}) => {
  await ready(page);

  // The first tab stop is a skip link that jumps straight to the workspace.
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to SQL workspace" });
  await expect(skipLink).toBeFocused();
  await skipLink.press("Enter");
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("workspace-main");

  // From the skip target, Tab enters the workspace controls rather than
  // restarting at the page chrome.
  await page.keyboard.press("Tab");
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest("main")))
    .toBe(true);

  // The results grid keeps exactly one tab stop (roving tabindex).
  await page.getByTestId("sql-input").fill("SELECT 1 AS a, 2 AS b;");
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);

  // Dialog: focus starts inside, Tab is trapped, Escape returns it to the opener.
  const opener = page.getByTestId("import-database");
  await opener.focus();
  await opener.press("Enter");
  await expect(page.getByTestId("import-dialog")).toBeVisible();
  await expect(page.getByTestId("import-file-input")).toBeFocused();

  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[data-testid="import-dialog"]')),
      ),
    ).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("import-dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("landmarks and accessible names expose the workspace to assistive tech (NFR-11)", async ({
  page,
}) => {
  await ready(page);

  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "SQL Playground" })).toBeVisible();
  await expect(page.getByRole("main", { name: "SQL workspace" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Databases and schema" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Analysis and history" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Side panel" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Analysis" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /History/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "SQL editor" })).toBeVisible();

  // The tab roving tabindex moves with the selection and Left/Right switch tabs.
  await page.getByRole("tab", { name: "Analysis" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /History/ })).toBeFocused();
  await expect(page.getByRole("tab", { name: /History/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Analysis" })).toBeFocused();

  await page.getByTestId("sql-input").fill("SELECT 1 AS a;");
  await page.getByTestId("sql-input").click();
  await page.getByTestId("run-button").click();
  await expect(page.getByRole("grid", { name: "Query results" })).toBeVisible({
    timeout: 15_000,
  });
});

test("desktop layout has no page overflow and tablet/phone show messaging (NFR-06)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await ready(page);
  await expect(page.getByTestId("viewport-notice")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.getByTestId("viewport-notice")).toBeVisible();

  await page.setViewportSize({ width: 375, height: 700 });
  await expect(page.getByTestId("unsupported-viewport")).toBeVisible();
  await expect(page.getByTestId("sql-input")).toHaveCount(0);
});

test("a browser without WebAssembly sees a clear unsupported screen (scenario 22)", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "WebAssembly", { value: undefined, configurable: true });
  });
  await page.goto("/");

  await expect(page.getByTestId("unsupported-browser")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("unsupported-browser")).toContainText("WebAssembly");
  await expect(page.getByTestId("unsupported-browser")).toContainText("Chrome");
  await expect(page.getByTestId("sql-input")).toHaveCount(0);
});
