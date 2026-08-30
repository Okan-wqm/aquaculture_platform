#!/usr/bin/env bash
# Regenerate the alarm-core WebAssembly bindings consumed by @platform/alarm-core.
# cargo + wasm-bindgen (pinned 0.2.127), deterministic given the pinned lock.
# Output is committed under src/generated; CI regenerates + the golden twin
# proves functional parity.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CRATE_DIR="$REPO_ROOT/crates/alarm-core-wasm"
OUT_DIR="$REPO_ROOT/libs/alarm-core/src/generated"
WASM="$REPO_ROOT/target/wasm32-unknown-unknown/release/alarm_core_wasm.wasm"
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

echo "[alarm-core] building crate for wasm32-unknown-unknown…"
(cd "$CRATE_DIR" && cargo build --locked --target wasm32-unknown-unknown --release)
echo "[alarm-core] generating nodejs bindings…"
rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"
wasm-bindgen --target nodejs --out-dir "$OUT_DIR" "$WASM"
echo "[alarm-core] done."
