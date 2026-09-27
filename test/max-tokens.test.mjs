import { describe, expect, it } from "vitest";
import { resolveMaxTokens } from "../adversarial-audit.mjs";

// --max-output-tokens feeds the model request directly. A non-numeric value used
// to become NaN and be sent as such.

describe("resolveMaxTokens", () => {
  it("defaults to 2500 in pr mode and 8000 in repo mode", () => {
    expect(resolveMaxTokens(undefined, "pr")).toBe(2500);
    expect(resolveMaxTokens(undefined, "repo")).toBe(8000);
  });

  it("accepts a positive integer", () => {
    expect(resolveMaxTokens("4096", "pr")).toBe(4096);
  });

  it("rejects a non-numeric, non-integer, zero or negative value", () => {
    for (const bad of ["abc", "12.5", "0", "-5", "1e3x"]) {
      expect(resolveMaxTokens(bad, "pr")).toBeNull();
    }
  });
});
