// @vitest-environment node
/**
 * Week 8 fixtures: real `EXPLAIN QUERY PLAN` rows captured from the selected
 * SQLite version (plan §4: plan text varies between versions, so the parser is
 * tested against version-pinned output). The live engine must still produce
 * these rows; if it does not, the fixtures are stale and the test fails.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { QueryPlanNode, RawPlanRow } from "../../shared/contracts";
import { createTsToolkit } from "./tsToolkit";

interface Fixture {
  name: string;
  sql: string;
  rows: RawPlanRow[];
  expect: (nodes: QueryPlanNode[]) => void;
}

const FIXTURES: Fixture[] = [
  {
    name: "full table scan",
    sql: "SELECT * FROM notes",
    rows: [{ id: 2, parent: 0, detail: "SCAN notes" }],
    expect: (nodes) => {
      expect(nodes[0]).toMatchObject({ operation: "SCAN", table: "notes", tags: [] });
    },
  },
  {
    name: "index search",
    sql: "SELECT * FROM notes WHERE body = 'x'",
    rows: [{ id: 3, parent: 0, detail: "SEARCH notes USING INDEX idx_body (body=?)" }],
    expect: (nodes) => {
      expect(nodes[0]).toMatchObject({
        operation: "SEARCH",
        table: "notes",
        index: "idx_body",
        tags: [],
      });
    },
  },
  {
    name: "covering index search",
    sql: "SELECT id FROM notes WHERE body = 'x'",
    rows: [{ id: 2, parent: 0, detail: "SEARCH notes USING COVERING INDEX idx_body (body=?)" }],
    expect: (nodes) => {
      expect(nodes[0]).toMatchObject({
        operation: "SEARCH",
        table: "notes",
        index: "idx_body",
        tags: ["COVERING INDEX"],
      });
    },
  },
  {
    name: "integer primary key search",
    sql: "SELECT * FROM notes WHERE id = 1",
    rows: [{ id: 2, parent: 0, detail: "SEARCH notes USING INTEGER PRIMARY KEY (rowid=?)" }],
    expect: (nodes) => {
      expect(nodes[0]).toMatchObject({
        operation: "SEARCH",
        table: "notes",
        tags: ["INTEGER PRIMARY KEY"],
      });
      expect(nodes[0]?.index).toBeUndefined();
    },
  },
  {
    name: "temporary b-tree sort",
    sql: "SELECT * FROM notes ORDER BY created_at",
    rows: [
      { id: 3, parent: 0, detail: "SCAN notes" },
      { id: 11, parent: 0, detail: "USE TEMP B-TREE FOR ORDER BY" },
    ],
    expect: (nodes) => {
      expect(nodes[0]).toMatchObject({ operation: "SCAN", table: "notes" });
      expect(nodes[1]).toMatchObject({ operation: "OTHER", tags: ["TEMP B-TREE"] });
    },
  },
  {
    name: "automatic covering index and bloom filter",
    sql: "SELECT * FROM a JOIN b ON a.x = b.y",
    rows: [
      { id: 3, parent: 0, detail: "SCAN a" },
      { id: 7, parent: 0, detail: "BLOOM FILTER ON b (y=?)" },
      { id: 16, parent: 0, detail: "SEARCH b USING AUTOMATIC COVERING INDEX (y=?)" },
    ],
    expect: (nodes) => {
      expect(nodes[1]).toMatchObject({ operation: "OTHER", tags: ["BLOOM FILTER"] });
      expect(nodes[2]).toMatchObject({
        operation: "SEARCH",
        table: "b",
        tags: ["AUTOMATIC INDEX", "COVERING INDEX"],
      });
      expect(nodes[2]?.index).toBeUndefined();
    },
  },
  {
    name: "correlated scalar subquery",
    sql: "SELECT id, (SELECT count(*) FROM tags WHERE tags.note_id = notes.id) FROM notes",
    rows: [
      { id: 2, parent: 0, detail: "SCAN notes USING COVERING INDEX idx_body" },
      { id: 6, parent: 0, detail: "CORRELATED SCALAR SUBQUERY 1" },
      { id: 11, parent: 6, detail: "SCAN tags" },
    ],
    expect: (nodes) => {
      expect(nodes[0]).toMatchObject({ operation: "SCAN", tags: ["COVERING INDEX"] });
      expect(nodes[1]).toMatchObject({ operation: "OTHER" });
      expect(nodes[2]).toMatchObject({ operation: "SCAN", table: "tags", parentId: 6 });
    },
  },
  {
    name: "compound query co-routine",
    sql: "SELECT * FROM (SELECT note_id FROM tags UNION ALL SELECT note_id FROM tags)",
    rows: [
      { id: 1, parent: 0, detail: "COMPOUND QUERY" },
      { id: 2, parent: 1, detail: "LEFT-MOST SUBQUERY" },
      { id: 4, parent: 2, detail: "SCAN tags" },
      { id: 9, parent: 1, detail: "UNION ALL" },
      { id: 11, parent: 9, detail: "SCAN tags" },
    ],
    expect: (nodes) => {
      expect(nodes.map((n) => n.operation)).toEqual(["OTHER", "OTHER", "SCAN", "OTHER", "SCAN"]);
      expect(nodes[2]?.parentId).toBe(2);
      expect(nodes[4]?.parentId).toBe(9);
    },
  },
  {
    name: "materialized CTE",
    sql: "WITH recent AS MATERIALIZED (SELECT id FROM notes) SELECT * FROM recent",
    rows: [
      { id: 3, parent: 0, detail: "MATERIALIZE recent" },
      { id: 6, parent: 3, detail: "SCAN notes USING COVERING INDEX idx_body" },
      { id: 16, parent: 0, detail: "SCAN recent" },
    ],
    expect: (nodes) => {
      expect(nodes[0]).toMatchObject({ operation: "OTHER", tags: ["MATERIALIZE"] });
      expect(nodes[1]).toMatchObject({ operation: "SCAN", parentId: 3 });
      expect(nodes[2]).toMatchObject({ operation: "SCAN", table: "recent" });
    },
  },
];

let sqlite3: Sqlite3Static;
let db: Database;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
  db = new sqlite3.oo1.DB(":memory:", "c");
  db.exec(`
    CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT, created_at TEXT);
    CREATE INDEX idx_body ON notes(body);
    CREATE TABLE tags(note_id INTEGER, tag TEXT);
    CREATE TABLE a(x INTEGER);
    CREATE TABLE b(y INTEGER);
  `);
});

afterAll(() => {
  db?.close();
});

function liveRows(sql: string): RawPlanRow[] {
  const rows = db.exec(`EXPLAIN QUERY PLAN ${sql}`, {
    rowMode: "array",
    returnValue: "resultRows",
  }) as unknown as [number, number, number, string][];
  return rows.map(([id, parent, , detail]) => ({ id, parent, detail }));
}

const toolkit = createTsToolkit();

describe("plan fixtures (SQLite 3.54.1)", () => {
  it("uses the selected SQLite version", () => {
    expect(sqlite3.version.libVersion).toBe("3.54.1");
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.name}: live rows match the fixture`, () => {
      expect(liveRows(fixture.sql)).toEqual(fixture.rows);
    });

    it(`${fixture.name}: parses into tagged nodes`, () => {
      const plan = toolkit.parsePlan(fixture.rows, sqlite3.version.libVersion);
      fixture.expect(plan.nodes);
      expect(plan.raw).toEqual(fixture.rows);
    });
  }
});
