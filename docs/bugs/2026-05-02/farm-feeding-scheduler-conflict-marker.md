# Farm feeding scheduler conflict marker

Date: 2026-05-02

## Problem

While rebasing the tenant-isolation/dependency-governance checkpoint onto
`origin/main`, `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`
contained unresolved merge markers around the feeding-rate interpolation
comment.

## Impact

Conflict markers in production TypeScript can break parsing, hide the intended
algorithm comment, and make future audit output unreliable.

## Fix

Removed the markers and kept the concrete nearest-neighbor interpolation
explanation. No runtime algorithm change was made.

## Verification

The fix must be covered by the normal TypeScript/build gates in GitHub Actions.
The local rebase flow also scans for exact conflict marker prefixes before the
rebase is continued.
