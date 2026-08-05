# security-audit

Adversarial LLM security audits for GitHub repositories via [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) and [AI Gateway](https://developers.cloudflare.com/ai-gateway/).

This is an **advisory** layer on top of static analysis (CodeQL, Semgrep, etc.). It does not replace merge gates unless you opt in with `--fail-on`.

## Modes

| Mode | Model | Scope | Typical trigger |
| --- | --- | --- | --- |
| **pr** | `@cf/moonshotai/kimi-k2.7-code` (Workers AI) | Merge-base diff + changed files | Every PR to `main` |
| **repo** (default) | `moonshotai/kimi-k3` via AI Gateway when PUBLIC; else K2.7 on-shore | Tracked source tree (~250k char budget) | `workflow_dispatch` or scheduled deep audit |
| **repo** (override) | any gateway model via `--model-repo` / `AUDIT_MODEL_REPO` | same | same |

PR mode is **not** overridable: it always stays on Workers AI (no third-party egress).

### Choosing a repo-mode model

Package default is **`moonshotai/kimi-k3`** so external users keep the public-service
behavior. Override when you want a different provider on Unified Billing:

```bash
# Estate deep audits (Anthropic via CF AI Gateway, keyless)
node adversarial-audit.mjs --mode repo --model-repo anthropic/claude-opus-5

# Or env (handy in workflows)
export AUDIT_MODEL_REPO=anthropic/claude-opus-5
node adversarial-audit.mjs --mode repo
```

Kimi remains fully supported; this is a selectable default, not a hard swap.

### The repo-mode data boundary

Gateway models leave your Cloudflare account (the gateway **forwards** the request).
Repo mode ships the whole tracked tree, so egress is gated by visibility **and** model:

| Gateway model prefix | PUBLIC | PRIVATE / INTERNAL |
| --- | --- | --- |
| `moonshotai/*` (and other non-Anthropic third parties) | gateway model | fall back to K2.7 Workers AI |
| `anthropic/*` | gateway model | gateway model (trusted US vendor) |
| `@cf/*` (Workers AI) | on-shore | on-shore |

When a gateway model is refused for the visibility, the same repo-mode prompt runs on
K2.7 on Workers AI and a `DATA BOUNDARY --` line is printed. Visibility resolution order:
explicit `--visibility`, then the GitHub event payload, then **`private`** (fail-safe
on-shore). Unknown third-party prefixes fail-safe to public-only.


## Scripts

| File | Purpose |
| --- | --- |
| `adversarial-audit.mjs` | Collects git diff or repo snapshot, redacts secrets, calls Cloudflare AI |
| `redact.mjs` | Strips likely secrets from payloads before they leave CI (hygiene only) |
| `post-pr-comment.sh` | Upserts an advisory markdown comment on the PR |

## Environment variables

| Name | Required | Notes |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | pr mode | Account-scoped token with Workers AI access (`/ai/run`) |
| `ADVERSARIAL_AUDIT_CF_API_TOKEN` | pr mode (Actions) | Recommended GitHub secret name when the repo already uses `CLOUDFLARE_API_TOKEN` for wrangler deploy; map into `CLOUDFLARE_API_TOKEN` env in the workflow |
| `CF_AIG_TOKEN` | repo mode on a gateway model | AI Gateway unified-billing token (`cf-aig-authorization`) |
| `AI_GATEWAY_ID` | No | Gateway slug (default: `your-gateway-id`) |
| `AUDIT_MODEL_REPO` | No | Override default repo-mode gateway model (`moonshotai/kimi-k3`) |

Create an [AI Gateway](https://developers.cloudflare.com/ai-gateway/get-started/) in your account and set `AI_GATEWAY_ID` to its ID.

For GitHub Actions, store tokens as **secrets** and account/gateway IDs as **variables** (repo or org level). Public repos must explicitly enable org secrets for the repository.

## Local usage

```bash
export CLOUDFLARE_ACCOUNT_ID=your-account-id
export CLOUDFLARE_API_TOKEN=your-api-token   # pr mode
export CF_AIG_TOKEN=your-aig-token             # repo mode
export AI_GATEWAY_ID=your-gateway-id

# PR diff audit (default base: origin/main)
node adversarial-audit.mjs --mode pr --output markdown

# Full repository snapshot (default: Kimi K3 when public)
node adversarial-audit.mjs --mode repo --output json --out-file audit.json

# Estate-style deep audit on Opus via the AI Gateway
node adversarial-audit.mjs --mode repo --model-repo anthropic/claude-opus-5
```

### Options

```
--mode pr|repo
--model-repo ID         repo-mode gateway model (default moonshotai/kimi-k3;
                        env AUDIT_MODEL_REPO). PR mode is not overridable.
--base SHA              merge base for pr mode
--head SHA              head ref (default: HEAD)
--repo-root PATH        repository root (default: .)
--output json|markdown
--out-file PATH
--md-file PATH          markdown report (any output mode)
--fail-on none|high|critical   default none (advisory)
--max-output-tokens N
--visibility public|private|internal   repo-mode data boundary (default: event
                                       payload, else private -- see Modes above)
```

## GitHub Actions

Copy an example from `examples/` into `.github/workflows/` and configure secrets/vars.

- **`examples/adversarial-audit-public.yml`**: checkout this repo and run inline (works for public repos).
- **`examples/adversarial-audit-private-reusable-call.yml`**: call the reusable workflow (private repos).

See also `.github/workflows/adversarial-audit-reusable.yml` in this repo for the callable workflow definition.

### Fork PR safety

Both example workflows skip fork PRs (`head.repo.full_name == repository`) so untrusted code does not receive your Cloudflare tokens.

### PR comments

On pull requests, the workflow posts (or updates) an advisory comment via `post-pr-comment.sh`. Requires `pull-requests: write` and `github.token`.

## Secret redaction

Before any payload is sent to the model, `redact.mjs` applies pattern-based redaction (PEM blocks, age keys, GitHub PATs, JWTs, common env assignments, etc.). **Redaction is hygiene, not a guarantee.** Do not audit repos containing live production secrets.

The rules match tokens, never whole lines or spans, for two reasons. In `pr` mode the payload is a unified diff, so every line carries a `+`, `-` or leading space and a line-anchored rule cannot fire at all. And the payload being redacted *is* the code under audit: a rule broad enough to touch ordinary source feeds the model `[REDACTED]` instead of the code, and the audit then returns a confident "no findings" precisely because it stopped working. The test suite therefore asserts what each rule must **not** match, including a secret-free diff that must come back byte-identical.

## Output

JSON (default) or markdown table with severity, location, title, and detail. Findings include optional exploit path and remediation fields when the model returns them.

## See also

- **Write-up:** [security-audit: an adversarial LLM gate you can run on every PR](https://skyphusion.net/blog/security-audit/)
- **Labs hub:** [skyphusion.org](https://skyphusion.org) · **Blog:** [skyphusion.net](https://skyphusion.net)
- **Related:** [search-mcp](https://github.com/skyphusion-labs/search-mcp), [postern](https://github.com/skyphusion-labs/postern), [prism](https://github.com/skyphusion-labs/prism)

## License

MIT: see [LICENSE](LICENSE).
