# CI Full trigger and summary contract

**Date:** 2026-07-27
**Baseline:** `99afcff0`

## INFRA-HIGH-084 — full CI did not protect PR or main SHAs

`CI - Full` ran weekly, manually and for release tags. A pull request could therefore merge
without the full project matrix, and the merge commit itself had no full-CI evidence.

The workflow also grouped concurrency by `github.ref` and set `cancel-in-progress: true`.
Every main push shares `refs/heads/main`, so a later merge could cancel the exact-main SHA run
that was supposed to serve as protected release evidence.

The repair:

- triggers CI Full for pull requests targeting `main` and pushes to `main`;
- groups PR runs by PR number and all other runs by immutable SHA;
- cancels only superseded PR runs, never main/tag/scheduled SHA runs;
- gives the existing summary job the explicit stable context `build-status`;
- adds `build-status` to the required-status manifest and contracts it to every CI Full job;
- adds an invariant that parses the workflow and locks all trigger, concurrency and summary
  relationships.

No existing release-tag, schedule or manual trigger is removed.

## INFRA-HIGH-085 — concurrent capacity fixture writes split one logical record

The deploy capacity invariant launches four `du` workers concurrently. Its fake `du` executable
appended each base64 scope and its newline with two separate writes to one shared log. Under CI
load, another worker could append between those writes, so a real hostile scope invocation was
present but no longer occupied one complete line. The assertion then reported zero invocations
even though the production script behaved correctly.

The fixture now builds the encoded record first and appends the complete line with one `printf`.
This preserves the concurrency exercised by the test while making its observation boundary
atomic for records well below `PIPE_BUF`.

## INFRA-HIGH-086 — full lint raced while installing the Rust toolchain

CI Full launched all Nx lint targets in parallel without first installing the repository's
pinned Rust toolchain. Multiple cargo-backed targets therefore invoked rustup concurrently.
One observed a partial toolchain without cargo while another failed to replace component
directories, causing the full lint gate to fail before clippy examined either crate.

The lint/type-check job now installs Rust 1.88.0 and the required components and targets exactly
once before Nx starts. An invariant locks the action SHA, toolchain inputs, and ordering ahead of
the full-surface lint command.
