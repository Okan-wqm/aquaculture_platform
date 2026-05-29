#!/usr/bin/env bash
set -euo pipefail

# 2026-04-30: Compose the Router supergraph from the self-hosted registry source.
# WHY: Router must boot from a static supergraph artifact; GraphOS/Studio must not
# be a runtime availability dependency for production /graphql traffic.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_PATH="${1:-${ROOT_DIR}/dist/graphql/supergraph.graphql}"
CONFIG_PATH="${ROOT_DIR}/infrastructure/apollo-router/supergraph-config.generated.yaml"

if ! command -v rover >/dev/null 2>&1; then
  echo "rover CLI is required for supergraph composition." >&2
  exit 1
fi

mkdir -p "$(dirname "${OUTPUT_PATH}")"

node "${ROOT_DIR}/scripts/graphql/validate-registry.mjs"
node "${ROOT_DIR}/scripts/graphql/generate-registry-artifacts.mjs"

rover supergraph compose --config "${CONFIG_PATH}" > "${OUTPUT_PATH}"

test -s "${OUTPUT_PATH}"
echo "Composed supergraph: ${OUTPUT_PATH}"
