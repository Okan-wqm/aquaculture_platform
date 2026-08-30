# protocol-codec → WebAssembly — Modbus decode SSoT for the backend

**Date:** 2026-07-13
**Reviewer:** claude (WASM adoption research)
**Scope:** `crates/protocol-codec`, new `crates/protocol-codec-wasm`, new `libs/protocol-codec`, `apps/sensor-service/src/vfd/adapters/base-vfd.adapter.ts`
**Workstream:** WASM adoption plan — Phase 2 (`docs/plans/2026-07-13-wasm-adoption`)

---

## Summary

`protocol-codec` is the drift-zero Modbus parser SSoT (ADR-026), consumed by the
edge gateway and the Rust ingestion sidecar. The NestJS backend re-implemented
pieces of the same bit-level decoding by hand — the VFD adapter's CRC-16-Modbus
loop (`base-vfd.adapter.ts`) is byte-for-byte the algorithm the crate already
owns — which is exactly the divergence ADR-026 exists to prevent. ADR-025
rejected NAPI-RS (a Rust panic would crash the NestJS process; the `.node` ABI is
fragile). WebAssembly is the middle path: a memory-isolated sandbox, no shared
crash domain, no native ABI.

## Findings

| ID                    | Severity | Statement                                                                                                                                                                   |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CODEC-WASM-HIGH-001   | HIGH     | CRC-16-Modbus was hand-rolled in `base-vfd.adapter.ts` (init 0xFFFF, poly 0xA001), duplicating `protocol-codec` with no parity test — a silent-drift vector on VFD framing. |
| CODEC-WASM-MEDIUM-002 | MEDIUM   | The Rust golden-fixture harness documented a TypeScript twin that did not exist, so cross-language decode parity was Rust-only (untested on the backend side).              |

## Resolution

- **Toolchain.** `crates/protocol-codec-wasm` wraps the crate with `wasm-bindgen`;
  `libs/protocol-codec` (`@platform/protocol-codec`) is the typed TS façade over
  the `--target nodejs` output (embedded `.wasm`, synchronous `require`, so every
  call is sync with no async init). `rust-toolchain.toml` gains `wasm32-unknown-unknown`;
  `libs/protocol-codec/scripts/build-wasm.sh` regenerates the committed bindings
  (cargo + `wasm-bindgen` `0.2.100`, pinned via the crate's own `Cargo.lock`), and
  the `codec-drift` CI job regenerates + `git diff --exit-code` to block stale
  artifacts. `build-service.sh` mirrors `libs/**/src/generated` into the service
  dist so the emitted `require()` resolves at runtime (verified end-to-end).
- **CODEC-WASM-HIGH-001** — `base-vfd.adapter.ts` `calculateCRC16` now delegates to
  the wasm `crc16Modbus`; the hand-rolled loop is deleted. Behaviour-preserving
  (the existing spec still asserts `0xCDC5`).
- **CODEC-WASM-MEDIUM-002** — `apps/sensor-service/src/protocol/adapters/__tests__/protocol-codec-golden.spec.ts`
  is the twin: it drives the wasm façade over the SAME `crates/protocol-codec/tests/golden/*.json`
  fixtures the Rust harness asserts, proving byte-identical output (17 cases).

## Explicitly deferred (documented, not hidden)

The industrial `parseRegisterData` reinterpretation (registers → typed scalar,
byte/word order) and the VFD-TCP hand-parsed MBAP path are NOT migrated here.
The current TS `parseRegisterData` has quirks (LE layout then BE interpretation;
word-swap only the first 32 bits) that are field behaviour — porting them is a
semantics-canon decision (like the Phase 4 alarm core), not a mechanical swap, so
it belongs in a focused follow-up with its own fixtures. This phase deliberately
lands only behaviour-preserving units (CRC + the drift-proof harness) plus the
toolchain Phase 4B reuses.
