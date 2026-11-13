import { describe, expect, it } from "vitest";
import { checkPolicy, isVacuumInto, leadingKeyword, skipTrivia } from "./policy";

describe("leadingKeyword", () => {
  it("returns uppercase first keyword", () => {
    expect(leadingKeyword("select 1")).toBe("SELECT");
    expect(leadingKeyword("  \n\t INSERT INTO t VALUES (1)")).toBe("INSERT");
  });

  it("skips line and block comments", () => {
    expect(leadingKeyword("-- note\nSELECT 1")).toBe("SELECT");
    expect(leadingKeyword("/* c */ DELETE FROM t")).toBe("DELETE");
    expect(leadingKeyword("-- only\n")).toBe("");
  });

  it("handles empty / trivia-only input", () => {
    expect(leadingKeyword("")).toBe("");
    expect(leadingKeyword("   \n  ")).toBe("");
  });
});

describe("skipTrivia", () => {
  it("finds first significant character", () => {
    expect(skipTrivia("  SELECT")).toBe(2);
    expect(skipTrivia("-- x\nSELECT")).toBe(5);
  });
});

describe("isVacuumInto", () => {
  it("detects VACUUM INTO", () => {
    expect(isVacuumInto("VACUUM INTO 'out.db'")).toBe(true);
    expect(isVacuumInto('vacuum into "x"')).toBe(true);
    expect(isVacuumInto("VACUUM  INTO 'x'")).toBe(true);
  });

  it("does not block bare VACUUM", () => {
    expect(isVacuumInto("VACUUM")).toBe(false);
    expect(isVacuumInto("VACUUM;")).toBe(false);
  });
});

describe("checkPolicy", () => {
  it("blocks ATTACH DATABASE and ATTACH", () => {
    expect(checkPolicy("ATTACH DATABASE 'x.db' AS x").blocked).toBe(true);
    expect(checkPolicy("attach 'x.db' as x").blocked).toBe(true);
    expect(checkPolicy("ATTACH DATABASE 'x.db' AS x").message).toMatch(/blocked/i);
  });

  it("blocks VACUUM INTO but allows bare VACUUM", () => {
    expect(checkPolicy("VACUUM INTO 'x.db'").blocked).toBe(true);
    expect(checkPolicy("VACUUM").blocked).toBe(false);
  });

  it("allows normal statements", () => {
    expect(checkPolicy("SELECT 1").blocked).toBe(false);
    expect(checkPolicy("CREATE TABLE t(a)").blocked).toBe(false);
    expect(checkPolicy("INSERT INTO t VALUES (1)").blocked).toBe(false);
  });

  it("sees through leading comments", () => {
    expect(checkPolicy("-- try attach\nATTACH DATABASE 'x' AS y").blocked).toBe(true);
  });
});
