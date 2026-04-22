# Package 12: auth-hardening-token-mfa

## Metadata
Status: PENDING
Estimated Tokens: 12K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none

## Context
Three auth-service findings relate to authentication hardening: the token service uses an in-memory Map cache that becomes stale in multi-pod deployments, refresh token bcrypt comparison needs verification, and MFA step-up for cross-tenant SUPER_ADMIN access defaults to opt-in (should be mandatory). These share the auth-service security domain and can be fixed atomically.

## Findings

**MEDIUM-012 [auth-security-expert]: Token service in-memory Map cache (multi-pod stale permissions)**
- File: `apps/auth-service/src/modules/authentication/services/token.service.ts` (lines 122-127)
- Per-process cache in multi-pod deployment causes stale permissions for up to 5 minutes
- Remediation: Replace in-memory Map with Redis cache (auth-service already has Redis dependency) or reduce TTL significantly

**MEDIUM-013 [auth-security-expert]: Refresh token bcrypt comparison verification needed**
- Token validation should use `bcrypt.compare()` to prevent timing attacks on refresh token comparison
- Executor must verify the current implementation uses constant-time comparison

**MEDIUM-014 [auth-security-expert]: MFA step-up for cross-tenant access opt-in by default**
- File: `libs/backend-common/src/guards/tenant.guard.ts` (line 70)
- `MFA_REQUIRED_FOR_CROSS_TENANT` defaults to `false`
- Compromised SUPER_ADMIN session without MFA can access any tenant
- Remediation: Default to `true` in production; explicit opt-out requires env var

Closing-Findings: [MEDIUM-012, MEDIUM-013, MEDIUM-014]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md

## Affected Files
- `/var/aqua-saas/apps/auth-service/src/modules/authentication/services/token.service.ts`
- `/var/aqua-saas/libs/backend-common/src/guards/tenant.guard.ts`

## Dependencies
None. These are independent auth hardening measures.

## Atomic Commit Plan
```
security(auth): harden token cache, verify bcrypt comparison, enable MFA cross-tenant default

1. token.service.ts: Replace in-memory Map cache with Redis-backed
   cache (or reduce TTL to 30s) to prevent stale permissions across pods.
2. token.service.ts: Verify refresh token uses bcrypt.compare() for
   constant-time comparison. Fix if not.
3. tenant.guard.ts: Change MFA_REQUIRED_FOR_CROSS_TENANT default from
   false to true in production (NODE_ENV=production). SUPER_ADMIN
   cross-tenant access now requires MFA step-up by default.

BREAKING CHANGE: MFA_REQUIRED_FOR_CROSS_TENANT now defaults to true in
production. Existing SUPER_ADMIN workflows that skip MFA will require
explicit MFA_REQUIRED_FOR_CROSS_TENANT=false env var.

Plan: docs/plans/2026-04-09-full-remediation/packages/12-auth-hardening-token-mfa.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-012
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-013
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-014
```

[Dispatch: security-reviewer]

## Test Plan
- Verify compilation of both targets
- Run auth-service tests: `npx jest --testPathPattern="apps/auth-service/src/modules/authentication"`
- Run tenant guard tests: `npx jest --testPathPattern="libs/backend-common/src/guards"`
- Verify Redis cache integration (if applicable) with mock Redis in test

## Verification Command
`npx tsc --noEmit -p apps/auth-service/tsconfig.json && npx tsc --noEmit -p libs/backend-common/tsconfig.json && npx jest --testPathPattern="apps/auth-service/src/modules/authentication" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
