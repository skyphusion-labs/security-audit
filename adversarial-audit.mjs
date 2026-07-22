#!/usr/bin/env node
/**
 * Adversarial security audit via Cloudflare Workers AI + AI Gateway.
 *
 * Modes:
 *   pr   -- @cf/moonshotai/kimi-k2.7-code on merge-base diff (every PR / push)
 *   repo -- moonshotai/kimi-k3 on tracked source tree (scheduled deep audit)
 *
 * Required env:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CF_AIG_TOKEN            (repo mode / Kimi K3)
 *   CLOUDFLARE_API_TOKEN    (pr mode / @cf K2.7 Code on /ai/run)
 * Optional env:
 *   AI_GATEWAY_ID (default: your-gateway-id)
 *
 * Usage:
 *   node adversarial-audit.mjs --mode pr [--base SHA] [--head SHA]
 *   node adversarial-audit.mjs --mode repo
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "./redact.mjs";

const MODEL_PR = "@cf/moonshotai/kimi-k2.7-code";
const MODEL_REPO = "moonshotai/kimi-k3";

const MAX_DIFF_CHARS = 150_000;
const MAX_FILE_CHARS = 30_000;
const MAX_PR_FILES = 12;
const MAX_REPO_CHARS = 250_000;

const SOURCE_GLOBS = [
  /^src\//,
  /^lib\//,
  /^workers\//,
  /^packages\//,
  /^cmd\//,
  /^internal\//,
  /^api\//,
  /^app\//,
  /\.github\/workflows\//,
  /^wrangler\.(toml|jsonc?)$/,
  /^Dockerfile$/,
  /^docker-compose\.ya?ml$/,
  /^go\.mod$/,
  /^package\.json$/,
  /^pyproject\.toml$/,
  /^Cargo\.toml$/,
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|sql|sh|yaml|yml|toml|json)$/i,
];

const SKIP_PATH = [
  /^node_modules\//,
  /^vendor\//,
  /^dist\//,
  /^build\//,
  /^coverage\//,
  /^\.git\//,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.min\./,
  /\.map$/,
  /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip|tar|gz|mp4|mp3|wav)$/i,
  /^work_product\//,
  /age-encrypted/,
];

const SYSTEM_PROMPT = `You are an adversarial application-security auditor.
Find real, exploitable issues in the supplied code and configuration. Be skeptical and concrete.
Do not invent findings. Do not report style or theoretical issues without a plausible exploit path.
Return strict JSON only (no markdown fences):
{
  "summary": "one sentence (max 200 chars)",
  "findings": [
    {
      "severity": "critical|high|medium|low|info",
      "title": "short title (max 80 chars)",
      "file": "repo-relative path or unknown",
      "line": 0,
      "detail": "what is wrong (max 240 chars)",
      "exploit": "plausible exploit path (max 240 chars)",
      "fix": "specific remediation (max 240 chars)"
    }
  ]
}
At most 8 findings. Prefer the highest-impact issues.`;

function usage(code = 1) {
  console.error(`usage: adversarial-audit.mjs --mode pr|repo [options]

options:
  --mode pr|repo          pr = Kimi K2.7 Code on diff; repo = Kimi K3 full tree
  --base SHA              merge base for pr mode (default: origin/main or GITHUB_BASE_SHA)
  --head SHA              head ref (default: HEAD)
  --repo-root PATH        repository root (default: .)
  --output json|markdown  default json
  --out-file PATH         also write formatted output to file
  --md-file PATH          also write markdown report (any --output mode)
  --fail-on LEVEL         none|high|critical (default none; advisory CI)
  --max-output-tokens N   default 1800 (pr) / 4000 (repo)
`);
  process.exit(code);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = { mode: "pr", output: "json", "fail-on": "none", "repo-root": "." };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage(0);
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (["mode", "base", "head", "repo-root", "output", "out-file", "md-file", "fail-on", "max-output-tokens"].includes(key)) {
      if (!next || next.startsWith("--")) usage();
      out[key] = next;
      i++;
    } else {
      usage();
    }
  }
  if (out.mode !== "pr" && out.mode !== "repo") usage();
  return out;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function readText(path, maxChars) {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  if (!st.isFile() || st.size > maxChars * 2) return null;
  const raw = readFileSync(path, "utf8");
  if (raw.includes("\0")) return null;
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n...[truncated]` : raw;
}

function shouldSkip(rel) {
  return SKIP_PATH.some((re) => re.test(rel));
}

function isSourcePath(rel) {
  if (shouldSkip(rel)) return false;
  return SOURCE_GLOBS.some((re) => re.test(rel));
}

/** @param {string} repoRoot @param {string} base @param {string} head */
function collectPrPayload(repoRoot, base, head) {
  const diff = git(repoRoot, "diff", `${base}...${head}`);
  const changed = git(repoRoot, "diff", "--name-only", `${base}...${head}`)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  /** @type {string[]} */
  const chunks = [`# Git diff (${base}...${head})\n`, diff.slice(0, MAX_DIFF_CHARS)];
  if (diff.length > MAX_DIFF_CHARS) chunks.push("\n...[diff truncated]\n");

  for (const rel of changed.slice(0, MAX_PR_FILES)) {
    if (shouldSkip(rel)) continue;
    const full = join(repoRoot, rel);
    const text = readText(full, MAX_FILE_CHARS);
    if (text) chunks.push(`\n# File: ${rel}\n\`\`\`\n${text}\n\`\`\`\n`);
  }

  for (const extra of ["SECURITY.md", "wrangler.toml", "wrangler.jsonc"]) {
    const text = readText(join(repoRoot, extra), MAX_FILE_CHARS);
    if (text) chunks.push(`\n# Context: ${extra}\n\`\`\`\n${text}\n\`\`\`\n`);
  }

  return redactSecrets(chunks.join(""));
}

