# Authentication, authorization and gateway security — production readiness review (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Reviewer | `auth-security-expert` (read-only specialist, dispatched by the orchestrator) |
| Question | What blocks this repository from going to production? |
| Scope | apps/auth-service, apps/gateway-api, libs/backend-common rate-limit/guards/tenant context |
| Verdict | **NOT READY** |
| Method | Independent read-only review; claims cite file:line as the reviewer reported them. Items the orchestrator re-checked are marked in the verification section. |

Two blockers in auth and session handling. Neither is a crypto flaw: one is a rate-limit design
defect, the other a production configuration setting. A third issue is high-confidence but not
runtime-verified.

## Blockers

- **B1. auth-service rate limits act as single platform-wide buckets.**
  - `RateLimitGuard.identityOf` reads `request.ip`
    (`libs/backend-common/src/rate-limit/rate-limit.guard.ts:293-320`). auth-service is internal
    with no `TRUST_PROXY` (`apps/auth-service/src/main.ts:14`,
    `docker-compose.droplet.yml:833-898`, `edge-hardening.ts:87-96`), so that IP is always the
    gateway container. The gateway does send `x-client-ip`, but the guard ignores it.
  - Any limit without an identifier is shared by every user: `refresh` 10 per 5 min
    (`auth.resolver.ts:141`), `password-reset` 3 per hour (`:232`), `webauthn-verify` 10 per 15
    min (`webauthn.resolver.ts:187`).
  - One anonymous caller can stop all session refresh, password reset and passkey login, and
    normal traffic alone goes over 10 refreshes per 5 min.
- **B2. SUPER_ADMIN MFA is not enforced in production.**
  - `SUPER_ADMIN_MFA_ENFORCED_AT: 'detective'` (`docker-compose.droplet.yml:890`) means
    `token.service.ts:290-305` issues SUPER_ADMIN tokens without MFA and only logs a warning.
    `SUPER_ADMIN_EMAIL` defaults to `admin@localhost.dev` (`:871`).
  - admin-api has no such variable, so `destructive-action.guard.ts:121` makes any destructive
    call lacking fresh MFA or break-glass throw an uncaught 500
    (`platform-admin-mfa-policy.ts:56`) before the shortfall is recorded.

## Major

- **M3 (high confidence, not runtime-verified): the gateway's global guards never run for
  `/graphql`.** ApolloGatewayDriver has no Nest resolvers, so AuthGuard, TenantIsolationGuard and
  RateLimitGuard (`apps/gateway-api/src/app.module.ts:542-607`) apply only to REST routes. The
  login, anonymous and mutation tiers (`rate-limit.config.ts:43-89`) never take effect, so the
  SEC-HIGH-166 fix does nothing. Login across many accounts is limited only by nginx at 60 req/s
  per IP (`droplet.conf:98,333`). Authentication itself still holds: JwtMiddleware plus
  fail-closed subgraph assertions.
- **M4. Reset/invitation links use the `action_tokens` primary key, stored in plaintext, as the
  credential** (`action-token-resolver.service.ts:89-92`, `action-token.entity.ts:27`). The
  `tokenHash` column is not used for links, so tokens are not hashed at rest; anyone who can read
  that table or a backup can take over accounts.
- **M5. Cross-tenant act-as is not durably audited.** It only writes a log line
  (`effective-tenant.middleware.ts:244-255`); rejections and reads are never persisted.

## Minor

- Production access-token lifetime is 1 h (`docker-compose.droplet.yml:727,870`) instead of the 15
  min code default, and the step-up `mfaVerified` claim lasts that full hour.
- The JWKS endpoint reads `JWT_PUBLIC_KEY_FILE` but production sets `_PATH`, so it serves an empty
  key set (`jwks.controller.ts:59-63`). Verifiers accept only one public key.
- In the gateway, RequestContextMiddleware runs before StripInternalHeadersMiddleware
  (`app.module.ts:644-646`), so a forged `x-tenant-id` ends up in gateway log context.
- The query-complexity check lets the query through if the calculation itself errors
  (`app.module.ts:373-384`).
- MFA and WebAuthn audit IPs use `req.ip` or `X-Forwarded-For` (`mfa.resolver.ts:220,264`,
  `webauthn.resolver.ts:196`), which records the gateway's IP.

## Verified sound

- RS256-only verification with issuer and audience checked; `type=access` enforced; revocation
  check fails closed; refresh-token rotation with family reuse containment; bcrypt cost 12 plus
  pepper; TOTP replay protection and lockout; v2-only HMAC in production; introspection off in
  production; depth limit 10 and one alias for sensitive mutations; rate limiter fails closed in
  production; CORS allowlist.

