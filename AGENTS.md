# security-audit

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

`@skyphusion/security-audit` runs an advisory security review with Cloudflare Workers AI and AI Gateway. It sits beside static analysis such as CodeQL or Semgrep. It does not replace a merge gate unless you pass `--fail-on`. Read [README.md](README.md).

The version is in `package.json`. See the latest `v*` tag. The package is not published to the npm registry from this repo.

## Modes

| Mode | Model | Scope |
| --- | --- | --- |
| `pr` | Workers AI Kimi, not overridable | Merge-base diff and changed files |
| `repo` default | Gateway Kimi when the repo is public; Workers AI otherwise | Tracked tree, about 250k characters |
| `repo` override | `--model-repo` or `AUDIT_MODEL_REPO` | Same tree |

Pull request mode stays on Workers AI. That mode sends no diff to a third party. A `moonshotai` model and an unknown third party are for public repos. A private repo falls back to Workers AI for those models. An `anthropic` model is allowed on a private repo. Visibility is `--visibility`, then the GitHub event, then private.

## Commands

```bash
npm test
npm run test:coverage
npm run typecheck
```

`npm run typecheck` checks `adversarial-audit.mjs`, `redact.mjs`, and `post-pr-comment.sh`. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs typecheck and `npm run test:coverage`. It runs on pull requests and on pushes to `main`.

| File | Role |
| --- | --- |
| `adversarial-audit.mjs` | Collect, redact, and call Cloudflare AI |
| `redact.mjs` | Pattern redaction before the payload leaves CI |
| `post-pr-comment.sh` | Upsert the advisory pull request comment |
| `examples/` | Workflow sketches for public and private repos |

The reusable workflow file is not on `main`. Use `examples/adversarial-audit-public.yml` for the inline pattern. Tags `v0.1.0`, `v0.2.0`, and `v0.2.1` still contain the old reusable file. That copy is unmaintained.

A fork pull request must skip any job that receives a Cloudflare secret.

## Secrets

Do not put a secret value in a tracked file. Do not put a secret value in a chat transcript. Tokens belong in GitHub Actions secrets or Cloudflare secrets. Redaction is hygiene. It is not a guarantee. Do not send a live production secret in an audit payload. When a repo already uses `CLOUDFLARE_API_TOKEN` for deploy, put the audit token in `ADVERSARIAL_AUDIT_CF_API_TOKEN` and map it in the workflow.

## Docs

Write Simplified Technical English. Use short sentences. Use one idea per sentence. Use the active present tense. Use plain words. Use the same word every time.

Do not use an em dash (U+2014). Do not use an en dash (U+2013). Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability. Do not turn a measured result into a promise.

## Release

No workflow in this repo runs on a tag. No workflow here publishes the npm package. A release is an annotated tag on `main` that matches `package.json`. A merge to `main` runs CI only. A version moves only in a release pull request. Feature work does not bump the version. Fix work does not bump the version.

## Commits

Use Conventional Commits. The body says why. The public handle is `skyphusion`.
