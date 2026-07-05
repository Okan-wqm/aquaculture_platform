# Messaging + AI RBAC Capabilities — Review of Record

- **Date:** 2026-07-05
- **Driver:** platform owner — tenant-configurable RBAC (each tenant admin decides who-can-do-what; members see only granted actions). Plan Faz 7.

## Duplicate check first (per owner directive: never duplicate — improve the existing)

Investigation found the tenant-configurable RBAC is **already built and wired end to end** — it must be EXTENDED, not re-implemented:

| Concern | Existing implementation |
|---|---|
| Capability catalogue SSoT | `PERMISSION_CATEGORIES` (`apps/auth-service/src/modules/tenant/services/tenant-role.service.ts`) — category → resources → actions; wire string `resourceKey:action` |
| Storage | `auth.tenant_roles` / `auth.tenant_role_permissions` / `auth.user_role_assignments` |
| Token-mint resolution | `TokenService.getUserResourcePermissions` JOINs the tables → `resourcePermissions` JWT claim (cached) |
| Enforcement | `@RequireTenantPermission` + `TenantPermissionGuard` (`libs/backend-common`); gateway `permission.guard` |
| Default seeding | `DEFAULT_TENANT_ROLES` + `DEFAULT_ROLE_PERMISSIONS` + `seedDefaultRoles`; provisioning wildcard admin |
| Tenant-admin CRUD | `tenant-role.resolver` (GraphQL) + FE `web/modules/tenant-admin` (RoleManagementPage, TenantRolesPage, RoleModal, useTenantRoles) |

An earlier attempt to add a parallel catalogue + resolver in `libs/backend-common/src/rbac` (PR #884) was a **duplicate of this system** and was closed.

## Real gap

| ID | Sev | Finding | State |
|---|---|---|---|
| MT-HIGH-053 | HIGH | `PERMISSION_CATEGORIES` (the RBAC catalogue SSoT) had ZERO messaging + AI capabilities — the new WhatsApp-like messaging and AI-assistant/BYOK features were entirely ungovernable by tenant RBAC (a tenant admin could neither grant nor restrict them), and seeded roles granted none of them | RESOLVED (this) |
| MT-HIGH-054 | HIGH | Hardcoded feature gates not yet routed through the capability check: group creation (`create-channel.handler` MODULE_MANAGER gate, MSG-MEDIUM-070) → `channels:create_group`; AI persona tier (AISAFETY-MEDIUM-013) → `ai_personas:<tier>`; AI settings CRUD → `ai_settings:manage`; AI chat → `ai_assistant:use` | OPEN (Faz 7c) |

## Delivered (MT-HIGH-053)

Extended the existing SSoT in `tenant-role.service.ts` — nothing parallel:
- **`PERMISSION_CATEGORIES`** gains two categories with globally-unique resource keys (the wire string is `resourceKey:action`, so keys must not collide — AI settings is `ai_settings`, never `settings`):
  - `messaging` → `channels` (`view`, `create_group`, `create_dm`, `manage`), `messages` (`send`)
  - `ai` → `ai_assistant` (`use`), `ai_settings` (`view`, `manage`), `ai_personas` (`operator`, `manager`, `expert`, `supervisor`)
- **`DEFAULT_ROLE_PERMISSIONS`** grants messaging/AI to all five seeded roles at sensible tiers (member-floor is WhatsApp-like: chat + DM + group + operator persona; Supervisor also gets `ai_settings:manage` and the manager/expert persona tiers; Viewer can DM + chat but not start groups).

Because `permissionCategories` (query) and the FE role editor are **data-driven**, the tenant-admin role UI now shows the messaging/AI capabilities automatically — no FE change. `TokenService` resolves them into `resourcePermissions` and `TenantPermissionGuard` enforces them with no code change.

New spec `permission-catalogue.spec.ts` locks the coverage in and adds the previously-unguarded **global resource-key-uniqueness invariant** (a collision would silently merge permissions across features).
