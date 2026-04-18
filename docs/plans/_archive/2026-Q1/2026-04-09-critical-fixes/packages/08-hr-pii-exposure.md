# Package 08: hr-pii-exposure

## Metadata
Status: IMPLEMENTED
Implemented: 2026-04-09
Estimated Tokens: 16K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [HR-CRITICAL-001, HR-CRITICAL-002, HR-CRITICAL-003]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Three compounding PII exposure vectors in the HR domain: (1) NATS event contracts contain raw PII (firstName, lastName, email) broadcast to all subscribing services -- any service with NATS access reads employee PII; (2) EmergencyInfo (bloodType, allergies) is registered as a GraphQL ObjectType, exposing medical data in the schema introspection and potentially in responses; (3) ContactInfo PII flows through mutation responses via EMPLOYEE_FULL_FRAGMENT. Together these violate GDPR Article 5(1)(c) data minimization and expose the platform to regulatory penalties.

## Findings
- **HR-CRITICAL-001**: Raw PII (firstName, lastName, email) in NATS event contracts
  - File: `libs/event-contracts/src/hr-events.ts` (~7.5K chars)
  - Events like EmployeeCreatedEvent, EmployeeUpdatedEvent contain full PII fields
  - Root cause: event contracts designed for convenience, not data minimization

- **HR-CRITICAL-002**: EmergencyInfo (bloodType, allergies) registered as GraphQL ObjectType
  - File: `apps/hr-service/src/hr/entities/employee.entity.ts` (~8.2K chars)
  - Medical data exposed via schema introspection

- **HR-CRITICAL-003**: ContactInfo PII in mutation responses via EMPLOYEE_FULL_FRAGMENT
  - File: `apps/hr-service/src/hr/entities/employee.entity.ts`
  - Full contact details (phone, address) returned in every employee mutation response

## Affected Files
- `/var/aqua-saas/libs/event-contracts/src/hr-events.ts` (~7.5K chars)
- `/var/aqua-saas/apps/hr-service/src/hr/entities/employee.entity.ts` (~8.2K chars)

## Dependencies
None. Event contract changes are additive (replacing PII with references).

## Atomic Commit Plan
```
security(hr): remove raw PII from event contracts and GraphQL schema

1. hr-events.ts: replace firstName/lastName/email with employeeId
   reference in all HR events. Consumers that need display names
   must query the HR service directly (data minimization).
2. employee.entity.ts: remove @ObjectType() from EmergencyInfo;
   expose only through a dedicated secure resolver with audit logging.
3. employee.entity.ts: create EMPLOYEE_SUMMARY_FRAGMENT without
   ContactInfo; use as default response fragment for mutations.

BREAKING CHANGE: HR event contracts no longer contain PII fields.
Downstream consumers must resolve employee details via HR service query.

Closes: docs/reviews/2026-04-09-critical-fixes#HR-CRITICAL-001
Closes: docs/reviews/2026-04-09-critical-fixes#HR-CRITICAL-002
Closes: docs/reviews/2026-04-09-critical-fixes#HR-CRITICAL-003
Plan: docs/plans/2026-04-09-critical-fixes/packages/08-hr-pii-exposure.md
```
data-expert review required (event contract shape change)

## Test Plan
- Unit test: EmployeeCreatedEvent does not contain firstName/lastName/email fields
- Unit test: EmergencyInfo not in GraphQL schema introspection
- Unit test: mutation response uses EMPLOYEE_SUMMARY_FRAGMENT (no ContactInfo)
- Integration test: NATS subscriber receives events with employeeId only

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p libs/event-contracts/tsconfig.json && npx tsc --noEmit -p apps/hr-service/tsconfig.json && npx jest --testPathPattern="apps/hr-service/src/hr" --coverage=false
```
Dispatch: test-runner
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
