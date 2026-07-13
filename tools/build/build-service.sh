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

# ── Generated non-TS lib assets (e.g. wasm-bindgen bindings) ──
# WHY: tsc compiles a lib's *.ts sources into the dist tree but does NOT copy
# pre-generated .js/.wasm assets that the lib's index.ts imports (e.g.
# libs/protocol-codec/src/generated). Mirror any such `src/generated` dir into
# the dist tree — only when the owning lib was actually compiled into this
# service — so the emitted require() resolves at runtime.
while IFS= read -r gendir; do
  libsrc="$(dirname "${gendir}")"
  if [ -d "${DIST_DIR}/${libsrc}" ]; then
    mkdir -p "${DIST_DIR}/${gendir}"
    cp -r "${gendir}/." "${DIST_DIR}/${gendir}/"
  fi
done < <(find libs -type d -path '*/src/generated' 2>/dev/null)

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
