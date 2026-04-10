# HR Domain Review
Date: 2026-04-10
Scope: full-repo audit of `apps/hr-service/**` and `web/modules/hr-module/**`

## Decision
`BLOCK`

## Summary
- `CRITICAL`: no HR mutation handlers are decorated with `@AuditLog()`, so the global audit interceptor never records employee/payroll changes.
- `CRITICAL`: HR handlers still call `eventBus.publish()` directly even though the app registers a transactional outbox.
- `HIGH`: employee detail UI fetches and renders unmasked contact PII for roles that can reach the page.

## Findings

### CRITICAL-001: Required `@AuditLog()` coverage is missing for HR mutations
The HR service registers `AuditLogInterceptor` globally, but it only records handlers decorated with `@AuditLog()`. I found no `@AuditLog()` usage anywhere under `apps/hr-service/src`, while multiple compliance-sensitive mutators are active: employee creation/update, payroll creation/approval, leave submission/approval, attendance clock-in/out, and training/certification changes.

Representative evidence:
- [`/var/aqua-saas/apps/hr-service/src/app.module.ts:326-329`](/var/aqua-saas/apps/hr-service/src/app.module.ts:326)
- [`/var/aqua-saas/apps/hr-service/src/hr/handlers/create-employee.handler.ts:18-89`](/var/aqua-saas/apps/hr-service/src/hr/handlers/create-employee.handler.ts:18)
- [`/var/aqua-saas/apps/hr-service/src/hr/handlers/update-employee.handler.ts:19-135`](/var/aqua-saas/apps/hr-service/src/hr/handlers/update-employee.handler.ts:19)
- [`/var/aqua-saas/apps/hr-service/src/hr/handlers/approve-payroll.handler.ts:20-100`](/var/aqua-saas/apps/hr-service/src/hr/handlers/approve-payroll.handler.ts:20)

Remediation:
- Annotate every employee-PII and payroll-mutating command with `@AuditLog()`.
- Ensure the audit payload is redacted through the shared `SENSITIVE_FIELDS` path before persistence.
- Add tests proving each decorated command emits exactly one audit entry.

Cross-domain dependency:
- `security-reviewer`
- `auth-security-expert`

### CRITICAL-002: HR events still bypass the transactional outbox
`apps/hr-service/src/app.module.ts` registers `OutboxModule.forFeature(HrOutbox)` and documents that it replaces fire-and-forget publishing, but the active handlers still call `eventBus.publish()` directly after commit. That leaves downstream consumers exposed to lost events if the process dies between commit and publish, and it undermines the outbox contract the module claims to provide.

Representative evidence:
- [`/var/aqua-saas/apps/hr-service/src/app.module.ts:280-284`](/var/aqua-saas/apps/hr-service/src/app.module.ts:280)
- [`/var/aqua-saas/apps/hr-service/src/hr/handlers/create-employee.handler.ts:80-87`](/var/aqua-saas/apps/hr-service/src/hr/handlers/create-employee.handler.ts:80)
- [`/var/aqua-saas/apps/hr-service/src/hr/handlers/update-employee.handler.ts:102-132`](/var/aqua-saas/apps/hr-service/src/hr/handlers/update-employee.handler.ts:102)
- [`/var/aqua-saas/apps/hr-service/src/hr/handlers/approve-payroll.handler.ts:68-98`](/var/aqua-saas/apps/hr-service/src/hr/handlers/approve-payroll.handler.ts:68)
- [`/var/aqua-saas/apps/hr-service/src/leave/handlers/submit-leave-request.handler.ts:76-79`](/var/aqua-saas/apps/hr-service/src/leave/handlers/submit-leave-request.handler.ts:76)
- [`/var/aqua-saas/apps/hr-service/src/attendance/handlers/clock-in.handler.ts:289-292`](/var/aqua-saas/apps/hr-service/src/attendance/handlers/clock-in.handler.ts:289)

Remediation:
- Replace direct `eventBus.publish()` calls with outbox enqueue operations inside the same DB transaction as the domain write.
- Remove the fire-and-forget publish path from the mutation handlers.
- Add a delivery test that proves a committed domain write survives a worker restart.

Cross-domain dependency:
- `platform-services`
- `messaging-expert`

### HIGH-003: Employee detail view exposes unmasked contact PII
The employee detail route is available from the HR module, and the backend `employee` query allows `MODULE_USER` access. The frontend detail page then renders `employee.email` and `employee.contactInfo.phone` directly, while the module already has masking utilities that are not used here. The detail fragment also fetches address and emergency-contact fields unconditionally, so low-privilege HR users receive more PII than the UI needs.

Representative evidence:
- [`/var/aqua-saas/apps/hr-service/src/hr/hr.resolver.ts:74-83`](/var/aqua-saas/apps/hr-service/src/hr/hr.resolver.ts:74)
- [`/var/aqua-saas/web/modules/hr-module/src/graphql/fragments.ts:52-91`](/var/aqua-saas/web/modules/hr-module/src/graphql/fragments.ts:52)
- [`/var/aqua-saas/web/modules/hr-module/src/pages/EmployeeDetailPage.tsx:111-120`](/var/aqua-saas/web/modules/hr-module/src/pages/EmployeeDetailPage.tsx:111)
- [`/var/aqua-saas/web/modules/hr-module/src/utils/pii-mask.ts:20-51`](/var/aqua-saas/web/modules/hr-module/src/utils/pii-mask.ts:20)

Remediation:
- Split the employee detail fragment into a masked public variant and a privileged full-PII variant.
- Apply `maskEmail()` and `maskPhone()` in the default detail view, and gate any full PII behind a stricter role check.
- If the business requires full contact details, move that access behind an explicit privileged view instead of the default employee page.

Cross-domain dependency:
- `auth-security-expert`
- `frontend-expert`

## Notes
- I did not run the test suite for this audit.
