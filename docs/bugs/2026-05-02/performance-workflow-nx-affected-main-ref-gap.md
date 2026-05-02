# Performance workflow Nx affected main ref gap

Date: 2026-05-02

## Problem

PR #228 still failed `Frontend Lighthouse CI` after the SWC native binding was
fixed. The new failure was:

`Command failed: git diff --name-only --no-renames --relative "main" "HEAD"`

`main` was not present in the PR checkout because the performance workflow used
the default shallow checkout.

## Impact

The performance workflow could fail before building or running Lighthouse. This
turns the performance gate into a checkout-shape-dependent gate instead of a
deterministic benchmark.

## Root Cause

`npm run build` delegates to `nx affected --target=build`. Without explicit
`--base` and `--head`, Nx defaults to `main..HEAD`. The workflow checked out the
PR merge ref with shallow history, so `main` was not available as a local
revision.

## Fix

The Lighthouse job now:

- checks out full history with `fetch-depth: 0`;
- computes explicit Nx affected refs for pull requests and push/manual runs;
- passes `--base` and `--head` into `npm run build`.
- only attempts to stop the preview server when `server.pid` exists, so an early
  build failure does not emit misleading shell noise during cleanup.

## Verification

GitHub Actions should no longer fail with ambiguous `main` revision during the
performance workflow build step. Any remaining Lighthouse failure is then a real
build, preview, or Lighthouse finding rather than an Nx checkout-shape failure.
