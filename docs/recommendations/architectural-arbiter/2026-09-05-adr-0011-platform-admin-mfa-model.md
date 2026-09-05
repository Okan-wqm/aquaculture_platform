# ADR-0011 — Platform Admin MFA: Enrolment at Token Issue, Step-Up by Principle

**Status:** accepted (section "Escalation to human reviewer" is `proposed`)
**Date:** 2026-09-05
**Amends:** `docs/adr/008-*` (guard strategy)
**Depends on:** ADR-0007 (mount point for cross-tenant step-up on admin-api)
**Resolves:** auth-security-expert#AUTH-005, #AUTH-006, #AUTH-007, #AUTH-013; access-boundary-auditor#ACCESS-003, #ACCESS-004; admin-expert#SURF-005
**Finding reference:** docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#SEC-CRITICAL-058

## Context

The mechanism exists and admin-api does not participate. `TokenService` (`apps/auth-service/src/modules/authentication/services/token.service.ts:322`) mints `mfaVerified` spread-omitted when false; `TenantGuard` defaults `MFA_REQUIRED_FOR_CROSS_TENANT` to true; `effective-tenant.middleware.ts:186-192` refuses cross-tenant act-as without `mfaVerified`; `shared.audit_logs.mfaVerified` is a mandatory indexed column. admin-api has no `configure(consumer)`, no `TenantGuard`, `security.mfa_enabled` has no reader, and `impersonation_sessions.mfaCompleted` is never written. `seed.service.ts:177-188` promotes an account to SUPER_ADMIN at boot without MFA.

## Decision

We enforce MFA for platform admins in three parts.

1. **Enrolment at token issue.** `TokenService` refuses to mint an access token carrying `SUPER_ADMIN` for a user with `mfaEnabled = false`. A platform admin without MFA cannot hold a credential, so no code path can skip the check. This also neutralises the boot-time promotion: the promoted account cannot authenticate until it enrols.
2. **Step-up by principle, not by list.** Cross-tenant access uses the existing act-as step-up, which covers admin-api the moment ADR-0007 mounts the kernel middleware there. Irreversible operations (tenant erasure, archive / delete, legal-hold release, schema deletion, audit / PII export) use `@Destructive({ requiresFreshMfa: true })` + `DestructiveActionGuard`, reading the same `mfaVerified` claim plus an `iat` freshness window.
3. **Minted in auth-service, verified in the kernel.** No admin-local MFA. `security.mfa_enabled` in `admin.system_settings` (seed `1805400000000:127`, `SystemSettingsPage.tsx:334-338`) is deleted; `mfaCompleted` disappears with ADR-0007.

Gate: `tests/invariants/platform-admin-mfa-ssot.spec.ts` — (i) `TokenService` cannot emit a `SUPER_ADMIN` payload without `mfaVerified`, asserted as unit behaviour; (ii) every `@Destructive({irreversible})` route resolves through `DestructiveActionGuard`; (iii) no `MFA_REQUIRED_FOR_CROSS_TENANT=false` in any committed compose or env file; (iv) zero readers of `mfa_enabled` as a runtime config key.

## Escalation to human reviewer (proposed)

The mint refusal locks out every un-enrolled platform operator the moment it ships. The mechanism is decided; the **cutover date** (`SUPER_ADMIN_MFA_ENFORCED_AT`, pinned in the invariant) and the **break-glass procedure for a locked-out operator** are the owner's decision and are recorded here as open until answered.

## Consequences

- Fleet-wide auth change, the highest-risk item in this arbitration; it ships behind a dated enrolment ramp.
- ~15 destructive admin routes gain the decorator; `libs/backend-common` gains the guard.
- The losing side: the "MFA optional, toggled in settings" model is gone. A config toggle for a mandatory control was a documented off-switch for a compliance obligation.

## Implementation note (landed 2026-09-05)

- Owner decision (okan, 2026-09-05): enforcement is not required yet; the structure ships so it can be switched on early. The cutover date is therefore not pinned — `SUPER_ADMIN_MFA_ENFORCED_AT` is `'detective'` in `docker-compose.droplet.yml` and setting it to an ISO-8601 date-time is the cutover. The `proposed` escalation clause above is resolved by that switch: the break-glass for a locked-out operator is to set the value back to `'detective'` in the same reviewed line, which un-refuses token issue without touching code.
- Detective mode is not silent: an un-enrolled SUPER_ADMIN is named in a `super_admin_token_without_mfa_enrolment` warning at every token issue, and an irreversible admin operation without a fresh claim writes `DESTRUCTIVE_WITHOUT_FRESH_MFA` to `admin.audit_logs`. The operator can therefore read the exact lock-out set before choosing a date.
- `@Destructive()` installs `DestructiveActionGuard` through `applyDecorators`; the irreversible set is derived (every DELETE plus erase / archive / purge / drop / release / export / terminate / revoke / rollback / deprovision handlers, public handlers exempt) rather than listed, and `tests/invariants/platform-admin-mfa-ssot.spec.ts` recomputes it on every PR.
