# 2026-05-05 - CI Rust Toolchain Parallel Build Race

## Affected Area
- `.github/workflows/ci-affected.yml`
- `.github/workflows/performance-benchmark.yml`
- `ci-affected` lint/type-check/test/build jobs
- `crates/event-contracts-rs/project.json`
- `crates/protocol-codec/project.json`

## Observed Issue
GitHub Actions `build` failed when Nx ran Rust crate builds in parallel. One crate reported that `cargo` was not applicable to the pinned toolchain, while another reported rustup rename/download state errors under `~/.rustup`. The Lighthouse workflow has the same risk because it runs the affected Nx build graph before serving frontend assets. The `type-check` and `test` jobs have the same class of failure when affected Rust targets start before the pinned toolchain is installed.

## Root Cause
Nx can start multiple cargo-backed build targets concurrently. If the pinned Rust toolchain from `rust-toolchain.toml` is not installed before that parallel execution starts, multiple cargo/rustup processes can attempt to install or mutate the same toolchain directory at the same time. A workflow-level toolchain action without explicit toolchain/components/targets is not enough because cargo can still trigger rustup during Nx execution.

## Architectural Fix
Install the pinned Rust toolchain once in every CI job that can run Rust-backed Nx build targets before the Nx graph starts. The workflow declaration must explicitly match `rust-toolchain.toml` for `toolchain`, `components`, and `targets`; this creates a single deterministic toolchain preparation boundary and keeps Nx parallelism for actual build work.

## Verification
- Local `npx nx run event-contracts-rs:build` could not complete because this server does not have `cargo` on `PATH`.
- Full validation must run in GitHub Actions where the workflow installs the pinned toolchain before Nx build.

## Status
Fixed in affected lint/type-check/test/build and Lighthouse workflows on 2026-05-05; pending GitHub Actions confirmation.
