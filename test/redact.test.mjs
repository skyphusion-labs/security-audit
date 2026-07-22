import { describe, expect, it } from "vitest";
import { redactSecrets } from "../redact.mjs";

describe("redactSecrets", () => {
  it("redacts GitHub PATs", () => {
    const out = redactSecrets("auth ghp_1234567890123456789012345678901234");
    expect(out).not.toContain("ghp_1234");
    expect(out).toContain("[REDACTED_GH_PAT]");
  });

  it("redacts bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456");
    expect(out).toContain("Bearer [REDACTED]");
  });

  it("redacts secret assignments", () => {
    const out = redactSecrets("API_TOKEN=super-secret-value-here");
    expect(out).toBe("API_TOKEN=[REDACTED]");
  });

  it("leaves benign text unchanged", () => {
    const text = "export function hello() { return 1; }";
    expect(redactSecrets(text)).toBe(text);
  });
});
