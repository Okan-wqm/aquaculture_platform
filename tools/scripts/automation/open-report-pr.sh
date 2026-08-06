#!/usr/bin/env bash
# Create or update an automation PR for generated reports/state changes.
#
# Required environment:
#   PR_BRANCH       automation branch name
#   PR_TITLE        pull request title
#   PR_BODY_FILE    markdown body file
#   COMMIT_MESSAGE  single-line commit message
#   CHANGED_PATHS   newline-separated repo-relative paths to stage
#
# Optional environment:
#   BASE_BRANCH       default: main
#   GH_TOKEN          GitHub token with contents:write + pull-requests:write
#   GITHUB_TOKEN      fallback token
#   PR_TOKEN_SOURCE   which identity the caller resolved ("aria-github-app"
#                     or "actions-default"). A PR authored by the Actions
#                     default token does not trigger workflow runs, so the
#                     body must say so — an unchecked PR that looks checked
#                     is worse than a red workflow.

set -euo pipefail

BASE_BRANCH="${BASE_BRANCH:-main}"
PR_BRANCH="${PR_BRANCH:?PR_BRANCH is required}"
PR_TITLE="${PR_TITLE:?PR_TITLE is required}"
PR_BODY_FILE="${PR_BODY_FILE:?PR_BODY_FILE is required}"
COMMIT_MESSAGE="${COMMIT_MESSAGE:?COMMIT_MESSAGE is required}"
CHANGED_PATHS="${CHANGED_PATHS:?CHANGED_PATHS is required}"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

case "${PR_BRANCH}" in
  automation/*) ;;
  *)
    echo "::error::PR_BRANCH must stay under automation/: ${PR_BRANCH}" >&2
    exit 2
    ;;
esac

if [ ! -f "${PR_BODY_FILE}" ]; then
  echo "::error::PR_BODY_FILE does not exist: ${PR_BODY_FILE}" >&2
  exit 2
fi

if [ -z "${TOKEN}" ]; then
  echo "::error::GH_TOKEN or GITHUB_TOKEN is required for automation PR upsert." >&2
  exit 2
fi

mapfile -t changed_paths < <(printf '%s\n' "${CHANGED_PATHS}" | awk 'NF { print }')
if [ "${#changed_paths[@]}" -eq 0 ]; then
  echo "::error::CHANGED_PATHS did not contain any stageable paths." >&2
  exit 2
fi

for changed_path in "${changed_paths[@]}"; do
  if [[ "${changed_path}" == /* || "${changed_path}" == *".."* ]]; then
    echo "::error::CHANGED_PATHS entries must be exact repo-relative paths: ${changed_path}" >&2
    exit 2
  fi
  if [[ "${changed_path}" == *"*"* || "${changed_path}" == *"?"* || "${changed_path}" == *"["* || "${changed_path}" == *"]"* ]]; then
    echo "::error::CHANGED_PATHS entries must not contain shell globs: ${changed_path}" >&2
    exit 2
  fi
  if [ ! -e "${changed_path}" ]; then
    echo "::error::CHANGED_PATHS entry does not exist: ${changed_path}" >&2
    exit 2
  fi
done

if [ -n "${GITHUB_REPOSITORY:-}" ]; then
  echo "::add-mask::${TOKEN}"
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git checkout -B "${PR_BRANCH}"

git add -- "${changed_paths[@]}"
if git diff --staged --quiet; then
  echo "No staged changes for ${PR_BRANCH}; nothing to publish."
  exit 0
fi

git commit -m "${COMMIT_MESSAGE}"
git fetch --force --prune origin "${BASE_BRANCH}"
git rebase "origin/${BASE_BRANCH}"

if [ -n "${GITHUB_REPOSITORY:-}" ]; then
  git remote set-url origin "https://x-access-token:${TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
fi

git push --force-with-lease origin "HEAD:${PR_BRANCH}"

if [ "${PR_TOKEN_SOURCE:-}" = "actions-default" ]; then
  # ARIA_GITHUB_APP_TOKEN is not provisioned on this repository, so the
  # caller fell back to the Actions default token. GitHub deliberately does
  # not run workflows for PRs authored by that token; a reviewer who cannot
  # see why checks are missing would read their absence as "nothing to run".
  {
    echo ""
    echo "---"
    echo ""
    echo "**Opened with the Actions default token** because \`ARIA_GITHUB_APP_TOKEN\`"
    echo "is not provisioned. GitHub does not trigger workflow runs for PRs authored"
    echo "by that token, so the absence of checks here is the token's doing, not a"
    echo "verdict on the change. Close-and-reopen this PR to make the checks run, or"
    echo "provision the App token in the \`automation-publication\` environment."
  } >> "${PR_BODY_FILE}"
fi

existing_pr="$(
  GH_TOKEN="${TOKEN}" gh pr list \
    --head "${PR_BRANCH}" \
    --base "${BASE_BRANCH}" \
    --state open \
    --json number \
    --jq '.[0].number // empty'
)"

if [ -n "${existing_pr}" ]; then
  GH_TOKEN="${TOKEN}" gh pr edit "${existing_pr}" \
    --title "${PR_TITLE}" \
    --body-file "${PR_BODY_FILE}"
  pr_url="$(GH_TOKEN="${TOKEN}" gh pr view "${existing_pr}" --json url --jq '.url')"
else
  pr_url="$(
    GH_TOKEN="${TOKEN}" gh pr create \
      --base "${BASE_BRANCH}" \
      --head "${PR_BRANCH}" \
      --title "${PR_TITLE}" \
      --body-file "${PR_BODY_FILE}"
  )"
fi

echo "automation_pr_url=${pr_url}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Automation PR"
    echo ""
    echo "- Branch: \`${PR_BRANCH}\`"
    echo "- PR: ${pr_url}"
  } >> "${GITHUB_STEP_SUMMARY}"
fi
