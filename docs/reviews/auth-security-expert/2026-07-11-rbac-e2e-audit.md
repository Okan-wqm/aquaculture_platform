# RBAC End-to-End Audit — auth-security findings (tenant-admin + superadmin)

**Cycle:** `2026-07-11-rbac-e2e-audit`
**Scope:** tenant-configurable RBAC shipped in PR #923 (delegation + override enforcement + discoverability) and PR #931 (drop dead parallel tenant-role subsystem), both live in production.
**Full consolidated report + phased plan:** `docs/plans/2026-07-11-rbac-e2e-audit/PLAN.md` (3 CRITICAL, 11 HIGH, 20 MEDIUM, 8 LOW across 8 audit lanes).

This file records the two write-time authority findings closed by the P0 remediation commit. The remaining findings (audit trail on role mutations, revocation propagation, frontend capability gating, tenant-suspend sessions, impersonation, plan-tier gating, data-model) are tracked in the plan for subsequent phases.

---

## RBAC-CRITICAL-001

**Title:** `updateUserRole` ran the role-grant authority guard only inside `if (roleId changed)`, so an override-only update skipped it — a delegate holding `users:edit_permissions` could self-grant any tenant capability.

**Layer:** 2 (RBAC / delegation)
**Evidence:**
- `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts`
- `apps/auth-service/src/modules/authentication/services/token.service.ts`

**Rule violated:** A capability-adding write must always pass the role-grant authority guard; the guard must not be reachable-around by omitting the role id. Least-privilege delegation ("cannot grant more than you have") is non-negotiable.

