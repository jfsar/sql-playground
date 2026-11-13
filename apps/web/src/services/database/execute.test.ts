// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { executeScript, byteOffsetToJsIndex } from "./execute";

let sqlite3: Sqlite3Static;
let db: Database;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
  db = new sqlite3.oo1.DB(":memory:", "c");
});

afterAll(() => {
  db?.close();
});

describe("byteOffsetToJsIndex", () => {
  it("maps ASCII offsets 1:1", () => {
    expect(byteOffsetToJsIndex("SELECT", 0)).toBe(0);
    expect(byteOffsetToJsIndex("SELECT", 3)).toBe(3);
    expect(byteOffsetToJsIndex("SELECT", 99)).toBe(6);
  });

  it("accounts for multi-byte UTF-8", () => {
    // 'é' is 2 bytes in UTF-8, 1 JS char. Mid-character offsets → containing char.
    expect(byteOffsetToJsIndex("aéb", 0)).toBe(0);
    expect(byteOffsetToJsIndex("aéb", 1)).toBe(1);
    expect(byteOffsetToJsIndex("aéb", 2)).toBe(1);
    expect(byteOffsetToJsIndex("aéb", 3)).toBe(2);
  });
});

describe("executeScript — prepare-loop splitting", () => {
  it("splits a multi-statement script into per-statement results", () => {
    db.exec("DROP TABLE IF EXISTS split_t");
    const res = executeScript(
      sqlite3,
      db,
      `
      CREATE TABLE split_t(a INTEGER);
      INSERT INTO split_t VALUES (1), (2);
      SELECT a FROM split_t ORDER BY a;
      `,
    );
    expect(res.statements).toHaveLength(3);
    expect(res.statements[0]?.kind).toBe("change");
    expect(res.statements[1]?.kind).toBe("change");
    expect(res.statements[2]?.kind).toBe("rows");
    if (res.statements[1]?.kind === "change") {
      expect(res.statements[1].rowsAffected).toBe(2);
    }
    if (res.statements[2]?.kind === "rows") {
      expect(res.statements[2].rows).toEqual([[1], [2]]);
      expect(res.statements[2].columns.map((c) => c.name)).toEqual(["a"]);
    }
    expect(res.inTransaction).toBe(false);
  });

  it("does not split on semicolons inside string literals", () => {
    db.exec("DROP TABLE IF EXISTS semi_t");
    const res = executeScript(
      sqlite3,
      db,
      `CREATE TABLE semi_t(s TEXT); INSERT INTO semi_t VALUES ('a;b;c'); SELECT s FROM semi_t;`,
    );
    expect(res.statements).toHaveLength(3);
    expect(res.statements.every((s) => s.kind !== "error")).toBe(true);
    if (res.statements[2]?.kind === "rows") {
      expect(res.statements[2].rows).toEqual([["a;b;c"]]);
    }
  });

  it("skips comments between statements", () => {
    db.exec("DROP TABLE IF EXISTS cmt_t");
    const res = executeScript(
      sqlite3,
      db,
      `-- create\nCREATE TABLE cmt_t(x);\n/* insert */\nINSERT INTO cmt_t VALUES (7);\nSELECT x FROM cmt_t;`,
    );
    expect(res.statements).toHaveLength(3);
    expect(res.statements.every((s) => s.kind !== "error")).toBe(true);
  });

  it("stops at first error; earlier statements keep effects", () => {
    db.exec("DROP TABLE IF EXISTS err_t");
    const res = executeScript(
      sqlite3,
      db,
      `CREATE TABLE err_t(x); INSERT INTO err_t VALUES (1); SELECT * FROM does_not_exist; SELECT 99;`,
    );
    expect(res.statements).toHaveLength(3);
    expect(res.statements[0]?.kind).toBe("change");
    expect(res.statements[1]?.kind).toBe("change");
    expect(res.statements[2]?.kind).toBe("error");
    // Fourth statement never ran
    const check = executeScript(sqlite3, db, `SELECT COUNT(*) FROM err_t`);
    if (check.statements[0]?.kind === "rows") {
      expect(check.statements[0].rows).toEqual([[1]]);
    }
  });

  it("reports error with span and sqlite message", () => {
    const res = executeScript(sqlite3, db, `SELECT * FROM missing_table_xyz`);
    expect(res.statements).toHaveLength(1);
    const s = res.statements[0];
    expect(s?.kind).toBe("error");
    if (s?.kind === "error") {
      expect(s.error.message).toMatch(/missing_table_xyz|no such table/i);
      expect(s.error.sqliteCode).toBeTypeOf("number");
      expect(s.span.text).toContain("missing_table_xyz");
      expect(s.span.start).toBeGreaterThanOrEqual(0);
      expect(s.span.end).toBeGreaterThan(s.span.start);
    }
  });
});

