# Tenant user + RBAC — end-to-end review & bridge (2026-07-07)

Operator report: as a tenant admin, `https://app.suderra.com/tenant/users` is not visible;
"tenants create their own roles" was agreed but the how/where is unclear. This review maps the
full workflow, roots-causes the visibility symptom, and tracks the fixes + remaining gaps.

## End-to-end (all already on `main` + deployed — NOT missing code, NOT stuck on a branch)

- **User create/invite:** `createTenantUser` → `TenantUserManagementService` → `UserLifecycleService.createUser`
  → `auth.users` + `auth.user_role_assignments` + invite email (SHA-256 token, 7d) or direct password.
  New user's GLOBAL role defaults to `MODULE_USER` (`user-lifecycle.service.ts`); the tenant custom role is separate.
- **Tenant role create:** `createTenantRole` (SERIALIZABLE) → `auth.tenant_roles` + `auth.tenant_role_permissions`,
  permissions chosen from `PERMISSION_CATEGORIES` (8 cats incl. messaging/ai) in `tenant-role.service.ts`.
- **Assign:** `assignUserRole` / `updateTenantUser(roleId)` → `auth.user_role_assignments` (UNIQUE user_id).
- **Token:** `TokenService.getUserResourcePermissions` flattens role `resource_permissions` into the JWT
  `resourcePermissions` claim; gateway threads it to subgraphs; `TenantPermissionGuard` (already registered
  in sensor-service, used on edge-device) enforces `@RequireTenantPermission`.

## Visibility root cause (build EXONERATED)

Droplet forensics ruled out the build: SRI manifest is empty (guard is inert for `type:'module'`
remotes → every other module loads), no shared-dep version skew between the shell tag and the
tenant-admin tag, all federation chunks present. Cause is the **auth/role layer**: the FE gates
`/tenant/*` purely on `role === 'TENANT_ADMIN'`. Most likely a **stale JWT** (re-login) or the tested
account's global role isn't `TENANT_ADMIN`. Confirm via the operator's account (email → `auth.users`
read, or decode the JWT `role` claim). Tracked as **RBAC-DIAG-001** (needs operator input).

## Fixed this PR

### MT-MEDIUM-059 — tenant role management had no rendered nav entry (discoverability) — RESOLVED
`/tenant/roles` (TenantRolesPage) + role CRUD exist end-to-end, but the rendered shell sidebar
(`web/shell/src/layouts/MainLayout.tsx` `tenantAdminBaseNavigation`) linked only Users, not Roles.
The one sidebar that listed "Roles & Permissions"
(`web/modules/tenant-admin/src/components/TenantAdminSidebar.tsx`) was **dead code, never mounted**.
Fix: add a "Roles & Permissions" → `/tenant/roles` nav item; delete the dead duplicate sidebar. This is
why "how do tenants create roles" was unanswerable — the UI existed but nothing linked to it.

### MT-HIGH-058 — per-user permission_overrides had zero runtime effect (security) — RESOLVED
`auth.user_role_assignments.permission_overrides` (`{grants,revokes}`) was written by the admin UI and
surfaced by the effective-permissions read path, but `TokenService.getUserResourcePermissions` never
SELECTed it — so the JWT `resourcePermissions` claim the guard enforces reflected only the role base;
grants/revokes did nothing. Fix: fold overrides into the token via a NEW shared SSoT
(`permission-overrides.util.ts`: `parsePermissionOverrides` + `applyPermissionOverrides`, revoke-then-grant)
that BOTH the token mint and the read path import, so the two can no longer diverge (removed the
duplicated private logic in `tenant-user-management.service.ts`). Tests: util 9/9, token fold e2e case,
no regressions.

### MT-HIGH-060 — tenant user/role mutations hard-gated to TENANT_ADMIN (no delegation) — RESOLVED (backend)
Every operation on `tenant-role.resolver.ts` (11 mutations + 5 queries) was gated by
`@Roles(SUPER_ADMIN, TENANT_ADMIN)` / `@TenantAdminOrHigher()`, so a tenant could NOT delegate
user/role administration to a custom role — the whole point of tenant-configurable RBAC. Fix:
register `TenantPermissionGuard` as an opt-in `APP_GUARD` in auth-service (mirroring the proven
sensor-service registration) and route every operation through `@RequireTenantPermission(cap)` mapped
to the catalogue (`roles:create/edit/delete/view`, `users:invite/edit_permissions/deactivate/view`).
Behavior-preserving TODAY (both guards are opt-in; SUPER/TENANT_ADMIN still bypass, ungranted users
still denied) — it only enables a tenant user whose custom role grants the capability. A structural
regression test (`tenant-role.resolver.gating.spec.ts`) asserts EVERY operation is gated (no method
can silently fall through both opt-in guards) + verifies the mapping. Convention: a delegated
user-management role must also carry `roles:view` (you cannot assign a role you cannot see).
**FE half:** now closed by MT-HIGH-061 below.

