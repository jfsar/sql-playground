import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseInfo, DatabaseSchema, TableSchema } from "../../shared/contracts";
import { SchemaExplorer } from "./SchemaExplorer";

afterEach(cleanup);

const albums: TableSchema = {
  name: "albums",
  type: "table",
  columns: [
    {
      name: "id",
      declaredType: "INTEGER",
      notNull: false,
      defaultValue: null,
      primaryKey: true,
      primaryKeyOrder: 1,
    },
    {
      name: "artist_id",
      declaredType: "INTEGER",
      notNull: true,
      defaultValue: null,
      primaryKey: false,
      primaryKeyOrder: 0,
    },
    {
      name: "title",
      declaredType: "TEXT",
      notNull: true,
      defaultValue: "'untitled'",
      primaryKey: false,
      primaryKeyOrder: 0,
    },
  ],
  foreignKeys: [
    {
      id: 0,
      from: "artist_id",
      table: "artists",
      to: "id",
      onUpdate: "NO ACTION",
      onDelete: "CASCADE",
    },
  ],
  indexes: [
    {
      name: "idx_albums_artist",
      unique: false,
      origin: "c",
      partial: false,
      columns: ["artist_id"],
    },
  ],
  checkConstraints: ["(length(title) > 0)"],
  sql: "CREATE TABLE albums (...)",
};

const view: TableSchema = {
  name: "album_totals",
  type: "view",
  columns: [
    {
      name: "album",
      declaredType: "TEXT",
      notNull: false,
      defaultValue: null,
      primaryKey: false,
      primaryKeyOrder: 0,
    },
  ],
  foreignKeys: [],
  indexes: [],
  checkConstraints: [],
  sql: "CREATE VIEW album_totals AS SELECT title FROM albums",
};

const schema: DatabaseSchema = { tables: [albums], views: [view] };
const database: DatabaseInfo = {
  id: "sample",
  name: "Sample database",
  createdAt: 1,
  lastOpenedAt: 1,
  sizeBytes: 1,
  status: "ok",
  sample: true,
};

function renderExplorer(overrides: Partial<Parameters<typeof SchemaExplorer>[0]> = {}) {
  const props = {
    schema,
    activeDatabase: database,
    busy: false,
    error: null,
    onRefresh: vi.fn(),
    onBrowse: vi.fn(),
    onLoadQuery: vi.fn(),
    ...overrides,
  };
  render(<SchemaExplorer {...props} />);
  return props;
}

describe("SchemaExplorer", () => {
  it("groups tables and views and expands table details", () => {
    renderExplorer();
    expect(screen.getByTestId("schema-tables").textContent).toContain("Tables · 1");
    expect(screen.getByTestId("schema-views").textContent).toContain("Views · 1");

    const item = screen.getByTestId("schema-item-albums");
    expect(item.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(item);
    expect(item.getAttribute("aria-expanded")).toBe("true");

    const details = screen.getByTestId("schema-details-albums");
    expect(details.textContent).toContain("artist_id");
    expect(details.textContent).toContain("PRIMARY KEY (id)");
    expect(details.textContent).toContain("FOREIGN KEY artist_id → artists(id)");
    expect(details.textContent).toContain("ON DELETE CASCADE");
    expect(details.textContent).toContain("CHECK (length(title) > 0)");
    expect(details.textContent).toContain("idx_albums_artist");
  });

  it("browses a table and loads a demo query", () => {
    const onLoadQuery = vi.fn();
    const props = renderExplorer({ onLoadQuery });
    fireEvent.click(screen.getByTestId("schema-item-albums"));
    fireEvent.click(screen.getByTestId("browse-albums"));
    expect(props.onBrowse).toHaveBeenCalledWith("albums");

    fireEvent.click(screen.getByTestId("demo-query-0"));
    expect(onLoadQuery).toHaveBeenCalledTimes(1);
    expect(String(onLoadQuery.mock.calls[0]?.[0])).toContain("SELECT");
  });

  it("refreshes and shows errors", () => {
    const props = renderExplorer({ error: "schema unreadable" });
    expect(screen.getByTestId("schema-error").textContent).toContain("schema unreadable");
    fireEvent.click(screen.getByTestId("refresh-schema"));
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("hides demo queries for non-sample databases", () => {
    renderExplorer({ activeDatabase: { ...database, sample: false } });
    expect(screen.queryByTestId("demo-queries")).toBeNull();
  });
});