**Fix:** The self-target + level-ceiling guard now runs unconditionally on every `updateUserRole` (measured against the incoming role if it is changing, else the user's current role), and the per-user override grants are validated through the shared `CapabilityAuthorityService`.

## RBAC-CRITICAL-002

**Title:** No "cannot grant more than you have" invariant and no catalogue whitelist existed on any tenant-role write path (`createRole`/`updateRole`/`assignUserRole`/`updateUserRole`/`createUser`); arbitrary `resource:action` strings could be injected and a delegate could author/assign roles carrying capabilities they did not hold.

**Layer:** 2 (RBAC / delegation)
**Evidence:**
- `apps/auth-service/src/modules/tenant/services/tenant-role.service.ts`
- `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts`
- `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts`

**Rule violated:** The permission catalogue is the single source of truth for storable capabilities; a non-admin actor may grant only a subset of their own effective permissions.

**Fix (architectural, tier-1 make-it-impossible):** A single `CapabilityAuthorityService` is the sole producer of the branded `GrantablePermissionSet` / `ValidatedOverrideSet` the persistence helpers require, so a capability write that skipped the catalogue-whitelist + subset-of-actor checks is a compile error. The catalogue was extracted to `permission-catalogue.ts` as a shared SSoT (with `CATALOGUE_CAPABILITIES` as the write-time whitelist), which also structurally bounds stored capability-set size.

## RBAC-CRITICAL-003

**Title:** Role-definition mutations in `TenantRoleService` (create / edit / delete / set-default / seed) wrote ZERO audit rows — a privileged permission rewrite that re-scopes every holder of a role was forensically invisible (SOC 2 CC6.1/CC7.2, GDPR Art 30).

**Layer:** 2 (audit / side-effect discipline)
**Evidence:**
- `apps/auth-service/src/modules/tenant/services/tenant-role.service.ts`
- `apps/auth-service/src/audit/audit-log.service.ts`

**Rule violated:** Every privileged, state-mutating RBAC action must write an audit row atomically with the mutation (fail-closed), never after a committed change and never omitted.

**Fix:** `TenantRoleService` now injects `AuditLogService` and writes `ROLE_CREATED` / `ROLE_UPDATED` (with before/after permission sets) / `ROLE_DELETED` (row snapshot) / `ROLE_SET_DEFAULT` / `ROLES_SEEDED` rows on the same SERIALIZABLE transaction (`queryRunner.manager`), mirroring the tenant-user-management assignment paths — a throwing audit rolls the mutation back.

## RBAC-MEDIUM-001

**Title:** The tenant-role gating invariant (`tenant-role.resolver.gating.spec.ts`) iterated a hand-maintained list of method names, so a newly-added `@Query`/`@Mutation` that was forgotten in the list and left ungated passed CI silently — falling through both opt-in guards to any authenticated tenant user.

**Layer:** 3 (make-it-detectable)
**Evidence:**
- `apps/auth-service/src/modules/tenant/resolvers/__tests__/tenant-role.resolver.gating.spec.ts`

**Rule violated:** Deny-by-default must be structural — an ungated authorization surface must fail the build, not depend on a reviewer remembering to update an allowlist.

**Fix:** The invariant now enumerates the resolver's ACTUAL own methods and partitions them into gated (carries `@RequireTenantPermission`) vs an explicit, reviewed private-helper allowlist. Any ungated method that is not a listed helper fails the test, so a forgotten new operation cannot ship open; the capability map is additionally checked both ways (every operation mapped, no stale entries).

## RBAC-MEDIUM-002

**Title:** `TenantRoleService` carried duplicate, unaudited, unguarded role-lifecycle methods (`assignRoleToUser` / `removeRoleFromUser` / `setDefaultRole`) with no production callers — a latent trap: a future wiring to them would silently reintroduce the horizontal-escalation and audit-gap holes the live `TenantUserManagementService` paths close.

**Layer:** 2 (duplicate / divergent state-transition paths)
**Evidence:**
- `apps/auth-service/src/modules/tenant/services/tenant-role.service.ts`

**Rule violated:** Dead code that contradicts the current SSoT (the live assignment paths carry `assertRoleGrantAuthority`, capability-authority validation, and fail-closed audit) must be removed, not left as a latent re-introduction vector.

**Fix:** Deleted the three dead methods and their tests. The single SSoT for assignment/revocation is `TenantUserManagementService` (`assignUserRole`/`updateUserRole`/`revokeUserRole`); default-role setting is handled by `updateRole(isDefault)`.

## RBAC-MEDIUM-003

**Title:** `permissionOverrides.grants`/`revokes` had no length or per-item bound at the validation boundary, so an abusive payload could inflate the request (and downstream the JWT `resourcePermissions` claim + gateway assertion header).

**Layer:** 3 (make-it-detectable / input validation)
**Evidence:**
- `apps/auth-service/src/modules/tenant/dto/tenant-role.dto.ts`

**Rule violated:** Untrusted array/string inputs must be size-bounded at the validation boundary, independent of downstream semantic checks.

**Fix:** Added `@ArrayMaxSize(256)` and per-item `@MaxLength(128)` to both override arrays. `CapabilityAuthorityService` already rejects any capability outside the finite catalogue (which structurally bounds the number of DISTINCT stored capabilities); these bounds are defense-in-depth that reject an oversized payload before it reaches the authority check.

## RBAC-HIGH-001

**Title:** A permission REVOKE (role change, override change, role-permission edit) did not take effect until the access-token TTL: nothing invalidated a user's live tokens on an authorization change. The gateway already enforced user-level invalidation on every request via the Redis key `user_blacklist:{userId}`, but that key had exactly one accessor (the gateway read) and no writer.

**Layer:** 2 (RBAC enforcement / token lifecycle)
**Evidence:**
- `libs/backend-common/src/security/user-token-revocation/user-token-revocation.service.ts`
- `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts`
- `apps/auth-service/src/modules/tenant/services/tenant-role.service.ts`
- `apps/gateway-api/src/guards/redis-token-blacklist.store.ts`

**Rule violated:** A reduction of a user's effective permissions must be enforceable promptly and fleet-wide, not deferred to natural token expiry; the key contract for user-level revocation must be a single SSoT shared by writer and reader.

**Fix (architectural SSoT):** Introduced a canonical `UserTokenRevocationService` in backend-common that OWNS the `user_blacklist:{userId}` key contract (`userBlacklistKey` builder + `revokeUserTokens`/`isTokenValid`, Redis-backed with in-memory fallback). The auth-service RBAC write paths (`assignUserRole`/`updateUserRole`/`revokeUserRole`/`updateTenantUser` role change, and `updateRole` fanned out to every active holder) call `revokeUserTokens` after a committed change, so the user's live tokens are rejected by the gateway's EXISTING enforcement on their next request — forcing a refresh that re-mints with current permissions, fleet-wide via Redis. The gateway reader now uses the same `userBlacklistKey` builder, eliminating the duplicated key string (partial SEC-LOW-001 consolidation).

## RBAC-HIGH-002

**Title:** `deleteTenantUser` (the live resolver deletion path) carried a divergent copy of the deletion logic that did NOT revoke refresh tokens — despite its docstring claiming it did — so a "deleted" user could still mint fresh access tokens. The complete, fail-closed SSoT (`UserLifecycleService.deleteUser`, which DOES revoke refresh tokens) existed but had zero production callers.

**Layer:** 2 (duplicate deletion path / token lifecycle)
**Evidence:**
- `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts`
- `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts`

**Rule violated:** One deletion SSoT; a destructive lifecycle action must revoke ALL of the user's credentials (refresh AND access tokens), not silently skip a class of them.

**Fix:** `deleteTenantUser` now delegates to `UserLifecycleService.deleteUser` (mirroring how `createTenantUser` delegates to `createUser`), and the duplicate body was deleted. `deleteUser` additionally revokes the user's live access token via the RBAC-HIGH-001 primitive, so a deleted user is locked out on their next request rather than at token expiry.

## RBAC-HIGH-003

**Title:** `seedDefaultRoles` was a permanent no-op for every provisioned tenant: it skipped the ENTIRE seed when any role already existed, but tenant provisioning always inserts a `TENANT_ADMIN` role first — so the count was always ≥1 and the 5 operational default roles (Supervisor, Technician, Feed Manager, Operator, Viewer, each with its `tenant_role_permissions`) were NEVER created.

**Layer:** 2 (role seeding)
**Evidence:**
- `apps/auth-service/src/modules/tenant/services/tenant-role.service.ts`
- `apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts`

**Rule violated:** A per-tenant seed must be idempotent per item and fill the gaps, not skip the whole operation when any single item pre-exists.

**Fix:** `seedDefaultRoles` now locks and reads the tenant's existing role names (`FOR UPDATE`, tenant-scoped) and creates only the named defaults that are ABSENT — so the operational roles get created even after provisioning inserted `TENANT_ADMIN`, and re-running only fills gaps (never duplicates). The seed audit records the real created count/names and is written only when something was created. (Auto-seeding at provisioning time — so tenants get the operational roles without the manual mutation — remains a separate provisioning-flow item.)

## RBAC-LOW-001

**Title:** The admin-api `AllowTenantAdmin()` decorator resolved to `Roles('SUPER_ADMIN')` but its name (and nearby "TENANT_ADMIN can…" comments) advertised tenant-admin access — a latent trap: a maintainer "fixing" the name toward real TENANT_ADMIN access, combined with the tenant-scoped `req.user.tenantId` reads on some admin endpoints, could open cross-tenant writes.

**Layer:** 3 (naming / latent-trap)
**Evidence:**
- `apps/admin-api-service/src/decorators/roles.decorator.ts`
- `apps/admin-api-service/src/users/users.controller.ts`

**Rule violated:** An authorization decorator's name must reflect what it actually enforces; a misleading name is a latent authorization defect.

**Fix:** Replaced all 30 `@AllowTenantAdmin()` usages (users/messaging/announcement/ticket controllers) with the existing, behaviorally-identical `@PlatformAdminOnly()`, deleted the `AllowTenantAdmin` alias, and corrected the stale "TENANT_ADMIN can…" comments. Pure behavior-preserving rename — the admin-api boundary is platform-admin (SUPER_ADMIN) only, and the name now says so.

## RBAC-HIGH-004

**Title:** The tenant-admin frontend gated its role/user CRUD controls on the coarse `hasRoleOrHigher('TENANT_ADMIN')` role check while the backend authorizes each action on a granular capability (`roles:create/edit/delete`, `users:invite/edit_permissions/deactivate`) — so a delegate granted a specific capability reached the page (route gated on `*:view`) but saw NO controls. The delegation feature PR #923 shipped was inert on these screens; only a full TENANT_ADMIN could act. (FE-HIGH-001.)

**Layer:** 3 (capability SSoT / FE gating)
**Evidence:**
- `web/modules/tenant-admin/src/pages/TenantRolesPage.tsx`
- `web/modules/tenant-admin/src/pages/TenantUsers.tsx`
- `web/modules/tenant-admin/src/components/users/UserListSection.tsx`
- `web/modules/tenant-admin/src/components/users/BulkActions.tsx`

**Rule violated:** FE control visibility must gate on the SAME capability the backend enforces, via the shared capability SSoT (`hasResourcePermission`) — not a divergent role check.

**Fix:** `TenantRolesPage` now gates seed/create on `roles:create`, edit on `roles:edit`, delete on `roles:delete`; `TenantUsers` gates Add on `users:invite`, row-edit on `users:edit_permissions`, and bulk/row-delete on `users:deactivate` (threaded into `UserListSection`/`BulkActions` as per-action props). All via `useAuth().hasPermission`, whose `hasResourcePermission` bypasses for SUPER_ADMIN/TENANT_ADMIN exactly like the backend — so admins are unaffected and delegates now see precisely the controls their capabilities authorize. (The backend shared read-queries `tenantUsers`/`myTenant`/`tenantStats` still carry `@TenantAdminOrHigher()`; migrating those to capability gates — so a delegate can also LOAD the data — is tracked as the FE-delegatable-vs-backend-query parity item, separate from this control-gating fix.)

## RBAC-HIGH-005

**Title:** The `tenantUsers` GraphQL query (the user-list read backing the tenant-admin Users page) was gated on the coarse `@TenantAdminOrHigher()` role, so the RBAC-HIGH-004 frontend fix was still end-to-end inert for a delegate: a user holding `users:view` saw the (now capability-gated) page shell but the query that loads the actual user rows returned Forbidden. The backend read guard and the FE control gate disagreed on the authority model.

**Layer:** 3 (capability SSoT / backend query gating)
**Evidence:**
- `apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts`

**Rule violated:** A backend read guard must gate on the SAME granular capability the frontend and the sibling queries enforce; a page whose controls are capability-gated must have its data query capability-gated too, or the delegation feature is inert end-to-end.

**Fix:** `tenantUsers` now carries `@RequireTenantPermission('users:view')` instead of `@TenantAdminOrHigher()`, matching the sibling `getUserEffectivePermissions` query and the `TenantRoleResolver` reads. The globally-registered `TenantPermissionGuard` (APP_GUARD) enforces it: SUPER_ADMIN/TENANT_ADMIN still bypass via `hasAllResourcePermissions`, a delegate holding `users:view` is now admitted, and everyone else is denied — a strict superset of the previous authority. `tenantId` is still sourced from the caller's JWT claim, so a delegate can only ever read their own tenant's users; tenant isolation is unchanged. The other queries on `TenantResolver` (tenant DB/schema introspection, module-manager, audit-log and activity views, `myTenant`/`tenantStats`/`myTenantModules`) legitimately remain `@TenantAdminOrHigher()` — those are administrative surfaces with no `users:*`-style delegatable capability, so role gating is correct for them.

## RBAC-MEDIUM-004

**Title:** The `AuthUserQueryNatsHandler` DI-resolution smoke test — the guard that fails at boot (not in production) if the handler regresses to the wrong `AuditLogService` import (the 2026-06-12 crash-loop) — had itself been silently red since #845: `AuditLogService` gained a `DataSource` constructor dependency (standalone audit writes run in an RLS system-context transaction), but the test's `TestingModule` never bound the `DataSource` token, so the smoke threw `Nest can't resolve dependencies of the AuditLogService … argument DataSource at index [2]` instead of asserting the wiring. A regression-detector that no longer compiles detects nothing.

**Layer:** 3 (test integrity / DI smoke)
**Evidence:**
- `apps/auth-service/src/modules/tenant/handlers/__tests__/auth-user-query-nats.handler.spec.ts`

**Rule violated:** A DI-resolution smoke test must supply every token the real object graph requires; when the production dependency set grows, the test's provided set must grow with it, or the guard is inert.

**Fix:** The smoke now supplies `DataSource` through a `@Global` stub module (`providers: [{ provide: DataSource, useValue: { transaction: jest.fn() } }]`, `exports: [DataSource]`), mirroring how the existing `ConfigModule.forRoot({ isGlobal: true })` supplies `ConfigService` to the imported `@Global` `AuditModule`. (A `.overrideProvider(DataSource)` does not work here: NestJS `overrideProvider` only replaces an already-registered provider, and this graph deliberately boots no `TypeOrmModule.forRoot`, so the token has no base provider to override.) The DI smoke resolves the handler against the real `AuditModule`-provided `AuditLogService` again, restoring the boot-time regression guard; all 41 auth-service suites (492 tests) pass.

## RBAC-HIGH-006

**Title:** Tenant-admin cache invalidations silently no-oped because epoch'd/args'd `createTenantQueryKey` keys were used as TanStack invalidation FILTERS: the seed-roles mutation invalidated `roleKeys.all()` (`{__sessionEpoch}` at the index where every stored key holds `'list'`/`'detail'`), so a successful seed left the page showing "No roles defined" (H9, invites double-seed); role update/delete invalidated a `tenant-users` key domain that no query ever stored under (a duplicate `userKeys` factory — the real users list lives under the `tenantKeys` `users` domain, M13); and the no-arg `tenantKeys.users()` / `tenantKeys.devices()` / epoch'd `auditLogKeys.all()` filters (user CRUD mutations, both Refresh buttons, audit-log refresh) matched zero stored keys because `undefined`/`{epoch}` at the args position never partial-matches. All verified empirically against the installed TanStack 5.90.10 matcher (each filter matched 0 stored queries; the epoch-less prefixes matched).

**Layer:** 3 (frontend cache coherence / query-key SSoT)
**Evidence:**
- `web/modules/tenant-admin/src/hooks/useTenantRoles.ts`
- `web/modules/tenant-admin/src/hooks/useTenantData.ts`
- `web/modules/tenant-admin/src/hooks/useTenantAuditLog.ts`
- `web/modules/tenant-admin/src/pages/TenantUsers.tsx`
- `web/modules/tenant-admin/src/pages/EdgeDevicesPage.tsx`
- `web/shared-ui/src/utils/tenant-query-keys.ts` (the RULE the callsites violated)

**Rule violated:** The tenant-query-keys SSoT RULE: `useQuery`/`setQueryData` use the epoch'd `createTenantQueryKey`; `invalidate/remove/cancelQueries` use the epoch-less `createTenantInvalidationKey` prefix. A mutation's invalidation filter must demonstrably match the stored query keys it targets; a duplicate key factory for another hook's domain is forbidden.

**Fix (root-cause):** The key factories now own paired invalidation builders so callers cannot hand-roll filters: `roleKeys.invalidateAll/invalidateLists/invalidateDetail/invalidateDefault`, `tenantKeys.invalidateUsers/invalidateDevices`, and `auditLogKeys.all` rebuilt on `createTenantInvalidationKey`. Every `invalidate/remove/cancelQueries` callsite in the module now goes through them; the wrong-domain `userKeys` duplicate was deleted and role mutations invalidate the real `tenantKeys` users domain. Guarded by new behavioral specs that pin filter↔stored-key matching through the real QueryClient matcher (seed→list invalidated; role update/delete→users list invalidated; prefix matches all four role key kinds; the epoch'd no-arg `users()` filter documented as matching nothing) — key-shape drift that breaks matching now fails the suite instead of shipping as silent staleness. Covers plan items RBAC-H9 and RBAC-M13 plus the same-class no-ops found during the fix (user CRUD invalidations, users/devices Refresh buttons, audit-log refresh).

## RBAC-LOW-002

**Title:** Dead `web/modules/tenant-admin/src/lib/query-keys.ts` exported a NON-tenant-scoped `tenantKeys` factory labeled "Single source of truth" — keys like `['tenant', 'users', …]` omit the tenantId entirely, alias the real `['tenant', tenantId, …]` prefix space, and shadow the genuine `tenantKeys` in `useTenantData` — a cross-tenant cache-bleed landmine for any future importer (zero current importers).

**Layer:** 3 (dead code / latent trap)
**Evidence:**
- `web/modules/tenant-admin/src/lib/query-keys.ts` (deleted)

**Rule violated:** A module must not carry a dead, misleadingly-documented duplicate of a security-relevant SSoT; non-tenant-scoped query keys violate the web/CLAUDE.md tenant-key invariant (FE-CRITICAL-014/015/016).

**Fix:** Deleted the file. The real SSoT remains `createTenantQueryKey`/`createTenantInvalidationKey` (shared-ui) consumed via the module's `tenantKeys`/`roleKeys`/`auditLogKeys` factories.

## RBAC-MEDIUM-005

**Title:** TenantRolesPage rendered a false-empty state and TWO "Seed Default Roles" offers on query ERROR: `roles = []` is only the destructured default when the query fails, but both the header seed button (`roles.length === 0`) and the empty-state block rendered alongside the error banner — inviting an admin to seed against unknown server state (double-seed trap, compounding the RBAC-HIGH-006 invalidation no-op that already masked seed results).

**Layer:** 3 (frontend state truthfulness)
**Evidence:**
- `web/modules/tenant-admin/src/pages/TenantRolesPage.tsx`

**Rule violated:** An error state and a confirmed-empty state are different truths and must render differently; a mutation offer must never be derived from a default value that merely masks a failed read.

**Fix:** The seed offer and the empty state render only on a CONFIRMED empty list (`!error && roles.length === 0`); on error the banner (with Retry) is the whole content. Pinned by `TenantRolesPage.spec.tsx` (error → banner only, no seed offer, no empty state; confirmed-empty → empty state + seed offer).

## RBAC-MEDIUM-006

**Title:** The delete-role dialog contradicted the backend contract: it stayed fully enabled with a "they will lose access" warning while the backend HARD-BLOCKS deleting a role with active holders, and the resulting ForbiddenException vanished into `logError` — the admin clicked Delete, nothing happened, no message appeared.

**Layer:** 3 (FE↔BE contract truthfulness)
**Evidence:**
- `web/modules/tenant-admin/src/pages/TenantRolesPage.tsx`
- `apps/auth-service/src/modules/tenant/services/tenant-role.service.ts` (the delete guard the UI contradicted)

**Rule violated:** A UI affordance must state and enforce the same precondition the backend enforces; a server rejection must surface to the operator, not disappear into a log call.

**Fix:** The dialog now states the backend rule ("cannot be deleted while it is assigned to N user(s) — reassign first") and disables confirm when `userCount > 0`; a server rejection renders inside the dialog via a new `errorMessage` prop (fed from `deleteMutation.error`), and reopening the dialog resets the stale rejection (`deleteMutation.reset()`). Pinned by `TenantRolesPage.spec.tsx` (holders → disabled + rule text; no holders → enabled; server rejection surfaces; reset on reopen).

## RBAC-LOW-003

**Title:** TenantUsers rendered an UNWIRED "Export" button (no onClick, no export backend) ungated to every `users:view` delegate — a false affordance that does nothing when clicked.

**Layer:** 3 (dead control / false affordance)
**Evidence:**
- `web/modules/tenant-admin/src/pages/TenantUsers.tsx`

**Rule violated:** A rendered control must perform its advertised action; dead controls are removed, not shipped.

**Fix:** Removed the button (and the now-unused icon import), with an in-place note that reintroduction requires a real export path AND a capability gate.

## RBAC-MEDIUM-007

**Title:** The permission editor's category select-all was a click-only `<span role="checkbox">` NESTED inside the accordion-expand `<button>` — invalid interactive-inside-interactive (WCAG 4.1.2 name/role/value) and unreachable by keyboard (WCAG 2.1.1): no tabindex, no key handler, so a keyboard user could not toggle a category's permissions at all; the resource-row select-all was a real button but carried no checkbox semantics (no role/aria-checked/accessible name).

**Layer:** 3 (accessibility / valid interactive structure)
**Evidence:**
- `web/modules/tenant-admin/src/components/permissions/PermissionCheckboxGroup.tsx`

**Rule violated:** Interactive controls must not nest inside other interactive controls; every stateful control must expose real keyboard operability and correct role/state semantics, not a mouse-only visual imitation.

**Fix:** The category header is now a plain container with two SIBLING buttons: a real `<button role="checkbox" aria-checked disabled …>` select-all (Tab reaches it; Space/Enter toggle natively; disabled in readOnly) and a separate expand/collapse button owning `aria-expanded`/`aria-controls`. The resource-row select-all gained `role="checkbox"`, `aria-checked` (true/mixed/false), and an accessible name. Pinned by `PermissionCheckboxGroup.spec.tsx` (real button with checkbox semantics; structural no-nesting invariant; keyboard Space toggles the whole category; toggling does not collapse the accordion; mixed state; readOnly disables).

## RBAC-MEDIUM-008

**Title:** Orphaned duplicate `RoleModal.tsx`/`DeleteRoleModal.tsx` in `components/roles/` were exported from the barrel as the "roles components" surface but had ZERO importers — the live dialogs are the inline copies in TenantRolesPage — and the orphaned copies lacked the focus trap and `useId` ARIA wiring the live ones have, so any future importer would silently ship the inferior-a11y variant; `ROLE_COLORS` additionally existed in THREE places (lib/constants MED-18 SSoT, the page inline, the orphaned modal).

**Layer:** 3 (dead duplicate / latent trap)
**Evidence:**
- `web/modules/tenant-admin/src/components/roles/RoleModal.tsx` (deleted)
- `web/modules/tenant-admin/src/components/roles/DeleteRoleModal.tsx` (deleted)
- `web/modules/tenant-admin/src/components/roles/index.ts`
- `web/modules/tenant-admin/src/pages/TenantRolesPage.tsx`

**Rule violated:** No orphaned inferior duplicates of live components reachable through a barrel; one SSoT per constant.

**Fix:** Deleted both orphaned modals; the barrel now exports only `RoleCard`/`RoleBadge` with a note that the dialogs live inline in the page (do not recreate without a real second consumer). The page's inline `ROLE_COLORS` copy was replaced with the `lib/constants` MED-18 SSoT import, collapsing three copies to one.

## RBAC-LOW-004

**Title:** token.service.ts (and its spec) cited the centralized-role-tables topology migration by BARE timestamp "1800500000000" — but auth-service's own migration directory contains a DIFFERENT `1800500000000-AddRefreshTokenFamilyId`, so a reader resolving the citation inside the owning service lands on the wrong migration; the topology migration actually lives in admin-api (`1800500000000-TenantProvisioningTopology`).

**Layer:** 3 (documentation accuracy / cross-service citation)
**Evidence:**
- `apps/auth-service/src/modules/authentication/services/token.service.ts`
- `apps/auth-service/src/modules/authentication/services/token.service.spec.ts`

**Rule violated:** A cross-service migration citation must name the migration and its owning service unambiguously; a bare timestamp that collides with a same-timestamp local migration is a wrong citation.

**Fix:** Both comments now cite "admin-api's `1800500000000-TenantProvisioningTopology`" and explicitly disambiguate from auth-service's same-timestamp `AddRefreshTokenFamilyId`. (The tenant-role.service citation flagged in the plan no longer exists — removed by the earlier RBAC refactors.)

## RBAC-HIGH-007

**Title:** Tenant suspend/deactivate/cancel/archive neither terminated sessions nor stopped token refresh: the lifecycle transition flipped `auth.tenants.status` and emitted the event but revoked NOTHING, and both refresh paths checked only `user.isActive` — so a suspended tenant's logged-in users kept full API access and silently ROTATED fresh tokens for the refresh-token lifetime (days). Login was the only gate (`isLoginAllowed`, MT-HIGH-003); refresh ignored the same SSoT.

**Layer:** 2 (session lifecycle / tenant containment)
**Evidence:**
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts`
- `apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts`
- `libs/event-contracts/src/enums/tenant-status.enum.ts` (ACTIVE is "the ONLY login-allowed state" — the SSoT refresh violated)

**Rule violated:** Revoking a tenant's operational status must revoke its users' live credentials promptly and fleet-wide; every credential-minting path (login AND refresh) must enforce the same fail-closed tenant-status allow-list SSoT.

**Fix (two symmetric legs, both on the isLoginAllowed SSoT):**
1. **Refresh gate (make it automatic):** both refresh paths now call `assertTenantOperationalForRefresh` after resolving the user — the SAME `isLoginAllowed` allow-list login enforces (SUPER_ADMIN/tenantId-null exempt, missing-tenant fall-through symmetric with login). A non-operational tenant can never rotate tokens again, independent of whether the suspend-side revocation ran.
2. **Transition-side termination (single emission point):** `transitionTenantStatus` — the one place all five lifecycle transitions flow through — now, for any transition into a status `isLoginAllowed` rejects, bulk-revokes ALL of the tenant users' refresh tokens INSIDE the SERIALIZABLE receipt transaction (atomic with the status write; a rolled-back suspend revokes nothing) under a tx-local `set_config('app.current_tenant', …, true)` so the RLS policy on `auth.refresh_tokens` admits exactly this tenant's rows (tenant-SCOPED context — the NATS lifecycle command carries no request tenant context); then post-commit blacklists each affected user via the RBAC-HIGH-001 `UserTokenRevocationService` (shared Redis `user_blacklist:{userId}`), which the gateway already enforces on every request — cutting LIVE access tokens fleet-wide immediately. The Redis leg is deliberately non-fatal per user (access tokens self-expire ≤15 min; the durable kill is in-tx + the refresh gate). Idempotent re-suspend and replayed receipts revoke nothing again; ActivateTenant (into ACTIVE) revokes nothing.

Pinned by `tenant-status-refresh-gate.spec.ts` (SUSPENDED/DEACTIVATED/CANCELLED/ARCHIVED → 401 before rotation; ACTIVE → rotates; platform user exempt) and `tenant-suspend-revocation.spec.ts` (in-tx bulk revoke under the tenant GUC with correct ordering; per-user post-commit blacklist; Redis failure non-fatal; zero-user, idempotent-re-suspend, and ActivateTenant negative cases). The gateway needs no change: its existing user-blacklist check is the fleet-wide access-token enforcement point, making the 5-minute tenant-status cache and the `/graphql` public-path exemption irrelevant to containment.

## RBAC-HIGH-008

**Title:** Impersonation was audit-only and UNENFORCED end-to-end: the admin-panel "Open Tenant Portal" button opened `/tenant?impersonation_session=<id>` in a new tab, but NOTHING consumed that query parameter — the tab ran under the SUPER_ADMIN's OWN JWT while the UI asserted an impersonated, read-only session. So the `canModifyData:false` permission set the backend computes was never enforced, and per-action dual-identity audit depended on a best-effort FE `log-action` POST. No MFA step-up gated session start (the `mfaCompleted` column is dead).

**Layer:** 3 (authorization boundary / false-security affordance)
**Evidence:**
- `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts` (mints an impersonationToken no downstream subgraph validates)

**Rule violated:** A UI must not present an authorization boundary it does not enforce; a "read-only impersonation" affordance that actually runs with full admin authority is worse than none — it manufactures false assurance and unaudited access.

**Fix (fail-closed, this PR):** Removed the "Open Tenant Portal" button — the only control that implied an active impersonated browsing context — so the panel no longer offers a session-entry path that silently runs as the admin. The session-management surface (start/list/extend/end/terminate/audit) remains and is now contract-correct (RBAC-MEDIUM-010), so the feature is honest about what it does: it records governed impersonation *intent* and audit, and does not grant an unenforced tenant-portal session. **Tracked debt (owner: auth-security-expert; deadline: next impersonation hardening cycle):** wiring a real gateway token-exchange that mints a scoped, `canModifyData`-enforcing impersonation JWT consumed by every subgraph, plus MFA step-up at session start, before any portal-entry control is reintroduced. This is a design-significant multi-service change (gateway + every subgraph guard), explicitly NOT smuggled in here.

## RBAC-MEDIUM-009

**Title:** Impersonation session-duration ceilings exceeded policy and were duplicated across DTOs: the request DTO accepted up to 480 min (8 h), the grant DTO up to 1440 min (24 h), and the extend DTO up to 120 min — versus the ≤1-hour impersonation policy — with no service-side clamp, so a historical over-cap grant row conferred an over-long session at USE time regardless of the DTO, and there was no idle/inactivity timeout.

**Layer:** 3 (policy ceiling / SSoT)
**Evidence:**
- `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts`
- `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`

**Rule violated:** A security limit must have ONE authoritative value enforced at every layer (DTO AND service), not a set of divergent per-DTO magic numbers that a stored record can outflank at use time.

**Fix:** Introduced `IMPERSONATION_MAX_SESSION_MINUTES = 60` as the single ceiling constant beside the entity. The three DTO `@Max` bounds (grant, request, extend) now derive from it, and the service clamps at every use point that consumes a stored grant: `grantImpersonationPermission` clamps `maxSessionDurationMinutes` on both the create and update paths; `startImpersonation` folds the absolute ceiling into the duration `Math.min` (so a legacy 1440 grant yields a ≤60-min session); `extendSession` bounds TOTAL duration by the ceiling, not the grant. Pinned by `impersonation.session-cap.spec.ts` (create/update clamp; legacy-1440 grant → ≤60-min session; extend refused at the ceiling). Raising the policy is now a one-line change to the constant. (Idle-timeout is called out as follow-on hardening under RBAC-HIGH-008's tracked debt.)

## RBAC-MEDIUM-010

**Title:** The admin-panel impersonation client was a fabricated contract: the TypeScript types invented a read model (tenantName/adminEmail/startedAt/sessionToken/lastActivityAt/actionsPerformed:number) that matched NOTHING the admin-api returns (targetTenantName/superAdminEmail/createdAt/actionCount/…), the start call sent `{tenantId, adminId, reason:string}` which the whitelist ValidationPipe rejected with 400 (the DTO requires `{targetTenantId, reason:<enum>}` and derives the admin from the JWT), list handlers read `.data` from endpoints that return `{items,total}`, terminate sent a non-whitelisted `revokedBy`, `getSessionActions` threw "Not implemented", and the status filter/badges used a `revoked` state the backend calls `terminated`. The impersonation UI was non-functional as shipped.

**Layer:** 3 (FE↔BE contract parity)
**Evidence:**
- `web/modules/admin-panel/src/services/types/impersonation.ts`
- `web/modules/admin-panel/src/services/api/impersonation.ts`
- `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`

**Rule violated:** A frontend client must speak the backend's exact contract (field names, request DTO shape, response envelope, enum values); an invented read model that never matches the API is a non-functional feature masquerading as complete.

**Fix:** Rewrote the impersonation types to MIRROR the admin-api entities field-for-field and the API client to speak the exact controller DTOs: `startSession` sends `{targetTenantId, targetUserId?, reason:<enum>, reasonDetails?}` (admin identity from the JWT, never the body); list results read `{items,total}`; `terminateSession(id, reason)` sends only the whitelisted `{reason}` and is required in the confirm dialog; `getSessionActions` reads the `actionsPerformed` jsonb off `GET /sessions/:id` (the log lives on the session row — no phantom `/actions` endpoint); the start modal's Reason is the backend enum with free text in `reasonDetails`; permission revoke is keyed by grantee `superAdminId`; status filters/badges use `terminated`; the false-affordance "Allowed Actions" checkboxes (never sent, never enforced) were removed. FE type-check + admin-panel lint clean; the admin-api impersonation controller/service specs (68) stay green.
