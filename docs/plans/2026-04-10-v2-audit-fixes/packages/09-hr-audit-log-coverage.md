# Package 09: hr-audit-log-coverage

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 16K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: no
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [hr-expert/CRITICAL-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/hr-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The HR service registers `AuditLogInterceptor` globally, but it only records handlers decorated with `@AuditLog()`. No handler in `apps/hr-service/src` uses `@AuditLog()`, so compliance-sensitive mutations (employee creation/update, payroll approval, leave submission, attendance clock-in/out, certification changes) produce zero audit records.

## Findings
`CRITICAL-001` (hr-expert): Required `@AuditLog()` coverage is missing for HR mutations. Files: `apps/hr-service/src/app.module.ts:326-329`, `apps/hr-service/src/hr/handlers/create-employee.handler.ts:18-89`, `apps/hr-service/src/hr/handlers/update-employee.handler.ts:19-135`, `apps/hr-service/src/hr/handlers/approve-payroll.handler.ts:20-100`. The global interceptor is wired but has zero decorated targets.

## Affected Files
- /var/aqua-saas/apps/hr-service/src/hr/handlers/create-employee.handler.ts
- /var/aqua-saas/apps/hr-service/src/hr/handlers/update-employee.handler.ts
- /var/aqua-saas/apps/hr-service/src/hr/handlers/approve-payroll.handler.ts
- /var/aqua-saas/apps/hr-service/src/leave/handlers/submit-leave-request.handler.ts
- /var/aqua-saas/apps/hr-service/src/leave/handlers/approve-leave-request.handler.ts
- /var/aqua-saas/apps/hr-service/src/attendance/handlers/clock-in.handler.ts
- /var/aqua-saas/apps/hr-service/src/attendance/handlers/clock-out.handler.ts

## Dependencies
None. Package 10 (hr-outbox-migration) depends on this package.

## Atomic Commit Plan
```
security(hr): add @AuditLog() to all compliance-sensitive HR mutation handlers

The HR service had AuditLogInterceptor wired globally but zero mutation
handlers were decorated with @AuditLog(), so no audit records were
produced for employee creation, payroll approval, leave management, or
attendance tracking. This annotates every compliance-sensitive command
handler with @AuditLog() and ensures the audit payload is redacted via
the shared SENSITIVE_FIELDS path before persistence.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/09-hr-audit-log-coverage.md
Closes: docs/reviews/hr-expert/2026-04-10-full-repo-audit.md#CRITICAL-001
```

## Test Plan
- Unit test per handler: verify @AuditLog() decorator is present.
- Integration test: create-employee produces exactly one audit entry.
- Integration test: approve-payroll produces exactly one audit entry.
- Verify audit payload redacts SENSITIVE_FIELDS (email, phone, salary).
- Negative test: removing @AuditLog() causes test failure.

## Verification Command
`npx tsc --noEmit -p apps/hr-service/tsconfig.json && npx jest --testPathPattern="apps/hr-service/src" --coverage=false`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

