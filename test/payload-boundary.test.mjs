import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readText,
  resolveVisibility,
  resolveModelRepo,
  gatewayAllowedForVisibility,
  isWorkersAiModel,
} from "../adversarial-audit.mjs";

// Two behaviors that the audit's usefulness and its data boundary rest on.
//
// 1. readText TRUNCATES an oversized file into the payload instead of dropping it.
//    A dropped file is invisible: the model reports no findings for code it never
//    saw, and the run still looks green. Truncating audits the first maxChars of it.
// 2. resolveVisibility answers "may this tree cross to the third-party provider",
//    and its fail-safe is PRIVATE. Repo mode ships the whole source tree to the
//    provider's own API, so an unknown answer must route on-shore, never egress.

let work;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "audit-payload-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  delete process.env.GITHUB_EVENT_PATH;
});

describe("readText", () => {
  it("returns a small file verbatim (control)", () => {
    const p = join(work, "small.ts");
    writeFileSync(p, "export const x = 1;\n", "utf8");
    expect(readText(p, 1000)).toBe("export const x = 1;\n");
  });

  it("TRUNCATES a file larger than the budget instead of dropping it", () => {
    const p = join(work, "big.ts");
    writeFileSync(p, "a".repeat(5000), "utf8");
    const out = readText(p, 100);
    expect(out, "an oversized file must reach the model truncated, never as null").not.toBeNull();
    expect(out).toContain("[truncated]");
    expect(out.length).toBeLessThan(5000);
  });

  it("still truncates when the file is far over the budget (no size cutoff at any multiple)", () => {
    const p = join(work, "huge.ts");
    writeFileSync(p, "b".repeat(200_000), "utf8");
    const out = readText(p, 1000);
    expect(out).not.toBeNull();
    expect(out).toContain("[truncated]");
  });

  it("returns null for a path that does not exist or is not a file", () => {
    expect(readText(join(work, "nope.ts"), 1000)).toBeNull();
    expect(readText(work, 1000)).toBeNull();
  });
});

describe("resolveVisibility", () => {
  it("takes an explicit flag first", async () => {
    expect(await resolveVisibility({ visibility: "public" })).toBe("public");
    expect(await resolveVisibility({ visibility: "PRIVATE" })).toBe("private");
    expect(await resolveVisibility({ visibility: "internal" })).toBe("internal");
  });

  it("reads the Actions event payload when no flag is given", async () => {
    const p = join(work, "event.json");
    writeFileSync(p, JSON.stringify({ repository: { visibility: "public" } }), "utf8");
    process.env.GITHUB_EVENT_PATH = p;
    expect(await resolveVisibility({})).toBe("public");
  });

  it("accepts the boolean private field some payloads carry instead", async () => {
    const p = join(work, "event-bool.json");
    writeFileSync(p, JSON.stringify({ repository: { private: true } }), "utf8");
    process.env.GITHUB_EVENT_PATH = p;
    expect(await resolveVisibility({})).toBe("private");

    const p2 = join(work, "event-bool-public.json");
    writeFileSync(p2, JSON.stringify({ repository: { private: false } }), "utf8");
    process.env.GITHUB_EVENT_PATH = p2;
    expect(await resolveVisibility({})).toBe("public");
  });

  it("FAIL-SAFES to private with no flag and no payload", async () => {
    expect(await resolveVisibility({})).toBe("private");
  });

  it("FAIL-SAFES to private when the payload is unreadable or says nothing", async () => {
    const bad = join(work, "bad.json");
    writeFileSync(bad, "{ not json", "utf8");
    process.env.GITHUB_EVENT_PATH = bad;
    expect(await resolveVisibility({})).toBe("private");

    const silent = join(work, "silent.json");
    writeFileSync(silent, JSON.stringify({ repository: {} }), "utf8");
    process.env.GITHUB_EVENT_PATH = silent;
    expect(await resolveVisibility({})).toBe("private");

    process.env.GITHUB_EVENT_PATH = join(work, "absent.json");
    expect(await resolveVisibility({})).toBe("private");
  });
});

describe("repo model routing (fc#1327)", () => {
  const prevAudit = process.env.AUDIT_MODEL_REPO;
  const prevModel = process.env.MODEL_REPO;

  afterEach(() => {
    if (prevAudit === undefined) delete process.env.AUDIT_MODEL_REPO;
    else process.env.AUDIT_MODEL_REPO = prevAudit;
    if (prevModel === undefined) delete process.env.MODEL_REPO;
    else process.env.MODEL_REPO = prevModel;
  });

  it("defaults to kimi-k3 for external users", () => {
    delete process.env.AUDIT_MODEL_REPO;
    delete process.env.MODEL_REPO;
    expect(resolveModelRepo({})).toBe("moonshotai/kimi-k3");
  });

  it("flag wins over env", () => {
    process.env.AUDIT_MODEL_REPO = "moonshotai/kimi-k3";
    expect(resolveModelRepo({ "model-repo": "anthropic/claude-opus-5" })).toBe(
      "anthropic/claude-opus-5",
    );
  });

  it("env wins over package default", () => {
    delete process.env.MODEL_REPO;
    process.env.AUDIT_MODEL_REPO = "anthropic/claude-opus-5";
    expect(resolveModelRepo({})).toBe("anthropic/claude-opus-5");
  });

  it("Moonshot gateway is public-only; Anthropic is allowed for private", () => {
    expect(gatewayAllowedForVisibility("moonshotai/kimi-k3", "public")).toBe(true);
    expect(gatewayAllowedForVisibility("moonshotai/kimi-k3", "private")).toBe(false);
    expect(gatewayAllowedForVisibility("moonshotai/kimi-k3", "internal")).toBe(false);
    expect(gatewayAllowedForVisibility("anthropic/claude-opus-5", "public")).toBe(true);
    expect(gatewayAllowedForVisibility("anthropic/claude-opus-5", "private")).toBe(true);
    expect(gatewayAllowedForVisibility("anthropic/claude-opus-5", "internal")).toBe(true);
  });

  it("unknown third-party prefixes fail-safe to public-only", () => {
    expect(gatewayAllowedForVisibility("openai/gpt-4o", "private")).toBe(false);
    expect(gatewayAllowedForVisibility("openai/gpt-4o", "public")).toBe(true);
  });

  it("Workers AI models are on-shore", () => {
    expect(isWorkersAiModel("@cf/moonshotai/kimi-k2.7-code")).toBe(true);
    expect(isWorkersAiModel("moonshotai/kimi-k3")).toBe(false);
    expect(gatewayAllowedForVisibility("@cf/moonshotai/kimi-k2.7-code", "private")).toBe(true);
  });
});