### MT-HIGH-061 — tenant-admin panel (FE) hard-gated on global TENANT_ADMIN (no delegation reach) — RESOLVED
The shell gated `/tenant/*` (route + module guard + nav) purely on `role === 'TENANT_ADMIN'`, so a
delegate whose tenant role grants panel capabilities could not REACH the pages the backend
(MT-HIGH-060) now lets them use. Fix, reusing the existing FE primitives (no parallel machinery):
- New capability SSoT `web/shared-ui/src/utils/tenant-capabilities.ts` (`hasResourcePermission`,
  `hasTenantPanelAccess`, `TENANT_PANEL_CAPABILITIES`) — `useAuth().hasPermission` now delegates to it
  (removes the duplicated inline check).
- `App.tsx` `ProtectedRoute` gains `requiredCapabilities` (role OR capability); `/tenant/*` passes for a
  global tenant admin or any panel capability.
- tenant-admin `RequireTenantAdmin` becomes the panel-access outer gate; a new `RequireTenantCapability`
  gates each page — TENANT_ADMIN bypasses, a delegate needs the page's specific capability, and
  admin-only pages (billing/database/audit/modules/…) accept only a global admin.
- `MainLayout` surfaces the delegatable tenant nav items (Users/Roles/Settings) to a delegate holding
  the matching capability.
Fail-closed throughout; the backend enforces independently. Verified: capability-util spec 6/6;
Module.spec 15/15 incl. delegation cases (a `users:view` delegate reaches `/tenant/users`, is redirected
from `/tenant/billing` and from the non-granted `/tenant/roles`); shell + tenant-admin + shared-ui lint green.

## Tracked, NOT in this PR (owner + follow-up)

- **MT-HIGH-054 (HIGH, OPEN — existing registry finding)** — the two role systems are not bridged for PANEL ACCESS: a tenant can grant a
  custom role the `admin`-category perms (`users:view`, `roles:view`, …) but the FE still hard-gates
  `/tenant/*` on global `TENANT_ADMIN`, so tenant-configured admin delegation can't reach the panel. Fix:
  extend `NavigationItem` + shared-ui `Sidebar` for capability gating (reuse the existing
  `hasPermission()`/`decodeResourcePermissions`), and gate MainLayout nav selection + `App.tsx`
  `ProtectedRoute` + `RequireTenantAdmin` on capability OR role. High blast radius (shared-ui Sidebar) →
  own PR + e2e. Owner: frontend-expert + auth-security-expert.
- **RBAC-SSOT-001 (MEDIUM)** — `PERMISSION_CATEGORIES` is duplicated: served SSoT in `tenant-role.service.ts`,
  a copy in `admin-api-service/.../tenant-role-permissions.entity.ts`, and a FE mirror in
  `web/modules/tenant-admin/src/types/permissions.ts`; the unmerged `feat/rbac-phase7-foundation` adds a 4th
  (`libs/backend-common/src/rbac/capabilities.ts`) — do NOT merge it. Consolidate to one source. Owner: data-expert.
- **RBAC-DEPLOY-001 (MEDIUM)** — prod deploy tag skew: `aqua-tenant-admin` ran commit `d2b733359` while the
  shell + 7 other remotes ran `c4e0f1a80`. Harmless here (no shared-dep divergence) but a deploy-integrity
  violation. Fix: atomic deploy / CI gate failing when any remote image tag ≠ shell tag. Owner: infra-expert.
- **RBAC-DEPLOY-002 (MEDIUM/security)** — prod shell `remoteHashes.json` is EMPTY → SH-SEC-04 SRI enforcement
  is effectively OFF, and the `createElement` guard never intercepts native `import()` module-remotes. Fix:
  wire `scripts/generate-sri-hashes.sh` into the image build + move enforcement to import-map/CSP-hash or a
  service worker. Owner: frontend-expert + infra-expert.
- **RBAC-DIAG-001** — operator `/tenant/users` visibility: confirm the tested account's `role`/`accessType`/
  `tenantId` (re-login first). Blocked on operator input.

## Unrelated pre-existing problems noted (not mine, not fixed)

- `docs/reviews/orphan-findings.md` contains committed Git conflict markers on `main`
  (`<<<<<<< HEAD` / `>>>>>>> origin/main`) — the file was merged with unresolved markers. Owner: whoever
  merged the ORPHAN-336/337 lines; needs a conflict-resolution commit.
- `apps/auth-service/.../auth-user-query-nats.handler.spec.ts` fails on an `AuditModule`/`DataSource` DI
  wiring issue (quarantined-style, DB-independent) — pre-existing, unrelated to this change.
