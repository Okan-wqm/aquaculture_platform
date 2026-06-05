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
#   BASE_BRANCH     default: main
#   GH_TOKEN        GitHub App/installation token with contents + PR scope

set -euo pipefail

BASE_BRANCH="${BASE_BRANCH:-main}"
PR_BRANCH="${PR_BRANCH:?PR_BRANCH is required}"
PR_TITLE="${PR_TITLE:?PR_TITLE is required}"
PR_BODY_FILE="${PR_BODY_FILE:?PR_BODY_FILE is required}"
COMMIT_MESSAGE="${COMMIT_MESSAGE:?COMMIT_MESSAGE is required}"
CHANGED_PATHS="${CHANGED_PATHS:?CHANGED_PATHS is required}"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

require_single_line() {
  local name="$1"
  local value="$2"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "::error::${name} must be a single line." >&2
    exit 2
  fi
}

require_single_line "BASE_BRANCH" "${BASE_BRANCH}"
require_single_line "PR_BRANCH" "${PR_BRANCH}"
require_single_line "PR_TITLE" "${PR_TITLE}"
require_single_line "COMMIT_MESSAGE" "${COMMIT_MESSAGE}"

if ! [[ "${PR_BRANCH}" =~ ^automation/[A-Za-z0-9._/-]+$ ]]; then
  echo "::error::PR_BRANCH must match automation/[A-Za-z0-9._/-]+: ${PR_BRANCH}" >&2
  exit 2
fi
case "${PR_BRANCH}" in
  *..*|*/|automation/)
    echo "::error::PR_BRANCH contains an unsafe path segment: ${PR_BRANCH}" >&2
    exit 2
    ;;
esac

if [ ! -f "${PR_BODY_FILE}" ]; then
  echo "::error::PR_BODY_FILE does not exist: ${PR_BODY_FILE}" >&2
  exit 2
fi

if [ -z "${GH_TOKEN:-}" ]; then
  echo "::error::GH_TOKEN is required for automation PR upsert; default GITHUB_TOKEN is not accepted." >&2
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

declare -A allowed_paths=()
for changed_path in "${changed_paths[@]}"; do
  allowed_paths["${changed_path}"]=1
done

while IFS= read -r dirty_path; do
  [ -n "${dirty_path}" ] || continue
  if [ -z "${allowed_paths[$dirty_path]+x}" ]; then
    echo "::error::Refusing automation PR with extra dirty path outside CHANGED_PATHS: ${dirty_path}" >&2
    exit 2
  fi
done < <(
  {
    git diff --name-only
    git diff --cached --name-only
    git ls-files --others --exclude-standard
  } | sort -u
)

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
