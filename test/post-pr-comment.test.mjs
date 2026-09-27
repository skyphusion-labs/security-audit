import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// post-pr-comment.sh drives the `gh` CLI. This test puts a small `gh` on PATH that
// serves a PR comment list in two pages (as the REST API does at 30 per page) and
// honours --paginate and --jq exactly as far as the script uses them; it records
// every mutating call. jq itself is the real one, so the script's own filter runs.

const SCRIPT = resolve(import.meta.dirname, "..", "post-pr-comment.sh");
const MARKER = "<!-- adversarial-audit -->";

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
log="$FAKE_GH_LOG"
if [[ "$1" == "pr" && "$2" == "comment" ]]; then echo "PR_COMMENT_CREATED" >> "$log"; exit 0; fi
if [[ "$1" == "api" ]]; then
  method=GET; paginate=0; jqf=""; url=""
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -X) method="$2"; shift 2;;
      --paginate) paginate=1; shift;;
      --jq) jqf="$2"; shift 2;;
      --input) cat >/dev/null; shift 2;;
      *) url="$1"; shift;;
    esac
  done
  if [[ "$method" == "PATCH" ]]; then echo "PATCH $url" >> "$log"; exit 0; fi
  if [[ -n "\${FAKE_GH_FAIL:-}" ]]; then echo "gh: HTTP 502" >&2; exit 1; fi
  if [[ "$paginate" == 1 ]]; then pages="$FAKE_PAGE1 $FAKE_PAGE2"; else pages="$FAKE_PAGE1"; fi
  for f in $pages; do jq -r "$jqf" "$f"; done
  exit 0
fi
exit 1
`;

let work;

function makePage(path, comments) {
  writeFileSync(path, JSON.stringify(comments));
}

function run(env = {}) {
  return spawnSync("bash", [SCRIPT, "7", "report.md"], {
    cwd: work,
    env: {
      PATH: `${join(work, "bin")}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "o/r",
      GH_TOKEN: "unused",
      FAKE_GH_LOG: join(work, "gh.log"),
      FAKE_PAGE1: join(work, "p1.json"),
      FAKE_PAGE2: join(work, "p2.json"),
      ...env,
    },
    encoding: "utf8",
  });
}

const log = () => (existsSync(join(work, "gh.log")) ? readFileSync(join(work, "gh.log"), "utf8") : "");

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "audit-comment-"));
  mkdirSync(join(work, "bin"));
  writeFileSync(join(work, "bin", "gh"), FAKE_GH);
  chmodSync(join(work, "bin", "gh"), 0o755);
  writeFileSync(join(work, "report.md"), "report body\n");
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const other = (id) => ({ id, user: { login: "someone" }, body: "hi" });
const ours = (id) => ({ id, user: { login: "github-actions[bot]" }, body: `${MARKER}\n\nold report` });

describe("post-pr-comment.sh upsert", () => {
  it("updates our comment when it is on the first page (control)", () => {
    makePage(join(work, "p1.json"), [other(1), ours(100)]);
    makePage(join(work, "p2.json"), []);
    const r = run();
    expect(r.status).toBe(0);
    expect(log()).toContain("PATCH repos/o/r/issues/comments/100");
    expect(log()).not.toContain("PR_COMMENT_CREATED");
  });

  it("finds our comment on a later page instead of posting a duplicate", () => {
    makePage(join(work, "p1.json"), Array.from({ length: 30 }, (_, i) => other(i + 1)));
    makePage(join(work, "p2.json"), [ours(900)]);
    const r = run();
    expect(r.status).toBe(0);
    expect(log()).toContain("PATCH repos/o/r/issues/comments/900");
    expect(log()).not.toContain("PR_COMMENT_CREATED");
  });

  it("creates the comment when none exists", () => {
    makePage(join(work, "p1.json"), [other(1)]);
    makePage(join(work, "p2.json"), []);
    const r = run();
    expect(r.status).toBe(0);
    expect(log()).toContain("PR_COMMENT_CREATED");
  });

  it("fails loudly when the comment list cannot be read, and posts nothing", () => {
    makePage(join(work, "p1.json"), []);
    makePage(join(work, "p2.json"), []);
    const r = run({ FAKE_GH_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(log()).not.toContain("PR_COMMENT_CREATED");
    expect(log()).not.toContain("PATCH");
  });
});
