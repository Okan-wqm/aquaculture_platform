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
