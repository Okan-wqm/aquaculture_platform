# Package 16: rust-edge-tracing

## Metadata
Status: PENDING
Estimated Tokens: 20K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
The Rust edge agent (sens-api-gateway) uses `eprintln!` for error output instead of the `tracing` crate which is already a dependency in Cargo.toml. Additionally, the CI workflow has no Rust test job despite 68 source files. The `tracing` crate is configured in Cargo.toml with clippy lints `print_stdout = "warn"` and `print_stderr = "warn"`, confirming the project intent to use tracing, but compliance is incomplete.

## Findings

**MEDIUM-019 [edge-expert]: Rust edge agent uses eprintln! instead of tracing**
- File: `sens-api-gateway/src/main.rs` (lines 87-92, 99)
- `tracing` and `tracing-subscriber` already in Cargo.toml dependencies
- Clippy config already warns on print_stdout/print_stderr
- Remediation: Replace `eprintln!` with `tracing::error!` / `tracing::warn!`

**MEDIUM-020 [test-runner]: CI workflow does not run edge-agent (Rust) tests**
- 68 Rust source files have no automated quality gate in CI
- Cargo.toml includes test dependencies
- Remediation: Add `cargo test` and `cargo clippy` jobs to ci-full.yml

Closing-Findings: [MEDIUM-019, MEDIUM-020]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Affected Files
- `/var/aqua-saas/sens-api-gateway/src/main.rs`
- `/var/aqua-saas/.github/workflows/ci-full.yml`

## Dependencies
None. Rust edge agent is an independent component.

Note: main.rs is 58541 bytes (~17K tokens). Executor should focus on the specific `eprintln!` lines (87-92, 99) and grep for other `eprintln!`/`println!` usages rather than loading the entire file.

## Atomic Commit Plan
```
fix(edge): replace eprintln! with tracing macros, add Rust CI job

main.rs: Replace eprintln! (lines 87-92, 99) and any other print
macros with tracing::error!/warn!/info!. The tracing subscriber is
already initialized — these calls bypassed it.

ci-full.yml: Add Rust job with cargo test, cargo clippy, and cargo
fmt --check for the sens-api-gateway crate.

Plan: docs/plans/2026-04-09-full-remediation/packages/16-rust-edge-tracing.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-019
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-020
```

## Test Plan
- Run `cargo test` in sens-api-gateway directory
- Run `cargo clippy -- -D warnings` to verify no print_stdout/print_stderr warnings
- Verify CI YAML is valid
- Grep for remaining `eprintln!`/`println!` in Rust source

## Verification Command
`cd /var/aqua-saas/sens-api-gateway && cargo clippy -- -D warnings 2>&1 | head -50 && cargo test 2>&1 | tail -20`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
