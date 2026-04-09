# Package 09: sensor-service-ts-ignore-worker-pool

## Metadata
Status: PENDING
Estimated Tokens: 11K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
The sensor-service st-worker-pool.service.ts has 2 `@ts-ignore` directives in a life-safety adjacent system (controls PLC programming and VFD motor control via piscina worker threads). CLAUDE.md forbids `@ts-ignore` unconditionally. The gateway app.module.ts has 1 additional `@ts-ignore`. These must be replaced with proper type definitions.

## Findings

**MEDIUM-003 [security-reviewer]: 3 `@ts-ignore` directives suppress type safety**
- Files:
  - `apps/sensor-service/src/automation/compiler/worker/st-worker-pool.service.ts:34,56` (2 occurrences)
  - `apps/gateway-api/src/app.module.ts:493` (1 occurrence)
- CLAUDE.md forbids `@ts-ignore` and `@ts-expect-error`.

**MEDIUM-006 [sensor-expert]: sensor-service has 2 `@ts-ignore` for piscina worker pool**
- File: `apps/sensor-service/src/automation/compiler/worker/st-worker-pool.service.ts`
- Life-safety adjacent system. Type suppression in worker thread management risks undetected runtime type mismatches.

Closing-Findings: [MEDIUM-003, MEDIUM-006]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Affected Files
- `/var/aqua-saas/apps/sensor-service/src/automation/compiler/worker/st-worker-pool.service.ts`
- `/var/aqua-saas/apps/gateway-api/src/app.module.ts`

## Dependencies
None.

## Atomic Commit Plan
```
fix(sensor,gateway): remove 3 @ts-ignore directives with proper type definitions

st-worker-pool.service.ts: Replace @ts-ignore on piscina instantiation
(lines 34, 56) with correct Piscina type imports or typed wrapper.
This is life-safety adjacent code controlling PLC/VFD workers.

app.module.ts: Replace @ts-ignore (line 493) with correct type for the
suppressed expression.

Plan: docs/plans/2026-04-09-full-remediation/packages/09-sensor-service-ts-ignore-worker-pool.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-006
```

## Test Plan
- Verify both services compile without `@ts-ignore`:
  - `npx tsc --noEmit -p apps/sensor-service/tsconfig.json`
  - `npx tsc --noEmit -p apps/gateway-api/tsconfig.json`
- Run sensor-service automation tests: `npx jest --testPathPattern="apps/sensor-service/src/automation"`
- Verify no new `@ts-ignore` or `@ts-expect-error` introduced

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx tsc --noEmit -p apps/gateway-api/tsconfig.json`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
