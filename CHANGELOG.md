# Changelog

## 0.2.0

Two fixes ported from the internal deployment of these scripts, where both were found
in production use.

- **Repo-mode data boundary.** Repo mode ships the whole tracked tree, and `kimi-k3` is
  proxied to Moonshot's own API rather than run on Workers AI, so it now only uses K3
  when the repository is PUBLIC; a private or internal tree gets the same repo-mode
  prompt on K2.7 on Workers AI, with a `DATA BOUNDARY --` notice. New
  `--visibility public|private|internal`, resolved from the flag, then the Actions event
  payload, then **private** as the fail-safe. Unknown never means egress.
- **Oversized files are truncated into the payload instead of dropped.** `readText`
  previously returned null for a file larger than twice the budget, so the biggest files
  in a repo were silently absent from the audit and the run still looked green. They are
  now truncated with a visible marker.
- `readText` and `resolveVisibility` are exported and unit-tested (the module no longer
  starts an audit when imported, only when invoked as a CLI).

## 0.1.0 (2026-07-22)

Initial public release.

- `adversarial-audit.mjs` — Kimi K2.7 PR diff and Kimi K3 full-repo audit modes
- `redact.mjs` — secret hygiene before model calls
- `post-pr-comment.sh` — upsert advisory PR comments
- Example GitHub Actions workflows for public inline and private reusable-call patterns
