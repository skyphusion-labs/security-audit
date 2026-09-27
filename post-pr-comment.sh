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

# --paginate: the API returns 30 comments per page, so a marker comment past the
# first page would otherwise be missed and duplicated. A failed listing aborts
# (set -e) instead of falling through to post a second comment.
matches="$(
  gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/comments" \
    --jq '.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("'"${marker}"'"))) | .id'
)"
existing="${matches%%$'\n'*}"

if [[ -n "${existing}" ]]; then
  jq -n --rawfile body pr-comment.md '{body: $body}' \
    | gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${existing}" --input -
  echo "Updated adversarial-audit comment ${existing} on PR #${pr_number}"
else
  gh pr comment "$pr_number" --body-file pr-comment.md
  echo "Created adversarial-audit comment on PR #${pr_number}"
fi
