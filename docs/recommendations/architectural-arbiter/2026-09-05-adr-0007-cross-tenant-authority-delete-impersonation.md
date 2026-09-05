# ADR-0007 — Kernel Act-As Middleware Is the Single Cross-Tenant Authority; Impersonation Module Deleted

**Status:** accepted
**Date:** 2026-09-05
**Amends:** `docs/adr/008-*` (guard strategy / defense in depth), `docs/adr/013-*` (tenant isolation)
**Depends on:** ADR-0006 (mount point on admin-api)
**Supersedes:** admin-expert#SURF-003, #SURF-011; access-boundary-auditor#ACCESS-001, #ACCESS-002, #ACCESS-005; tenant-isolation-auditor#ISO-004, #ISO-012; audit-trail-completeness-auditor#TRAIL-002, #TRAIL-003; db-audit-platform-admin#DB-ADMIN-CRITICAL-001, #DB-ADMIN-CRITICAL-004; contract-parity-enforcer#CONTRACT-002, #CONTRACT-006, #CONTRACT-022, #CONTRACT-023; performance-expert#PERF-016; database-reviewer#DB-REVIEW-001
**Finding reference:** docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#SEC-CRITICAL-057

## Context

Two options were on the table. (a) Build a real enforcement leg: gateway act-as requires a live impersonation session, `sessionId` rides in the HMAC assertion, permissions are consumed by `TenantGuard`. (b) Delete the impersonation module and make the gateway `EffectiveTenantMiddleware` (`X-Act-As-Tenant`) the single authority, moving reason / ticket / TTL / dual identity onto it.

Verified evidence: `apps/gateway-api/**` contains zero occurrences of `impersonat*`. The minted impersonation token has no consumer anywhere in the fleet. `admin.impersonation_sessions` carries a blanket `BEFORE UPDATE OR DELETE` refusal trigger (`apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:266-277`) that six service paths violate, so the module is already non-functional at the database. `EffectiveTenantMiddleware` (`apps/gateway-api/src/middleware/effective-tenant.middleware.ts`) already enforces UUID validation, tenant-ACTIVE fail-closed in production, MFA step-up, and an HMAC-bound effective tenant. Option (a) would ratify a second, weaker authority (no ACTIVE check, no fail-closed) for one invariant.

## Decision

We delete the impersonation subsystem and make the kernel act-as middleware the only cross-tenant access authority on the platform.

- `EffectiveTenantMiddleware` and `CaptureRequestedTenantMiddleware` move from `apps/gateway-api/src/middleware/` to `libs/backend-common/src/middleware/` and are mounted at every internet-reachable ingress derived per ADR-0006.
- Reason, ticket reference and TTL become a required `X-Act-As-Reason` / `X-Act-As-Ticket` pair validated by the kernel middleware and persisted into the already-canonical `shared.audit_logs` columns `actorHomeTenantId`, `actedOnTenantId`, `mfaVerified`.
- Deleted: impersonation controller, service, entities, `admin.impersonation_sessions`, `admin.impersonation_permissions`, the Baseline trigger and function, `ImpersonationPage.tsx`, its client and types, the `X-Impersonate-User` CORS header, and the debug-tools sub-module (`debug_sessions`, `captured_queries`, `captured_api_calls`, `cache_entries_snapshot`, `feature_flag_overrides`) that lives under it.
- Gate: `tests/invariants/cross-tenant-authority-ssot.spec.ts` derives the ingress set from nginx and asserts one act-as implementation repo-wide, correct mount order on every ingress, and zero `impersonation_session` references outside migrations.
- Ownership: `auth-security-expert` becomes primary owner of the promoted middleware (prompt-writer to update).

## Consequences

- The "impersonate a user" product feature is gone; cross-tenant operator access is act-as-tenant with reason and ticket, audited in `shared.audit_logs`. Anyone who wanted per-user impersonation loses it; the platform never actually had it.
- Two admin tables and five debug tables are dropped (archive-then-drop with count assertion; debug archives must be encrypted or discarded because they hold raw tenant SQL and `Set-Cookie` headers).
- `admin.impersonation_sessions` leaves `PROTECTED_TABLES` because it is dropped, not because the invariant relaxed (ADR-0008).
- `tests/invariants/tenant-context-ssot.spec.ts` and both `app.module.ts` files change import paths and mount order.

## Implementation note (landed 2026-09-05)

- `CaptureRequestedTenantMiddleware` and `EffectiveTenantMiddleware` live in `libs/backend-common/src/middleware/effective-tenant.middleware.ts`; the tenant-ACTIVE check is a port (`TENANT_ACTIVE_CHECK`) an ingress binds to its lookup service. A cross-tenant act-as now requires `X-Act-As-Reason` (≤ 512 chars) and accepts `X-Act-As-Ticket` (≤ 128 chars, ticket-reference charset); both are kernel CORS defaults.
- The claims ride in the signed user-assertion (`actAs: { homeTenantId, reason, ticket }`). `VerifiedUserAssertionMiddleware` rebuilds `req.actAs`; `AuditedOperationInterceptor` writes `actorHomeTenantId` from it (previously it wrote the acted-on tenant into both columns) and persists `metadata.actAs`. `AccessLogMiddleware` records the effective tenant, so read access under act-as is attributed to the target tenant.
- Mount point: the middleware mounts where a JWT middleware populates `req.user` before guards — gateway-api. admin-api-service authenticates in a guard, reads no tenant header, and addresses tenants by route parameter; mounting the act-as chain there would run before `req.user` exists and resolve nothing. Its actor/tenant attribution is ADMIN-CRITICAL-008 / ADMIN-CRITICAL-009 (C8/C9). The decision text's "every internet-reachable ingress" is therefore implemented as "every ingress whose middleware chain authenticates the browser", which `cross-tenant-authority-ssot.spec.ts` asserts alongside single-implementation, CORS-default, reason-required, assertion and audit checks.
- The web has no SUPER_ADMIN tenant switcher today (`switchTenant` was an unimplemented stub); the shared-ui client now exposes `setActAsContext()` and attaches the three headers, and `switchTenant(tenant, { reason, ticket })` is the only way a super admin selects a tenant. The switcher UI itself is delivered with the admin-panel FE architecture work (ADMIN-HIGH-010, W6, owner okan, 2026-12-31).
