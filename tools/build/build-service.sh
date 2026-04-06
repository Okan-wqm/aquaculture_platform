#!/bin/bash
# tools/build/build-service.sh — Enterprise build script for NestJS services
# Replaces webpack with direct tsc compilation.
# Usage: bash tools/build/build-service.sh <service-name>
set -euo pipefail

SERVICE_NAME="${1:?Usage: build-service.sh <service-name>}"
DIST_DIR="dist/apps/${SERVICE_NAME}"

# ── Clean ──
rm -rf "${DIST_DIR}"

# ── Compile ──
# WHY: Direct tsc preserves decorator metadata (emitDecoratorMetadata).
# Webpack's module evaluation order breaks this — see design spec.
npx tsc -p "apps/${SERVICE_NAME}/tsconfig.build.json"

# ── Path Resolution ──
# WHY: tsc does NOT rewrite path aliases in emitted JS.
# tsc-alias rewrites @platform/* and @aquaculture/* to relative paths
# so all require() calls resolve within the dist directory.
npx tsc-alias -p "apps/${SERVICE_NAME}/tsconfig.build.json" --outDir "${DIST_DIR}"

# ── Assets ──
if [ -d "apps/${SERVICE_NAME}/src/assets" ]; then
  mkdir -p "${DIST_DIR}/apps/${SERVICE_NAME}/src/assets"
  cp -r "apps/${SERVICE_NAME}/src/assets/." "${DIST_DIR}/apps/${SERVICE_NAME}/src/assets/"
fi

# ── Entry Shim ──
# WHY: With rootDir=workspace-root, tsc outputs to dist/apps/{svc}/apps/{svc}/src/main.js.
# Docker expects `node dist/main.js`. This shim bridges the gap.
cat > "${DIST_DIR}/main.js" << SHIM
'use strict';
require('./apps/${SERVICE_NAME}/src/main');
SHIM

# ── Verify ──
node --check "${DIST_DIR}/main.js"
node --check "${DIST_DIR}/apps/${SERVICE_NAME}/src/main.js"

echo "BUILD OK: ${SERVICE_NAME}"
