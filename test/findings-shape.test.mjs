import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseAuditReply } from "../adversarial-audit.mjs";

// A model reply that parses as JSON but has lost its findings must not read as a clean
// audit. "The payload was unusable" and "nothing was found" are different answers; only
// the second may produce a report with no findings and let --fail-on pass.

const good = JSON.stringify({
  summary: "one issue",
  findings: [{ severity: "high", title: "t", file: "a.js", line: 1, detail: "d", exploit: "e", fix: "f" }],
});
const clean = JSON.stringify({ summary: "nothing found", findings: [] });

describe("parseAuditReply", () => {
  it("accepts a well-formed reply with findings (control)", () => {
    expect(parseAuditReply(good).findings).toHaveLength(1);
  });

  it("accepts an explicit empty findings array: that is a real clean answer (control)", () => {
    expect(parseAuditReply(clean).findings).toEqual([]);
  });

  it("keeps string findings, which the report writer already turns into info findings", () => {
    expect(parseAuditReply(JSON.stringify({ summary: "s", findings: ["a note"] })).findings).toEqual(["a note"]);
  });

  it.each([
    ["findings is a string", { summary: "s", findings: "none" }],
    ["findings is an object", { summary: "s", findings: {} }],
    ["findings is null", { summary: "s", findings: null }],
    ["findings is absent", { summary: "s" }],
    ["a finding is null", { summary: "s", findings: [null] }],
    ["a finding is a number", { summary: "s", findings: [3] }],
    ["a finding is an array", { summary: "s", findings: [[]] }],
  ])("rejects a reply where %s", (_name, body) => {
    expect(() => parseAuditReply(JSON.stringify(body))).toThrow(/findings/);
  });

  it.each([["null"], ["[]"], ["5"], ['"clean"']])("rejects a top-level %s", (text) => {
    expect(() => parseAuditReply(text)).toThrow(/JSON object/);
  });
});

describe("the CLI on a malformed findings payload", () => {
  const cli = resolve(import.meta.dirname, "../adversarial-audit.mjs");
  const fake = resolve(import.meta.dirname, "helpers/fake-model-fetch.mjs");
  let repo;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "audit-shape-"));
    writeFileSync(join(repo, "a.js"), "export const x = 1;\n", "utf8");
    const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    git("init", "-q");
    git("add", "a.js");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  function run(replies, extra = []) {
    const r = spawnSync(
      process.execPath,
      ["--import", fake, cli, "--mode", "repo", "--visibility", "private", "--repo-root", repo, ...extra],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_API_TOKEN: "test-token-value",
          FAKE_MODEL_REPLIES: JSON.stringify(replies),
        },
      },
    );
    return { code: r.status, out: r.stdout, err: r.stderr, calls: Number(/FAKE_FETCH_CALLS=(\d+)/.exec(r.stderr)?.[1]) };
  }

  it("a valid clean reply exits 0 with a report (control: the instrument can produce a pass)", () => {
    const r = run([clean], ["--fail-on", "high"]);
    expect(r.code).toBe(0);
    expect(r.calls).toBe(1);
    expect(JSON.parse(r.out).findings).toEqual([]);
  });

  it("a non-array findings reply retries compact, and if still malformed exits 2 with no report", () => {
    const bad = JSON.stringify({ summary: "s", findings: "none" });
    const r = run([bad, bad], ["--fail-on", "high"]);
    expect(r.calls).toBe(2);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/FATAL: .*findings/);
  });

  it("a malformed first reply followed by a good retry succeeds", () => {
    const r = run([JSON.stringify({ summary: "s", findings: null }), good]);
    expect(r.calls).toBe(2);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).findings).toHaveLength(1);
  });

  it("a malformed reply never reaches --fail-on as an empty list", () => {
    const bad = JSON.stringify({ summary: "s" });
    const r = run([bad, bad], ["--fail-on", "critical"]);
    expect(r.code).toBe(2);
  });
});
