# Changelog

## 0.3.0

Repo-mode model is **configurable**; PR mode stays on K2.7 Workers AI (no egress).

- **`--model-repo` / `AUDIT_MODEL_REPO`.** Package default remains `moonshotai/kimi-k3` for
  external users. Estate workflows can pin `anthropic/claude-opus-5` (Unified Billing via
  the AI Gateway) without forking the script. Kimi stays selectable.
- **Data boundary refined.** Moonshot (and other non-Anthropic third-party gateway models)
  still require a PUBLIC tree; private/internal falls back to K2.7 on Workers AI.
  `anthropic/*` is allowed for private/internal (trusted US vendor). Unknown third-party
  prefixes fail-safe to public-only.
- **PR mode is not overridable** -- still `@cf/moonshotai/kimi-k2.7-code` on `/ai/run`.
  Routing PR diffs to a third party remains an explicit product decision, not a side
  effect of preferring Opus for deep audits.
- Gateway call path renamed generically (`callGateway`); Moonshot-only `reasoning_effort`
  is only sent for kimi/moonshot models so Anthropic compat does not reject the payload.

## 0.2.1

Three redaction defects, all found by executing the redactor against the input shape it
actually receives in production rather than by reading it.

- **Age keys were unredactable in `pr` mode.** The rule was anchored to a whole line
  (`^AGE-SECRET-KEY-...), and every line of a unified diff carries a `+`, `-` or
  leading space, so the only rule covering that key format could not fire in the mode
  that runs on every PR. Indented occurrences (a YAML value) failed the same way. The
  rule now matches the token wherever it sits, with a `{20,}` length floor so
  documentation mentions of the format stay readable.
- **Quoted assignment values leaked their tail.** The value side stopped at the first
  whitespace, so `API_TOKEN="abc123 trailing-part"` became
  `API_TOKEN=[REDACTED] trailing-part"`. Single- and double-quoted values are now taken
  whole. No value pattern may cross a newline, or an unbalanced quote would swallow every
  line up to the next one.
- **The assignment rule ate real source, and fixing the value side alone made that worse.**
  The identifier matched any name *containing* a keyword, so `const tokenizer = new
  Tokenizer()` parsed as a secret assignment and the value side removed the rest of the
  statement; `passwordInput = document.getElementById('pw');` lost its whole right-hand
  side. Widening the value side to quoted strings turned a partial mangle into total
  erasure of string literals. The keyword must now end the identifier or be `_`-delimited
  within it. This is the more dangerous failure direction: over-redaction silently feeds
  the model `[REDACTED]` instead of code while the audit still reports clean.
- Tests now drive the redactor with production-shaped input (diff-prefixed lines, indented
  YAML, quoted values with spaces) and assert in both directions. A secret-free diff must
  come back byte-identical, which is the only assertion that can tell a working redactor
  from one that redacts everything.

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

- `adversarial-audit.mjs`: Kimi K2.7 PR diff and Kimi K3 full-repo audit modes
- `redact.mjs`: secret hygiene before model calls
- `post-pr-comment.sh`: upsert advisory PR comments
- Example GitHub Actions workflows for public inline and private reusable-call patterns
