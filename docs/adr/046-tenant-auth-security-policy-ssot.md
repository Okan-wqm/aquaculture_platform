# ADR-046: Tenant auth-security policy SSoT (auth-service)

- **Status:** Accepted
- **Date:** 2026-09-04
- **Deciders:** auth-security-expert + architectural-arbiter (binding co-design,
  ADMIN-HIGH-010 / ADMIN-HIGH-014 / ADMIN-HIGH-015)
- **Relates to:** ADR-011 (schema ownership), ADR-038 (auth role-table RLS),
  ADR-037 (per-tenant policy precedent), `/CLAUDE.md` D14 (tenant row placement)

> **Numbering note.** This decision was originally drafted as "ADR-042" and then
> "ADR-045" on the `frontend-admin-panels-enterprise` branch. Both numbers were
> taken on `main` in the meantime — 042 by _Retire `shared.user_permissions`_ and
> 045 by _SCADA multi-tenant runtime_ — so the record lands at 046. Any older
> reference to "ADR-042 / ADR-045 tenant auth-security policy" means this file.

## Context

Tenant-level "require MFA" and "session timeout" existed only as _fabricated_
fields. admin-api's retired `tenant_configurations` adapter synthesized a
`TenantSecurityConfig` carrying `mfaRequired: false` / `sessionTimeoutMinutes:
480` defaults that **no runtime component ever read**, and its write path
returns `410 Gone`. The admin-panel rendered those values as editable controls —
a policy surface with zero enforcement (ADMIN-HIGH-010). A tenant administrator
could tick "require MFA", see it persist in the UI, and remain in a tenant where
nothing required MFA.

## Decision

**auth-service owns AND enforces the tenant auth-security policy.** It is the
only service that _can_ enforce it: login, MFA and refresh-token issuance all
live there.

1. **Storage** — two typed nullable columns on `auth.tenants` (the D14
   tenant-record SSoT): `enforce_mfa boolean` and `session_timeout_minutes int`.
   NOT a new table (the policy is 1:1 with the tenant row) and NOT the `settings`
   jsonb (typed columns keep the type system in the loop — Tier 1). NULL means
   "no tenant policy" and platform defaults apply, so the migration is a pure
   nullable add and needs no backfill. The 5..1440 bound is a table CHECK
   _and_ a DTO bound _and_ an entity `@Check` — the store refuses an
   out-of-range value even when the write does not pass through the DTO.

2. **Localization is NOT part of this decision.** Tenant timezone / locale is a
   different authority: it is written through the tenant command-receipt path
   (`updateTenantLocalization`, a SERIALIZABLE receipt with a `TenantUpdated`
   outbox emission in the same transaction) into `auth.tenants.settings.
localization`, and consumed by farm-service's feeding clock. Adding
   `timezone` / `date_format` columns beside the policy columns — as the
   original draft of this ADR did — would create a second, competing timezone
   SSoT on the same row. They are deliberately absent here.

3. **Write/read surface** — TENANT_ADMIN-guarded GraphQL on auth-service
   (`tenantSecurityPolicy` / `updateTenantSecurityPolicy`). The tenant id comes
   from `@Tenant()` (the JWT claim / TenantGuard-validated value), never from an
   argument, so a TENANT_ADMIN can only address their own tenant and a session
   with no tenant context is refused by the decorator rather than guessed at.
   Mutations are audit-logged like the sibling tenant-admin mutations.

4. **Write shape** — the mutation issues a column-scoped `update()` on exactly
   the two policy columns, never a whole-entity `save()`. The tenant row's
   lifecycle columns (`status`, `plan`, the suspension trio) belong to the
   command-receipt/FSM path; a self-service policy edit must not carry a stale
   snapshot of them back into the table.

5. **Consumers, never parallel persisters** — config-service and admin-api may
   read or echo policy but MUST NOT persist a competing copy. admin-api's
   retired `settings/tenant/:id/security` write stays `410 Gone`, and its
   synthesized read no longer fabricates `mfaRequired` / `sessionTimeoutMinutes`
   at all: the fields were removed from `TenantSecurityConfig` so a consumer
   cannot mistake a hardcoded default for a decision. The SUPER_ADMIN
   tenant-configuration UI now points at the tenant's own Security Policy.

## Enforcement points (what makes the policy real)

### Enrollment gate — `AuthenticationService.resolveMfaEnrollmentGate`

Every password-backed token-minting path — `login`, `acceptInvitation`,
`resetPassword` — funnels through ONE shared assertion. When the resolved tenant
has `enforce_mfa = true` and the user satisfies enforcement with NEITHER a TOTP
secret NOR a registered WebAuthn credential, issuance returns **no
access/refresh tokens**. Instead it returns `mfaSetupRequired: true` plus a
short-lived (10 minute) single-purpose `mfa_setup` token — a completable
enrollment path, not a lockout.

- A passkey / security key counts as a valid factor, so a WebAuthn user is not
  forced onto TOTP as well — and, symmetrically, a WebAuthn-only user does not
  bypass the gate.
