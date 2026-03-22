# Tenant Module — Security Discovery Log

Date: 2026-03-22
Scope: `apps/auth-service/src/modules/tenant/`

## Fixed (CRIT/HIGH)

### CRIT-001: deleteTenantUser missing refresh token revocation
- **File**: `services/tenant-user-management.service.ts`
- **Issue**: `deleteTenantUser()` deactivated user and revoked role assignments but did NOT revoke refresh tokens. Deleted users could continue accessing the system with existing tokens.
- **Fix**: Delegated to `UserLifecycleService.deleteUser()` which performs all three operations atomically.

### HIGH-001: Object.assign with untrusted input in TenantService.update()
- **File**: `services/tenant.service.ts`
- **Issue**: Both SUPER_ADMIN and TENANT_ADMIN code paths used `Object.assign(tenant, input)` which could set unexpected properties if the input DTO had extra fields.
- **Fix**: Replaced with explicit field-by-field mapping for both paths.

### HIGH-002: Duplicate updateTenantSettings mutation
- **File**: `resolvers/tenant.resolver.ts`, `services/tenant.service.ts`
- **Issue**: Two separate mutations (`updateTenant` and `updateTenantSettings`) with duplicated logic and inconsistent behavior.
- **Fix**: Removed `updateTenantSettings` mutation. `updateTenant` now applies role-based field filtering internally via `callerRole` parameter.

### HIGH-003: MobileSettingsService tenant isolation bypass
- **File**: `services/mobile-settings.service.ts`
- **Issue**: `getByUserId()` and `update()` queried by `userId` only, without filtering by `tenantId`. A TENANT_ADMIN could potentially access another tenant's user settings if they knew the userId.
- **Fix**: Added `tenantId` to all `findOne()` where clauses.

## Remaining (MED/LOW — Not Fixed)

### MED-001: TenantAdminService.deactivateUser not delegated to UserLifecycleService
- **File**: `services/tenant-admin.service.ts`
- **Issue**: `deactivateUser()` directly deactivates user and revokes tokens. While it does revoke tokens (unlike the old deleteTenantUser), the logic is duplicated with UserLifecycleService.
- **Impact**: Code duplication. Future changes to deactivation logic must be updated in two places.
- **Recommendation**: Delegate to a shared method in UserLifecycleService.

### MED-002: TenantAdminService.assignUserToModule has inline user creation
- **File**: `services/tenant-admin.service.ts`
- **Issue**: `assignUserToModule()` creates users inline when email doesn't exist. This is a separate creation path from UserLifecycleService.createUser(), missing role assignment in tenant schema.
- **Impact**: Users created via module assignment skip the tenant role system.
- **Recommendation**: Use UserLifecycleService.createUser() for the user creation step.

### LOW-001: Unused import cleanup
- **File**: `resolvers/tenant-role.resolver.ts`
- **Issue**: `Context` was imported from `@nestjs/graphql` but never used.
- **Fix**: Removed.
