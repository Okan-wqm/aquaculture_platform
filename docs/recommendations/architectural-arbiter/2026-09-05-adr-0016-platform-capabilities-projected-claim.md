# ADR-0016 — Platform Capabilities as a DB-Backed Projected JWT Claim, ANDed After PlatformAdminGuard

**Status:** accepted
**Date:** 2026-09-05
**Amends:** `docs/adr/008-*` (guard strategy), `docs/adr/038-auth-role-table-rls.md`
**Depends on:** ADR-0011 (`break-glass` fresh MFA)
**Resolves:** access-boundary-auditor#ACCESS-006, #ACCESS-012, #ACCESS-019; audit-trail-completeness-auditor#TRAIL-001; auth-security-expert#AUTH-005; admin-expert §7 (DestructiveActionGuard)
**Finding reference:** docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#SEC-HIGH-059

## Context

`PlatformAdminGuard` (`apps/admin-api-service/src/guards/platform-admin.guard.ts:249-254`) filters decorated roles to `SUPER_ADMIN` and re-adds it if the filter empties the list — a decorator can narrow but never widen. That property is correct and must survive. One bit governs 50 pages, 34 controllers and 273 mutation routes including tenant erasure, cross-tenant export and the SQL explorer. The role-template catalogue (`users.controller.ts:415-469`) is consulted by no guard.

The projection pattern already exists: `token.service.ts:310-311` mints `modules` and `resourcePermissions` from DB state; `user-lifecycle.service.ts:659-679` revokes refresh tokens and enqueues durable access-token invalidation on any authorization change.

## Decision

We introduce platform capabilities now, stored in `auth.platform_capability_grants (userId, capability, grantedBy, grantedAt, expiresAt, revokedBy, revokedAt, reason)` and projected into a `platformCapabilities: string[]` claim by `TokenService`; revocation rides the existing durable invalidation. The capability set is a closed enum in `libs/event-contracts`: `billing-ops`, `support-ops`, `security-ops`, `platform-read-only`, `break-glass` (time-boxed, `expiresAt` ≤ 4 h, the only capability admitting irreversible operations, always with fresh MFA).

`@RequiresCapability(...)` + `PlatformCapabilityGuard` register as the third `APP_GUARD`, running only on requests `PlatformAdminGuard` has already admitted. `PlatformAdminGuard` is not modified. A mutating route without a capability decorator fails the gate. `@Destructive({scope, dualControl, dryRunDefault, requiresTypedConfirmation, requiresFreshMfa})` + `DestructiveActionGuard` write a `destructive_runs` WORM ledger modelled on `cleanup_runs`; the operation fails if the ledger write fails.

The role-template catalogue becomes the tenant-side RBAC template surface it was named for, or is deleted; it is not the platform capability store.

Gate: `tests/invariants/platform-capability-coverage.spec.ts` — every `@Post` / `@Put` / `@Patch` / `@Delete` in admin-api carries `@RequiresCapability`, discharged via reflected metadata, with a ratcheting allowlist `.claude/allowlists/uncapability-admin-routes.yaml` carrying `{route, owner, expiry, findingId}` and a monotonically decreasing ceiling. Shares the route-enumeration helper with the audit-coverage gate.

## Consequences

- The JWT gains one optional, spread-omitted claim; existing verifiers are unaffected (Tolerant Reader holds).
- ~273 routes are decorated over the ramp; admin-panel navigation gates on capabilities.
- A pure-JWT design (unrevocable) and a per-request DB lookup (hot-path hop) are both rejected; the losing side is simplicity of a single role.
- AUTH-012 (single non-rotating signing key) remains open and is not addressed here.
