# Discovery Log — Auth Service Tenant Module

Scan date: 2026-03-22
Scanned by: Agent 2 (Auth Security Architect)
Scope: `apps/auth-service/src/modules/tenant/`

## Fixed (CRIT/HIGH) — in this PR

### CRIT-001: deleteTenantUser did NOT revoke refresh tokens
- **File**: `services/tenant-user-management.service.ts` (deleteTenantUser)
- **Impact**: After soft-deleting a user, their refresh tokens remained valid.
  An attacker could use a stolen refresh token to continue obtaining access tokens.
- **Fix**: Created `UserLifecycleService.deleteUser()` that revokes ALL refresh
  tokens as part of the deletion flow. `deleteTenantUser` now delegates to it.

### HIGH-002: MobileSettingsResolver entirely unguarded
- **File**: `resolvers/mobile-settings.resolver.ts`
- **Impact**: Any authenticated user could view/modify other users' mobile
  settings, including admin-level bulk operations.
- **Fix**: Added `@TenantAdminOrHigher()` to admin methods,
  `@Roles(Role.MODULE_USER, ...)` to `getMyMobileSettings`.

### HIGH-003: myModules query unguarded
- **File**: `resolvers/tenant-admin.resolver.ts`
- **Impact**: Any authenticated request could list module assignments.
- **Fix**: Added `@Roles(Role.MODULE_USER, Role.MODULE_MANAGER, Role.TENANT_ADMIN, Role.SUPER_ADMIN)`.

### HIGH-004: updateTenantSettings missing TenantUpdatedEvent
- **File**: `services/tenant.service.ts` (updateTenantSettings)
- **Impact**: When a TENANT_ADMIN updated settings, no `TenantUpdatedEvent` was
  published, causing downstream services to miss tenant configuration changes.
- **Fix**: Consolidated into `update()` with role-based field filtering.
  TenantUpdatedEvent is now published for ALL update paths.

### HIGH-005: TenantService.update() used unfiltered Object.assign
- **File**: `services/tenant.service.ts` (update)
- **Impact**: If a TENANT_ADMIN managed to call `update()` directly (bypassing the
  resolver's routing), they could modify `status`, `plan`, `maxUsers`.
- **Fix**: `update()` now accepts caller role and applies field allowlist for
  non-SUPER_ADMIN callers.

## Logged (MED/LOW) — for future work

### MED-001: MobileSettingsService.getByUserId queries by userId only, not tenantId
- **File**: `services/mobile-settings.service.ts` line 20
- **Issue**: `findOne({ where: { userId } })` does not include `tenantId` in the
  lookup. If a TENANT_ADMIN knows another tenant's userId, they could read
  cross-tenant mobile settings.
- **Recommendation**: Change to `findOne({ where: { userId, tenantId } })`.

### MED-002: TenantService.updateTenantSettings still exists as dead code
- **File**: `services/tenant.service.ts` (updateTenantSettings)
- **Issue**: The method is no longer called from the resolver (consolidated into
  `update()`), but the code remains. It could be accidentally re-used without
  proper event publishing.
- **Recommendation**: Deprecate or remove; ensure any remaining callers use
  `update(id, input, role)` instead.

### LOW-001: BulkUpdateMobileSettingsInput.userIds missing @IsUUID validation
- **File**: `dto/mobile-settings.dto.ts` line 48-49
- **Issue**: `userIds` is typed as `string[]` with `@Field(() => [ID])` but lacks
  `@IsUUID('4', { each: true })` class-validator decorator. Malformed UUIDs could
  reach the service layer.
- **Recommendation**: Add `@IsUUID('4', { each: true })` to the `userIds` field.

### LOW-002: MobileSettingsService.bulkUpdate processes users sequentially
- **File**: `services/mobile-settings.service.ts` (bulkUpdate)
- **Issue**: Uses a `for` loop calling `update()` one user at a time. For large
  tenant user bases this is O(n) database round-trips.
- **Recommendation**: Use a batch UPDATE query or Promise.all with concurrency
  limiting.
