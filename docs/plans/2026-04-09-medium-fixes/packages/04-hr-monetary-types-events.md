# Package 04: hr-monetary-types-events

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 22K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [HR-MEDIUM-001, HR-MEDIUM-007, HR-MEDIUM-009, HR-MEDIUM-010]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Four HR findings share a root cause: monetary values and training events use incorrect types or bypass the BaseEvent contract. Payroll events emit monetary amounts as JavaScript `number` (IEEE 754 float) instead of string-encoded decimals, and training events do not extend BaseEvent. Grouped because they all touch event contracts and HR event publishers.

## Findings

**HR-MEDIUM-001 — Payroll event monetary values as number type**
`PayrollProcessedEvent` and related events use `amount: number` for salary, deductions, and net pay. JavaScript `number` is IEEE 754 double-precision — `0.1 + 0.2 !== 0.3`. Monetary values MUST be string-encoded decimals (e.g., `"1234.56"`) or integer cents. This affects event contracts and all publishers.

**HR-MEDIUM-007 — Training events do not extend BaseEvent**
`TrainingCompletedEvent`, `CertificationAddedEvent`, and related training domain events are plain objects without `eventId`, `timestamp`, `version`, or `tenantId` from BaseEvent. They must use `createBaseEvent()` from `@platform/event-contracts`.

**HR-MEDIUM-009 — Salary entity uses Number() conversion**
`employee.entity.ts` or `payroll.entity.ts` uses `Number(salary)` to convert from database numeric type, losing precision for values above `Number.MAX_SAFE_INTEGER`. Use `@Column({ type: 'numeric', transformer: ... })` with a string transformer.

**HR-MEDIUM-010 — Redundant Number() conversion in event publishing**
Event publishers apply `Number(entity.salary)` when building payroll events, doubling the precision-loss path from HR-MEDIUM-009. Once the entity transformer returns a string, remove all `Number()` wrappers in event builders.

## Affected Files
- libs/event-contracts/src/hr-events.ts
- apps/hr-service/src/hr/entities/payroll.entity.ts
- apps/hr-service/src/hr/entities/employee.entity.ts
- apps/hr-service/src/training/handlers/complete-training.handler.ts
- apps/hr-service/src/training/handlers/add-employee-certification.handler.ts
- apps/hr-service/src/hr/handlers/ (payroll-related handlers that publish events)

## Dependencies
None. HR service is self-contained; event contract changes are additive (new required fields).

## Atomic Commit Plan
```
fix(hr): use string-encoded decimals for monetary events, extend BaseEvent in training events

Payroll events used number type for monetary values, risking IEEE 754 precision loss.
Switch to string-encoded decimal format in event contracts and entity transformers.
Training events were plain objects missing BaseEvent fields — wrap with createBaseEvent().
Remove all Number() conversions in event publishers (entity transformer now returns string).

BREAKING CHANGE: PayrollProcessedEvent.amount, .deductions, .netPay change from number to string.
Training events now include eventId, timestamp, version, tenantId fields.
data-expert review required

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-MEDIUM-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-MEDIUM-007
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-MEDIUM-009
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-MEDIUM-010
Plan: docs/plans/2026-04-09-medium-fixes/packages/04-hr-monetary-types-events.md
```

## Test Plan
- Unit test: payroll event monetary fields are strings matching /^\d+\.\d{2}$/ pattern
- Unit test: training events include all BaseEvent required fields
- Unit test: entity transformer returns string, not number, for salary column
- Integration test: publish payroll event -> consume -> verify no precision loss
- Verify no remaining Number() calls on salary/amount fields

## Verification Command
`npx tsc --noEmit -p apps/hr-service/tsconfig.json && npx jest --testPathPattern="apps/hr-service/src/(hr|training)" --coverage=false`
[Dispatch: test-runner]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
