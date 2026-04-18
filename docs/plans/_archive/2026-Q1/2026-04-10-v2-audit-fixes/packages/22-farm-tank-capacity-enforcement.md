# Package 22: farm-tank-capacity-enforcement

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 10K
Priority: HIGH
Security-Sensitive: no
Parallelizable: no
Prerequisites: 21-farm-batch-close-fixes
Sprint: 1

## Closing-Findings
Closing-Findings: [farm-expert/HIGH-003]

## Source-Reviews
- /var/aqua-saas/docs/reviews/farm-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The allocate-to-tank handler computes `availableCapacity`, logs a warning when exceeded, and then proceeds with the allocation anyway. It never checks projected density against `maxDensity`. The tank model already has the correct `hasCapacityFor()` contract, but the handler bypasses it.

## Findings
`HIGH-003` (farm-expert): Allocate-to-tank still ignores hard capacity enforcement. Files: `apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts:127`, `apps/farm-service/src/tank/entities/tank.entity.ts:376`. The handler logs a warning but proceeds with over-capacity allocations.

## Affected Files
- /var/aqua-saas/apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts
- /var/aqua-saas/apps/farm-service/src/tank/entities/tank.entity.ts

## Dependencies
21-farm-batch-close-fixes -- both packages touch farm-service batch domain files. The batch close fix establishes the correct lifecycle enforcement pattern that the capacity enforcement can build upon.

## Atomic Commit Plan
```
fix(farm): enforce hard capacity limits in allocate-to-tank handler

The allocate-to-tank handler logged capacity violations as warnings
and proceeded with the allocation, allowing over-capacity and unsafe
stocking density. This replaces the warn-and-proceed pattern with
blocking validation through the tank model's hasCapacityFor() contract,
checking both biomass and density limits. Admin override is gated behind
an explicit privileged path with audit logging.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/22-farm-tank-capacity-enforcement.md
Closes: docs/reviews/farm-expert/2026-04-10-full-repo-audit.md#HIGH-003
```

## Test Plan
- Unit test: allocation exceeding biomass capacity is rejected.
- Unit test: allocation exceeding density limit is rejected.
- Unit test: allocation within capacity succeeds.
- Unit test: admin override with audit logging is available for exceptional cases.
- Negative test: warn-only capacity check pattern is not present.

## Verification Command
`npx tsc --noEmit -p apps/farm-service/tsconfig.json && npx jest --testPathPattern="apps/farm-service/src/batch" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

