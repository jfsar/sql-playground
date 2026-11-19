import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("ready")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("import-database")).toBeEnabled();
}

async function exportActive(page: Page): Promise<Buffer> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-button").click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("export download has no path");
  return readFile(path);
}

async function openImport(page: Page): Promise<void> {
  await page.getByTestId("import-database").click();
  await expect(page.getByTestId("import-dialog")).toBeVisible();
}

test("exports a valid database and imports it as a new entry (Week 6)", async ({ page }) => {
  await ready(page);
  await page
    .getByTestId("sql-input")
    .fill(
      "CREATE TABLE export_me (id INTEGER PRIMARY KEY, body TEXT);\nINSERT INTO export_me (body) VALUES ('kept');",
    );
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-change-1")).toBeVisible({ timeout: 15_000 });

  const exported = await exportActive(page);
  expect(exported.subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0");
  await expect(page.getByTestId("export-result")).toContainText("exported");
  await expect(page.getByTestId("backup-reminder")).toHaveCount(0);

  await openImport(page);
  await page.getByTestId("import-file-input").setInputFiles({
    name: "exported-copy.sqlite3",
    mimeType: "application/vnd.sqlite3",
    buffer: exported,
  });
  await expect(page.getByTestId("import-preview")).toContainText("SQLite database");
  await page.getByTestId("import-name").fill("Imported copy");
  await page.getByTestId("import-confirm").click();

  await expect(page.getByTestId("import-dialog")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("active-database")).toHaveText("Imported copy");
  await expect(page.getByTestId("schema-item-export_me")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("sql-input").fill("SELECT body FROM export_me;");
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-rows-0")).toContainText("kept", { timeout: 15_000 });
});

test("rejects unsupported and truncated files, and warns on WAL headers (Week 6)", async ({
  page,
}) => {
  await ready(page);

  await openImport(page);
  await page.getByTestId("import-file-input").setInputFiles({
    name: "secret.db",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([1, 2, 3, 4, 5]),
  });
  await expect(page.getByTestId("import-validation-error")).toContainText(
    /encrypted|different format/i,
  );
  await page.getByTestId("import-close").click();

  const truncated = Buffer.alloc(100);
  truncated.write("SQLite format 3\0", 0, "binary");
  truncated[16] = 2;
  await openImport(page);
  await page.getByTestId("import-file-input").setInputFiles({
    name: "truncated.db",
    mimeType: "application/octet-stream",
    buffer: truncated,
  });
  await expect(page.getByTestId("import-validation-error")).toContainText(/truncated/i);
  await page.getByTestId("import-close").click();

  const exported = await exportActive(page);
  const wal = Buffer.from(exported);
  wal[18] = 2;
  wal[19] = 2;
  await openImport(page);
  await page.getByTestId("import-file-input").setInputFiles({
    name: "wal-copy.sqlite3",
    mimeType: "application/vnd.sqlite3",
    buffer: wal,
  });
  await expect(page.getByTestId("import-warning-wal_mode")).toContainText(/WAL mode/i);
  await page.getByTestId("import-name").fill("WAL import");
  await page.getByTestId("import-confirm").click();

  await expect(page.getByTestId("active-database")).toHaveText("WAL import", { timeout: 20_000 });
  await expect(page.getByTestId("journal")).toContainText("delete");
});

test("imports SQL scripts into new databases and rolls back failures (Week 6)", async ({
  page,
}) => {
  await ready(page);

  await openImport(page);
  await page.getByTestId("import-file-input").setInputFiles({
    name: "script-seed.sql",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "CREATE TABLE script_t (id INTEGER PRIMARY KEY, label TEXT);\nINSERT INTO script_t (label) VALUES ('from script');",
    ),
  });
  await expect(page.getByTestId("import-target")).toBeVisible();
  await page.getByTestId("import-name").fill("Script DB");
  await page.getByTestId("import-confirm").click();

  await expect(page.getByTestId("import-result")).toContainText("2 statements");
  await page.getByTestId("import-done").click();
  await expect(page.getByTestId("active-database")).toHaveText("Script DB");
  await expect(page.getByTestId("schema-item-script_t")).toBeVisible({ timeout: 15_000 });

  await openImport(page);
  await page.getByTestId("import-file-input").setInputFiles({
    name: "bad-script.sql",
    mimeType: "text/plain",
    buffer: Buffer.from("CREATE TABLE partial_t (id INTEGER);\nSELECT * FROM missing_table;"),
  });
  await page.getByTestId("import-name").fill("Bad Script");
  await page.getByTestId("import-confirm").click();
  await expect(page.getByTestId("import-rolled-back")).toContainText(/removed/i);
  await page.getByTestId("import-done").click();

  await expect(page.getByTestId("active-database")).toHaveText("Script DB");
  await expect(page.getByTestId("database-item").filter({ hasText: "Bad Script" })).toHaveCount(0);
});

test("rejects a corrupted database via quick_check (Week 6)", async ({ page }) => {
  await ready(page);
  await page.getByTestId("sql-input").fill("CREATE TABLE corrupt_me (id INTEGER PRIMARY KEY);");
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("stmt-change-0")).toBeVisible({ timeout: 15_000 });

  const exported = Buffer.from(await exportActive(page));
  exported.fill(0xff, 100);
  await openImport(page);
  await page.getByTestId("import-file-input").setInputFiles({
    name: "corrupt.db",
    mimeType: "application/octet-stream",
    buffer: exported,
  });
  await expect(page.getByTestId("import-confirm")).toBeVisible();
  await page.getByTestId("import-confirm").click();

  await expect(page.getByTestId("import-error")).toContainText(/quick_check|corrupt|malformed/i, {
    timeout: 20_000,
  });
  await expect(page.getByTestId("import-dialog")).toBeVisible();
});
