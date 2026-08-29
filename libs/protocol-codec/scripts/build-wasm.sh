#!/usr/bin/env bash
# Regenerate the protocol-codec WebAssembly bindings consumed by
# @platform/protocol-codec.
#
# Mirrors what `wasm-pack build --target nodejs` would do, but driven directly
# by cargo + wasm-bindgen so it works on the repo's pinned rustc (1.88) without
# the newer rustc that recent wasm-pack requires. Output is committed under
# src/generated (deterministic given the pinned wasm-bindgen version), and CI
# regenerates + git-diffs to guard against drift.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CRATE_DIR="$REPO_ROOT/crates/protocol-codec-wasm"
OUT_DIR="$REPO_ROOT/libs/protocol-codec/src/generated"
WASM="$REPO_ROOT/target/wasm32-unknown-unknown/release/protocol_codec_wasm.wasm"
WASM_BINDGEN_VERSION="0.2.127"

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "error: wasm-bindgen CLI not found. Install: cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked" >&2
  exit 1
fi

actual_wasm_bindgen_version="$(wasm-bindgen --version)"
if [ "$actual_wasm_bindgen_version" != "wasm-bindgen ${WASM_BINDGEN_VERSION}" ]; then
  echo "error: expected wasm-bindgen ${WASM_BINDGEN_VERSION}, got ${actual_wasm_bindgen_version}" >&2
  exit 1
fi

echo "[protocol-codec] building crate for wasm32-unknown-unknown…"
(cd "$CRATE_DIR" && cargo build --locked --target wasm32-unknown-unknown --release)

echo "[protocol-codec] generating nodejs bindings into src/generated…"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
wasm-bindgen --target nodejs --out-dir "$OUT_DIR" "$WASM"

echo "[protocol-codec] done."