/** @param {string} repoRoot */
function collectRepoPayload(repoRoot) {
  const files = git(repoRoot, "ls-files")
    .split("\n")
    .map((s) => s.trim())
    .filter((rel) => rel && isSourcePath(rel))
    .sort((a, b) => a.length - b.length);

  /** @type {string[]} */
  const chunks = [`# Repository source audit (${files.length} candidate files)\n`];
  let used = chunks[0].length;

  for (const rel of files) {
    const text = readText(join(repoRoot, rel), MAX_FILE_CHARS);
    if (!text) continue;
    const block = `\n# File: ${rel}\n\`\`\`\n${text}\n\`\`\`\n`;
    if (used + block.length > MAX_REPO_CHARS) {
      chunks.push("\n...[remaining files omitted for context budget]\n");
      break;
    }
    chunks.push(block);
    used += block.length;
  }

  for (const extra of ["SECURITY.md", "README.md", "CLAUDE.md"]) {
    const text = readText(join(repoRoot, extra), 12_000);
    if (text) {
      const block = `\n# Context: ${extra}\n\`\`\`\n${text}\n\`\`\`\n`;
      if (used + block.length <= MAX_REPO_CHARS) {
        chunks.push(block);
        used += block.length;
      }
    }
  }

  return redactSecrets(chunks.join(""));
}

/** @param {string} text */
function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) return JSON.parse(fence[1].trim());
    const summaryObj = trimmed.match(/\{\s*"summary"\s*:[\s\S]*\}/);
    if (summaryObj) {
      try {
        return JSON.parse(summaryObj[0]);
      } catch {
        /* fall through */
      }
    }
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] !== "{") continue;
      const end = trimmed.lastIndexOf("}");
      if (end <= i) break;
      try {
        return JSON.parse(trimmed.slice(i, end + 1));
      } catch {
        /* try next { */
      }
    }
    throw new Error(`model did not return JSON: ${trimmed.slice(0, 400)}`);
  }
}

/** @param {unknown} body */
function messageContent(body) {
  const msg = body?.choices?.[0]?.message ?? body?.result?.choices?.[0]?.message;
  if (!msg) throw new Error(`unexpected model response shape: ${JSON.stringify(body).slice(0, 500)}`);
  const content = (msg.content || "").trim();
  if (content) return content;
  throw new Error("model returned empty content (reasoning-only response)");
}

async function callK27Code({ accountId, gatewayId, token, messages, maxTokens }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL_PR}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "cf-aig-gateway-id": gatewayId,
    },
    body: JSON.stringify({
      messages,
      max_tokens: maxTokens,
      chat_template_kwargs: { thinking: false },
      response_format: { type: "json_object" },
    }),
  });
  const body = await resp.json();
  if (!resp.ok || body.success === false) {
    throw new Error(`K2.7 Code ${resp.status}: ${JSON.stringify(body).slice(0, 800)}`);
  }
  return { raw: body.result ?? body, text: messageContent(body.result ?? body) };
}

async function callK3({ accountId, gatewayId, token, messages, maxTokens }) {
  const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "cf-aig-authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL_REPO,
      messages,
      max_tokens: maxTokens,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
    }),
  });
  const rawText = await resp.text();
  let body;
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error(`Kimi K3 ${resp.status} non-JSON: ${rawText.slice(0, 300)}`);
  }
  if (!resp.ok || body.success === false) {
    throw new Error(`Kimi K3 ${resp.status}: ${JSON.stringify(body).slice(0, 800)}`);
  }
  return { raw: body, text: messageContent(body) };
}

/** @param {any} report @param {"json"|"markdown"} format */
function formatReport(report, format) {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  const short = (sha) => (sha && sha.length >= 7 ? sha.slice(0, 7) : sha);
  const lines = [
    `## Adversarial security audit`,
    "",
  ];
  if (report.generated_at) {
    const range =
      report.base && report.head ? ` · \`${short(report.base)}...${short(report.head)}\`` : "";
    lines.push(`_Generated ${report.generated_at}${range}_`, "");
  }
  lines.push(
    report.summary || "(no summary)",
    "",
    "| Severity | Location | Finding |",
    "| --- | --- | --- |",
  );
  for (const f of report.findings || []) {
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "unknown";
    lines.push(`| ${f.severity} | ${loc} | ${f.title}: ${f.detail} |`);
  }
  if (!report.findings?.length) lines.push("| - | - | No findings |");
  return `${lines.join("\n")}\n`;
}

