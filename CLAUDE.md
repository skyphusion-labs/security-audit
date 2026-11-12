# CLAUDE.md -- security-audit

Guidance for agents working in this repository.

## What this is

**Adversarial LLM security audits** for GitHub repositories via Cloudflare Workers AI and AI
Gateway. Advisory layer on top of static analysis (CodeQL, Semgrep, etc.). It does not replace
merge gates unless you opt in with `--fail-on`.

Named **`@skyphusion/security-audit`** in root `package.json`; not on the npm registry
(`npm view` returns E404). Version is root `package.json` (trust pin + tags).

## Modes and data boundary (load-bearing)

| Mode | Model | Scope | Typical trigger |
| --- | --- | --- | --- |
| **pr** | `@cf/moonshotai/kimi-k2.7-code` (Workers AI) | Merge-base diff + changed files | Every PR to `main` |
| **repo** (default) | `moonshotai/kimi-k3` via Gateway when PUBLIC; else K2.7 | Tracked source tree (~250k char) | `workflow_dispatch` / scheduled |
| **repo** (override) | `--model-repo` / `AUDIT_MODEL_REPO` (e.g. `anthropic/claude-opus-5`) | same | same |

**PR mode is not overridable** (no third-party egress on diffs). Repo-mode model is selectable;
package default stays Kimi for external users. Data boundary: `moonshotai/*` and unknown
third parties are PUBLIC-only (private falls back to K2.7); `anthropic/*` is allowed for
private/internal. Visibility: explicit `--visibility`, then GitHub event, then **private**.

## Package scripts

```bash
npm test              # vitest
npm run test:coverage  # vitest + the coverage floors in vitest.config.mjs; the ci workflow runs this
npm run typecheck     # node --check adversarial-audit.mjs + redact.mjs; bash -n post-pr-comment.sh
```

| File | Purpose |
| --- | --- |
| `adversarial-audit.mjs` | Collect diff or repo snapshot, redact, call Cloudflare AI |
| `redact.mjs` | Pattern-based secret hygiene before payload leaves CI (not a guarantee) |
| `post-pr-comment.sh` | Upsert advisory PR comment |
| `examples/` | Copy-paste workflow templates (public inline vs private reusable) |

## CI / adversarial gate

- This repo runs its own CI, coverage, and CodeQL. The reusable adversarial workflow
  (`.github/workflows/adversarial-audit-reusable.yml`) was retired in aa391a7 and does not exist
  on `main`; re-enable it only if Conrad asks. It still exists in the tags `v0.1.0` to `v0.2.1`, so a
  caller pinned to one of those (see `examples/adversarial-audit-private-reusable-call.yml`) resolves
  but is unmaintained; the inline pattern in `examples/adversarial-audit-public.yml` does not
  depend on it.
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

## Release / deploy

Release = an annotated SemVer tag on `main` matching `package.json`
(`git tag -a vX.Y.Z ...`). No workflow runs on tags. Root `package.json` is `0.3.0`
and there is no `v0.3.0` tag (tags that exist: `v0.1.0`, `v0.2.0`, `v0.2.1`).

No deploy workflow and no npm publish workflow live in this repo. `.github/workflows/ci.yml`
runs on pull requests, pushes to `main`, and `workflow_dispatch` only (`npm run typecheck`,
then `npm run test:coverage`). It does not run on tags, and nothing in this tree asserts
that a tag commit is an ancestor of `origin/main`. A merge to `main` runs that CI; it does
not ship a release. The org `.github` workflows (`corpus-notify.yml`, `coverage.yml`,
`oss-discoverability-drift.yml`, `pages.yml`) are not a deploy gate for this package.

## Release convention (bump-at-release)

One convention for every skyphusion-labs repo (Conrad, ruled 2026-11-10, fleet-chezmoi#1766). A version moves ONLY in a release PR: bump the version, then assemble the changelog. Feature and fix PRs do not bump. Releases go through a PR (fleet-chezmoi#1622) and the tag goes on that PR's merge commit.

- Version of record here: package.json.
- Tag shape: `v*`.
- Check before a release PR: does a tag already exist for the version currently in the manifest? Yes means the cycle is closed, so the release PR bumps. No means a bump already landed outside a release PR; stop and read why before bumping again.
