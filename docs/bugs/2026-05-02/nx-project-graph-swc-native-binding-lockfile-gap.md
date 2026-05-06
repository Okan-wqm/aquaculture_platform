# Nx project graph SWC native binding lockfile gap

Date: 2026-05-02

## Problem

PR #228 failed the `Frontend Lighthouse CI` job before Lighthouse ran. The job
failed at `npm run build` with:

`NX Failed to process project graph`

Verbose local project-graph reproduction showed the root error:

`Failed to load plugin '@nx' declared in '.eslintrc.json#overrides[1]': Failed to load native binding`

The missing native binding was `@swc/core-linux-x64-gnu`.

## Impact

Any CI job that needs Nx project graph construction can fail before reaching its
actual validation target. This is broader than Lighthouse because Nx graph
creation is a shared build/test/lint primitive.

## Root Cause

`@swc/core` declares platform native packages as optional dependencies, but the
root lockfile did not include a Linux x64 GNU package entry. GitHub-hosted Ubuntu
runners install with `npm ci --ignore-scripts`, so the install must be satisfied
from locked packages and cannot rely on lifecycle scripts to fetch or repair a
native binding.

## Fix

Added root optional dependency:

`@swc/core-linux-x64-gnu: 1.15.10`

The version is exact and matches the locked `@swc/core` version. This keeps CI
peer-clean and scripts-disabled while making the Linux native binding explicit
in `package-lock.json`.

## Verification

- `npm install --ignore-scripts --no-audit --no-fund`
- `node -e "require('@swc/core'); console.log('swc ok')"`
- `NX_DAEMON=false NX_NO_CLOUD=true npx nx show projects --affected --base=origin/main --head=HEAD --verbose`

