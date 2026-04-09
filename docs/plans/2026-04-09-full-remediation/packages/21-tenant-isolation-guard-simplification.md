# Package 21: tenant-isolation-guard-simplification

## Metadata
Status: PENDING
Estimated Tokens: 10K
Priority: LOW
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none

## Context
The TenantIsolationGuard extracts requested tenant ID from 5 sources (header, URL param, query, body, GraphQL variables). multi-tenant-saas-expert confirmed this is NOT exploitable (guard always compares against JWT-verified user.tenantId), but the unnecessary attack surface complexity makes security auditing harder. Additionally, MEDIUM-015 was downgraded to LOW by multi-tenant-saas-expert. This package reduces extraction to only the architecturally necessary sources.

## Findings

**MEDIUM-015 / TENANT-HIGH-003 -> LOW [multi-tenant-saas-expert]: TenantIsolationGuard multi-source extraction**
- File: `apps/gateway-api/src/guards/tenant-isolation.guard.ts` (lines 162-220)
- `extractRequestedTenantId()` accepts tenant from: header, URL param, query, body, GraphQL variables
- Guard correctly blocks cross-tenant access regardless of source
- Unnecessary complexity — reduce to `X-Act-As-Tenant` header (SUPER_ADMIN only) and URL path params

**AUTH-HIGH-004 -> LOW [auth-security-expert]: String-based entity lookup in farm-service**
- File: `apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts` (lines 1070, 1719, 1788)
- Uses `this.dataSource.getRepository('SubEquipment')` with string names
- tenantId present but no compile-time type checking on entity
- LOW risk — style violation, not security vulnerability

Closing-Findings: [MEDIUM-015, AUTH-HIGH-004]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/multi-tenant-saas-expert/2026-04-09-tenant-isolation-exploitability.md
- docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md

## Affected Files
- `/var/aqua-saas/apps/gateway-api/src/guards/tenant-isolation.guard.ts`
- `/var/aqua-saas/apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts`

## Dependencies
None.

## Atomic Commit Plan
```
refactor(gateway,farm): simplify tenant extraction sources, fix string entity lookups

1. tenant-isolation.guard.ts: Reduce extractRequestedTenantId() to
   accept only X-Act-As-Tenant header (for SUPER_ADMIN) and URL path
   parameters. Remove body, query, and bare header extraction paths.
   Guard logic unchanged — this reduces unnecessary attack surface.

2. feeding-program.resolver.ts: Replace string-based
   getRepository('SubEquipment') with typed getRepository(SubEquipment)
   at lines 1070, 1719, 1788.

Plan: docs/plans/2026-04-09-full-remediation/packages/21-tenant-isolation-guard-simplification.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-015
Closes: docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md#AUTH-HIGH-004
```

[Dispatch: security-reviewer]

## Test Plan
- Verify compilation of both services
- Run gateway guard tests: `npx jest --testPathPattern="apps/gateway-api/src/guards"`
- Run farm-service feeding tests: `npx jest --testPathPattern="apps/farm-service/src/feeding"`
- Verify no regression in cross-tenant access control

## Verification Command
`npx tsc --noEmit -p apps/gateway-api/tsconfig.json && npx tsc --noEmit -p apps/farm-service/tsconfig.json`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
