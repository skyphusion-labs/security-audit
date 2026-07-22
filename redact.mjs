/**
 * Strip likely secrets from audit payloads before they leave CI.
 * Hygiene only; never treat redaction as proof that no secrets remain.
 */

const RULES = [
  { name: "pem-block", re: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, replace: "[REDACTED_PEM]" },
  { name: "age-header", re: /^AGE-SECRET-KEY-[A-Z0-9=]+$/gm, replace: "[REDACTED_AGE_KEY]" },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g, replace: "Bearer [REDACTED]" },
  { name: "ghp", re: /\bghp_[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED_GH_PAT]" },
  { name: "gho", re: /\bgho_[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED_GH_OAUTH]" },
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: "[REDACTED_GH_PAT]" },
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED_AWS_KEY]" },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: "[REDACTED_JWT]" },
  {
    name: "assignment",
    re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*[^\s#]+/gi,
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
