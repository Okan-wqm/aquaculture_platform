# Tenant-Configurable RBAC — Design of Record

- **Date:** 2026-07-05
- **Driver:** platform owner requirement — platform RBAC is incomplete; each tenant must configure its OWN RBAC (the tenant admin decides who-can-do-what), and members see only the actions/UI they were granted, enforced in the backend AND reflected in FE visibility.
- **Plan:** Faz 7 of `mutable-wiggling-prism`.

## Existing primitive (reuse, do not duplicate)

The platform already ships a permission primitive: `@RequireTenantPermission('resource:action')` (`libs/backend-common/src/decorators/require-permission.decorator.ts`) + `TenantPermissionGuard` (`libs/backend-common/src/guards/tenant-permission.guard.ts`), which bypasses SUPER_ADMIN/TENANT_ADMIN and, for MODULE_MANAGER/MODULE_USER, requires every listed permission in the user's `resourcePermissions` JWT claim. **What was missing** is the tenant-configurable layer that FILLS that claim: a capability SSoT, per-tenant role/grant storage, mint-time resolution, and FE visibility.

## Findings

| ID | Sev | Finding | Slice |
|---|---|---|---|
| MT-HIGH-053 | HIGH | No capability catalogue SSoT and no effective-capability resolver — permission strings are ungoverned magic strings, and nothing computes a user's effective capability set from platform-role floors + tenant grants to fill the `resourcePermissions` claim | Faz 7a (this) |
| MT-HIGH-054 | HIGH | No per-tenant RBAC storage/management — `tenant_role`, `tenant_role_permission`, `tenant_user_role` (auth schema) + tenant-admin CRUD; token-mint must resolve grants into `resourcePermissions` | Faz 7b (TODO) |
| MT-MEDIUM-055 | MEDIUM | No FE permission visibility — `me.permissions` query + `useHasPermission(cap)` hook so members see only granted actions; server still enforces independently | Faz 7c (TODO) |

## Faz 7a (delivered)

- **Capability catalogue** (`libs/backend-common/src/rbac/capabilities.ts`) — the SSoT of valid `resource:action` capabilities, grouped by domain (messaging, ai, rbac), with `Capability` type, `isCapability()` validator, and `knownCapabilities()` drift-safe filter.
- **Effective-capability resolver** (`permission-resolver.ts`) — `DEFAULT_ROLE_CAPABILITIES` (platform-role floors; member floor is WhatsApp-like: chat + DM + group + operator persona; admins get the whole catalogue) and `resolveEffectiveCapabilities({ roles, tenantGrants })` = role floor ∪ tenant grants, deduped, catalogue-validated, stable order. This is what auth-service will call at token-mint to fill `resourcePermissions`, and what `me.permissions` returns.
- Pure and fully unit-tested (12 cases). No change to the existing decorator/guard.

## Interaction with shipped hardcoded gates

The already-shipped defaults migrate onto capabilities in Faz 7b/c: group creation → `messaging-group:create`, AI persona tiers → `ai-persona-<tier>:use`, AI settings CRUD → `ai-config:manage`. Until then they run as the sensible defaults already in place.
