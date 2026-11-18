// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { extractCheckConstraints, readSchema } from "./schema";

let sqlite3: Sqlite3Static;
let db: Database;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
  db = new sqlite3.oo1.DB(":memory:", "c");
  db.exec(`
    CREATE TABLE artists (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE albums (
      id INTEGER PRIMARY KEY,
      artist_id INTEGER NOT NULL REFERENCES artists(id) ON UPDATE CASCADE ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'untitled',
      released_year INTEGER CHECK (released_year BETWEEN 1900 AND 2100),
      rating INTEGER CHECK (rating >= 0 AND (rating <= 5))
    );
    CREATE INDEX idx_albums_artist ON albums(artist_id);
    CREATE INDEX idx_albums_lower_title ON albums(lower(title));
    CREATE VIEW artist_albums AS
      SELECT artists.name AS artist, albums.title AS title
      FROM artists JOIN albums ON albums.artist_id = artists.id;
    CREATE TABLE "odd ""name" (id INTEGER PRIMARY KEY);
  `);
});

afterAll(() => {
  db?.close();
});

describe("readSchema", () => {
  it("lists tables and views, excluding internal tables", () => {
    const schema = readSchema(db);
    expect(schema.tables.map((table) => table.name)).toEqual(["albums", "artists", 'odd "name']);
    expect(schema.views.map((view) => view.name)).toEqual(["artist_albums"]);
  });

  it("reports columns, primary keys, defaults, and nullability", () => {
    const schema = readSchema(db);
    const albums = schema.tables.find((table) => table.name === "albums");
    expect(albums?.type).toBe("table");

    const id = albums?.columns.find((column) => column.name === "id");
    expect(id).toMatchObject({ primaryKey: true, primaryKeyOrder: 1, notNull: false });

    const artistId = albums?.columns.find((column) => column.name === "artist_id");
    expect(artistId).toMatchObject({ notNull: true, primaryKey: false });

    const title = albums?.columns.find((column) => column.name === "title");
    expect(title?.defaultValue).toBe("'untitled'");
  });

  it("reports foreign keys with their actions", () => {
    const schema = readSchema(db);
    const albums = schema.tables.find((table) => table.name === "albums");
    expect(albums?.foreignKeys).toEqual([
      {
        id: 0,
        from: "artist_id",
        table: "artists",
        to: "id",
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
    ]);
  });

  it("reports unique constraints, explicit indexes, and expression indexes", () => {
    const schema = readSchema(db);
    const artists = schema.tables.find((table) => table.name === "artists");
    const unique = artists?.indexes.find((index) => index.origin === "u");
    expect(unique?.unique).toBe(true);
    expect(unique?.columns).toEqual(["name"]);

    const albums = schema.tables.find((table) => table.name === "albums");
    const explicit = albums?.indexes.find((index) => index.name === "idx_albums_artist");
    expect(explicit).toMatchObject({ origin: "c", unique: false, columns: ["artist_id"] });
    const expression = albums?.indexes.find((index) => index.name === "idx_albums_lower_title");
    expect(expression?.columns).toEqual([]);
  });

  it("extracts CHECK constraints and preserves view columns", () => {
    const schema = readSchema(db);
    const albums = schema.tables.find((table) => table.name === "albums");
    expect(albums?.checkConstraints).toHaveLength(2);
    expect(albums?.checkConstraints.join(" ")).toContain("BETWEEN 1900 AND 2100");
    expect(albums?.checkConstraints.join(" ")).toContain("rating <= 5");

    const view = schema.views[0];
    expect(view?.columns.map((column) => column.name)).toEqual(["artist", "title"]);
    expect(view?.indexes).toEqual([]);
    expect(view?.foreignKeys).toEqual([]);
  });
});

describe("extractCheckConstraints", () => {
  it("ignores CHECK inside strings, comments, and brackets", () => {
    const sql = `CREATE TABLE t (
      note TEXT DEFAULT 'CHECK (not a constraint)',
      -- CHECK (also commented)
      /* CHECK (block comment) */
      value INTEGER,
      CHECK (value > 0 AND (value < 100)),
      CHECK ("label" <> 'CHECK')
    )`;
    expect(extractCheckConstraints(sql)).toEqual([
      "(value > 0 AND (value < 100))",
      "(\"label\" <> 'CHECK')",
    ]);
  });

  it("handles bracket identifiers and escaped quotes", () => {
    const sql = `CREATE TABLE t (
      [weird]]check] TEXT,
      CHECK ([weird]]check] IS NOT NULL),
      CHECK (length([weird]]check]) < 10)
    )`;
    expect(extractCheckConstraints(sql)).toEqual([
      "([weird]]check] IS NOT NULL)",
      "(length([weird]]check]) < 10)",
    ]);
  });
});
