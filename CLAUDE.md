# CLAUDE.md -- security-audit

Guidance for agents working in this repository.

## What this is

**Adversarial LLM security audits** for GitHub repositories via Cloudflare Workers AI and AI
Gateway. Advisory layer on top of static analysis (CodeQL, Semgrep, etc.). It does not replace
merge gates unless you opt in with `--fail-on`.

Published as **`@skyphusion/security-audit`**. Version is root `package.json` (trust pin + tags).

## Modes and data boundary (load-bearing)

| Mode | Model | Scope | Typical trigger |
| --- | --- | --- | --- |
| **pr** | `@cf/moonshotai/kimi-k2.7-code` (Workers AI) | Merge-base diff + changed files | Every PR to `main` |
| **repo**, PUBLIC | `moonshotai/kimi-k3` (AI Gateway -> Moonshot) | Tracked source tree (~250k char) | `workflow_dispatch` / scheduled |
| **repo**, PRIVATE / INTERNAL | `@cf/moonshotai/kimi-k2.7-code` (Workers AI) | Same tree snapshot, on-shore | same |

**Repo mode only uses K3 when the repository is PUBLIC.** Private or internal repos use K2.7 on
Workers AI (payload stays in the CF account). Visibility resolution order: explicit
`--visibility`, then GitHub event payload, then **private** (fail-safe on-shore). There is no
override flag to force K3 on a private tree.

## Package scripts

```bash
npm test              # vitest
npm run test:coverage
npm run typecheck     # node --check adversarial-audit.mjs + redact.mjs; bash -n post-pr-comment.sh
```

| File | Purpose |
| --- | --- |
| `adversarial-audit.mjs` | Collect diff or repo snapshot, redact, call Cloudflare AI |
| `redact.mjs` | Pattern-based secret hygiene before payload leaves CI (not a guarantee) |
| `post-pr-comment.sh` | Upsert advisory PR comment |
| `examples/` | Copy-paste workflow templates (public inline vs private reusable) |

## CI / adversarial gate

- This repo runs its own CI, coverage, CodeQL, and the reusable adversarial workflow definition
  (`.github/workflows/adversarial-audit-reusable.yml`).
- Downstream product repos typically call the reusable workflow on every PR to `main` (K2.7 diff)
  and optionally schedule full repo mode.
- Fork PRs must skip tokened jobs (`head.repo.full_name == repository`) so untrusted code never
  receives Cloudflare secrets.

## Secrets and transcripts

- **Never put a plaintext secret value in a tracked file or a chat transcript.**
- Tokens live as GitHub Actions secrets / CF secrets; account and gateway IDs as variables.
- Redaction is hygiene only. Do not feed live production secrets into an audit payload.
- Prefer `ADVERSARIAL_AUDIT_CF_API_TOKEN` when the repo already uses `CLOUDFLARE_API_TOKEN` for
  wrangler deploy (map into `CLOUDFLARE_API_TOKEN` env in the workflow).

## Conventions

- No em-dashes (U+2014) or en-dashes (U+2013) in source or docs; use commas, semicolons, or `--`.
- Handle / username default: `skyphusion`.
- Conventional Commits. SemVer in root `package.json`.
- See `README.md` for env vars, local usage, and GitHub Actions examples.

## Crew + identity

Crew work as their own identity (`sudo -u <member> bash -lc '...'`). Conrad laptop commits:
`Conrad Rockenhaus <conrad@skyphusion.org>`.
