import { describe, expect, it } from "vitest";
import { failOnThreshold, severityRank } from "../adversarial-audit.mjs";

// --fail-on is the opt-in merge gate. A level the gate cannot parse must not
// quietly become a different gate, and a finding whose severity differs only by
// case must not rank as "info".

describe("failOnThreshold", () => {
  it("maps the documented levels", () => {
    expect(failOnThreshold("none")).toBe(0);
    expect(failOnThreshold("high")).toBe(3);
    expect(failOnThreshold("critical")).toBe(4);
  });

  it("is case-insensitive", () => {
    expect(failOnThreshold("Critical")).toBe(4);
    expect(failOnThreshold("HIGH")).toBe(3);
  });

  it("rejects an unknown level instead of treating it as high", () => {
    expect(failOnThreshold("crit")).toBeNull();
    expect(failOnThreshold("medium")).toBeNull();
    expect(failOnThreshold("")).toBeNull();
  });
});

describe("severityRank", () => {
  it("ranks the documented severities", () => {
    expect(severityRank("critical")).toBe(4);
    expect(severityRank("high")).toBe(3);
    expect(severityRank("info")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(severityRank("Critical")).toBe(4);
    expect(severityRank("HIGH")).toBe(3);
  });

  it("ranks an unknown or missing severity as 0", () => {
    expect(severityRank("bogus")).toBe(0);
    expect(severityRank(undefined)).toBe(0);
  });
});
