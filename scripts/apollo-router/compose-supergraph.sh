#!/usr/bin/env bash
set -euo pipefail

# R0 (2026-06-13): the Router supergraph is composed at BUILD time from the
# self-hosted registry — GraphOS/Studio is never a runtime availability
# dependency for production /graphql traffic, and a broken subgraph schema is a
# build failure rather than a gateway restart-loop.
#
# This is now a thin wrapper around scripts/apollo-router/build-supergraph.mjs
# (the canonical engine): it emits each subgraph's Federation v2 SDL from its
# code-first resolvers (no runtime — no DB/NATS/Redis, no @nestjs/apollo) and
# composes them with @apollo/composition. The previous path required the `rover`
# CLI binary AND pre-existing dist/graphql/subgraphs/*.graphql files that nothing
# generated — both removed.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_PATH="${1:-${ROOT_DIR}/dist/graphql/supergraph.graphql}"
DEFAULT_OUT="${ROOT_DIR}/dist/graphql/supergraph.graphql"

# Keep the gateway's generated registry artifacts (federated-subgraphs.generated.ts
# + supergraph-config) in sync before composing.
node "${ROOT_DIR}/scripts/graphql/validate-registry.mjs"
node "${ROOT_DIR}/scripts/graphql/generate-registry-artifacts.mjs"

# Emit SDLs + compose (writes DEFAULT_OUT, fails loud on composition errors).
node "${ROOT_DIR}/scripts/apollo-router/build-supergraph.mjs"

if [ "${OUTPUT_PATH}" != "${DEFAULT_OUT}" ]; then
  mkdir -p "$(dirname "${OUTPUT_PATH}")"
  cp "${DEFAULT_OUT}" "${OUTPUT_PATH}"
fi

test -s "${OUTPUT_PATH}"
echo "Composed supergraph: ${OUTPUT_PATH}"
