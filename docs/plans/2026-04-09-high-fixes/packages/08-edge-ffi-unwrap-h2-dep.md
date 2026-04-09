# Package 08: edge-ffi-unwrap-h2-dep

## Metadata
Status: PENDING
Estimated Tokens: 20K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Closing-Findings: [EDGE-HIGH-004, EDGE-HIGH-005, EDGE-HIGH-006]
Source-Reviews:
  - docs/reviews/edge-expert/2026-04-05-s2-high-findings.md

## Context
Three edge agent reliability/safety findings: (1) FFI unsafe lgw_receive() nb_pkt used as slice bound without explicit assertion -- C HAL bug causes uncontrolled panic, (2) unwrap() on config-controlled Option in production path -- race between two read() locks causes panic, (3) h2 0.4.13 dependency tracking gap -- deny.toml advisory-db path broken in CI. All affect resource availability per IEC 62443 FR-7.

## Findings

**EDGE-HIGH-004** (edge-expert, HIGH)
File: sens-api-gateway/src/lora/sx1302.rs (lines 207-215)
nb_pkt from lgw_receive() is cast as usize slice bound without asserting nb_pkt <= pkt_buf.len(). C HAL bug returning count > buffer capacity causes uncontrolled panic. MAX_RX_PACKETS as u8 may silently truncate if > 255. IEC 62443 FR-7.

**EDGE-HIGH-005** (edge-expert, HIGH)
File: sens-api-gateway/src/main.rs (line 1423)
unwrap() on lorawan.as_ref() in production path. Two separate read() lock acquisitions with no guarantee lorawan remains Some between them. Config update race can cause panic. Violates established error propagation pattern.

**EDGE-HIGH-006** (edge-expert, HIGH)
File: sens-api-gateway/Cargo.lock (h2 entry)
h2 0.4.13 transitive dependency via reqwest. deny.toml advisory-db path uses user-home-relative path that is not populated in CI, effectively disabling advisory checks. cargo deny check not in CI pipeline.

## Affected Files
- sens-api-gateway/src/lora/sx1302.rs
- sens-api-gateway/src/main.rs
- sens-api-gateway/Cargo.lock
- sens-api-gateway/Cargo.toml
- sens-api-gateway/deny.toml

## Dependencies
None. Rust edge agent is standalone.

## Atomic Commit Plan
```
fix(edge): add FFI bounds assertion, replace unwrap with error propagation, fix cargo-deny CI

lgw_receive() nb_pkt used as slice bound without bounds assertion -- C HAL
bug causes uncontrolled panic. unwrap() on config Option has race between
two read() locks. deny.toml advisory-db path broken in CI disabling
vulnerability checks. All IEC 62443 FR-7 resource availability violations.

Add nb_pkt bounds assertion after unsafe block with compile-time MAX_RX_PACKETS
check. Collapse LoRaWAN init into single lock acquisition with ok_or_else
error propagation. Fix deny.toml db-path for CI, add cargo deny check to
CI pipeline.

Plan: docs/plans/2026-04-09-high-fixes/packages/08-edge-ffi-unwrap-h2-dep.md
Closes: docs/reviews/edge-expert/2026-04-05-s2-high-findings.md#H-04
Closes: docs/reviews/edge-expert/2026-04-05-s2-high-findings.md#H-05
Closes: docs/reviews/edge-expert/2026-04-05-s2-high-findings.md#H-06
```

## Test Plan
- Unit test: nb_pkt > buffer capacity returns error instead of panicking
- Unit test: MAX_RX_PACKETS compile-time assertion (const assertion)
- Unit test: LoRaWAN init with None config returns error not panic
- Verify cargo deny check passes with corrected db-path
- Verify CI pipeline includes cargo deny step

## Verification Command
`cd sens-api-gateway && cargo test && cargo clippy -- -D warnings && cargo deny check`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
