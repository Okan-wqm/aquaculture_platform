# Package 17: hr-gdpr-payroll-audit

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 35K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [HR-HIGH-001, HR-HIGH-002, HR-HIGH-003, HR-HIGH-004, HR-HIGH-005, HR-HIGH-006]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
HR-service has 18 HIGH findings. This package covers the first 6 most critical ones: (1) update-plan-entry regression from S1 fix, (2) no GDPR erasure command handler, (3) baseSalary field has no RBAC (any HR module user can read salaries), (4) PII in exception stack traces, (5) payroll float multiplication causes cent-rounding errors, (6) no payroll audit table.

## Findings

**HR-HIGH-001** (hr-expert, HIGH)
File: apps/hr-service/src/hr/handlers/update-plan-entry.handler.ts
Regression from S1 fix: the handler update path was refactored but the validation logic now allows updating entries in closed plans.

**HR-HIGH-002** (hr-expert, HIGH)
No GDPR erasure command handler exists. Employee data (name, national ID, address, phone, salary) cannot be erased on request. Required by GDPR Article 17.

**HR-HIGH-003** (hr-expert, HIGH)
File: apps/hr-service/src/hr/entities/employee.entity.ts
baseSalary field has no RBAC check. Any user with HR_MODULE_USER role can read all employee salaries via GraphQL query. Should require HR_ADMIN or specific salary-read permission.

**HR-HIGH-004** (hr-expert, HIGH)
PII (employee name, national ID, email) appears in exception stack traces. NestJS exception filter does not redact PII from error responses sent to client.

**HR-HIGH-005** (hr-expert, HIGH)
File: apps/hr-service/src/payroll/services/payroll-calculation.service.ts
Payroll calculations use JavaScript float multiplication (amount * rate). For hourly rates with decimal minutes, this produces IEEE 754 rounding errors. Penny-level discrepancies in payroll are a legal compliance issue.

**HR-HIGH-006** (hr-expert, HIGH)
No payroll audit table. Pay calculation inputs, outputs, and approval steps have no immutable audit trail. Required for labor law compliance.

## Affected Files
- apps/hr-service/src/hr/handlers/update-plan-entry.handler.ts
- apps/hr-service/src/hr/entities/employee.entity.ts
- apps/hr-service/src/hr/handlers/ (GDPR erasure)
- apps/hr-service/src/payroll/services/payroll-calculation.service.ts
- apps/hr-service/src/common/filters/exception.filter.ts (PII redaction)

## Dependencies
None.

## Atomic Commit Plan
```
security(hr): fix plan-entry regression, add GDPR erasure, RBAC on salary, redact PII, fix payroll float

update-plan-entry allows edits to closed plans (S1 regression). No GDPR
erasure command. baseSalary readable by any HR_MODULE_USER. PII in exception
stacks. Payroll uses float multiplication (rounding errors). No payroll audit.

Add closed-plan guard. Implement GdprErasureCommandHandler. Add salary-read
permission check. Redact PII in exception filter. Replace float arithmetic
with integer-cent calculation. Create payroll_audit table.

Plan: docs/plans/2026-04-09-high-fixes/packages/17-hr-gdpr-payroll-audit.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-005
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-HIGH-006
```

## Test Plan
- Unit test: update-plan-entry rejects update when plan status is CLOSED
- Unit test: GDPR erasure replaces PII with anonymized values
- Unit test: baseSalary query rejected for HR_MODULE_USER (requires HR_ADMIN)
- Unit test: exception filter redacts name/email/national ID from response
- Unit test: payroll calculation matches expected cent-precise values
- Unit test: payroll audit table records calculation inputs/outputs

## Verification Command
`npx tsc --noEmit -p apps/hr-service/tsconfig.json && npx jest --testPathPattern="apps/hr-service/src/(hr|payroll|common)" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
