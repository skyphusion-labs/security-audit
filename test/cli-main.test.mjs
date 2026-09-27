import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseAuditReply } from "../adversarial-audit.mjs";

// Drives the real main() in-process (v8 coverage cannot see a spawned CLI). Only the model
// call (fetch) is scripted, the same seam test/helpers/fake-model-fetch.mjs uses for the
// subprocess tests; argument parsing, base/head resolution, payload collection, request
// building, retry, report formatting and the --fail-on exit all run for real. process.exit is
// intercepted only so a test can read the code the CLI would have exited with.
//
// Deliberately NOT pinned here (open decisions, see the PR body): what an empty diff reports
// (#34), GITHUB_BASE_REF resolution and the origin/main -> main fallback (#35), repo-mode
// file ordering, the byte budget and its omission marker, and whether json/yaml are source
// (#36), and what `--model-repo @cf/...` does (#37).

class Exit extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

const CLEAN = JSON.stringify({ summary: "nothing found", findings: [] });
const finding = (severity, extra = {}) => ({
  severity,
  title: `t-${severity}`,
  file: "src/a.js",
  line: 3,
  detail: "d",
  exploit: "e",
  fix: "f",
  ...extra,
});
const reply = (summary, findings) => JSON.stringify({ summary, findings });
const USAGE = { prompt_tokens: 3, completion_tokens: 4 };
const SECRET = "ghp_1234567890123456789012345678901234";

// Every env var main() or its helpers read, pinned so the host environment cannot leak in.
const BASE_ENV = {
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_API_TOKEN: "api-value",
  CF_AIG_TOKEN: "aig-value",
  AI_GATEWAY_ID: undefined,
  AUDIT_MODEL_REPO: undefined,
  MODEL_REPO: undefined,
  GITHUB_BASE_SHA: undefined,
  GITHUB_BASE_REF: undefined,
  GITHUB_SHA: undefined,
  GITHUB_EVENT_PATH: undefined,
};

/**
 * Each reply is a string (message content, wrapped in the envelope the URL implies) or
 * { status, json } / { status, text } for a raw HTTP answer. The last reply repeats.
 */
function makeFetch(replies, calls) {
  let i = 0;
  return async (url, init) => {
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    if (typeof r === "object") {
      const text = "text" in r ? r.text : JSON.stringify(r.json);
      return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
    }
    const choices = [{ message: { content: r } }];
    const body = String(url).includes("/ai/run/")
      ? { success: true, result: { choices, usage: USAGE } }
      : { choices, usage: USAGE };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function run(argv, { replies = [CLEAN], env = {} } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  vi.stubGlobal("fetch", makeFetch(replies, calls));
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(console, "error").mockImplementation((...a) => err.push(a.join(" ")));
  vi.spyOn(process, "exit").mockImplementation((c) => {
    throw new Exit(c ?? 0);
  });
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...env })) vi.stubEnv(k, v);
  let code = 0;
  let thrown;
  try {
    await main(argv);
  } catch (e) {
    if (e instanceof Exit) code = e.code;
    else {
      code = "threw";
      thrown = e;
    }
  }
  const stdout = out.join("");
  return {
    code,
    thrown,
    calls,
    stdout,
    stderr: err.join("\n"),
    report: stdout.trim().startsWith("{") ? JSON.parse(stdout) : undefined,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

let work;
let repo;
let first;
let second;
const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "audit-cli-main-"));
  repo = join(work, "repo");
  mkdirSync(repo);
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.invalid");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "dist"));
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(join(repo, "src", "b.js"), "export const b = 2;\n");
  writeFileSync(join(repo, "dist", "built.js"), "export const built = 3;\n");
  writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "export const dep = 4;\n");
  writeFileSync(join(repo, "logo.png"), "not really a png\n");
  writeFileSync(join(repo, "README.md"), "readme context marker\n");
  g("add", ".");
  g("commit", "-q", "-m", "one");
  first = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "src", "a.js"), `export const a = 1;\nexport const token = "${SECRET}";\n`);
  writeFileSync(join(repo, "SECURITY.md"), "security policy marker\n");
  g("add", ".");
  g("commit", "-q", "-m", "two");
  second = g("rev-parse", "HEAD");
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

