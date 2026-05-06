# Backend Common Test Type Drift

Date: 2026-04-29

## Problem

Full `libs/backend-common` spec typecheck failed on two test-only type drifts:

- watchdog integration test used `Date` where `WatchdogViolation.timestamp`
  requires ISO string;
- leader-election fake Redis implemented an evolving `ioredis` overload surface
  directly, so upstream type overload changes broke the mock even though the
  service only uses a narrow command subset.

## Root Fix

Aligned the watchdog test timestamp with the production interface and removed
the brittle direct `implements Pick<Redis, ...>` from the fake Redis. The test
still casts the fake at the service boundary, which is the correct seam for a
minimal in-memory test double.

## Verification

- `npx tsc -p libs/backend-common/tsconfig.spec.json --noEmit`
