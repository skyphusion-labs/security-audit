import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { collectPrPayload } from "../adversarial-audit.mjs";

// MAX_PR_FILES caps how many changed files are embedded in full. Files the audit
// skips (build output, lockfiles) must not spend that cap: a PR whose first
// changed paths sort into a skipped directory would otherwise leave its real
// source out of the payload while the run still looks green.

let repo;
const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "audit-prpayload-"));
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.invalid");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "base\n");
  g("add", ".");
  g("commit", "-q", "-m", "base");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("collectPrPayload file cap", () => {
  it("embeds a real source file that sorts after twelve skipped ones", () => {
    const base = g("rev-parse", "HEAD");
    mkdirSync(join(repo, "dist"));
    mkdirSync(join(repo, "src"));
    for (let i = 1; i <= 12; i++) writeFileSync(join(repo, "dist", `f${String(i).padStart(2, "0")}.js`), `built ${i}\n`);
    writeFileSync(join(repo, "src", "real.js"), "export const real = 1;\n");
    g("add", ".");
    g("commit", "-q", "-m", "change");
    const payload = collectPrPayload(repo, base, "HEAD");
    expect(payload).toContain("# File: src/real.js");
    expect(payload).not.toContain("# File: dist/");
  });

  it("still caps the number of embedded files (control)", () => {
    const base = g("rev-parse", "HEAD");
    mkdirSync(join(repo, "src"));
    for (let i = 1; i <= 15; i++) writeFileSync(join(repo, "src", `f${String(i).padStart(2, "0")}.js`), `x${i}\n`);
    g("add", ".");
    g("commit", "-q", "-m", "change");
    const payload = collectPrPayload(repo, base, "HEAD");
    expect(payload.match(/# File: src\//g)).toHaveLength(12);
  });
});
