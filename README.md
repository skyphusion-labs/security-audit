# security-audit

Adversarial LLM security audits for GitHub repositories via [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) and [AI Gateway](https://developers.cloudflare.com/ai-gateway/).

This is an **advisory** layer on top of static analysis (CodeQL, Semgrep, etc.). It does not replace merge gates unless you opt in with `--fail-on`.

## Modes

| Mode | Model | Scope | Typical trigger |
| --- | --- | --- | --- |
| **pr** | `@cf/moonshotai/kimi-k2.7-code` | Merge-base diff + changed files | Every PR to `main` |
| **repo** | `moonshotai/kimi-k3` | Tracked source tree (~250k char budget) | `workflow_dispatch` or scheduled deep audit |

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
| `CF_AIG_TOKEN` | repo mode | AI Gateway unified-billing token (`cf-aig-authorization`) |
| `AI_GATEWAY_ID` | No | Gateway slug (default: `your-gateway-id`) |

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

# Full repository snapshot
node adversarial-audit.mjs --mode repo --output json --out-file audit.json
```

### Options

```
--mode pr|repo
--base SHA              merge base for pr mode
--head SHA              head ref (default: HEAD)
--repo-root PATH        repository root (default: .)
--output json|markdown
--out-file PATH
--md-file PATH          markdown report (any output mode)
--fail-on none|high|critical   default none (advisory)
--max-output-tokens N
```

## GitHub Actions

Copy an example from `examples/` into `.github/workflows/` and configure secrets/vars.

- **`examples/adversarial-audit-public.yml`** — checkout this repo and run inline (works for public repos).
- **`examples/adversarial-audit-private-reusable-call.yml`** — call the reusable workflow (private repos).

See also `.github/workflows/adversarial-audit-reusable.yml` in this repo for the callable workflow definition.

### Fork PR safety

Both example workflows skip fork PRs (`head.repo.full_name == repository`) so untrusted code does not receive your Cloudflare tokens.

### PR comments

On pull requests, the workflow posts (or updates) an advisory comment via `post-pr-comment.sh`. Requires `pull-requests: write` and `github.token`.

## Secret redaction

Before any payload is sent to the model, `redact.mjs` applies pattern-based redaction (PEM blocks, GitHub PATs, JWTs, common env assignments, etc.). **Redaction is hygiene, not a guarantee.** Do not audit repos containing live production secrets.

## Output

JSON (default) or markdown table with severity, location, title, and detail. Findings include optional exploit path and remediation fields when the model returns them.

## License

MIT — see [LICENSE](LICENSE).
