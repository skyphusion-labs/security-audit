# security-audit

Adversarial LLM security audits for GitHub repositories via [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) and [AI Gateway](https://developers.cloudflare.com/ai-gateway/).

This is an **advisory** layer on top of static analysis (CodeQL, Semgrep, etc.). It does not replace merge gates unless you opt in with `--fail-on`.

## Modes

| Mode | Model | Scope | Typical trigger |
| --- | --- | --- | --- |
| **pr** | `@cf/moonshotai/kimi-k2.7-code` (Workers AI) | Merge-base diff + changed files | Every PR to `main` |
| **repo**, PUBLIC repo | `moonshotai/kimi-k3` (through the AI Gateway) | Tracked source tree (~250k char budget) | `workflow_dispatch` or scheduled deep audit |
| **repo**, PRIVATE / INTERNAL repo | `@cf/moonshotai/kimi-k2.7-code` (Workers AI) | Same tree snapshot, same prompt, on-shore | same |

### The repo-mode data boundary

The two models sit on different data paths, and repo mode is the one that matters:
`@cf/...` models **run on Workers AI**, so the payload stays inside your Cloudflare
account, while `moonshotai/kimi-k3` is **proxied by the AI Gateway to Moonshot's own
API** -- a gateway forwards a request, it does not contain it. Repo mode ships your whole
tracked tree, so:

**Repo mode only uses K3 when the repository is PUBLIC.** For a private or internal repo
it runs the same repo-mode prompt against K2.7 on Workers AI instead, prints a
`DATA BOUNDARY --` line saying so, and the sweep still happens; it just does not egress.

Visibility is resolved in this order: an explicit `--visibility public|private|internal`,
then the GitHub Actions event payload (`repository.visibility`, or `repository.private`),
then **`private`**. The fail-safe direction is deliberate: an unknown answer must route
on-shore, so a local run with no flag can never leak a private tree by omission. There is
no override flag for the boundary itself, on purpose.


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
