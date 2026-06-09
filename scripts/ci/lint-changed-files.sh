#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" \
  node scripts/ci/lint-changed-files.mjs "$@"
