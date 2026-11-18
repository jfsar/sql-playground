// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { browseTable, quoteIdent } from "./browse";

let sqlite3: Sqlite3Static;
let db: Database;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
  db = new sqlite3.oo1.DB(":memory:", "c");
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);
    INSERT INTO items (label) VALUES ('a'), ('b'), ('c'), ('d'), ('e');
    CREATE VIEW labels AS SELECT label FROM items WHERE id <= 2;
    CREATE TABLE "odd ""table" (id INTEGER PRIMARY KEY);
    INSERT INTO "odd ""table" VALUES (1);
  `);
});

afterAll(() => {
  db?.close();
});

describe("browseTable", () => {
  it("returns a page and the unpaged total", () => {
    const page = browseTable(sqlite3, db, "items", { limit: 2, offset: 0 });
    expect(page).toMatchObject({ table: "items", totalRows: 5, limit: 2, offset: 0 });
    expect(page.columns.map((column) => column.name)).toEqual(["id", "label"]);
    expect(page.rows).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
  });

  it("pages forward and returns an empty page past the end", () => {
    const middle = browseTable(sqlite3, db, "items", { limit: 2, offset: 2 });
    expect(middle.rows).toEqual([
      [3, "c"],
      [4, "d"],
    ]);
    const last = browseTable(sqlite3, db, "items", { limit: 2, offset: 4 });
    expect(last.rows).toEqual([[5, "e"]]);
    const past = browseTable(sqlite3, db, "items", { limit: 2, offset: 99 });
    expect(past.rows).toEqual([]);
    expect(past.totalRows).toBe(5);
  });

  it("browses views and quotes identifiers", () => {
    const view = browseTable(sqlite3, db, "labels", { limit: 10, offset: 0 });
    expect(view.rows.map((row) => row[0])).toEqual(["a", "b"]);

    expect(quoteIdent('odd "table')).toBe('"odd ""table"');
    const odd = browseTable(sqlite3, db, 'odd "table');
    expect(odd.rows).toEqual([[1]]);
  });

  it("clamps invalid page values", () => {
    const page = browseTable(sqlite3, db, "items", { limit: Number.NaN, offset: -5 });
    expect(page.limit).toBe(50);
    expect(page.offset).toBe(0);
  });

  it("surfaces a missing table as an error", () => {
    expect(() => browseTable(sqlite3, db, "nope")).toThrow(/no such table/i);
  });
});
