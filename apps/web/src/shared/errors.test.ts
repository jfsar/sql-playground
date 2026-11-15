import { describe, expect, it } from "vitest";
import { DB_ERROR_CODES, DbOperationError, describeDbError } from "./errors";

describe("error model (NFR-07)", () => {
  it("provides title, message, and next step for every DbError code", () => {
    for (const code of DB_ERROR_CODES) {
      const guidance = describeDbError(code);
      expect(guidance.title.length, code).toBeGreaterThan(0);
      expect(guidance.message.length, code).toBeGreaterThan(0);
      expect(guidance.nextStep.length, code).toBeGreaterThan(0);
    }
  });

  it("prefers the source error message as the user-facing message", () => {
    const guidance = describeDbError("SQL_ERROR", "no such column: foo");
    expect(guidance.message).toBe("no such column: foo");
    expect(guidance.title).toBe("SQL error");
    expect(guidance.nextStep.length).toBeGreaterThan(0);
  });

  it("falls back to the default message when detail is blank", () => {
    expect(describeDbError("QUOTA", "   ").message).toContain("not enough browser storage");
  });

  it("DbOperationError carries the code and default message", () => {
    const err = new DbOperationError("STORAGE_UNAVAILABLE");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DbOperationError");
    expect(err.code).toBe("STORAGE_UNAVAILABLE");
    expect(err.message).toBe(describeDbError("STORAGE_UNAVAILABLE").message);
  });
});
