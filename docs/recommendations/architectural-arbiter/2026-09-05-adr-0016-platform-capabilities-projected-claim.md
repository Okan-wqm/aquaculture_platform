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

## Implementation note (landed 2026-09-05)

- The closed enum lives in `libs/event-contracts/src/enums/platform-capability.enum.ts` (`PLATFORM_CAPABILITIES`, `toPlatformCapabilities`, `BREAK_GLASS_MAX_TTL_SECONDS`); the writer's CHECK constraint mirrors it and `tests/invariants/platform-capability-coverage.spec.ts` pins the two together. `auth.platform_capability_grants` is written only by `PlatformCapabilityService` (auth-service): active-SUPER_ADMIN target, one live row per capability (partial unique index), `break-glass` time-boxed to four hours and dual-controlled (grantor ≠ target), an auth audit row in the same transaction, and the target's refresh tokens revoked plus the durable access-token invalidation epoch advanced on every grant or revoke — so the claim re-mints instead of surviving to natural expiry. `TokenService` projects the live rows as `platformCapabilities` (omitted when empty, like `modules`), fail-loud on a read error.
- admin-api reaches the writer over the existing `request.auth.admin.*` NATS request/reply (`grantPlatformCapability`, `revokePlatformCapability`, `listPlatformCapabilityGrants`; ACL SSoT regenerated). REST: `GET/POST users/:id/capabilities`, `POST users/:id/capabilities/:capability/revoke`, both writes under `security-ops`; the actor is the verified principal, never a body field. The FE grant page is part of ADMIN-HIGH-010 (W6); until it lands the routes are operator-callable and the panel's own navigation is not yet capability-aware.
- `PlatformCapabilityGuard` (kernel) is the third `APP_GUARD` in admin-api, after `PlatformAdminGuard` (untouched) and the throttler. It reads the claim the authentication guard copied onto the request, narrowed to the enum; no metadata → admitted by the role alone, so every GET stays open to every SUPER_ADMIN and `platform-read-only` is the explicit statement of that. All 235 non-public mutation handlers carry `@RequiresCapability(...)` at method level (billing → `billing-ops`; support, onboarding, announcements, messaging → `support-ops`; everything else → `security-ops`); a class-level decorator is refused by the gate because it would close the GETs. The ratchet `.claude/allowlists/uncapability-admin-routes.yaml` starts at ceiling 0.
- Bootstrap: the migration seeds the three standing capabilities for every active SUPER_ADMIN that pre-dates the table, and `SeedService` does the same for the first account of a fresh install, so a deploy never locks every operator out of every mutation and the capability that grants capabilities has a holder. `break-glass` is never seeded.
- `@Destructive()` now also requires `break-glass` (`requiresBreakGlass`, default true) beside fresh MFA. Both controls follow the single `SUPER_ADMIN_MFA_ENFORCED_AT` switch (ADR-0011): in detective mode a shortfall is a `DESTRUCTIVE_WITHOUT_BREAK_GLASS` / `DESTRUCTIVE_WITHOUT_FRESH_MFA` row in `admin.audit_logs` and the operation proceeds; once dated, it is refused. One switch, one ledger to read before choosing a date. The `destructive_runs` WORM ledger, dual-control confirmation and dry-run options named above are not built here; they are the destructive-runs line of ADMIN-CRITICAL-009 / W3 and the sink keeps the evidence until then.
- The role-template catalogue stays what it is named for — the tenant-side RBAC template surface read by RoleManagementPage and UserManagementPage; it is not consulted for platform capabilities.
