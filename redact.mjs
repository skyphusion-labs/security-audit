/**
 * Strip likely secrets from audit payloads before they leave CI.
 * Hygiene only; never treat redaction as proof that no secrets remain.
 *
 * TWO FAILURE DIRECTIONS, AND THEY ARE NOT SYMMETRIC.
 *
 * Under-redaction leaks a secret into the model payload. Over-redaction is
 * worse: the payload IS the code under audit, so a rule broad enough to touch
 * ordinary source feeds the model "[REDACTED]" instead of the thing it was
 * asked to review, and the audit still returns a confident "no findings". That
 * is a security control reporting success exactly when it has stopped working.
 * Every rule below is therefore written to match a TOKEN, never a line or a
 * span, and the test suite asserts what each rule must NOT match.
 *
 * Two consequences of that, both deliberate:
 *   - no value-side pattern may cross a newline (hence [^"\n] and [ \t]*
 *     rather than [^"] and \s*): a pattern that can span lines will swallow
 *     every line between an opening quote and the next quote in the payload.
 *   - the assignment rule requires its keyword to END the identifier or be
 *     _-delimited within it, so camelCase source (tokenizer, passwordInput,
 *     secretsManager, this.tokens) is not parsed as a secret assignment.
 *     The cost is that run-on plurals (SECRETS_FILE=) are no longer matched;
 *     that is the safe direction, and the json-secret and pem rules still
 *     cover the shapes that actually carry key material.
 *
 * PAYLOAD SHAPE. In `pr` mode the payload is `git diff` output, so every added
 * line carries a "+", every removed line a "-", and every context line a
 * leading space; file bodies are also embedded with their original
 * indentation. No rule may be anchored to a whole line (^...$) -- such a rule
 * cannot fire on any line of a diff, which is the mode that runs on every PR.
 */

const RULES = [
  { name: "pem-block", re: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, replace: "[REDACTED_PEM]" },

  // Matches the key wherever it sits: diff-prefixed, indented, quoted, or with
  // trailing content. The {20,} floor keeps documentation mentions of the
  // format ("the AGE-SECRET-KEY- prefix", "AGE-SECRET-KEY-1XXXX") readable --
  // a real key body is 59 characters -- and matches the floor the other
  // token rules below already use.
  { name: "age-key", re: /AGE-SECRET-KEY-[A-Z0-9=]{20,}/g, replace: "[REDACTED_AGE_KEY]" },

  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g, replace: "Bearer [REDACTED]" },
  { name: "ghp", re: /\bghp_[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED_GH_PAT]" },
  { name: "gho", re: /\bgho_[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED_GH_OAUTH]" },
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: "[REDACTED_GH_PAT]" },
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED_AWS_KEY]" },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: "[REDACTED_JWT]" },

  {
    // Identifier: the keyword must be the tail of the name (API_TOKEN, mytoken)
    // or a _-delimited component of it (GITHUB_TOKEN_PROD). It may NOT be
    // followed by more letters, which is what kept `tokenizer`, `passwordInput`
    // and `secretsManager` out.
    //
    // Value: quoted alternatives are tried first, so a quoted value is taken
    // whole including spaces and internal "="; the bare form still stops at
    // whitespace. Neither may cross a newline.
    name: "assignment",
    re: /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[0-9]*(?:_[A-Za-z0-9]+)*)[ \t]*=[ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^\s#]+)/gi,
    replace: "$1=[REDACTED]",
  },
  {
    name: "json-secret",
    re: /"(secret|token|password|api[_-]?key|private[_-]?key)"\s*:\s*"[^"]{8,}"/gi,
    replace: '"$1":"[REDACTED]"',
  },
];

/** @param {string} text */
export function redactSecrets(text) {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, rule.replace);
  }
  return out;
}