## Registry

The 20 INFRA-* items owned by security-reviewer (including INFRA-CRITICAL-096 BLOCKED and
INFRA-CRITICAL-097/098 OPEN) were left to the infra and security specialists.

| Finding | Registry state | Reviewer status | Note |
| ------- | -------------- | --------------- | ---- |
| SEC-HIGH-166 | RESOLVED | Fix ineffective, reopen candidate | Major M3 |
| MT-HIGH-054 | OPEN | CONFIRMED | `channel.resolver.ts:549` |
| SEC-MEDIUM-126 | OPEN | CONFIRMED | Capability checks only in auth, sensor, hr |
| SEC-HIGH-167 | OPEN | CONFIRMED | `create-batch.command.ts` has no roles or site IDs |
| MT-HIGH-064 | OPEN | CONFIRMED | `mcp-client.service.ts:120` |
| SEC-LOW-160 | OPEN | CONFIRMED |  |
| SEC-LOW-114 | OPEN | CONFIRMED, mitigated | ServiceIdentityGuard still checks resolvers |
| SEC-LOW-115 | OPEN | CONFIRMED |  |
| SEC-LOW-120 | OPEN | CONFIRMED, worse | JWKS empty in production |
| SEC-LOW-063 | OPEN | CONFIRMED in code | Production message masked by `subgraphFormatError` |
| SEC-LOW-087 | OPEN | Partly stale | nginx strips the CDN IP headers |
| SEC-LOW-124 | OPEN | Cookie part STALE, logging part CONFIRMED |  |
| SEC-LOW-128 | OPEN | STALE | No debug controller remains |
| SEC-MEDIUM-127 | OPEN | STALE (ai part) |  |
| ADMIN-MEDIUM-101 | OPEN | Not re-verified |  |

## Not verified

- Runtime behaviour (no `node_modules`, so the ApolloGatewayDriver guard behaviour is
  unconfirmed); current database grants on `auth.action_tokens`; findings outside this domain:
  MT-HIGH-062, MT-MEDIUM-063/065, SEC-MEDIUM-059/079/106/111/112.

## Registry entries

This review appended 7 finding(s) to `docs/reviews/_registry/findings.jsonl` (state OPEN, owner
okan). Findings the review only confirmed, such as ALERT-CRITICAL-009 or the INFRA-CRITICAL
deploy-pipeline cluster, already exist and were not re-filed.

| ID | Severity | Title |
| --- | --- | --- |
| SEC-CRITICAL-179 | CRITICAL | auth-service rate limits act as single platform-wide buckets: RateLimitGuard keys on request.ip, auth-service is internal with no TRUST\_PROXY so every caller is the gateway container, and the guard ignores x-client-ip, so one anonymous caller can exhaust refresh (10/5 min), password-reset (3/h) and passkey-verify (10/15 min) for every user |
| SEC-CRITICAL-180 | CRITICAL | SUPER\_ADMIN MFA is not enforced in production: SUPER\_ADMIN\_MFA\_ENFORCED\_AT is detective so token.service issues SUPER\_ADMIN tokens without MFA and only logs, SUPER\_ADMIN\_EMAIL defaults to `admin@localhost.dev`, and admin-api lacks the variable so a destructive call without fresh MFA throws an uncaught 500 before the shortfall is recorded |
| SEC-HIGH-181 | HIGH | The gateway global guards (AuthGuard, TenantIsolationGuard, RateLimitGuard) never run for /graphql because ApolloGatewayDriver has no Nest resolvers, so the login, anonymous and mutation rate-limit tiers never take effect and login across many accounts is limited only by nginx at 60 req/s per IP |
| SEC-HIGH-182 | HIGH | Password-reset and invitation links use the action\_tokens primary key as the credential and it is stored in plaintext; the tokenHash column is not used for links, so anyone who can read the table or a backup can take over accounts |
| SEC-HIGH-183 | HIGH | Cross-tenant act-as is not durably audited: effective-tenant.middleware only writes a log line, and rejections and reads are never persisted |
| SEC-MEDIUM-184 | MEDIUM | Production access tokens live 1 hour instead of the 15-minute code default and the step-up mfaVerified claim lasts that full hour |
| SEC-LOW-185 | LOW | Gateway and MFA hygiene: RequestContextMiddleware runs before StripInternalHeadersMiddleware so a forged x-tenant-id reaches log context, the query-complexity check lets a query through if the calculation errors, and MFA/WebAuthn audit rows record the gateway IP instead of the client |
