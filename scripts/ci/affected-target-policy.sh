#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

TARGET=""
BASE_REF="origin/main"
HEAD_REF="HEAD"
PARALLEL="2"
POLICY_PATH="$ROOT_DIR/scripts/ci/affected-target-policy.json"
ARTIFACT_DIR="$ROOT_DIR/artifacts/ci-affected-policy"
DRY_RUN="false"
EXCLUDES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --base)
      BASE_REF="${2:-}"
      shift 2
      ;;
    --head)
      HEAD_REF="${2:-}"
      shift 2
      ;;
    --parallel)
      PARALLEL="${2:-}"
      shift 2
      ;;
    --policy)
      POLICY_PATH="$ROOT_DIR/${2:-}"
      shift 2
      ;;
    --artifact-dir)
      ARTIFACT_DIR="$ROOT_DIR/${2:-}"
      shift 2
      ;;
    --exclude)
      EXCLUDES+=("${2:-}")
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "--target is required" >&2
  exit 2
fi

if [[ ! "$TARGET" =~ ^[A-Za-z0-9:_-]+$ ]]; then
  echo "Invalid target: $TARGET" >&2
  exit 2
fi

if [[ ! "$PARALLEL" =~ ^[0-9]+$ ]]; then
  echo "Invalid --parallel value: $PARALLEL" >&2
  exit 2
fi

# A target that NO project declares must fail the lane, never pass it.
# `nx show projects --with-target=<phantom>` resolves to an empty set, and an
# empty set used to fall through to "no strict projects remain … exit 0": the
# lane over `test:invariant` was green for months without running a single
# spec (INFRA-HIGH-152). Resolved before the diff so it fires on every
# invocation — no-change PRs and --dry-run included.
DECLARING_PROJECTS_JSON="$(NX_DAEMON="${NX_DAEMON:-false}" NX_NO_CLOUD="${NX_NO_CLOUD:-true}" \
  node tools/toolchain/run.mjs npx nx show projects "--with-target=$TARGET" --json)"
DECLARING_COUNT="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).length))' "$DECLARING_PROJECTS_JSON")"
if [[ "$DECLARING_COUNT" == "0" ]]; then
  echo "No project in the workspace declares target '$TARGET'; refusing to run a lane that can only be green." >&2
  exit 2
fi

mkdir -p "$ARTIFACT_DIR"
CHANGED_FILE_LIST="$ARTIFACT_DIR/$TARGET.changed-files.txt"
AFFECTED_PROJECT_LIST="$ARTIFACT_DIR/$TARGET.affected-projects.txt"
STRICT_PROJECT_LIST="$ARTIFACT_DIR/$TARGET.strict-projects.txt"
EXCLUDE_LIST="$ARTIFACT_DIR/$TARGET.explicit-excludes.txt"
REPORT_PATH="$ARTIFACT_DIR/$TARGET.json"

node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); for (const item of p.metadataExcludes ?? ['.npmrc','package.json','package-lock.json']) console.log(item);" "$POLICY_PATH" > "$ARTIFACT_DIR/$TARGET.metadata-excludes.txt"
printf '%s\n' "${EXCLUDES[@]}" > "$EXCLUDE_LIST"

git diff --name-only "$BASE_REF" "$HEAD_REF" -- \
  | grep -Fvx -f "$ARTIFACT_DIR/$TARGET.metadata-excludes.txt" \
  > "$CHANGED_FILE_LIST" || true

if [[ ! -s "$CHANGED_FILE_LIST" ]]; then
  : > "$AFFECTED_PROJECT_LIST"
  : > "$STRICT_PROJECT_LIST"
  node scripts/ci/write-affected-target-report.mjs \
    --target "$TARGET" \
    --base "$BASE_REF" \
    --head "$HEAD_REF" \
    --policy "$POLICY_PATH" \
    --changed-files "$CHANGED_FILE_LIST" \
    --affected-projects "$AFFECTED_PROJECT_LIST" \
    --explicit-excludes "$EXCLUDE_LIST" \
    --strict-projects "$STRICT_PROJECT_LIST" \
    --report "$REPORT_PATH" \
    --dry-run "$DRY_RUN"
  echo "No source files affected beyond root package metadata; skipping $TARGET."
  exit 0
fi

# --json, then one name per line. Without --json the shape of this output is
# environment-dependent: newline-separated names on a GitHub runner, a single
# JSON array (`["a","b"]`) when piped elsewhere — and a JSON array read as one
# "project name" turns the strict list into a value Nx matches to nothing
# (`nx run-many --projects=["a","b"]` reports "No tasks were run" and exits 0).
node tools/toolchain/run.mjs npx nx show projects --affected "--base=$BASE_REF" "--head=$HEAD_REF" "--with-target=$TARGET" --json \
  | node -e 'const names = JSON.parse(require("fs").readFileSync(0, "utf8")); if (!Array.isArray(names)) throw new Error("nx show projects --json did not return an array"); for (const name of names) process.stdout.write(`${name}\n`);' \
  | sort > "$AFFECTED_PROJECT_LIST"

node scripts/ci/write-affected-target-report.mjs \
  --target "$TARGET" \
  --base "$BASE_REF" \
  --head "$HEAD_REF" \
  --policy "$POLICY_PATH" \
  --changed-files "$CHANGED_FILE_LIST" \
  --affected-projects "$AFFECTED_PROJECT_LIST" \
  --explicit-excludes "$EXCLUDE_LIST" \
  --strict-projects "$STRICT_PROJECT_LIST" \
  --report "$REPORT_PATH" \
  --dry-run "$DRY_RUN"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run requested; no Nx target executed."
  exit 0
fi

if [[ ! -s "$STRICT_PROJECT_LIST" ]]; then
  echo "No strict $TARGET projects remain after explicit quarantine/excludes."
  exit 0
fi

STRICT_PROJECTS="$(paste -sd, "$STRICT_PROJECT_LIST")"
echo "Running strict Nx target: node tools/toolchain/run.mjs npx nx run-many --target=$TARGET --projects=$STRICT_PROJECTS --parallel=$PARALLEL"
NX_DAEMON="${NX_DAEMON:-false}" NX_NO_CLOUD="${NX_NO_CLOUD:-true}" \
  node tools/toolchain/run.mjs npx nx run-many "--target=$TARGET" "--projects=$STRICT_PROJECTS" "--parallel=$PARALLEL"
