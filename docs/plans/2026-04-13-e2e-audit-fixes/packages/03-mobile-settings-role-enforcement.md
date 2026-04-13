# Package 03: mobile-settings-role-enforcement

## Metadata
Status: PENDING
Estimated Tokens: ~6K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (with 01, 02)
Prerequisites: none

## Source Reviews
- docs/test-audits/access-boundary-auditor/2026-04-11-full-platform-e2e.md
- docs/test-audits/context-manager/2026-04-11-full-platform-e2e.md

## Closing Findings
Closing-Findings: [access-boundary-auditor/CRITICAL-001]

## Context
The MobileSettingsResolver has no `@Roles()` decorator on any of its methods. The RolesGuard (confirmed at `libs/backend-common/src/guards/roles.guard.ts:67`) allows any authenticated user when no role metadata is present -- it only checks `if (!user)`. This means any authenticated tenant user can call `getMobileUserSettings`, `getMobileUsersSettings`, `updateMobileUserSettings`, and `bulkUpdateMobileSettings` to inspect and mutate per-user mobile permissions for ANY user in their tenant. Only `getMyMobileSettings` (line 29) is correctly auth-only since it returns the caller's own settings.

## Findings
access-boundary-auditor CRITICAL-001: MobileSettingsResolver is auth-only -- any authenticated user can mutate per-user mobile permissions.
- File: `apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts` (entire file, 91 lines)
- No `@Roles()` decorator on `getMobileUserSettings`, `getMobileUsersSettings`, `updateMobileUserSettings`, or `bulkUpdateMobileSettings`. The `RolesGuard` allows any authenticated user when no role metadata is present (confirmed at `libs/backend-common/src/guards/roles.guard.ts:67`).
- Note: `getMyMobileSettings` (line 29) is correctly auth-only since it returns the caller's own settings.
- Severity: CRITICAL
- Gap class: access-gap, tenant-gap

## Affected Files
- apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts (primary -- add @Roles decorators)

## Dependencies
Prerequisites: none
This package touches only the auth-service resolver. The `@Roles` decorator and `Role` enum are already available from `@aquaculture/backend-common`. No shared lib changes needed.

## Atomic Commit Plan
```
security(auth): enforce TENANT_ADMIN role on MobileSettingsResolver admin methods

MobileSettingsResolver has no @Roles() decorators, so RolesGuard allows
any authenticated user to read and mutate per-user mobile permissions
for all users in the tenant. Add @Roles(Role.TENANT_ADMIN) to:
getMobileUserSettings, getMobileUsersSettings, updateMobileUserSettings,
and bulkUpdateMobileSettings. Leave getMyMobileSettings as auth-only
(returns caller's own settings, correctly scoped).

Addresses: access-boundary-auditor/CRITICAL-001

Plan: docs/plans/2026-04-13-e2e-audit-fixes/packages/03-mobile-settings-role-enforcement.md
Closes: docs/test-audits/access-boundary-auditor/2026-04-11-full-platform-e2e.md#CRITICAL-001
```

## Test Plan
- Unit test: call getMobileUserSettings with a non-admin user (e.g., Role.USER). Assert ForbiddenException.
- Unit test: call getMobileUserSettings with Role.TENANT_ADMIN. Assert success.
- Unit test: call getMyMobileSettings with a non-admin user. Assert success (auth-only, no role required).
- Unit test: call updateMobileUserSettings with a non-admin user. Assert ForbiddenException.
- Unit test: call bulkUpdateMobileSettings with a non-admin user. Assert ForbiddenException.
- Unit test: call getMobileUsersSettings with a non-admin user. Assert ForbiddenException.

## Verification Command
`npx tsc --noEmit -p apps/auth-service/tsconfig.json && npx jest --testPathPattern="apps/auth-service/src/modules/tenant" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
