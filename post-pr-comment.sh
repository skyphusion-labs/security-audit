#!/usr/bin/env bash
# post-pr-comment.sh -- upsert the advisory adversarial-audit PR comment.
#
# Usage: post-pr-comment.sh <pr-number> [report-markdown-path]
#
# Requires: gh, jq, GH_TOKEN, GITHUB_REPOSITORY

set -euo pipefail

pr_number="${1:?PR number required}"
report="${2:-audit-report.md}"
marker="<!-- adversarial-audit -->"

if [[ ! -f "$report" ]]; then
  echo "FATAL: report not found: $report" >&2
  exit 2
fi

{
  printf '%s\n\n' "$marker"
  cat "$report"
} > pr-comment.md

existing="$(
  gh api "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/comments" \
    --jq '.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("'"${marker}"'"))) | .id' \
    | head -1 || true
)"

if [[ -n "${existing}" ]]; then
  jq -n --rawfile body pr-comment.md '{body: $body}' \
    | gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${existing}" --input -
  echo "Updated adversarial-audit comment ${existing} on PR #${pr_number}"
else
  gh pr comment "$pr_number" --body-file pr-comment.md
  echo "Created adversarial-audit comment on PR #${pr_number}"
fi
