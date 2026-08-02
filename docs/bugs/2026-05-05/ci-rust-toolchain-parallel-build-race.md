# 2026-05-05 - CI Rust Toolchain Parallel Build Race

## Affected Area

- `.github/workflows/ci-affected.yml`
- `.github/workflows/ci-full.yml`
- `.github/workflows/performance-benchmark.yml`
- `.github/actions/setup-rust-workspace/action.yml`
- `ci-affected` lint/type-check/test/build jobs
- `crates/event-contracts-rs/project.json`
- `crates/protocol-codec/project.json`

## Observed Issue

GitHub Actions `build` failed when Nx ran Rust crate builds in parallel. One crate reported that `cargo` was not applicable to the pinned toolchain, while another reported rustup rename/download state errors under `~/.rustup`. The Lighthouse workflow has the same risk because it runs the affected Nx build graph before serving frontend assets. The `type-check` and `test` jobs have the same class of failure when affected Rust targets start before the pinned toolchain is installed.

## Root Cause

Nx can start multiple cargo-backed build targets concurrently. If the pinned Rust toolchain from `rust-toolchain.toml` is not installed before that parallel execution starts, multiple cargo/rustup processes can attempt to install or mutate the same toolchain directory at the same time. A workflow-level toolchain action without explicit toolchain/components/targets is not enough because cargo can still trigger rustup during Nx execution.

## Architectural Fix

Install the pinned Rust toolchain once in every CI job that can run Rust-backed Nx targets before the Nx graph starts. A repository-owned composite action derives `toolchain`, `components`, and `targets` from the generated Rust manifest, installs them through the pinned upstream action, and then verifies both manifest parity with `rust-toolchain.toml` and the installed toolchain. This creates a single deterministic preparation boundary without repeating the toolchain contract across workflows and keeps Nx parallelism for actual build work.

## Verification

- Local `npx nx run event-contracts-rs:build` could not complete because this server does not have `cargo` on `PATH`.
- The setup action is contract-tested for manifest derivation, action pinning, and ordering before every broad root-workspace Nx command.
- Full validation runs in GitHub Actions where the workflow installs and verifies the complete pinned toolchain before Nx build.

## Status

The incomplete duplicated workflow setup was replaced with the verified workspace action after the missing WebAssembly target reproduced the race in Lighthouse on 2026-08-01. Pending exact-head GitHub Actions confirmation.
