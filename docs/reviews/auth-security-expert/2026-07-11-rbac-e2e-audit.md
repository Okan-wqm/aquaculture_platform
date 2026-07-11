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