describe("executeScript — policy", () => {
  it("blocks ATTACH with POLICY_BLOCKED and stops", () => {
    const res = executeScript(
      sqlite3,
      db,
      `SELECT 1; ATTACH DATABASE 'other.db' AS other; SELECT 2;`,
    );
    expect(res.statements).toHaveLength(2);
    expect(res.statements[0]?.kind).toBe("rows");
    const s = res.statements[1];
    expect(s?.kind).toBe("error");
    if (s?.kind === "error") {
      expect(s.error.code).toBe("POLICY_BLOCKED");
      expect(s.error.message).toMatch(/ATTACH/i);
    }
  });

  it("blocks VACUUM INTO", () => {
    const res = executeScript(sqlite3, db, `VACUUM INTO 'out.sqlite3'`);
    expect(res.statements).toHaveLength(1);
    const s = res.statements[0];
    expect(s?.kind).toBe("error");
    if (s?.kind === "error") {
      expect(s.error.code).toBe("POLICY_BLOCKED");
    }
  });
});

describe("executeScript — transaction-state reading", () => {
  it("reads autocommit after BEGIN/COMMIT", () => {
    const begin = executeScript(sqlite3, db, `BEGIN`);
    expect(begin.inTransaction).toBe(true);
    const commit = executeScript(sqlite3, db, `COMMIT`);
    expect(commit.inTransaction).toBe(false);
  });

  it("reads autocommit after BEGIN/ROLLBACK", () => {
    executeScript(sqlite3, db, `BEGIN`);
    const rb = executeScript(sqlite3, db, `ROLLBACK`);
    expect(rb.inTransaction).toBe(false);
  });

  it("keeps user transaction open after a statement error (no silent rollback)", () => {
    db.exec("DROP TABLE IF EXISTS tx_t");
    executeScript(sqlite3, db, `CREATE TABLE tx_t(x); BEGIN; INSERT INTO tx_t VALUES (1);`);
    const res = executeScript(sqlite3, db, `INSERT INTO missing_tx VALUES (1)`);
    expect(res.statements[0]?.kind).toBe("error");
    expect(res.inTransaction).toBe(true);
    expect(res.rolledBackBySqlite).toBeUndefined();
    // Cleanup
    executeScript(sqlite3, db, `ROLLBACK`);
  });

  it("reports inTransaction false for ordinary scripts", () => {
    const res = executeScript(sqlite3, db, `SELECT 1`);
    expect(res.inTransaction).toBe(false);
  });
});

describe("executeScript — row cap and timing", () => {
  it("truncates at maxRows", () => {
    db.exec("DROP TABLE IF EXISTS cap_t");
    executeScript(sqlite3, db, `CREATE TABLE cap_t(n);`);
    for (let i = 0; i < 25; i += 1) {
      executeScript(sqlite3, db, `INSERT INTO cap_t VALUES (${i});`);
    }
    const res = executeScript(sqlite3, db, `SELECT n FROM cap_t ORDER BY n`, { maxRows: 10 });
    const s = res.statements[0];
    expect(s?.kind).toBe("rows");
    if (s?.kind === "rows") {
      expect(s.rows).toHaveLength(10);
      expect(s.truncated).toBe(true);
      expect(s.engineMs).toBeGreaterThanOrEqual(0);
    }
    expect(res.totalEngineMs).toBeGreaterThanOrEqual(0);
  });

  it("does not set truncated when under the cap", () => {
    const res = executeScript(sqlite3, db, `SELECT 1 AS a`, { maxRows: 1000 });
    const s = res.statements[0];
    if (s?.kind === "rows") {
      expect(s.truncated).toBe(false);
      expect(s.rows).toEqual([[1]]);
    }
  });
});

describe("executeScript — DML row counts", () => {
  it("reports rowsAffected for INSERT/UPDATE/DELETE only", () => {
    db.exec("DROP TABLE IF EXISTS dml_t");
    const create = executeScript(sqlite3, db, `CREATE TABLE dml_t(x)`);
    expect(create.statements[0]?.kind).toBe("change");
    if (create.statements[0]?.kind === "change") {
      expect(create.statements[0].rowsAffected).toBeUndefined();
    }

    const ins = executeScript(sqlite3, db, `INSERT INTO dml_t VALUES (1),(2),(3)`);
    if (ins.statements[0]?.kind === "change") {
      expect(ins.statements[0].rowsAffected).toBe(3);
    }

    const upd = executeScript(sqlite3, db, `UPDATE dml_t SET x = x + 1`);
    if (upd.statements[0]?.kind === "change") {
      expect(upd.statements[0].rowsAffected).toBe(3);
    }

    const del = executeScript(sqlite3, db, `DELETE FROM dml_t`);
    if (del.statements[0]?.kind === "change") {
      expect(del.statements[0].rowsAffected).toBe(3);
    }

    const sel = executeScript(sqlite3, db, `SELECT COUNT(*) FROM dml_t`);
    expect(sel.statements[0]?.kind).toBe("rows");
  });
});
