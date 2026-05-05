# Migration Harness Dev-Only Build RootDir Failure

Date: 2026-05-04

## Problem

GitHub Actions `Frontend Lighthouse CI` failed before Lighthouse execution because the broad affected build included `migration-harness:build`. The `@nx/js:tsc` build attempted to emit files imported through `@aquaculture/backend-common/database`, then failed with `TS6059` because backend-common source files are outside `libs/migration-harness` rootDir.

## Root Cause

`libs/migration-harness` is tagged `scope:devOnly` and is a test harness, not a production/distribution library. Its build target was modeled like an artifact-producing library even though its public API intentionally references Jest DSL and backend-common database helpers.

## Enterprise Fix

The `migration-harness:build` target is now a dev-only compile gate:

- runs `npx tsc -p libs/migration-harness/tsconfig.lib.json --noEmit`,
- produces no dist artifact,
- includes `jest` ambient types because the harness exports Jest-based helpers.

This preserves CI build coverage without forcing a dev-only harness into the production artifact graph.

## Why This Is Not a Patch

The fix does not widen TypeScript `rootDir`, emit backend-common source into the harness dist, or suppress TypeScript errors. It corrects the Nx target semantics to match the library’s declared architecture.

## Validation

- `npx tsc -p libs/migration-harness/tsconfig.lib.json --noEmit`
- GitHub Actions affected build / Frontend Lighthouse CI
