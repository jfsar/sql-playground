import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseInfo, ScriptImportResult } from "../../shared/contracts";
import { ImportDatabaseDialog } from "./ImportDatabaseDialog";

afterEach(cleanup);

const DATABASES: DatabaseInfo[] = [
  {
    id: "db-1",
    name: "Existing",
    createdAt: 1,
    lastOpenedAt: 1,
    sizeBytes: 512,
    status: "ok",
  },
  {
    id: "db-2",
    name: "Missing",
    createdAt: 1,
    lastOpenedAt: 1,
    sizeBytes: 0,
    status: "missing-file",
  },
];

const RESPONSE: ScriptImportResult = {
  response: { statements: [], inTransaction: false, totalEngineMs: 1 },
  database: DATABASES[0]!,
  rolledBack: false,
};

function sqliteFile(name = "import.db", wal = false): File {
  const bytes = new Uint8Array(512);
  const header = "SQLite format 3\0";
  for (let i = 0; i < header.length; i += 1) bytes[i] = header.charCodeAt(i);
  bytes[16] = 2;
  bytes[17] = 0;
  bytes[18] = wal ? 2 : 1;
  bytes[19] = wal ? 2 : 1;
  return new File([bytes], name);
}

function renderDialog(overrides: Partial<Parameters<typeof ImportDatabaseDialog>[0]> = {}) {
  const props = {
    open: true,
    databases: DATABASES,
    storageInfo: null,
    onClose: vi.fn(),
    onImportDatabase: vi.fn(async () => DATABASES[0]!),
    onImportScript: vi.fn(async () => RESPONSE),
    onImported: vi.fn(),
    ...overrides,
  };
  render(<ImportDatabaseDialog {...props} />);
  return props;
}

describe("ImportDatabaseDialog", () => {
  it("previews valid SQLite files and imports them", async () => {
    const props = renderDialog();
    const file = sqliteFile("my data.db");

    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByTestId("import-preview")).toBeTruthy());
    expect(screen.getByTestId("import-name")).toHaveProperty("value", "my data");
    fireEvent.click(screen.getByTestId("import-confirm"));

    await waitFor(() => expect(props.onImportDatabase).toHaveBeenCalledOnce());
    expect(props.onImportDatabase).toHaveBeenCalledWith(file, {
      name: "my data",
      storageInfo: null,
    });
    expect(props.onImported).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("blocks invalid files before the import button appears", async () => {
    renderDialog();

    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [new File([new Uint8Array([1, 2, 3])], "broken.db")] },
    });

    await waitFor(() => expect(screen.getByTestId("import-validation-error")).toBeTruthy());
    expect(screen.queryByTestId("import-confirm")).toBeNull();
  });

  it("shows WAL warnings without demanding confirmation for normal files", async () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [sqliteFile("wal.db", true)] },
    });

    await waitFor(() => expect(screen.getByTestId("import-warning-wal_mode")).toBeTruthy());
    expect(screen.queryByTestId("import-confirm-large")).toBeNull();
  });

  it("runs a script into the selected existing database", async () => {
    const props = renderDialog();
    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: {
        files: [new File([new TextEncoder().encode("SELECT 1;")], "seed.sql")],
      },
    });

    await waitFor(() => expect(screen.getByTestId("import-target")).toBeTruthy());
    fireEvent.change(screen.getByTestId("import-target"), { target: { value: "db-1" } });
    fireEvent.click(screen.getByTestId("import-confirm"));

    await waitFor(() => expect(props.onImportScript).toHaveBeenCalledOnce());
    expect(props.onImportScript).toHaveBeenCalledWith(expect.any(File), { targetId: "db-1" });
    expect(await screen.findByTestId("import-result")).toBeTruthy();
    expect(props.onImported).toHaveBeenCalledOnce();
  });

  it("explains when a new script database was rolled back", async () => {
    const rolledBack: ScriptImportResult = {
      response: {
        statements: [
          {
            kind: "error",
            sql: "SELECT broken;",
            error: { code: "SQL_ERROR", message: "syntax error" },
            span: { start: 0, end: 15, text: "SELECT broken;" },
          },
        ],
        inTransaction: false,
        totalEngineMs: 1,
      },
      database: null,
      rolledBack: true,
    };
    renderDialog({ onImportScript: vi.fn(async () => rolledBack) });

    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: {
        files: [new File([new TextEncoder().encode("SELECT broken;")], "bad.sql")],
      },
    });
    await waitFor(() => expect(screen.getByTestId("import-confirm")).toBeTruthy());
    fireEvent.click(screen.getByTestId("import-confirm"));

    expect(await screen.findByTestId("import-rolled-back")).toBeTruthy();
  });
});
