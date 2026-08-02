import { describe, expect, it } from "vitest";
import { redactSecrets } from "../redact.mjs";

/**
 * Every fixture here is deliberately, obviously synthetic. Nothing in this file
 * is a real credential or is shaped closely enough to one to be mistaken for it
 * if these tests are ever quoted, logged, or pasted somewhere else.
 *
 * The suite asserts in BOTH directions on purpose. A suite that only proves
 * secrets get redacted cannot tell a working redactor from one that redacts
 * everything -- and over-redaction is the more dangerous failure here, because
 * the payload being redacted IS the code under audit. A rule that is too broad
 * silently feeds the model "[REDACTED]" instead of source, and the audit then
 * returns a confident "no findings" precisely because it stopped working.
 * So most of what follows is must-NOT-match.
 */

// Not a key, and deliberately not shaped like one. A real age secret key has a "1"
// separator after the prefix and a 59-character bech32 body; this has neither, and its
// body is the literal word EXAMPLE repeated. It is assembled by concatenation so the
// whole string never appears as a literal in this file.
//
// That matters beyond taste: an earlier version of this fixture used the realistic
// "AGE-SECRET-KEY-1..." shape and tripped a real credential scanner on push. A test
// fixture that trips secret scanners is a defect to ship in a public repo -- everyone
// who clones it inherits the tripwire. Do not "tidy" this back into a single literal.
const AGE_KEY = "AGE-SECRET-KEY-" + "EXAMPLE".repeat(8);

describe("redactSecrets -- baseline rules", () => {
  it("redacts GitHub PATs", () => {
    const out = redactSecrets("auth ghp_1234567890123456789012345678901234");
    expect(out).not.toContain("ghp_1234");
    expect(out).toContain("[REDACTED_GH_PAT]");
  });

  it("redacts bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456");
    expect(out).toContain("Bearer [REDACTED]");
  });

  it("redacts secret assignments", () => {
    const out = redactSecrets("API_TOKEN=super-secret-value-here");
    expect(out).toBe("API_TOKEN=[REDACTED]");
  });

  it("leaves benign text unchanged", () => {
    const text = "export function hello() { return 1; }";
    expect(redactSecrets(text)).toBe(text);
  });
});

/**
 * PR mode sends `git diff` output, so EVERY added line carries a "+", every
 * removed line a "-", and every context line a leading space. A rule anchored
 * to a whole line (^...$) cannot fire on any of them. This is the shape the
 * redactor actually receives in production and nothing used to test it.
 */
describe("age keys -- production line shapes", () => {
  const shapes = {
    "a bare line": AGE_KEY,
    "a diff added line": "+" + AGE_KEY,
    "a diff removed line": "-" + AGE_KEY,
    "a diff context line": " " + AGE_KEY,
    "an indented yaml value": "  age_key: " + AGE_KEY,
    "a quoted yaml value": '  age_key: "' + AGE_KEY + '"',
    "a diff added indented yaml value": "+  age_key: " + AGE_KEY,
    "a line with trailing content": AGE_KEY + "  # rotate me",
  };

  for (const [name, input] of Object.entries(shapes)) {
    it("redacts an age key on " + name, () => {
      const out = redactSecrets(input);
      expect(out).not.toContain(AGE_KEY);
      expect(out).not.toContain("EXAMPLEEXAMPLE");
      expect(out).toContain("[REDACTED_AGE_KEY]");
    });
  }

  it("replaces only the key, keeping the line structure around it", () => {
    expect(redactSecrets("+  age_key: " + AGE_KEY)).toBe("+  age_key: [REDACTED_AGE_KEY]");
  });

  it("redacts every occurrence when several appear in one payload", () => {
    const payload = ["+" + AGE_KEY, " " + AGE_KEY, "-" + AGE_KEY].join("\n");
    const out = redactSecrets(payload);
    expect(out).not.toContain("EXAMPLE");
    expect(out.match(/\[REDACTED_AGE_KEY\]/g)).toHaveLength(3);
  });
});

/**
 * Must-NOT for the age rule. Dropping the line anchors must not turn the rule
 * into something that eats documentation or public (non-secret) material.
 */
describe("age rule -- must not match", () => {
  it("leaves a prose mention of the key format alone", () => {
    const text = "Chezmoi keys use the AGE-SECRET-KEY- prefix; see the age docs.";
    expect(redactSecrets(text)).toBe(text);
  });

  it("leaves a short doc placeholder alone", () => {
    const text = "age_key: AGE-SECRET-KEY-1XXXX  # replace with your own";
    expect(redactSecrets(text)).toBe(text);
  });

  it("leaves an age PUBLIC recipient alone (recipients are not secret)", () => {
    const text = "recipient = age1exampleexampleexampleexampleexampleexampleexample";
    expect(redactSecrets(text)).toBe(text);
  });
});

/**
 * The value side used to stop at the first whitespace, so the tail of a quoted
 * value survived: API_TOKEN="abc def" became API_TOKEN=[REDACTED] def".
 */
