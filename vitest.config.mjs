import { defineConfig } from "vitest/config";

// Coverage floors, set just below the measured values so coverage can only go up.
// Raise them when the measured numbers rise; never lower one to make a change pass.
// `npm run test:coverage` (what the ci workflow runs) enforces these; plain `npm test`
// does not collect coverage.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["adversarial-audit.mjs", "redact.mjs"],
      thresholds: {
        "adversarial-audit.mjs": { statements: 94, branches: 91, functions: 96, lines: 94 },
        "redact.mjs": { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
