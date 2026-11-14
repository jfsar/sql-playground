// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { createTsToolkit } from "../toolkit/tsToolkit";
import { explainQuery } from "./explain";

let sqlite3: Sqlite3Static;
let db: Database;
const toolkit = createTsToolkit();

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
  db = new sqlite3.oo1.DB(":memory:", "c");
  db.exec(`CREATE TABLE exp_t(a INTEGER PRIMARY KEY, b TEXT);
           CREATE INDEX exp_t_b ON exp_t(b);
           INSERT INTO exp_t(a, b) VALUES (1, 'x');`);
});

afterAll(() => {
  db?.close();
});

describe("explainQuery", () => {
  it("returns a SCAN plan for a full-table query", () => {
    const plan = explainQuery(sqlite3, db, toolkit, "SELECT a FROM exp_t");
    expect(plan.sqliteVersion).toBe(sqlite3.version.libVersion);
    expect(plan.nodes.length).toBeGreaterThan(0);
    expect(plan.raw.length).toBe(plan.nodes.length);
    const root = plan.nodes.find((n) => n.parentId === 0) ?? plan.nodes[0];
    expect(root?.operation).toBe("SCAN");
    expect(root?.table).toBe("exp_t");
    expect(root?.detail).toContain("SCAN");
  });

  it("returns a SEARCH plan when the index is usable", () => {
    const plan = explainQuery(sqlite3, db, toolkit, "SELECT a FROM exp_t WHERE b = 'x'");
    const search = plan.nodes.find((n) => n.operation === "SEARCH");
    expect(search).toBeDefined();
    expect(search?.table).toBe("exp_t");
    expect(search?.index).toBe("exp_t_b");
  });

  it("explains only the first statement of a script", () => {
    const plan = explainQuery(sqlite3, db, toolkit, "SELECT 1; SELECT 2;");
    expect(plan.nodes.length).toBeGreaterThan(0);
    expect(plan.raw[0]?.detail).toMatch(/SCAN|OTHER|SEARCH/);
  });

  it("throws the SQLite message for invalid SQL", () => {
    expect(() => explainQuery(sqlite3, db, toolkit, "SELECT * FROM missing_tbl")).toThrow(
      /missing_tbl|no such table/i,
    );
  });
});
