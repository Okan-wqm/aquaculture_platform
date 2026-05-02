# Dependency audit source map CI artifact

Date: 2026-04-30

## Problem

`npm audit` failures were blocking after the CI hardening work, but the failure
signal did not explain which package family owned each vulnerability. That makes
enterprise dependency cleanup slower and increases the chance of broad,
low-quality fixes such as force upgrades or peer bypasses.

## Root Cause

The CI audit step emitted raw npm output only. It did not persist a durable
artifact with direct/transitive ownership, severity, `via`, `effects`, and
available fix hints.

## Fix

Added `scripts/ci/audit-source-map.mjs` and wired it into affected/full CI audit
jobs. The workflow now:

- Runs `npm audit` with JSON output.
- Converts the JSON into `npm-audit-source-map.md`.
- Uploads both raw JSON and the Markdown source map as GitHub Actions artifacts.
- Exits with the original `npm audit` status so the artifact never hides a
  failing audit.

## Verification

Server/local build and test execution was not run. The repository policy is to
run build/typecheck/test in GitHub Actions on this Docker server.

Lightweight check performed:

- `node --check scripts/ci/audit-source-map.mjs`

## Remaining Work

Use the uploaded artifact in GitHub Actions to close the remaining dependency
families one by one. Do not add `continue-on-error`, `|| true`, `--force`, or
`--legacy-peer-deps`.
