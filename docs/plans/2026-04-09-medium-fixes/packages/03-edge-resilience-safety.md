# Package 03: edge-resilience-safety

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 35K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [EDGE-MEDIUM-001, EDGE-MEDIUM-002, EDGE-MEDIUM-003, EDGE-MEDIUM-004, EDGE-MEDIUM-005, EDGE-MEDIUM-006, EDGE-MEDIUM-007, EDGE-MEDIUM-008]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/edge-expert/2026-04-05-targeted-security-audit.md

## Context
All eight findings are in the Rust edge agent (sens-api-gateway). They share file locality (all under sens-api-gateway/src/) and a common theme: defensive coding gaps in a life-safety-adjacent embedded system. Grouped as one package because Rust compilation is all-or-nothing and the fixes are small, independent changes within the same crate.

## Findings

**EDGE-MEDIUM-001 — RateLimiter panics on zero window**
The rate limiter divides by the window duration. If configured with `window_secs: 0`, this causes a division-by-zero panic. Add a guard: `max(window_secs, 1)` or reject zero at config parse time.

**EDGE-MEDIUM-002 — Unbounded string interner**
`src/interning.rs` uses a `HashMap` interner that grows without bound. Long-running edge agents accumulate every unique MQTT topic/tag seen. Add a max-capacity eviction policy (LRU or periodic flush).

**EDGE-MEDIUM-003 — zeroize dependency is optional**
Cryptographic key material in `src/security.rs` is not zeroized on drop. The `zeroize` crate is in `[dev-dependencies]` but not `[dependencies]`. Move it to required dependencies and derive `Zeroize` + `ZeroizeOnDrop` on key structs.

**EDGE-MEDIUM-004 — tokio::sync::Mutex used without comment on async cancellation**
Several critical sections use `tokio::sync::Mutex` without documenting why `std::sync::Mutex` is insufficient. Add `// WHY: held across .await` comments per CLAUDE.md marker convention, or switch to `std::sync::Mutex` where no `.await` is held.

**EDGE-MEDIUM-005 — MQTT select! loop cancel-safety**
The main MQTT processing loop uses `tokio::select!` with a branch that is not cancel-safe. If the MQTT future is dropped mid-message, the partial read is lost. Pin the MQTT stream processing in a dedicated task or use `biased;` with the MQTT branch first.

**EDGE-MEDIUM-006 — Backup endpoint uses magic header for auth**
`src/backup.rs` checks `X-Backup-Key` header against a hardcoded constant. Replace with the standard JWT-based auth flow or at minimum load the expected key from env/config.

**EDGE-MEDIUM-007 — Watchdog JoinHandle discarded**
`src/health.rs` spawns the hardware watchdog task but discards the `JoinHandle`. If the watchdog panics, the main loop never learns. Store the handle and check for panics in the health loop.

**EDGE-MEDIUM-008 — SCADA CSP allows unsafe-inline**
`src/scada_server.rs` sets `Content-Security-Policy` with `unsafe-inline` for script-src. The SCADA HMI should use nonce-based CSP instead.

## Affected Files
- sens-api-gateway/src/resilience/rate_limiter.rs (or equivalent)
- sens-api-gateway/src/interning.rs
- sens-api-gateway/src/security.rs
- sens-api-gateway/src/mqtt.rs
- sens-api-gateway/src/backup.rs
- sens-api-gateway/src/health.rs
- sens-api-gateway/src/scada_server.rs
- sens-api-gateway/Cargo.toml (zeroize dependency)

## Dependencies
None. Edge agent is an independent Rust crate with no backend service dependencies.

## Atomic Commit Plan
```
fix(edge): harden rate limiter, interner, zeroize, MQTT cancel-safety, backup auth, watchdog handle, SCADA CSP

Eight defensive fixes in the Rust edge agent:
- Guard against zero-window division in rate limiter
- Add LRU eviction to string interner (max 10K entries)
- Promote zeroize to required dep, derive ZeroizeOnDrop on key structs
- Add WHY comments on tokio::sync::Mutex usage or switch to std::sync::Mutex
- Fix MQTT select! cancel-safety by pinning stream processing
- Replace magic X-Backup-Key header with env-loaded secret
- Store watchdog JoinHandle and check for panics
- Replace unsafe-inline with nonce-based CSP in SCADA server

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#EDGE-MEDIUM-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#EDGE-MEDIUM-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#EDGE-MEDIUM-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#EDGE-MEDIUM-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#EDGE-MEDIUM-005
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#EDGE-MEDIUM-006
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#EDGE-MEDIUM-007
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#EDGE-MEDIUM-008
Plan: docs/plans/2026-04-09-medium-fixes/packages/03-edge-resilience-safety.md
```

## Test Plan
- Unit test: RateLimiter with window_secs=0 does not panic
- Unit test: Interner evicts after capacity threshold
- Compile-time verify: zeroize derives on key structs (build failure if missing)
- Integration test: MQTT message processing survives select cancellation
- Unit test: backup endpoint rejects requests without correct env-loaded key
- Unit test: watchdog panic propagates to health check

## Verification Command
`cd /var/aqua-saas/sens-api-gateway && cargo check && cargo test`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