- The setup token authorizes ONLY `setupMfa` + `verifyMfaSetup`.
  `enforceAccessTokenType` rejects every `type !== 'access'` token on every
  bearer surface, and `verifyMfaLogin` positively requires
  `type === 'mfa_challenge'`, so the setup token is inert everywhere else.
- `setupMfa` / `verifyMfaSetup` are `@Public` so the pre-session path can reach
  them; `JwtAuthGuard` attaches _optional_ identity on public routes (running
  the full verification chain and swallowing only the failure), and the resolver
  gives an authenticated session precedence over any token argument — a setup
  token can never redirect an authenticated user's enrollment.
- `verifyMfaSetup` via a setup token issues NO tokens. The user signs in again
  and takes the normal `mfa_challenge` flow, which keeps token issuance on
  exactly one audited path.
- **Fail-closed:** if the tenant enforces MFA, the user is unenrolled AND the
  MFA service is unavailable (no `MFA_ENCRYPTION_KEY` — reachable only in
  local/dev, since production fails fast at boot), issuance denies with a
  CRITICAL `LOGIN_BLOCKED_MFA_UNAVAILABLE` audit event. Enforcement never
  depends on a boot-time env heuristic.
- `verifyMfaLogin` / `verifyStepUp` / WebAuthn login inherently satisfy
  enforcement — the user just presented a factor — and mint normally.

**Why the gate is at the callers and not inside `generateTokens`:** producing
the graceful `mfaSetupRequired` outcome requires minting an `mfa_setup` token via
`MfaService`, and `TokenService → MfaService` would reintroduce the exact cycle
`TokenService` was extracted to break. So the gate is one shared, greppable
helper. The _clamp_, which needs no `MfaService`, does live in the chokepoint.

### Refresh-TTL clamp — `TokenService.generateTokens`

Effective refresh-token TTL = `MIN(configured TTL incl. rememberMe,
session_timeout_minutes)`; the tenant policy wins, including over a rememberMe
extension. The policy is resolved **inside** `generateTokens`
(`resolveTenantTokenPolicy`, widening by one column the same `auth.tenants` read
the `planLevel` claim already performs on every mint — no extra round-trip), NOT
threaded by callers. That is what makes it unforgettable: login, both rotation
paths, `verifyMfaLogin`, `verifyStepUp`, `acceptInvitation`, `resetPassword` and
WebAuthn are all clamped structurally, and a future mint path is clamped the day
it is written. Rotation applies the same clamp, giving _sliding idle-timeout_
semantics. Access-token TTL is untouched. A timeout **reduction** takes effect at
the next rotation (existing rows keep their persisted expiry until rotated).

### Revocation-on-flip — `TenantAdminService.updateSecurityPolicy`

When `enforce_mfa` transitions false/NULL → true, the sessions of that tenant's
users **without a second factor** are terminated. The candidate set is computed
with one statement (`mfaEnabled = false AND NOT EXISTS (webauthn credential)`,
the same definition the login gate uses), and each candidate is terminated with
the canonical credential-mutation fence: User row `FOR UPDATE`, then
`revokeActiveRefreshTokens`, then a durable `UserAccessTokenInvalidation`
intent enqueued in the same transaction and applied immediately after commit.
Their next login walks the enrollment gate.

The durable intent is what closes the residual risk the original draft of this
ADR accepted: because the user's invalidation epoch is advanced, **already-issued
access tokens are rejected too**, not just refresh tokens. The intent uses the
existing `logout_all_devices` reason — the contract's reason vocabulary carries
no MFA-policy member, and adding one would skew the event JSON schema across a
rolling deploy; _why_ the sessions ended is carried by the
`TENANT_SECURITY_POLICY_UPDATED` audit entry instead.

## Consequences

- The policy is enforceable exactly where credentials are minted; no
  cross-service consistency problem can exist because there is one writer and
  one enforcer.
- admin-panel (SUPER_ADMIN) no longer shows editable MFA-required /
  session-timeout controls for tenants; those are managed by the tenant's own
  administrator in tenant-admin.
- Every mint path is clamped at issuance, not only at the first rotation, so
  there is no unclamped window on `verifyMfaLogin`, step-up,
  invitation-acceptance, password-reset or WebAuthn.
- `JwtPayload.type` grew a fourth member (`mfa_setup`). Because every bearer
  surface asserts `type === 'access'` positively, the new member is inert
  wherever it is not explicitly required.
- Turning enforcement on is a **disruptive** operation for a tenant whose users
  have no factor: it signs them out. The mutation says so in its audit entry
  (WARNING severity + the blast radius), and the tenant-admin UI warns before
  saving.

## Alternatives rejected

- **`settings` jsonb instead of typed columns** — the clamp would read an
  untyped value on the hottest path in the platform, and the 5..1440 bound
  could not be a store-level CHECK.
- **Clamp threaded by callers** — this is exactly the defect ADMIN-HIGH-015
  recorded: five of seven mint paths, including the primary MFA login path,
  omitted it.
- **Enforcing the MFA gate inside `generateTokens`** — see above; it would
  re-create the `TokenService ↔ MfaService` cycle, and a throw there could only
  produce a lockout, never a completable enrollment.
- **Blacklisting access tokens only, without a durable intent** — a
  Redis-only revocation is lost on an outage. The durable outbox intent replays.
