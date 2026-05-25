#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

BASE_REF="origin/main"
HEAD_REF="HEAD"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE_REF="${2:-}"
      shift 2
      ;;
    --head)
      HEAD_REF="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

mapfile -t CHANGED_TS_FILES < <(
  git diff --name-only --diff-filter=ACMR "$BASE_REF...$HEAD_REF" \
    | grep -E '\.(ts|tsx)$' \
    | grep -Ev '\.d\.ts$' \
    | grep -Ev '^apps/[^/]+/src/database/migrations/[0-9]{13}-Baseline\.ts$' \
    || true
)

if [[ "${#CHANGED_TS_FILES[@]}" -eq 0 ]]; then
  echo "No changed TypeScript files require file-level lint."
  exit 0
fi

echo "File-level lint changed TypeScript files:"
printf '  %s\n' "${CHANGED_TS_FILES[@]}"

# Project-level lint can be explicitly quarantined while monorepo debt is paid
# down. This file-level gate is intentionally not quarantined: touched app/lib
# files must not introduce new lint failures. Generated TypeORM baselines are
# excluded above because they are very large and are covered by migration SQL
# lint plus TypeScript checks.
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" \
  npx eslint --max-warnings=0 "${CHANGED_TS_FILES[@]}"