describe("secret assignments -- quoted values", () => {
  it("redacts a double-quoted value containing spaces, in full", () => {
    const out = redactSecrets('API_TOKEN="aaaa1111 bbbb2222 cccc3333"');
    expect(out).toBe("API_TOKEN=[REDACTED]");
  });

  it("redacts a single-quoted value containing spaces, in full", () => {
    const out = redactSecrets("API_TOKEN='aaaa1111 bbbb2222 cccc3333'");
    expect(out).toBe("API_TOKEN=[REDACTED]");
  });

  it("redacts a quoted value on a diff added line", () => {
    const out = redactSecrets('+API_TOKEN="aaaa1111 bbbb2222"');
    expect(out).toBe("+API_TOKEN=[REDACTED]");
  });

  it("redacts a quoted value on an indented line", () => {
    const out = redactSecrets('    DB_PASSWORD="aaaa1111 bbbb2222"');
    expect(out).toBe("    DB_PASSWORD=[REDACTED]");
  });

  it("redacts a quoted value with an equals sign inside it", () => {
    const out = redactSecrets('CF_API_TOKEN="aaaa=1111 bbbb=2222"');
    expect(out).toBe("CF_API_TOKEN=[REDACTED]");
  });

  it("still redacts a bare unquoted value", () => {
    expect(redactSecrets("GITHUB_TOKEN=aaaa1111bbbb2222")).toBe("GITHUB_TOKEN=[REDACTED]");
  });
});

/**
 * The catastrophic over-redaction shape: a quoted-value pattern that can cross a
 * newline will swallow every line between an opening quote and the next quote
 * anywhere in the payload. These pin it to a single line.
 */
describe("secret assignments -- must not bleed across lines", () => {
  it("does not swallow the lines after an assignment", () => {
    const payload = [
      'const before = "one";',
      'API_TOKEN="aaaa1111 bbbb2222"',
      "const after = compute(before);",
      'const trailing = "two";',
    ].join("\n");
    const out = redactSecrets(payload);
    expect(out).toContain('const before = "one";');
    expect(out).toContain("const after = compute(before);");
    expect(out).toContain('const trailing = "two";');
    expect(out).not.toContain("aaaa1111");
  });

  it("does not swallow following lines when a quote is left unterminated", () => {
    const payload = [
      'API_TOKEN="aaaa1111 unterminated',
      "const realCode = compute();",
      'const another = "a closing quote lives here";',
    ].join("\n");
    const out = redactSecrets(payload);
    expect(out).toContain("const realCode = compute();");
    expect(out).toContain('const another = "a closing quote lives here";');
  });
});

/**
 * Must-NOT for the assignment rule, and the reason this suite exists.
 *
 * The identifier side matches any name CONTAINING one of the keywords, so
 * ordinary camelCase source -- tokenizer, passwordInput, secretsManager --
 * parses as a secret assignment and the value side then eats the rest of the
 * statement. Every line below is secret-free source that must survive
 * byte-identical.
 */
describe("assignment rule -- must not eat real source", () => {
  const sourceLines = [
    "const tokenizer = new Tokenizer(input);",
    "let passwordInput = document.getElementById('pw');",
    "const secretsManager = require('./secrets-manager');",
    "this.tokens = tokenize(source);",
    "const apiKeyLabel = 'API Key';",
    "function refreshToken() { return fetch(url); }",
    "const tokenCount = tokens.length;",
    "let passwordStrength = score(candidate);",
    'const secretsPath = "config/secrets";',
    "const tokenizerOptions = { lowercase: true };",
  ];

  for (const line of sourceLines) {
    it("leaves untouched: " + line, () => {
      expect(redactSecrets(line)).toBe(line);
    });
  }
});

/**
 * The end-to-end control. A realistic secret-free payload in the exact shape
 * PR mode produces must come back byte-identical. This is the single assertion
 * that can tell a working redactor from one that redacts everything: it fails
 * the moment any rule becomes broad enough to touch ordinary code.
 */
describe("whole-payload behaviour", () => {
  const cleanDiff = [
    "# Git diff (main...HEAD)",
    "diff --git a/src/auth.mjs b/src/auth.mjs",
    "index 1111111..2222222 100644",
    "--- a/src/auth.mjs",
    "+++ b/src/auth.mjs",
    "@@ -1,8 +1,10 @@",
    " import { Tokenizer } from './tokenizer.mjs';",
    " ",
    "-const tokenizer = new Tokenizer();",
    "+const tokenizer = new Tokenizer({ lowercase: true });",
    "+const tokenCount = tokenizer.count(input);",
    " ",
    " export function refreshToken(session) {",
    "   const passwordInput = session.form.password;",
    "   return validate(passwordInput, tokenCount);",
    " }",
  ].join("\n");

  it("leaves a secret-free diff byte-identical", () => {
    expect(redactSecrets(cleanDiff)).toBe(cleanDiff);
  });

  it("redacts the secrets in a mixed diff and leaves the code intact", () => {
    const dirtyDiff = [
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1,2 +1,4 @@",
      " # deployment secrets",
      "+" + AGE_KEY,
      '+API_TOKEN="aaaa1111 bbbb2222 cccc3333"',
      " const tokenizer = new Tokenizer();",
      " export function refreshToken() { return 1; }",
    ].join("\n");

    const out = redactSecrets(dirtyDiff);

    // secrets gone
    expect(out).not.toContain("EXAMPLE");
    expect(out).not.toContain("aaaa1111");
    expect(out).not.toContain("cccc3333");
    expect(out).toContain("[REDACTED_AGE_KEY]");
    expect(out).toContain("API_TOKEN=[REDACTED]");

    // code and diff structure intact
    expect(out).toContain("@@ -1,2 +1,4 @@");
    expect(out).toContain("+++ b/.env");
    expect(out).toContain(" const tokenizer = new Tokenizer();");
    expect(out).toContain(" export function refreshToken() { return 1; }");
  });
});
