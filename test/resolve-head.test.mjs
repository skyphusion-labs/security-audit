import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveHeadSha } from "../adversarial-audit.mjs";

// The report records which commit was audited. When --head selects the audited
// commit, the report must name that commit, not whatever GITHUB_SHA says the
// workflow ran on.

let repo;
let first;
let second;
const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "audit-head-"));
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.invalid");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "1\n");
  g("add", ".");
  g("commit", "-q", "-m", "one");
  first = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "a.txt"), "2\n");
  g("commit", "-q", "-am", "two");
  second = g("rev-parse", "HEAD");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  delete process.env.GITHUB_SHA;
});

describe("resolveHeadSha", () => {
  it("resolves --head to the commit that is audited, even when GITHUB_SHA is set", () => {
    process.env.GITHUB_SHA = second;
    expect(resolveHeadSha(repo, first)).toBe(first);
  });

  it("resolves a symbolic --head to its commit", () => {
    expect(resolveHeadSha(repo, "HEAD~1")).toBe(first);
  });

  it("uses GITHUB_SHA when no --head is given (control)", () => {
    process.env.GITHUB_SHA = first;
    expect(resolveHeadSha(repo, undefined)).toBe(first);
  });

  it("falls back to HEAD with neither", () => {
    expect(resolveHeadSha(repo, undefined)).toBe(second);
  });
});