function resolveBase(repoRoot, argBase) {
  if (argBase) return argBase;
  if (process.env.GITHUB_BASE_SHA) return process.env.GITHUB_BASE_SHA;
  if (process.env.GITHUB_BASE_REF) {
    try {
      return git(repoRoot, "rev-parse", process.env.GITHUB_BASE_REF);
    } catch {
      /* fall through */
    }
  }
  try {
    return git(repoRoot, "rev-parse", "origin/main");
  } catch {
    return git(repoRoot, "rev-parse", "main");
  }
}

function severityRank(s) {
  return { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[s] ?? 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = String(args["repo-root"] || ".");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const aigToken = process.env.CF_AIG_TOKEN?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const gatewayId = process.env.AI_GATEWAY_ID?.trim() || "your-gateway-id";
  const output = args.output === "markdown" ? "markdown" : "json";
  const failOn = String(args["fail-on"] || "none");
  const mode = args.mode;

  if (!accountId) {
    console.error("FATAL: CLOUDFLARE_ACCOUNT_ID is required");
    process.exit(2);
  }
  if (mode === "pr" && !apiToken) {
    console.error("FATAL: CLOUDFLARE_API_TOKEN is required for --mode pr (K2.7 @cf /ai/run path)");
    process.exit(2);
  }
  if (mode === "repo" && !aigToken) {
    console.error("FATAL: CF_AIG_TOKEN is required for --mode repo (Kimi K3 unified billing)");
    process.exit(2);
  }

  const base = mode === "pr" ? resolveBase(repoRoot, args.base ? String(args.base) : undefined) : null;
  const headRef = mode === "pr" ? String(args.head || "HEAD") : null;
  const headSha =
    mode === "pr"
      ? process.env.GITHUB_SHA?.trim() || git(repoRoot, "rev-parse", headRef)
      : undefined;
  const maxTokens = Number(args["max-output-tokens"] || (mode === "repo" ? 8000 : 2500));

  const userPrompt =
    mode === "pr"
      ? `Adversarially audit this pull-request change set. Focus on authz, injection, SSRF, secret handling, and cross-tenant data leaks.\n\n${collectPrPayload(repoRoot, base, headRef)}`
      : `Adversarially audit this entire repository snapshot. Hunt for missed auth checks, injection, unsafe defaults, CI footguns, and cross-user data leaks.\n\n${collectRepoPayload(repoRoot)}`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const model = mode === "pr" ? MODEL_PR : MODEL_REPO;
  console.error(`adversarial-audit: mode=${mode} model=${model} gateway=${gatewayId}`);

  const { text, raw } =
    mode === "pr"
      ? await callK27Code({ accountId, gatewayId, token: apiToken, messages, maxTokens })
      : await callK3({ accountId, gatewayId, token: aigToken, messages, maxTokens });

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (firstErr) {
    console.error(`adversarial-audit: JSON parse failed (${firstErr.message}); retrying compact`);
    const retryMessages = [
      ...messages,
      {
        role: "user",
        content:
          "Your prior answer was not valid JSON or was truncated. Reply again with VALID JSON only. At most 8 findings. Keep detail fields under 240 characters each.",
      },
    ];
    const retry =
      mode === "pr"
        ? await callK27Code({ accountId, gatewayId, token: apiToken, messages: retryMessages, maxTokens })
        : await callK3({ accountId, gatewayId, token: aigToken, messages: retryMessages, maxTokens });
    parsed = extractJson(retry.text);
  }
  const report = {
    mode,
    model,
    gateway: gatewayId,
    base: base || undefined,
    head: headSha || undefined,
    generated_at: new Date().toISOString(),
    summary: parsed.summary || "",
    findings: Array.isArray(parsed.findings)
      ? parsed.findings.map((f) => (typeof f === "string" ? { severity: "info", title: f, file: "unknown", line: 0, detail: f, exploit: "", fix: "" } : f))
      : [],
    usage: raw.usage ?? undefined,
  };

  const formatted = formatReport(report, output);
  process.stdout.write(formatted);

  if (args["out-file"]) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(String(args["out-file"]), formatted, "utf8");
  }
  if (args["md-file"]) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(String(args["md-file"]), formatReport(report, "markdown"), "utf8");
  }

  if (failOn !== "none") {
    const threshold = failOn === "critical" ? 4 : 3;
    const worst = Math.max(0, ...(report.findings.map((f) => severityRank(f.severity))));
    if (worst >= threshold) process.exit(1);
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(2);
});
