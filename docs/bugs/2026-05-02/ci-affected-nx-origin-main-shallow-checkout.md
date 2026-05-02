# CI affected Nx origin main shallow checkout

Date: 2026-05-02

## Problem

CI affected jobs failed before running build, lint, test, and type-check:

`fatal: ambiguous argument 'origin/main': unknown revision or path not in the working tree`

## Impact

The CI gate reported red without testing the code. That blocks review and also
hides real application failures behind a checkout-shape problem.

## Root Cause

`ci-affected.yml` used `fetch-depth: 2` while the Nx affected commands compared
`origin/${{ github.base_ref || 'main' }}` to `HEAD`. In pull request merge
checkouts, the shallow clone did not contain `origin/main`.

## Fix

All `ci-affected.yml` checkout steps now use full history (`fetch-depth: 0`) so
every affected job has the base ref needed by Nx. This matches the explicit
base/head discipline already applied to the performance workflow.

## Verification

The next CI affected run should reach actual Nx lint, type-check, test, and
build tasks instead of failing in Git revision discovery.
