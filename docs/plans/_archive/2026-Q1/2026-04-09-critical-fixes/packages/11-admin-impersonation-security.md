# Package 11: admin-impersonation-security

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [ADMIN-CRITICAL-001, ADMIN-CRITICAL-002, ADMIN-CRITICAL-003]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Three compounding impersonation security defects: (1) the impersonation audit log write is fire-and-forget with `.catch()` swallowing failures -- impersonation actions can occur without any audit trail; (2) no MFA step-up is required before impersonation despite it being the most privileged operation in the system (4 days unfixed, escalated); (3) impersonation sessions have no inactivity TTL, so a compromised admin session can impersonate indefinitely. Together these make impersonation a high-value attack vector with no detection capability.

## Findings
- **ADMIN-CRITICAL-001**: Impersonation audit fire-and-forget (.catch swallows failure)
  - File: `apps/admin-api-service/src/impersonation/services/impersonation.service.ts` (~34.4K chars)
  - `.catch(() => {})` on audit write -- audit failure is silently swallowed
  - Root cause: audit was added as an afterthought, not integrated into the transaction

- **ADMIN-CRITICAL-002**: No MFA step-up before impersonation (4 days unfixed, escalated)
  - File: `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts` (~11.9K chars)
  - No guard or middleware requiring fresh MFA verification before impersonation
  - Root cause: MFA step-up infrastructure exists but not wired to impersonation endpoint

- **ADMIN-CRITICAL-003**: No inactivity TTL on impersonation sessions
  - File: `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts` (~4.3K chars)
  - Session entity has createdAt but no lastActivityAt or expiresAt
  - Root cause: session lifecycle not fully implemented

## Affected Files
- `/var/aqua-saas/apps/admin-api-service/src/impersonation/services/impersonation.service.ts` (~34.4K chars)
- `/var/aqua-saas/apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts` (~11.9K chars)
- `/var/aqua-saas/apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts` (~4.3K chars)

## Dependencies
None.

## Atomic Commit Plan
```
security(admin): enforce MFA step-up, audit reliability, and TTL on impersonation

1. impersonation.service.ts: make audit write part of the impersonation
   transaction (not fire-and-forget). If audit write fails, impersonation
   fails. Remove .catch(() => {}).
2. impersonation.controller.ts: add MfaStepUpGuard to impersonation
   endpoints requiring a fresh MFA challenge within the last 5 minutes.
3. impersonation-session.entity.ts: add lastActivityAt and expiresAt
   columns. Set TTL to 30 minutes of inactivity. Add middleware to
   check TTL on every impersonated request.

Closes: docs/reviews/2026-04-09-critical-fixes#ADMIN-CRITICAL-001
Closes: docs/reviews/2026-04-09-critical-fixes#ADMIN-CRITICAL-002
Closes: docs/reviews/2026-04-09-critical-fixes#ADMIN-CRITICAL-003
Plan: docs/plans/2026-04-09-critical-fixes/packages/11-admin-impersonation-security.md
```

## Test Plan
- Unit test: audit write failure causes impersonation to fail (transaction rollback)
- Unit test: impersonation without recent MFA -- 403 Forbidden
- Unit test: impersonation with recent MFA -- succeeds
- Unit test: session expired after 30 min inactivity -- 401 Unauthorized
- Unit test: session refreshed on activity -- lastActivityAt updated

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p apps/admin-api-service/tsconfig.json && npx jest --testPathPattern="apps/admin-api-service/src/impersonation" --coverage=false
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
