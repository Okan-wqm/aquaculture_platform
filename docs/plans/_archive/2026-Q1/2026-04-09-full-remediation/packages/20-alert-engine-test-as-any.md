# Package 20: alert-engine-test-as-any

## Metadata
Status: PENDING
Estimated Tokens: 10K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
The alert-engine has 52 `as any` casts in integration/spec tests and 2 in production code. This is a safety-critical component that triggers emergency responses for water quality and oxygen levels. While test `as any` casts are lower risk than production code, they mask type mismatches that could allow tests to pass with incorrect mock shapes, giving false confidence in safety-critical alert logic.

## Findings

**MEDIUM-011 [platform-services]: alert-engine 15 `as any` casts in integration tests**
- Actual count: 52 `as any` in test files, 2 in production code
- Safety-critical component (triggers emergency responses for water quality, oxygen levels)
- Test files affected:
  - `alert-engine/src/alert/event-handlers/__tests__/sensor-reading.handler.spec.ts`
  - `alert-engine/src/notification/__tests__/channel-router-rate-limit.spec.ts`
  - `alert-engine/src/notification/__tests__/template-renderer.service.spec.ts`
  - `alert-engine/src/rules-engine/__tests__/rules-engine.service.spec.ts`
  - `alert-engine/src/rules-engine/__tests__/rules-engine-caching.spec.ts`
  - `alert-engine/src/rules-engine/__tests__/rule-evaluator.service.spec.ts`
  - `alert-engine/src/risk-scoring/__tests__/risk-calculator.service.spec.ts`
  - `alert-engine/src/__tests__/alert-engine.security.spec.ts`
  - `alert-engine/src/__tests__/alert-engine.performance.spec.ts`
  - `alert-engine/src/__tests__/alert-engine.integration.spec.ts`

Closing-Findings: [MEDIUM-011]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Affected Files
- All 10 test files listed above
- 2 production files with `as any` (executor: `grep -rl "as any" apps/alert-engine/src/ | grep -v .spec.ts | grep -v .test.ts`)

## Dependencies
None.

## Atomic Commit Plan
```
refactor(alert-engine): remove 52 as any casts from safety-critical test suite

Replace type-unsafe casts in alert-engine test mocks with properly
typed test factories. Incorrect mock shapes masked by as any could
allow tests to pass despite type mismatches in safety-critical alert
logic (water quality alerts, oxygen level emergency responses).

Also fix 2 production as any casts.

Plan: docs/plans/2026-04-09-full-remediation/packages/20-alert-engine-test-as-any.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-011
```

## Test Plan
- Verify compilation: `npx tsc --noEmit -p apps/alert-engine/tsconfig.json`
- Run all alert-engine tests: `npx jest --testPathPattern="apps/alert-engine" --coverage=false`
- All tests must still pass with typed mocks (no false negatives introduced)

## Verification Command
`npx tsc --noEmit -p apps/alert-engine/tsconfig.json && npx jest --testPathPattern="apps/alert-engine" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