const pr = (...extra) => ["--mode", "pr", "--repo-root", repo, "--base", first, ...extra];
const repoMode = (...extra) => ["--mode", "repo", "--repo-root", repo, ...extra];

describe("argument parsing", () => {
  it("--help prints usage and exits 0 without calling the model", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("usage: adversarial-audit.mjs");
    expect(r.calls).toHaveLength(0);
  });

  it.each([
    ["an unknown flag", ["--mode", "pr", "--bogus", "x"]],
    ["a flag with no value", ["--mode", "pr", "--base"]],
    ["a flag whose value is another flag", ["--mode", "--repo-root"]],
    ["an unknown mode", ["--mode", "both"]],
    ["an unknown --fail-on level", ["--mode", "pr", "--fail-on", "medium"]],
    ["a non-integer --max-output-tokens", ["--mode", "pr", "--max-output-tokens", "abc"]],
    ["an unknown --visibility", ["--mode", "repo", "--visibility", "secret"]],
  ])("rejects %s with usage and exit 1, before any model call", async (_name, argv) => {
    const r = await run(argv);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage:");
    expect(r.calls).toHaveLength(0);
  });

  it("ignores a stray positional argument", async () => {
    const r = await run(["stray", ...pr()]);
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
  });
});

describe("preflight (missing credentials exit 2 before any model call)", () => {
  it("needs CLOUDFLARE_ACCOUNT_ID", async () => {
    const r = await run(pr(), { env: { CLOUDFLARE_ACCOUNT_ID: undefined } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("FATAL: CLOUDFLARE_ACCOUNT_ID is required");
    expect(r.calls).toHaveLength(0);
  });

  it("pr mode needs CLOUDFLARE_API_TOKEN even when a gateway token is set", async () => {
    const r = await run(pr(), { env: { CLOUDFLARE_API_TOKEN: undefined } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("CLOUDFLARE_API_TOKEN is required");
    expect(r.calls).toHaveLength(0);
  });

  it("repo mode on a gateway model needs CF_AIG_TOKEN", async () => {
    const r = await run(repoMode("--visibility", "public"), { env: { CF_AIG_TOKEN: undefined } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("CF_AIG_TOKEN is required");
    expect(r.calls).toHaveLength(0);
  });

  it("repo mode routed on-shore by the data boundary needs CLOUDFLARE_API_TOKEN, not CF_AIG_TOKEN", async () => {
    const r = await run(repoMode("--visibility", "private"), { env: { CLOUDFLARE_API_TOKEN: undefined } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("CLOUDFLARE_API_TOKEN is required");
    expect(r.calls).toHaveLength(0);
  });
});

describe("the data boundary at the request", () => {
  it("a private repo with a non-Anthropic gateway model goes to K2.7 on Workers AI, never the gateway", async () => {
    const r = await run(repoMode("--visibility", "private", "--model-repo", "moonshotai/kimi-k3"));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("DATA BOUNDARY");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toContain("https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/moonshotai/kimi-k2.7-code");
    expect(r.calls.some((c) => new URL(c.url).hostname === "gateway.ai.cloudflare.com")).toBe(false);
    expect(r.report.model).toBe("@cf/moonshotai/kimi-k2.7-code");
  });

  it("a private repo may use an anthropic/ gateway model (control: the gateway path is reachable)", async () => {
    const r = await run(repoMode("--visibility", "private", "--model-repo", "anthropic/claude-opus-5"));
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("DATA BOUNDARY");
    expect(new URL(r.calls[0].url).hostname).toBe("gateway.ai.cloudflare.com");
    expect(r.report.model).toBe("anthropic/claude-opus-5");
  });

  it("an unknown visibility is treated as private: the tree stays on-shore", async () => {
    const r = await run(repoMode());
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("visibility=private");
    expect(r.calls[0].url).toContain("/ai/run/");
  });
});

describe("the K2.7 Workers AI request (pr mode)", () => {
  it("sends account, token, gateway id, token budget and the diff", async () => {
    const r = await run(pr(), { env: { AI_GATEWAY_ID: "gw-1" } });
    expect(r.code).toBe(0);
    const [call] = r.calls;
    expect(call.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/moonshotai/kimi-k2.7-code");
    expect(call.headers.Authorization).toBe("Bearer api-value");
    expect(call.headers["cf-aig-gateway-id"]).toBe("gw-1");
    expect(call.body.max_tokens).toBe(2500);
    expect(call.body.response_format).toEqual({ type: "json_object" });
    expect(call.body.messages[0].role).toBe("system");
    expect(call.body.messages[1].content).toContain("# Git diff (");
    expect(call.body.messages[1].content).toContain("# File: src/a.js");
    expect(call.body.messages[1].content).toContain("# Context: SECURITY.md");
  });

  it("honors --max-output-tokens", async () => {
    const r = await run(pr("--max-output-tokens", "4096"));
    expect(r.calls[0].body.max_tokens).toBe(4096);
  });

  it("uses the default gateway id when AI_GATEWAY_ID is unset", async () => {
    const r = await run(pr());
    expect(r.calls[0].headers["cf-aig-gateway-id"]).toBe("your-gateway-id");
    expect(r.report.gateway).toBe("your-gateway-id");
  });

  it("redacts a secret out of the payload before it leaves (control: the surrounding code IS sent)", async () => {
    const r = await run(pr());
    const sent = r.calls[0].body.messages[1].content;
    expect(sent).toContain("export const token");
    expect(sent).not.toContain(SECRET);
  });
});

describe("the AI Gateway request (repo mode)", () => {
  it("posts to the compat endpoint with the AIG token, the model and the repo-mode budget", async () => {
    const r = await run(repoMode("--visibility", "public"), { env: { AI_GATEWAY_ID: "gw-2" } });
    expect(r.code).toBe(0);
    const [call] = r.calls;
    expect(call.url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw-2/compat/chat/completions");
    expect(call.headers["cf-aig-authorization"]).toBe("Bearer aig-value");
    expect(call.body.model).toBe("moonshotai/kimi-k3");
    expect(call.body.max_tokens).toBe(8000);
    expect(call.body.response_format).toEqual({ type: "json_object" });
    expect(r.report.model).toBe("moonshotai/kimi-k3");
    expect(r.report.usage).toEqual(USAGE);
  });

  it("asks Kimi models for low reasoning effort and does not send it to other providers", async () => {
    const kimi = await run(repoMode("--visibility", "public"));
    expect(kimi.calls[0].body.reasoning_effort).toBe("low");
    const opus = await run(repoMode("--visibility", "public", "--model-repo", "anthropic/claude-opus-5"));
    expect(opus.calls[0].body).not.toHaveProperty("reasoning_effort");
  });

  it("takes the model from AUDIT_MODEL_REPO, and --model-repo overrides it", async () => {
    const env = { AUDIT_MODEL_REPO: "anthropic/claude-opus-5" };
    const fromEnv = await run(repoMode("--visibility", "public"), { env });
    expect(fromEnv.report.model).toBe("anthropic/claude-opus-5");
    const fromFlag = await run(repoMode("--visibility", "public", "--model-repo", "moonshotai/kimi-k3"), { env });
    expect(fromFlag.report.model).toBe("moonshotai/kimi-k3");
  });

  it("puts tracked source and context in the payload and leaves build output, vendored code and binaries out", async () => {
    const r = await run(repoMode("--visibility", "public"));
    const sent = r.calls[0].body.messages[1].content;
    expect(sent).toContain("# Repository source audit");
    expect(sent).toContain("# File: src/a.js");
    expect(sent).toContain("# File: src/b.js");
    expect(sent).toContain("# Context: README.md");
    expect(sent).toContain("# Context: SECURITY.md");
    expect(sent).not.toContain("dist/built.js");
    expect(sent).not.toContain("node_modules/pkg");
    expect(sent).not.toContain("logo.png");
    expect(sent).not.toContain(SECRET);
  });
});

describe("model call failures", () => {
  const AIG = () => repoMode("--visibility", "public");

  it("K2.7 HTTP error is fatal with the status and no retry", async () => {
    const r = await run(pr(), { replies: [{ status: 401, json: { success: false, errors: ["nope"] } }] });
    expect(r.code).toBe("threw");
    expect(r.thrown.message).toMatch(/^K2\.7 Code 401/);
    expect(r.calls).toHaveLength(1);
  });

  it("K2.7 success:false on a 200 is still an error", async () => {
    const r = await run(pr(), { replies: [{ status: 200, json: { success: false } }] });
    expect(r.thrown.message).toMatch(/^K2\.7 Code 200/);
  });

  it("gateway non-JSON body is an error naming the model and status", async () => {
    const r = await run(AIG(), { replies: [{ status: 502, text: "<html>bad gateway</html>" }] });
    expect(r.thrown.message).toContain("Gateway moonshotai/kimi-k3 502 non-JSON");
  });

  it("gateway HTTP error is an error naming the model and status", async () => {
    const r = await run(AIG(), { replies: [{ status: 500, json: { error: "boom" } }] });
    expect(r.thrown.message).toMatch(/^Gateway moonshotai\/kimi-k3 500/);
    expect(r.calls).toHaveLength(1);
  });

  it("a 200 with no message is an unexpected-shape error", async () => {
    const r = await run(pr(), { replies: [{ status: 200, json: { success: true, result: { choices: [] } } }] });
    expect(r.thrown.message).toMatch(/^unexpected model response shape/);
  });

  it("a reasoning-only reply with empty content is an error, not a clean audit", async () => {
    const r = await run(pr(), { replies: ["   "] });
    expect(r.code).toBe("threw");
    expect(r.thrown.message).toContain("empty content");
    expect(r.stdout).toBe("");
  });
});

describe("compact retry", () => {
  it("re-asks with the original messages plus a repair instruction, and uses the retry's answer", async () => {
    const r = await run(pr(), { replies: ["I cannot help with that", reply("fixed", [finding("low")])] });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("retrying compact");
    expect(r.calls).toHaveLength(2);
    const [a, b] = r.calls.map((c) => c.body.messages);
    expect(b).toHaveLength(a.length + 1);
    expect(b.at(-1).content).toContain("VALID JSON only");
    expect(r.report.summary).toBe("fixed");
  });

  it("retries on the gateway path with the same model and endpoint", async () => {
    const r = await run(repoMode("--visibility", "public"), { replies: ["not json", CLEAN] });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1].url).toBe(r.calls[0].url);
    expect(r.calls[1].body.model).toBe("moonshotai/kimi-k3");
  });

  it("a second unparseable reply is fatal: no report, no fail-on pass", async () => {
    const r = await run(pr("--fail-on", "high"), { replies: ["nope", "still nope"] });
    expect(r.code).toBe("threw");
    expect(r.thrown.message).toContain("model did not return JSON");
    expect(r.calls).toHaveLength(2);
    expect(r.stdout).toBe("");
  });
});

describe("parseAuditReply JSON extraction", () => {
  const body = { summary: "s", findings: [] };

  it("reads a fenced block, with or without the json tag", () => {
    expect(parseAuditReply("Here you go:\n```json\n" + JSON.stringify(body) + "\n```\nbye")).toEqual(body);
    expect(parseAuditReply("```\n" + JSON.stringify(body) + "\n```")).toEqual(body);
  });

  it("reads a summary object embedded in prose", () => {
    expect(parseAuditReply(`Sure. ${JSON.stringify(body)} Hope that helps.`)).toEqual(body);
  });

  it("finds a findings object that does not start with summary", () => {
    const only = { findings: [finding("low")] };
    expect(parseAuditReply(`Result: ${JSON.stringify(only)} done`)).toEqual(only);
  });

  it("falls past a summary-shaped span that is not valid JSON to a later valid object", () => {
    const text = `{"summary": broken ... } then ${JSON.stringify(body)}`;
    expect(parseAuditReply(text)).toEqual(body);
  });

  it("names the failure and quotes the reply when there is no JSON at all", () => {
    expect(() => parseAuditReply("plain text, no braces")).toThrow(/^model did not return JSON: plain text/);
  });
});

describe("the report", () => {
  it("json output carries mode, model, gateway, resolved base and head, an ISO timestamp, summary, findings, usage", async () => {
    const f = finding("medium");
    const r = await run(pr(), { replies: [reply("one issue", [f])] });
    expect(r.code).toBe(0);
    expect(r.report).toMatchObject({
      mode: "pr",
      model: "@cf/moonshotai/kimi-k2.7-code",
      gateway: "your-gateway-id",
      base: first,
      head: second,
      summary: "one issue",
      findings: [f],
      usage: USAGE,
    });
    expect(new Date(r.report.generated_at).toISOString()).toBe(r.report.generated_at);
  });

  it("repo mode records no base or head", async () => {
    const r = await run(repoMode("--visibility", "public"));
    expect(r.report).not.toHaveProperty("base");
    expect(r.report).not.toHaveProperty("head");
  });

  it("turns a string finding into an info finding, and a missing summary into an empty one", async () => {
    const r = await run(pr(), { replies: [JSON.stringify({ findings: ["a loose note"] })] });
    expect(r.report.summary).toBe("");
    expect(r.report.findings).toEqual([
      { severity: "info", title: "a loose note", file: "unknown", line: 0, detail: "a loose note", exploit: "", fix: "" },
    ]);
  });

  it("markdown output names the audited range in short shas and lists each finding by location", async () => {
    const findings = [
      finding("high", { file: "src/a.js", line: 3, title: "T1", detail: "D1" }),
      finding("low", { file: "src/b.js", line: 0, title: "T2", detail: "D2" }),
      finding("info", { file: "", title: "T3", detail: "D3" }),
    ];
    const r = await run(pr("--output", "markdown"), { replies: [reply("three", findings)] });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("## Adversarial security audit");
    expect(r.stdout).toContain(`\`${first.slice(0, 7)}...${second.slice(0, 7)}\``);
    expect(r.stdout).toContain("| Severity | Location | Finding |");
    expect(r.stdout).toContain("| high | src/a.js:3 | T1: D1 |");
    expect(r.stdout).toContain("| low | src/b.js | T2: D2 |");
    expect(r.stdout).toContain("| info | unknown | T3: D3 |");
  });

  it("markdown output for a clean audit says so, and shows no range in repo mode", async () => {
    const r = await run(repoMode("--visibility", "public", "--output", "markdown"), {
      replies: [JSON.stringify({ findings: [] })],
    });
    expect(r.stdout).toContain("(no summary)");
    expect(r.stdout).toContain("| - | - | No findings |");
    expect(r.stdout).toMatch(/_Generated \d{4}-\d\d-\d\dT[^ ]+_\n/);
    expect(r.stdout).not.toContain("...");
  });

  it("--out-file gets the formatted stdout and --md-file gets markdown even when stdout is json", async () => {
    const outFile = join(work, "report.json");
    const mdFile = join(work, "report.md");
    const r = await run(pr("--out-file", outFile, "--md-file", mdFile), { replies: [reply("s", [finding("low")])] });
    expect(r.code).toBe(0);
    expect(readFileSync(outFile, "utf8")).toBe(r.stdout);
    expect(JSON.parse(readFileSync(outFile, "utf8")).summary).toBe("s");
    const md = readFileSync(mdFile, "utf8");
    expect(md).toContain("## Adversarial security audit");
    expect(md).toContain("| low | src/a.js:3 |");
  });
});

describe("base and head resolution (explicit inputs only)", () => {
  it("--base is used as given and --head selects the audited commit", async () => {
    const r = await run(["--mode", "pr", "--repo-root", repo, "--base", first, "--head", second]);
    expect(r.report.base).toBe(first);
    expect(r.report.head).toBe(second);
    expect(r.calls[0].body.messages[1].content).toContain(`# Git diff (${first}...${second})`);
  });

  it("GITHUB_BASE_SHA is the base when --base is absent", async () => {
    const r = await run(["--mode", "pr", "--repo-root", repo], { env: { GITHUB_BASE_SHA: first } });
    expect(r.report.base).toBe(first);
    expect(r.report.head).toBe(second);
  });

  it("--base wins over GITHUB_BASE_SHA", async () => {
    const r = await run(["--mode", "pr", "--repo-root", repo, "--base", first], {
      env: { GITHUB_BASE_SHA: second },
    });
    expect(r.report.base).toBe(first);
  });
});

describe("--fail-on exit", () => {
  it.each([
    { name: "high finding at --fail-on high", severity: "high", level: "high", expected: 1 },
    { name: "critical finding at --fail-on high", severity: "critical", level: "high", expected: 1 },
    { name: "critical finding at --fail-on critical", severity: "critical", level: "critical", expected: 1 },
    { name: "upper-case severity at --fail-on high", severity: "HIGH", level: "high", expected: 1 },
    { name: "high finding at --fail-on critical", severity: "high", level: "critical", expected: 0 },
    { name: "medium finding at --fail-on high", severity: "medium", level: "high", expected: 0 },
    { name: "unknown severity at --fail-on high", severity: "bogus", level: "high", expected: 0 },
    { name: "critical finding at --fail-on none", severity: "critical", level: "none", expected: 0 },
  ])("$name exits $expected", async ({ severity, level, expected }) => {
    const r = await run(pr("--fail-on", level), { replies: [reply("s", [finding(severity)])] });
    expect(r.code).toBe(expected);
    // The report is written whether or not the gate trips.
    expect(r.report.findings).toHaveLength(1);
  });

  it("defaults to advisory: a critical finding does not fail without the flag", async () => {
    const r = await run(pr(), { replies: [reply("s", [finding("critical")])] });
    expect(r.code).toBe(0);
  });

  it("the worst finding decides, not the first", async () => {
    const r = await run(pr("--fail-on", "high"), {
      replies: [reply("s", [finding("low"), finding("info"), finding("high")])],
    });
    expect(r.code).toBe(1);
  });

  it("a clean audit passes the gate (control: the gate can pass)", async () => {
    const r = await run(pr("--fail-on", "critical"));
    expect(r.code).toBe(0);
  });

  it("a string finding is info and never trips the gate", async () => {
    const r = await run(pr("--fail-on", "high"), { replies: [JSON.stringify({ summary: "s", findings: ["note"] })] });
    expect(r.code).toBe(0);
  });
});

describe("payload edge cases (pr mode)", () => {
  let edge;
  let base;
  const e = (...a) => execFileSync("git", ["-C", edge, ...a], { encoding: "utf8" }).trim();

  beforeAll(() => {
    edge = join(work, "edge");
    mkdirSync(edge);
    e("init", "-q", "-b", "main");
    e("config", "user.email", "t@example.invalid");
    e("config", "user.name", "t");
    e("config", "commit.gpgsign", "false");
    writeFileSync(join(edge, "README.md"), "base\n");
    e("add", ".");
    e("commit", "-q", "-m", "base");
    base = e("rev-parse", "HEAD");
    mkdirSync(join(edge, "src"));
    writeFileSync(join(edge, "src", "big.js"), `${"x".repeat(200_000)}\n`);
    writeFileSync(join(edge, "src", "blob.js"), "head\0tail\n");
    e("add", ".");
    e("commit", "-q", "-m", "change");
  });

  it("marks a diff over the cap as truncated instead of sending all of it", async () => {
    const r = await run(["--mode", "pr", "--repo-root", edge, "--base", base]);
    const sent = r.calls[0].body.messages[1].content;
    expect(sent).toContain("...[diff truncated]");
    expect(sent.length).toBeLessThan(200_000);
  });

  it("does not embed a file with a NUL byte (binary) in the payload", async () => {
    const r = await run(["--mode", "pr", "--repo-root", edge, "--base", base]);
    expect(r.calls[0].body.messages[1].content).not.toContain("# File: src/blob.js");
  });
});
