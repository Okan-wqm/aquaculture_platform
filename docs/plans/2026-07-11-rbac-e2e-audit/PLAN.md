# RBAC End-to-End Audit — Remediation Plan

**Date:** 2026-07-11
**Scope audited:** Tenant-configurable RBAC shipped in **PR #923** (delegation + override enforcement + discoverability) and **PR #931** (drop dead parallel tenant-role subsystem), both merged to `main` (`ce87101e`) and deployed to production. Tenant-admin (`TENANT_ADMIN`) and platform-admin (`SUPER_ADMIN`) surfaces, end to end: web → gateway assertion → guards → services → SQL → schema, plus token mint, cache, impersonation, and lifecycle.
**Method:** 8 specialist read-only audit lanes (auth-security, access-boundary, admin/superadmin, multi-tenant, tenant-isolation, data-model, workflow-state, frontend). No code was modified during the audit.

> **Headline:** The system is **strongly isolated cross-tenant** (no CRITICAL/HIGH cross-tenant read/write/cache/event leak found — the ORPHAN-CRITICAL-100 remediation holds). The failure class is **authorization containment within a tenant**: the delegation model PR #923 shipped has **no "cannot grant more than you have" invariant on any write path**, one path (`updateUserRole` override-only) **skips the one authority guard that exists**, and privileged role-definition changes are **not audited**. Separately, the delegation feature is **non-functional on the frontend** (controls gate on role, not capability), so the primary value of #923 does not reach delegates today.

---

## Verdict summary

| Lane | Verdict | Worst finding |
|---|---|---|
| auth-security (enforcement) | **BLOCK** | C1 override-only escalation (verified in code) |
| access-boundary (gating) | CONDITIONAL | H2/H3 delegation broken + no capability ceiling |
| admin / superadmin | CONDITIONAL | H6 impersonation unenforced, H8 phantom permission store |
| multi-tenant | HIGH | H7 plan-tier decoupled, C2 capability injection |
| tenant-isolation | PASS (conditional) | H1 stale-permission cache |
| data-model / migrations | HIGH | H10 default roles never seeded, H11 no entity/unique-name |
| workflow-state | **BLOCK** | C3 no audit on role mutations |
| frontend | CONDITIONAL | H2/H9 role-not-capability gating + seed cache miss |

**Cross-tenant isolation: PASS.** **Within-tenant authorization containment + auditability: BLOCK.**

---

## Consolidated findings (deduplicated across all 8 lanes)

Convergence is noted per finding — a finding reached independently by multiple lanes is higher-confidence.

### CRITICAL

