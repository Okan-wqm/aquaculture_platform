# CI quality gates peer-clean install drift

Date: 2026-05-02

## Problem

After rebasing the dependency-governance checkpoint onto `origin/main`, the
dependency-policy gate found two peer-bypass references:

- `.github/workflows/quality-gates.yml` used `npm ci --legacy-peer-deps` in the
  invariants job.
- `tools/gates/check-pin.ts` told operators to populate `node_modules` with
  `npm ci --legacy-peer-deps --ignore-scripts`.

## Impact

Quality gates must be the strictest dependency-resolution surface. If they
allow legacy peer resolution, Apollo/Nest/TypeORM graph conflicts can be hidden
exactly where they should be detected.

## Fix

Changed both references to strict peer-clean `npm ci --ignore-scripts` flows.
The dependency-policy gate remains fail-closed.

## Verification

`npm run gates:dependency-policy` must pass before the rebased PR branch is
force-pushed.
