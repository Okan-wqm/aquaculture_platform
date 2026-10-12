# 2026-10-12 — Pre-auth RLS outage review (invitation + password reset + anonymous mints)

**Owner agent:** zcode · **Cycle:** 2026-10-12-preauth-rls-outage
**Trigger:** tenant-admin invitation for duygu@suderra.com rendered "Davet bağlantısı geçersiz veya süresi dolmuş" on a provably valid, unexpired, unconsumed link (nginx + aqua-auth logs 12:28–12:29 UTC; DB row `auth.invitations` PENDING, `auth.action_tokens` ACTIVE until 2026-10-19).

## Root cause

`auth`-schema tables carrying a `tenantId` column are covered by `tenant_isolation_policy`
(`FOR ALL … USING (app.bypass_rls = 'on' OR "tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`),
armed with FORCE ROW LEVEL SECURITY by db-migrate post-migration hardening
(`apps/db-migrate/src/schema-registry.ts`, exclusions only `auth_outbox` / `users` / `tenants`).
Authentication flows that run BEFORE a tenant context can exist (no JWT, no `x-tenant-id`) checked
connections out with empty GUCs, so:

- `validateInvitation` / `acceptInvitation` read `auth.action_tokens` + `auth.invitations` → ZERO rows → "invalid link";
- `initiatePasswordReset`'s `auth.action_tokens` INSERT was refused and swallowed by the method's
  catch (uniform-200 anti-enumeration contract) → reset e-mails silently never sent;
- `resetPassword` died at the first gated read → "Invalid or expired password reset token";
- WebAuthn login and MFA login verification minted sessions AFTER a successful assertion through a
  bare `generateTokens` → the `auth.refresh_tokens` INSERT was refused → login failed at the last step.

This is the fourth production incident of the anonymous/RLS-invisible class: `auth.users` login
(2026-04-21, DEPLOY-CRITICAL-006), `auth.refresh_tokens` rotation (2026-04-21, DEPLOY-CRITICAL-007,
fixed with the audited bypass), `auth.tenant_command_receipts` provisioning (2026-08-06, fixed with
`bindTenantRlsContext`), and now invitations + password reset + anonymous mints. Each prior fix
landed as one more hand-rolled frame at one more call site.

## Fix (this PR)

1. **One audited boundary** — `PreAuthRlsFrameService`
   (`apps/auth-service/src/modules/authentication/services/pre-auth-rls-frame.service.ts`):
   `runPreAuthTokenFlow` (audited bypass for cross-tenant-by-construction token resolution),
   `runTenantCredentialWrite` (fail-closed `bindTenantRlsContext` transaction for known-tenant writes),
   `mintTokensForPrincipal` (login's dual path: tenant frame for tenant users, audited bypass for
   platform principals). All four transactions and all previously-bare mint call sites route through it.
2. **Fence anchor** — `acceptInvitation` / `resetPassword` re-load the committed user row before
   minting: the password write advances the trigger-maintained `credentialVersion`, and minting from
   the stale entity made `TokenService`'s issuance fence refuse the flow AFTER its writes committed.
3. **CI ratchet** — `tests/invariants/auth-preauth-rls-context-ssot.spec.ts`: every
   `generateTokens(` / `dataSource.transaction(` call site under `modules/authentication/services`
   must be lexically inside an approved frame (or carry an allowlisted, finding-tracked reason).
4. **Runtime proof** — `apps/auth-service/src/modules/authentication/__tests__/preauth-flows-rls.postgres.spec.ts`:
   real Postgres (production image digest), FORCE RLS armed by the platform helper, non-owner runtime
   role, real `BypassRlsService` + `RlsConnectionBootstrap` + `AuthenticationService`; anonymous
   validate/accept/reset succeed, cross-tenant rows stay invisible, tenant mints emit no bypass WARN.
5. **Rate limit** — `validateInvitation` carries `@RateLimit(10 / 5m)`: after the fix every anonymous
   probe emits an audited bypass WARN pair; the limit closes the log-amplification channel.

## Findings

- **SEC-HIGH-196 — Pre-auth RLS blindness (invitations + password reset).** Closed by this PR.
  (SEC-HIGH-199 is a double registration of the same finding from this session — closed by the same
  commit; the registry CLI allocates sequentially and has no void path.)
- **SEC-HIGH-197 — WebAuthn / MFA login mints without RLS context.** Closed by this PR.
  (SEC-HIGH-200 is the same double registration — closed by the same commit.)
- **PROC-HIGH-048 — No pre-auth RLS boundary and no CI invariant for the class (4th recurrence).**
  Closed by this PR (choke point + ratchet + real-PG spec).
- **SEC-MEDIUM-201 — notification_logs INSERTs refused by tenant_isolation_policy.** OPEN — separate
  deploy unit (notification-service), separate PR; registered with owner + deadline 2026-10-26.
- **SEC-MEDIUM-198 — Platform-principal logout / logout-all / change-password revocations match zero
  rows under RLS (refresh rows survive logout for tenantId=NULL users).** OPEN — ratchet-allowlisted
  against this finding; registered with owner + deadline 2026-10-26.