**RBAC-C1 — Override-only privilege escalation: `updateUserRole` skips the authority guard.** *(converged: auth-security ×2, multi-tenant, workflow, tenant-isolation cross-flag — VERIFIED in code)*
`apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts:645` — `assertRoleGrantAuthority(...)` runs **only** inside `if (input.roleId && input.roleId !== existing.role_id)`. An override-only update (no `roleId`, or unchanged `roleId`) skips it, then writes `permission_overrides` verbatim (`:665-668`), which `TokenService.getUserResourcePermissions` folds into the JWT `resourcePermissions` claim (`token.service.ts:585-616`) and `TenantPermissionGuard` enforces platform-wide.
**Exploit:** a MODULE_USER delegated `users:edit_permissions` (exactly the delegation #923 ships) calls `updateUserRole(userId=self, { permissionOverrides:{ grants:['roles:delete','users:deactivate','settings:edit','ai_settings:manage', …every capability…] } })`. Guard skipped → grants persist → on next refresh (≤15 min) the caller holds the full tenant-admin capability surface. Bounded to the tenant (cannot obtain the `SUPER_ADMIN`/`TENANT_ADMIN` role enum, cannot cross tenants) but defeats least-privilege entirely.
The same uncontained override write exists in `assignUserRole` and `UserLifecycleService.createUser` (via `createTenantUser`, gated only `users:invite`) — neither checks grant contents.

**RBAC-C2 — No capability ceiling and no catalogue whitelist on any grant path.** *(converged: auth-security ×2, multi-tenant MT-HIGH-063, access-boundary HIGH-002, workflow HIGH-004, frontend HIGH-001)*
`createRole`/`updateRole` accept arbitrary `panelPermissions: GraphQLJSON` (`tenant-role.dto.ts:243,284`) and `panelPermissionsToResourceArray` (`tenant-role.service.ts:322-334`) emits `${resource}:${action}` for **every** truthy leaf — the **category key is ignored** and there is **no check** that (a) the strings exist in `PERMISSION_CATEGORIES`, or (b) the granted set is a subset of the actor's own effective permissions. The only "ceiling" is a comparison of the admin-settable integer `level` (`assertRoleGrantAuthority:525`), which is decoupled from capability content. System roles block `name`/`level` edits but **allow `panelPermissions` rewrites** (`:622-626`).
**Exploit A (injection):** submit `panelPermissions={ x:{ billing_admin:{ manage:true } } }` → persists `billing_admin:manage`; the catalogue is not authoritative, any `resource:action` string is storable and enforceable.
**Exploit B (escalation):** a delegate with `roles:edit` rewrites their own (or a seeded) role to include every capability; a delegate with `roles:create`+`users:invite` mints a max-capability role and assigns it to a confederate. No subset check anywhere.

**RBAC-C3 — Role-definition lifecycle emits zero audit rows.** *(workflow CRITICAL-001)*
`TenantRoleService` never injects `AuditLogService`; `createRole` (`:553-555`), `updateRole` (`:714-716`), `deleteRole` (`:802-804`), `setDefaultRole` (`:1164`), `seedDefaultRoles` (`:890`) log only via `this.logger`. A privileged permission rewrite that re-scopes every holder of a role is **forensically invisible** (SOC 2 CC6.1/CC7.2, GDPR Art 30). Contrast: the assignment paths in `tenant-user-management.service.ts` audit atomically and fail-closed — the pattern exists, it is simply not applied to role definitions.

### HIGH

**RBAC-H1 — Permission REVOKE not enforced until token expiry; `invalidateModuleCache` is dead code.** *(converged: auth-security, workflow HIGH-002, tenant-isolation MEDIUM-001, multi-tenant, access-boundary MEDIUM-002)*
Enforcement is a mint-time JWT snapshot. No RBAC mutation revokes tokens, bumps a per-user invalidation threshold, or clears the 60 s per-user `resourcePermissionCache`. `TokenService.invalidateModuleCache` has **zero callers** repo-wide. A revoke (override, role downgrade, role-permission edit) stays effective for up to the access-token TTL (≤15 min), and a refresh within 60 s re-mints the stale set. Cache is per-pod in-memory (multi-pod → needs a fleet-wide signal). Compounds C1: even after detecting a rogue self-escalation, an admin cannot promptly cut it.

**RBAC-H2 — Frontend delegation controls gate on ROLE, not CAPABILITY → the shipped delegation is inert.** *(converged: access-boundary HIGH-001/MEDIUM-001, frontend HIGH-001, admin LOW, workflow)*
`TenantRolesPage.tsx:519-520` (`canManageRoles = hasRoleOrHigher('TENANT_ADMIN')`) and `TenantUsers.tsx:69-70` (`canManageUsers`) gate every create/edit/delete/seed/assign control on the TENANT_ADMIN role, while the backend authorizes on granular `roles:*`/`users:*` capabilities. A delegate granted `roles:create` reaches `/tenant/roles` (route gated on `roles:view`) but sees no controls. Fail-closed (no escalation) but the delegation feature — the entire point of #923 Slice C — does nothing for delegates.

**RBAC-H3 — FE-delegatable panel capabilities point at role-gated backend queries (broken delegation, fails closed).** *(access-boundary HIGH-001)*
`TENANT_PANEL_CAPABILITIES` advertises `users:view` and `settings:view` as delegatable panel entry (`tenant-capabilities.ts:46-63`), but the backing queries `tenantUsers`/`myTenant`/`tenantStats`/`myTenantModules` and `updateTenantSettings` are still `@TenantAdminOrHigher()` (`tenant.resolver.ts:139-182,251`). A delegate granted `users:view`/`settings:view` enters the page and every query 403s. Incomplete migration: `TenantRoleResolver` moved to `@RequireTenantPermission` but `tenant.resolver.ts` did not.

**RBAC-H4 — Tenant suspend/deactivate/archive neither terminates sessions nor stops token refresh.** *(tenant-lifecycle HIGH)*
`refreshToken`/`refreshTokenWithHash` gate only on `user.isActive`, never re-checking tenant status; `SuspendTenantHandler` flips status + emits events but revokes no token families/sessions. The gateway `TenantContextMiddleware` treats `/graphql` (the primary federated API) as a public path and returns before any status check, else serves from a 5-min cache. Net: a suspended tenant's logged-in users keep full GraphQL access and silently rotate new tokens for the **refresh-token lifetime (days)**. Login is the only real gate.

**RBAC-H5 — `deleteTenantUser` does not revoke refresh tokens despite its docstring/resolver promise.** *(workflow HIGH-003)*
`tenant-user-management.service.ts:415-452` sets `isActive=false`, revokes role assignments, audits — but writes no `RefreshToken` revocation. Relies on the implicit `isActive` check in `authentication.service.ts` (a different service); if any future refresh path drops that check, the un-revoked token is a permanent live session for a "deleted" account. Current window: existing access token valid up to 15 min post-delete.

**RBAC-H6 — Impersonation is audit-only and unenforced.** *(converged: admin HIGH-001/002, tenant-lifecycle LOW)*
No downstream consumer of the impersonation token exists (grep: only admin-api's own `/sessions/validate`); the admin-panel "Open Tenant Portal" opens `/tenant` with the SUPER_ADMIN's **own** JWT. So RBAC during "impersonation" runs against the SUPER_ADMIN, `canModifyData:false` is never enforced, and per-action dual-identity audit depends on a best-effort FE `log-action` POST. Session capabilities are derived from the admin's grant, not the impersonated user's role. No **MFA step-up** at initiation (the `mfaCompleted` column is dead). Not a new escalation beyond existing SUPER_ADMIN power, but the "read-only impersonation" boundary is advisory — becomes CRITICAL the moment impersonation is wired to real tenant access.

**RBAC-H7 — Plan-tier fully decoupled from capability grants; downgrade re-evaluates nothing.** *(converged: multi-tenant MT-HIGH-062, tenant-lifecycle MEDIUM, auth SEC-LOW)*
The catalogue (`permissionCategories`) is returned in full to every tenant regardless of `planLevel`/`tenant_modules`; `createRole`/`updateRole`/override writes never check plan; `getUserResourcePermissions` folds capabilities with no module/plan intersection; the ai/messaging subgraphs gate only on the capability (zero `planLevel`/`tenant_modules` references). A STARTER tenant can grant itself `ai_settings:manage`/`channels:create_group`. `TenantSubscriptionProjectionHandler` projects only `plan`/dates on downgrade — enabled modules and granted roles/overrides persist across ENTERPRISE→STARTER. The MT-HIGH-057 backfill granted messaging/AI caps to **every** tenant's default-named roles irrespective of entitlement — a concrete over-grant instance.

**RBAC-H8 — `shared.user_permissions` is a phantom permission store whose writes have zero authorization effect.** *(admin HIGH-001)*
`apps/admin-api-service/src/users/entities/user-permissions.entity.ts` + `user-permissions.service.ts:45-66` + `users.controller.ts:490-660` persist a `PanelPermissions` matrix that **no guard or token path reads** (enforcement comes from `auth.tenant_role_permissions` via the JWT). An operator toggling permissions here believes they revoked a capability that is still live — security theater. (Also effectively dead: gated SUPER_ADMIN yet requires `req.user.tenantId`, which SUPER_ADMIN lacks.) Residue #931 did not remove.

**RBAC-H9 — Seed-roles mutation does not refresh the list (onboarding appears broken).** *(frontend HIGH-002)*
`useTenantRoles.ts:520` invalidates `roleKeys.all()` = `['tenant', t, 'tenant-roles', {epoch}]`, but the list query lives under `roleKeys.lists()` = `[…, 'tenant-roles', 'list', {epoch}]`; TanStack's left-prefix match fails on the object-vs-string index-3 mismatch, so no refetch fires. New admin clicks "Seed Default Roles", server succeeds, page still shows "No roles defined" → invites a duplicate seed. Fix: use `createTenantInvalidationKey` (no epoch) for all `invalidate/removeQueries`.

**RBAC-H10 — `seedDefaultRoles` is a permanent no-op: the 5 operational default roles are never created for any provisioned tenant.** *(data-model DATA-HIGH-002; converged with tenant-lifecycle M5)*
`tenant-role.service.ts:838-847` guards seeding with `SELECT COUNT(*) … WHERE "tenantId"=$1; if count>0 → skip`. Provisioning **always** inserts a TENANT_ADMIN row first (`tenant-provisioning-command.service.ts:250-296`), so the count is always ≥1. When an admin later calls the `seedTenantRoles` mutation, the guard sees count>0 and returns the existing set **without ever creating** Supervisor/Technician/Feed Manager/Operator/Viewer (`DEFAULT_TENANT_ROLES`). The advertised default-role set of tenant-configurable RBAC is thus unreachable for every real tenant — two seed subsystems writing one table where one assumes it is the sole writer. Fix: make the seed idempotent per-role (upsert by `(tenantId, name)`) or gate on "the 5 named defaults are absent", and unify provisioning onto one seed path.

**RBAC-H11 — Three centralized RBAC tables have no TypeORM entity and no unique `(tenantId, name)` constraint.** *(data-model DATA-HIGH-003 + DATA-HIGH-005)*
`auth.tenant_roles`/`tenant_role_permissions`/`user_role_assignments` have **no `@Entity`** (0 matches) — DDL owned by admin-api migrations, DML issued as raw SQL from **both** auth-service and admin-api. So they are invisible to `SchemaDriftValidator` (ADR-012 blind spot), the cross-service column contract is hand-maintained (the ORPHAN-CRITICAL-100 class), and it violates ADR-011 single-owner DDL. Separately, the only unique index is `(tenantId, code) WHERE code IS NOT NULL` — the new model never sets `code`, so duplicate role **names** per tenant are permitted at the DB layer (uniqueness rests solely on the app-layer SERIALIZABLE dup-check, which the `ON CONFLICT DO NOTHING` provisioning path bypasses). Fix: give the tables a canonical entity in the owning service routed through `SchemaDriftModule`; add `UNIQUE (tenantId, LOWER(name))`.

### MEDIUM

- **RBAC-M1** — `settings:view`/`settings:edit` advertised on the FE as delegatable with **zero** backend enforcement point (dead delegation surface). *(access-boundary MEDIUM-001)*
- **RBAC-M2** — No per-tenant quota on custom-role count, `permissionOverrides.grants/revokes` length, or `panelPermissions` blob size → noisy-neighbor on the shared `auth` table **and** unbounded `resourcePermissions` inflating the RS256 JWT + gateway `X-Service-Assertion` header (431 / connection-reset risk). *(multi-tenant MT-MEDIUM-064, auth SEC-MEDIUM)*
- **RBAC-M3** — RBAC tables have no DB-level tenant backstop: no RLS, and `tenant_role_permissions`/`user_role_assignments` carry **no `tenantId` column** (tenancy is transitive via join). App-layer scoping is currently correct on every audited query, but one forgotten predicate leaks with nothing behind it. ADR-038 (RLS on auth role tables) is unratified. *(converged: tenant-isolation MEDIUM-001, multi-tenant MT-MEDIUM-065)*
- **RBAC-M4** — #931 residue in admin-api: dead `RoleTemplateService.createCustomRole`/`getTenantCustomRoles` writing an unqualified `tenant_custom_roles` table that no migration creates, and a hardcoded `RoleTemplateService` catalogue (`:53-281`) with a **different vocabulary** than the enforced `PERMISSION_CATEGORIES`, feeding the SUPER_ADMIN Role Management page fictional roles/permissions. *(converged: admin MEDIUM-001/002, tenant-isolation LOW)*
- **RBAC-M5** — Two divergent role models coexist in `auth.tenant_roles`: provisioning writes `code`/`permissions(jsonb=['*'])` rows (and seeds **only** TENANT_ADMIN), while `seedDefaultRoles` writes `name`/`level`/`is_system` + `tenant_role_permissions`. Enforcement reads only `tenant_role_permissions`, so the `['*']` wildcard is **inert** and provisioning-seeded roles mint empty permissions. `seedDefaultRoles` is never called at provisioning (migration header claim is false). *(converged: tenant-lifecycle MEDIUM ×2)*
- **RBAC-M6** — No systematic capability backfill: name-keyed one-off migrations (MT-HIGH-057 pattern) silently miss renamed/custom roles; every future capability needs another bespoke migration. *(tenant-lifecycle MEDIUM)*
- **RBAC-M7** — Impersonation TTL exceeds policy: request `@Max(480)`=8h, grant `@Max(1440)`=24h vs the ≤1h absolute cap; no inactivity/idle timeout. *(admin MEDIUM-003)*
- **RBAC-M8** — Delete-role UI contradicts backend: button stays enabled with a "they will lose access" warning, but the backend hard-blocks delete while active holders exist (`tenant-role.service.ts:782`) → raw ForbiddenException. *(workflow MEDIUM-001)*
- **RBAC-M9** — Role edit is last-write-wins: `updateRole` full-overwrites `panelPermissions` with no `updatedAt`/version precondition; two concurrent admin edits silently lose one. *(workflow MEDIUM-002)*
- **RBAC-M10** — Duplicate, unaudited, unguarded role-lifecycle methods in `TenantRoleService` (`assignRoleToUser`/`removeRoleFromUser`/`setDefaultRole`) — only tests call them; a future wiring reintroduces the horizontal-escalation + audit hole. *(workflow MEDIUM-003)*
- **RBAC-M11** — Deny-by-default is not structural: `TenantPermissionGuard` + `RolesGuard` are opt-in (undecorated mutation → open to any authenticated tenant user), protected only by a **hand-maintained allowlist** spec (`tenant-role.resolver.gating.spec.ts`), not a reflection over actual resolver operations. *(converged: auth SEC-MEDIUM/LOW, access-boundary MEDIUM-003)*
- **RBAC-M12** — Impersonation start FE↔BE contract drift (FE sends `{adminId, reason:string}`, BE requires `{targetTenantId, reason:enum}`) → 400; `getSessionActions` throws "Not implemented" → the impersonation UI is non-functional as shipped. *(admin MEDIUM-004)*
- **RBAC-M13** — FE role mutations invalidate `userKeys.lists()` = `['tenant', t, 'tenant-users', …]` but the users list lives under `tenantKeys.users()` = `['tenant', t, 'users', …]` → silent no-op; users list shows stale role data until staleTime. *(frontend MEDIUM-001)*
- **RBAC-M14** — Roles page renders a false-empty state + "Seed Default Roles" offer on query **error** (`roles = []` default) → an admin may double-seed. *(frontend MEDIUM-002)*
- **RBAC-M15** — Duplicate orphaned `components/roles/RoleModal.tsx`/`DeleteRoleModal.tsx` exported from the barrel but unused; the orphaned copies lack the focus-trap + `useId` the inline page copies have (inferior a11y variant reachable by future importers). *(frontend MEDIUM-003)*
- **RBAC-M16** — `PermissionCheckboxGroup` category select-all is a non-focusable `<span role="checkbox">` nested inside a `<button>` (invalid; WCAG 2.1.1 keyboard + 4.1.2 name/role/value) → keyboard users can't toggle a category. *(frontend MEDIUM-004)*
- **RBAC-M17** — `MODULE_SCHEMAS[auth]` misclassifies the three centralized tables as per-tenant `tables` instead of `infrastructureTables` (`schema-manager.service.ts:736-741`); a `createTenantSchema` call whose module list includes `auth` would `CREATE TABLE LIKE` the per-tenant clones the topology migration DROPs and RAISEs on. Mitigated only because `DEFAULT_TENANT_MODULES` excludes `auth`. Move them to `infrastructureTables`. *(data-model DATA-MEDIUM-006)*
- **RBAC-M18** — Missing foreign keys → orphan-row risk: `user_role_assignments.user_id` has **no FK** to `auth.users`, and `tenant_roles.tenantId` has **no FK** to `auth.tenants` (inconsistent with `tenant_modules`'s `ON DELETE RESTRICT`). Hard-deleting a user or tenant strands assignment/role rows. Add `FK user_id → auth.users ON DELETE CASCADE` and `FK tenantId → auth.tenants ON DELETE RESTRICT`. *(data-model DATA-MEDIUM-007)*
- **RBAC-M19** — Single-default-role invariant is app-only (no partial unique index); any bypassing writer/race can leave two `is_default=true` rows → `getDefaultRole` (`LIMIT 1`) returns a nondeterministic default. Add `UNIQUE INDEX ON auth.tenant_roles (tenantId) WHERE is_default`. *(data-model DATA-MEDIUM-008)*
- **RBAC-M20** — RBAC migrations omit the mandatory `SET LOCAL lock_timeout/statement_timeout` envelope; the index migration uses plain `CREATE INDEX` (blocking) not `CONCURRENTLY`; the destructive topology `DROP TABLE … CASCADE` has a no-op `down()` and no independent backup/row-count reconciliation artifact. Add the envelope, use `CONCURRENTLY`, document the topology backup + reconciliation. *(data-model DATA-MEDIUM-010)*

### LOW

- **RBAC-L1** — Role delete `ON DELETE CASCADE` silently erases inactive `user_role_assignments` history (who once held the role), with no audit. *(workflow LOW-001)*
- **RBAC-L2** — No "≥1 default role per tenant" invariant; an admin can set their own `accessType=MOBILE_ONLY` and self-lock out of the panel (self role-change is blocked, accessType is not). *(workflow LOW-002)*
- **RBAC-L3** — `auth.tenant_roles.tenantId` is NULLABLE with no NOT NULL/FK/CHECK — a latent "platform-global role" over-grant surface. **Audit each environment for a leftover NULL-tenant row (the "codex-test global role").** Currently inert/fail-closed. *(converged: admin LOW-001, tenant-isolation LOW)*
- **RBAC-L4** — `AllowTenantAdmin()` decorator maps to `Roles('SUPER_ADMIN')` with stale "TENANT_ADMIN can…" comments — a rename toward real tenant-admin access + the tenant-scoped `req.user.tenantId` reads could open cross-tenant writes. Rename to `PlatformAdminOnly`. *(admin LOW)*
- **RBAC-L5** — Dead, non-tenant-scoped `web/modules/tenant-admin/src/lib/query-keys.ts` labeled "SSoT" (keys omit tenantId) — a cache-bleed landmine if imported. Delete or re-point to `createTenantQueryKey`. *(tenant-isolation LOW)*
- **RBAC-L6** — Unwired "Export" button renders (ungated) for read-only `users:view` delegates on `TenantUsers` — false affordance; needs a capability gate if wired. *(converged: access-boundary LOW-002, frontend)*
- **RBAC-L7** — Stale migration-number citations in `token.service.ts:570-579` / `tenant-role.service.ts:1086` point to the wrong service's migrations. *(tenant-isolation LOW)*
- **RBAC-L8** — Cross-service DDL/DML split: admin-api owns the `auth.*` role-table migrations while auth-service owns runtime read/write (ADR-011 ownership); `console.error` in `RoleManagementPage.tsx`; FE `gcTime`/prune-vs-`false` payload hygiene. *(admin LOW-002, frontend LOW-001)*

---

## Remediation phases

### Phase 0 — EMERGENCY (production security; land this week)

**P0.1 — Close RBAC-C1 + RBAC-C2 with one authority helper (Tier-1 make-it-impossible).**
Introduce `assertCanGrant(actor, requestedCapabilities, tenantId)` in the shared SSoT (`permission-overrides.util.ts` or a new `grant-authority.util.ts`) that enforces:
1. every requested `resource:action` ∈ flattened `PERMISSION_CATEGORIES` (catalogue whitelist);
2. requested set ⊆ actor's own effective `resourcePermissions` — **unless** actor is `SUPER_ADMIN`/`TENANT_ADMIN` (the existing role bypass);
3. (folds in P1.5) requested set ⊆ tenant's entitled modules.
Invoke it **unconditionally** on every capability-adding write: `updateUserRole` (move the call OUT of the `if (roleId changed)` branch), `assignUserRole`, `createRoleAssignment` (both services), `createUser`, `createRole`, `updateRole` (including system-role `panelPermissions`), `bulkAssignRole`. Persist only through a branded `GrantablePermissionSet` type that the helper alone can produce, so an un-checked write is a compile error. Forbid self-target on override writes.
Add `tests/invariants/rbac-grant-authority.spec.ts` asserting each write path calls the helper (Tier-3 backstop).
*Files:* `tenant-user-management.service.ts`, `user-lifecycle.service.ts`, `tenant-role.service.ts`, `permission-overrides.util.ts`, `tenant-role.dto.ts` (validate/bound override arrays).

**P0.2 — Close RBAC-C3: audit every role-definition mutation, atomically.**
Inject `AuditLogService` into `TenantRoleService`; inside each SERIALIZABLE transaction (thread `queryRunner.manager`) write `ROLE_CREATED`/`ROLE_UPDATED` (with `previousValue`/`newValue` permission sets) / `ROLE_DELETED`/`ROLE_SET_DEFAULT`, fail-closed (audit failure rolls back the mutation), mirroring the assignment paths. Add an invariant test that each role-lifecycle method commits an audit row in-transaction.
*Files:* `tenant-role.service.ts`, `audit-log.service.ts` (already supports `manager`).

**P0.3 — Environment audit for RBAC-L3.**
Run `SELECT id, name, "tenantId" FROM auth.tenant_roles WHERE "tenantId" IS NULL` in each environment; remove/repair any leftover NULL-tenant "global" role (the operator's noted `codex-test` role). This also answers the operator's open question about the codex-test account's effective grants.

### Phase 1 — HIGH (this sprint)

- **P1.1 (RBAC-H1)** — On every capability-reducing mutation, revoke the affected user(s)' sessions and clear the permission cache: wire `TokenService.invalidateModuleCache(userId)` + bump `tokensInvalidBefore`/blacklist, fanning out to all holders on a role-permission edit. Promote invalidation to a cross-pod signal (Redis pub/sub or a NATS `UserAuthorizationChanged` event) so the clear is fleet-wide. *Files:* `token.service.ts`, `tenant-user-management.service.ts`, `tenant-role.service.ts`.
- **P1.2 (RBAC-H2 + H3 + M1)** — Make capability the single gating axis. FE: replace `hasRoleOrHigher('TENANT_ADMIN')` control gates with `useCanTenantCapability(cap)` (wrapping `hasResourcePermission`) for `roles:create/edit/delete`, `users:invite/edit_permissions/deactivate`. BE: migrate `tenantUsers`/`myTenant`/`tenantStats`/`myTenantModules`/`updateTenantSettings` to `@RequireTenantPermission('users:view'|'settings:view'|'settings:edit')` **or** drop `users:view`/`settings:*` from the delegatable set — pick one SSoT. Add a parity invariant: every FE-delegatable capability maps to a backend `@RequireTenantPermission` on the query the page depends on. *Files:* `TenantRolesPage.tsx`, `TenantUsers.tsx`, `tenant-capabilities.ts`, `tenant.resolver.ts`, `Module.tsx`.
- **P1.3 (RBAC-H4)** — `refreshToken`/`refreshTokenWithHash` must call `isLoginAllowed(tenant.status)` before minting; suspend/deactivate/archive must revoke the tenant's refresh-token families + sessions; do not skip tenant-status enforcement on `/graphql`. *Files:* `authentication.service.ts`, `suspend-tenant.handler.ts`, gateway `tenant-context.middleware.ts`.
- **P1.4 (RBAC-H5)** — `deleteTenantUser` must revoke the user's refresh tokens + sessions in the same transaction as the soft-delete (defense-in-depth, independent of the refresh-time `isActive` check). *Files:* `tenant-user-management.service.ts`.
- **P1.5 (RBAC-H7)** — Derive the available catalogue from `tenant_modules ∩ PLAN_CATALOG` in one resolver used by both the editor query and the grant path (P0.1 condition 3); intersect `resource_permissions` with entitled modules at mint; on downgrade, re-evaluate/disable modules + granted caps in `TenantSubscriptionProjectionHandler`. Coordinate the module-dependency check with billing-expert. *Files:* `tenant-role.service.ts`, `token.service.ts`, `tenant-subscription-projection.handler.ts`.
- **P1.6 (RBAC-H8)** — Delete `UserPermissions` entity + `UserPermissionsService` + the `user_permissions`-backed controller endpoints (or make them a read-through projection of `auth.tenant_role_permissions`, never writable). *Files:* admin-api `users/` module.
- **P1.7 (RBAC-H6 + M7 + M12)** — Decide impersonation's target state: either make it **enforcing** (short-lived MFA-gated impersonation JWT carrying the impersonated user's role/`resourcePermissions` + `realUserId`, consumed at the gateway, server-side dual-identity audit) or stop presenting an unenforced permission model. Server-clamp absolute TTL ≤60 min + add ≤15 min inactivity; require MFA step-up at `sessions/start`; fix the FE↔BE start contract + implement `getSessionActions`. Route to security-reviewer + multi-tenant-saas-expert. *Files:* admin-api `impersonation/`, admin-panel `ImpersonationPage.tsx`.
- **P1.8 (RBAC-H9 + M13 + M14)** — FE query-truth: use `createTenantInvalidationKey` (no epoch) for all `invalidate/removeQueries` in `useTenantRoles`; invalidate the real users key (`tenantKeys.users()`); render the empty/seed state only when `!error && !isLoading && roles.length===0`. *Files:* `useTenantRoles.ts`, `TenantRolesPage.tsx`.

### Phase 2 — MEDIUM (next sprint)

- **P2.1 (RBAC-M2)** — `assertWithinQuota('tenant_roles', count, planLimit)` in `createRole`; `@ArrayMaxSize` on `grants`/`revokes`; cap serialized `panelPermissions` + resolved `resourcePermissions` size (fail-closed).
- **P2.2 (RBAC-M3)** — Ratify ADR-038: add `tenantId` columns to the two child tables + `FORCE ROW LEVEL SECURITY` keyed to request tenant context (blue-green: nullable → backfill → NOT NULL); at minimum add `tests/invariants/auth-role-query-tenant-scoped.spec.ts`.
- **P2.3 (RBAC-M4 + M5 + M6)** — Finish #931: delete `tenant_custom_roles` code + the stale `RoleTemplateService` catalogue (repoint the SUPER_ADMIN Role Management page at the auth-service SSoT `permissionCategories`). Collapse the two `tenant_roles` seeding shapes to one SSoT (provisioning delegates to `seedDefaultRoles`; remove the inert `permissions:['*']` model or make the mint read it as a bridge). Replace name-keyed backfill migrations with a catalogue-driven seed/upgrade routine.
- **P2.4 (RBAC-M8 + M9 + M15 + M16)** — Delete-role UI reflects backend truth (disable + "reassign N users first" when holders exist); add optimistic-concurrency (`updatedAt` precondition → 409 on conflict); delete orphaned modal copies (or port focus-trap into the shared ones); fix the category select-all a11y.
- **P2.5 (RBAC-M10)** — Collapse the duplicate `TenantRoleService` assignment/default methods into the single `TenantUserManagementService` SSoT (or have them delegate), so audit + authority checks can't be bypassed.
- **P2.6 (RBAC-M11)** — Rewrite `tenant-role.resolver.gating.spec.ts` to reflect over every `@Query`/`@Mutation` on the resolver and assert each carries a non-empty `@RequireTenantPermission`/`@Roles`; extend to all RBAC-adjacent resolvers.
- **P2.7 — Data-model hardening (RBAC-H11 + M17 + M18 + M19 + M20).** Give the three centralized tables a canonical TypeORM entity in the owning service (`@Entity(…, { schema:'auth' })`) routed through `SchemaDriftModule`; add `UNIQUE (tenantId, LOWER(name))` and `UNIQUE (tenantId) WHERE is_default`; add the two missing FKs; move the tables to `MODULE_SCHEMAS[auth].infrastructureTables`; add the `SET LOCAL lock_timeout/statement_timeout` envelope + `CREATE INDEX CONCURRENTLY` to the RBAC migrations and document the topology-DROP backup/reconciliation. **Note:** DATA-HIGH-001's cross-service raw-SQL ownership of the `auth` schema + the recurring three-model duplication is a **systemic** pattern — route to architectural-arbiter before landing P2.3/P2.7 so the single-owner decision is made once. *(Escalation flagged by data-model + auth-security lanes.)*

> **Sequencing note:** P2.3 (finish #931 dedup) and P2.7 (data-model) overlap heavily (both touch the two-model split and `seedDefaultRoles`). Land them together, arbiter-reviewed, after Phase 0/1 have closed the security-critical items.

### Phase 3 — LOW (backlog / opportunistic)

RBAC-L1 (audit-snapshot on role delete / count inactive holders), RBAC-L2 (default-role + self-lockout invariants), RBAC-L4 (rename `AllowTenantAdmin`), RBAC-L5 (delete dead `lib/query-keys.ts`), RBAC-L6 (gate/remove Export button), RBAC-L7 (fix migration citations), RBAC-L8 (consolidate DDL ownership, `console.error`→Logger, FE `gcTime`).

---

## What is verified-GOOD (do not regress)

- **Cross-tenant isolation holds** across all RBAC CRUD: every write derives `tenantId` from the RS256-verified JWT / HMAC-signed gateway assertion (never client input); every read/write is tenant-scoped (directly or laundered through the `tenant_roles` join); no `getRepository()` bypass in scope; a foreign `roleId`/`userId` returns 0 rows → 404.
- **JWT is RS256-only**, type + audience + per-jti/per-user blacklist enforced; refresh rotation has family reuse-detection.
- **Platform-role escalation is closed**: tenant mutations pin new users to `MODULE_USER`; no DTO exposes `role`/`tenantId`/`isSuperAdmin`; `ValidationPipe` whitelist + `forbidNonWhitelisted`.
- **admin-api is fail-closed SUPER_ADMIN-only** via a global `PlatformAdminGuard` that can't be widened by decorators; runtime migration execution hard-disabled; DB Explorer on a forced read-only DataSource.
- **The override fold is a genuine SSoT** — JWT `resourcePermissions` and the admin effective-permissions read both call `applyPermissionOverrides`, so enforcement and display can't diverge. (The bug is the *authority* on writing overrides, not the fold.)
- **Guard ordering** is correct: ServiceIdentity → RateLimit → Jwt → Tenant → Roles → TenantPermission.

---

## Finding-ID crosswalk (for `docs/reviews/` traceability)

C1 ← SEC-CRITICAL-001 / auth-core CRITICAL · C2 ← MT-HIGH-063, SEC-MEDIUM-001, PRODUCT-ACCESS-HIGH-002, WORKFLOW-HIGH-001/004, FE-HIGH-001, DATA-MEDIUM-009 · C3 ← WORKFLOW-CRITICAL-001 · H1 ← SEC-HIGH-001, WORKFLOW-HIGH-002, PRODUCT-TENANT-MEDIUM-001, PRODUCT-ACCESS-MEDIUM-002 · H2 ← PRODUCT-ACCESS-HIGH-001/MEDIUM-001, FE-HIGH-001 · H3 ← PRODUCT-ACCESS-HIGH-001 · H4 ← tenant-lifecycle HIGH · H5 ← WORKFLOW-HIGH-003 · H6 ← ADMIN-HIGH-002 · H7 ← MT-HIGH-062 · H8 ← ADMIN-HIGH-001 · H9 ← FE-HIGH-002 · H10 ← DATA-HIGH-002, tenant-lifecycle M5 · H11 ← DATA-HIGH-003, DATA-HIGH-005 · M1 ← PRODUCT-ACCESS-MEDIUM-001 · M2 ← MT-MEDIUM-064, SEC-MEDIUM · M3 ← PRODUCT-TENANT-MEDIUM-001, MT-MEDIUM-065, DATA-HIGH-004, ADR-038 · M4 ← ADMIN-MEDIUM-001/002 · M5 ← tenant-lifecycle MEDIUM, DATA-HIGH-001 · M6 ← tenant-lifecycle MEDIUM · M7 ← ADMIN-MEDIUM-003 · M8 ← WORKFLOW-MEDIUM-001 · M9 ← WORKFLOW-MEDIUM-002 · M10 ← WORKFLOW-MEDIUM-003 · M11 ← SEC-MEDIUM/LOW, PRODUCT-ACCESS-MEDIUM-003 · M12 ← ADMIN-MEDIUM-004 · M13 ← FE-MEDIUM-001 · M14 ← FE-MEDIUM-002 · M15 ← FE-MEDIUM-003 · M16 ← FE-MEDIUM-004 · M17 ← DATA-MEDIUM-006 · M18 ← DATA-MEDIUM-007 · M19 ← DATA-MEDIUM-008 · M20 ← DATA-MEDIUM-010 · L1 ← WORKFLOW-LOW-001 · L2 ← WORKFLOW-LOW-002 · L3 ← ADMIN-LOW-001, PRODUCT-TENANT-LOW-001 · L4 ← ADMIN-LOW misnomer · L5 ← PRODUCT-TENANT-LOW-001 · L6 ← PRODUCT-ACCESS-LOW-002 · L7 ← PRODUCT-TENANT-LOW-002 · L8 ← ADMIN-LOW-002, FE-LOW-001 · (by-design, no action: DATA-LOW-011 — no RBAC domain events; refresh-only staleness is documented)
