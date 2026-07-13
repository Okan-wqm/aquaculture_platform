# ADR-042: Tenant auth-security policy SSoT (auth-service)

**Status:** Accepted
**Date:** 2026-07-13
**Deciders:** auth-security-expert + architectural-arbiter (binding co-design, ADMIN-HIGH-010 / ADMIN-MEDIUM-010)
**Related:** ADR-011 (Schema Ownership), ADR-038 (auth role-table RLS), CLAUDE.md D14 (tenant row placement), `docs/adr/037-plan-limit-ssot.md` (per-tenant policy precedent)

## Context

Tenant-level "require MFA" and "session timeout" existed only as *fabricated*
fields: admin-api's retired `tenant_configurations` adapter synthesized a
`TenantSecurityConfig` with `mfaRequired: false` / `sessionTimeoutMinutes: 480`
defaults that **no runtime component ever read**, and its write path returns
`410 Gone`. The admin-panel rendered these as editable controls — a policy
surface with zero enforcement (ADMIN-HIGH-010). Tenant localization
preferences (timezone, date format) had the same fabricated-only existence
(ADMIN-MEDIUM-010).

## Decision

**auth-service owns AND enforces the tenant auth-security policy.** It is the
only service that can enforce it — login, MFA, and refresh-token issuance all
live there.

1. **Storage** — typed nullable columns on `auth.tenants` (the D14 tenant-record
   SSoT): `enforce_mfa boolean`, `session_timeout_minutes int`, plus the
   deliberately *separate* localization preference columns `timezone varchar`
   and `date_format varchar` (`DD/MM/YYYY` | `MM/DD/YYYY` | `YYYY-MM-DD`).
   NOT a new table (the policy is 1:1 with the tenant row), NOT the `settings`
   jsonb (typed columns keep the type system in the loop — Tier-1). NULL means
   "no tenant policy" (platform defaults apply).
2. **Write/read surface** — TENANT_ADMIN-guarded GraphQL on auth-service
   (`tenantSecurityPolicy` / `updateTenantSecurityPolicy`,
   `tenantLocalizationPreferences` / `updateTenantLocalizationPreferences`).
   `tenantId` is always taken from the caller's JWT (`@CurrentUser`), never an
   argument. Mutations are audit-logged like sibling tenant-admin mutations.
3. **Consumers, never parallel persisters** — config-service and admin-api may
   *read/echo* policy but MUST NOT persist a competing copy. admin-api's retired
   `settings/tenant/:id/security` write stays `410 Gone`, and its synthesized
   read no longer fabricates `mfaRequired` / `sessionTimeoutMinutes` at all —
   the fields were removed from the synthesized `TenantSecurityConfig` so a
   consumer cannot mistake a default for a decision.
4. **Localization is not security** — `timezone` / `date_format` are preference
   columns beside the policy columns, exposed via a separate ObjectType/DTO.
   They are deliberately not folded into a "security config" container.

## Enforcement points (what makes the policy real)

- **Enrollment gate** (`AuthenticationService`, ADMIN-HIGH-014): every
  password-backed token-minting path — `login`, `acceptInvitation`,
  `resetPassword` — funnels through ONE shared assertion
  (`resolveMfaEnrollmentGate`). When the resolved tenant has `enforce_mfa =
  true` and the user satisfies enforcement with NEITHER a TOTP secret NOR a
  registered WebAuthn credential (a passkey / security key counts as a valid
  factor — SEC-MEDIUM), issuance returns **no access/refresh tokens**. Instead
  it returns `mfaSetupRequired: true` plus a short-lived (10 min)
  single-purpose `mfa_setup` token (JWT `type: 'mfa_setup'`) — a completable
  enrollment path, not a lockout. The setup token authorizes ONLY `setupMfa` +
  `verifyMfaSetup`; `enforceAccessTokenType` rejects it on every bearer surface
  and `verifyMfaLogin` rejects it positively (`type !== 'mfa_challenge'`). Users
  who already satisfy enforcement proceed (TOTP → the unchanged challenge flow;
  WebAuthn → a normal mint). If the tenant enforces MFA, the user is unenrolled,
  AND the MFA service is unavailable (no `MFA_ENCRYPTION_KEY` — reachable only
  in local/dev, since production fails fast at boot), issuance **FAILS CLOSED**:
  deny + a CRITICAL security-audit event, so enforcement never depends on a boot
  env heuristic (SEC-MEDIUM-003). `verifyMfaLogin` / `verifyStepUp` / WebAuthn
  login inherently satisfy enforcement (the user just presented a factor) and
  mint normally.
- **Refresh-TTL clamp** (`TokenService.generateTokens`, ADMIN-HIGH-015):
  effective refresh-token TTL = `MIN(configured TTL incl. rememberMe,
  session_timeout_minutes)` — tenant policy wins. The policy is resolved INSIDE
  `generateTokens` from the user's own tenant (widening by one column the same
  `auth.tenants` read the `planLevel` claim already performs on every mint),
  NOT threaded by callers — so the clamp is a property of the single mint
  chokepoint and no path (login, both rotation paths, `verifyMfaLogin`,
  `verifyStepUp`, `acceptInvitation`, `resetPassword`, WebAuthn) can forget it.
  Rotation applies the same clamp, giving *sliding idle-timeout* semantics.
  Access-token TTL is untouched. A timeout **reduction** applies on the next
  rotation (existing rows keep their expiry until rotated).
- **Revocation-on-flip** (`TenantAdminService.updateSecurityPolicy`): when
  `enforce_mfa` transitions false/NULL → true, the refresh tokens of that
  tenant's users **without MFA enrolled** are revoked (same
  `refreshTokenRepository.update({...isRevoked:false}, {isRevoked:true,...})`
  primitive as logout-all/deactivate), and a security audit event is written.
  Their next login walks the enrollment gate above.

## Residual risk (accepted)

- **SEC-LOW-004 — access-token residual on enforce-MFA flip.** When
  `enforce_mfa` flips false/NULL → true, `updateSecurityPolicy` revokes the
  **refresh** tokens of the tenant's non-MFA users (so they cannot obtain new
  access tokens and their next login hits the enrollment gate), but it does NOT
  blacklist their already-issued **access** tokens. Those stay valid until they
  expire — at most one access-token lifetime (`JWT_EXPIRES_IN`, default 15 min).
  **Decision: document, do not blacklist.** The residual is short and
  self-limiting (no new access token can be minted once the refresh token is
  revoked), and refresh-only revocation is exactly the posture of the sibling
  `deactivateUser` in the same service — blacklisting here would make one admin
  action inconsistently stronger than the other. If a tighter bound is ever
  required, call `tokenBlacklist.blacklistUserTokens(userId, now +
  JWT_EXPIRES_IN, …)` for each revoked user (the same primitive `logout-all` /
  `resetPassword` use).

## Consequences

- The policy is enforceable exactly where credentials are minted; no
  cross-service consistency problem can exist because there is one writer and
  one enforcer.
- admin-panel (SUPER_ADMIN) no longer shows editable MFA-required /
  session-timeout controls for tenants; those are managed by the tenant's own
  admin in tenant-admin (auth-service policy).
- Every mint path is clamped at issuance, not only at the first rotation,
  because the clamp is resolved inside the `generateTokens` chokepoint — there
  is no longer an unclamped-until-rotation window on `verifyMfaLogin`, step-up,
  invitation-acceptance, password-reset, or WebAuthn.
