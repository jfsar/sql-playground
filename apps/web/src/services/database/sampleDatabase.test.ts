// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { executeScript } from "./execute";
import { readSchema } from "./schema";
import { DEMO_QUERIES, SAMPLE_SCHEMA_SQL } from "./sampleDatabase";

let sqlite3: Sqlite3Static;
let db: Database;

beforeEach(async () => {
  sqlite3 = await sqlite3InitModule();
  db = new sqlite3.oo1.DB(":memory:", "c");
});

afterEach(() => {
  db?.close();
});

describe("bundled sample database", () => {
  it("creates every table, view, index, and constraint through the execution contract", () => {
    const result = executeScript(sqlite3, db, SAMPLE_SCHEMA_SQL);
    expect(result.statements.some((statement) => statement.kind === "error")).toBe(false);

    const schema = readSchema(db);
    expect(schema.tables.map((table) => table.name)).toEqual([
      "albums",
      "artists",
      "playlist_tracks",
      "playlists",
      "tracks",
    ]);
    expect(schema.views.map((view) => view.name)).toEqual(["album_track_counts"]);

    const tracks = schema.tables.find((table) => table.name === "tracks");
    expect(tracks?.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "idx_tracks_album",
        "idx_tracks_rating",
        "sqlite_autoindex_tracks_1",
      ]),
    );
    expect(tracks?.checkConstraints).toHaveLength(2);
    expect(tracks?.foreignKeys).toHaveLength(1);
  });

  it("inserts enough rows for paging", () => {
    executeScript(sqlite3, db, SAMPLE_SCHEMA_SQL);
    const counts = db.selectObjects(
      "SELECT (SELECT count(*) FROM artists) AS artists, (SELECT count(*) FROM tracks) AS tracks",
    );
    expect(counts[0]).toMatchObject({ artists: 12, tracks: 120 });
  });

  it("every demo query runs without an error statement", () => {
    executeScript(sqlite3, db, SAMPLE_SCHEMA_SQL);
    for (const query of DEMO_QUERIES) {
      const result = executeScript(sqlite3, db, query.sql);
      expect(result.statements, query.title).toHaveLength(1);
      expect(result.statements[0]?.kind, query.title).toBe("rows");
      if (result.statements[0]?.kind === "rows") {
        expect(result.statements[0].rows.length, query.title).toBeGreaterThan(0);
      }
    }
  });
});
