# Discovery Log - Tenant Isolation Architect (Agent 1)

## Findings from Discovery Pass (2026-03-22)

### MED: Duplicated UUID regex across codebase

**Files affected:**
- `libs/backend-common/src/database/tenant-schema.utils.ts` - `UUID_V4_REGEX`
- `libs/backend-common/src/middleware/tenant-context.middleware.ts` - inline regex
- `libs/backend-common/src/guards/tenant.guard.ts` - inline regex (duplicated twice)
- `libs/backend-common/src/redis/tenant-redis.service.ts` - local `UUID_REGEX`
- `libs/backend-common/src/database/rls/tenant-rls.service.ts` - local `UUID_REGEX`

**Recommendation:** All files should import `UUID_V4_REGEX` from `tenant-schema.utils.ts` or a central `constants.ts` to avoid regex drift.

### MED: tenant-schema.middleware.ts defines its own TenantRequest interface

**File:** `libs/backend-common/src/middleware/tenant-schema.middleware.ts` (line 11-20)

The file defines a local `TenantRequest` interface instead of importing from the canonical location (`types/tenant-request.interface.ts`). This creates type drift risk if fields are added to the canonical interface.

### LOW: SessionManagerService and TokenBlacklistService use raw Redis client

**Files:**
- `libs/backend-common/src/security/session-manager/session-manager.service.ts`
- `libs/backend-common/src/security/token-blacklist/token-blacklist.service.ts`

Both inject raw `ioredis.Redis` via `@Inject('REDIS_CLIENT')` instead of using `RedisService`. This means they bypass the `RedisService` key prefix system and use their own prefixing. Not a security issue since these are user-scoped (not tenant-scoped), but inconsistent.

### LOW: TenantContextMiddleware accepts tenantId from query parameter without UUID validation

**File:** `libs/backend-common/src/middleware/tenant-context.middleware.ts` (line 108-111)

The `queryTenant` extraction path (source 3) does not validate that the tenant ID is a UUID. While TenantGuard later validates UUID format, there's a window where an invalid tenantId could be set on the request. The header-based extraction (source 1) similarly lacks UUID validation at this layer.

**Note:** The TenantGuard (separate middleware) does validate UUID format, so this is defense-in-depth, not a direct vulnerability.

### LOW: IdorGuard validateTenantAccess returns true when no resourceTenantId found

**File:** `libs/backend-common/src/security/validators/idor-guard.ts` (line 254)

When `resourceTenantId` is undefined (not found in request params/query/body), the guard returns `true` (allows access). While this is by design for routes that operate within the user's own tenant context, it could be confusing and should be documented more prominently.
