# Security Reviewer — CATCHER — 2026-04-28 Core Platform Review

**Agent:** security-reviewer (cross-cutting platform quality gate)
**Mode:** review (CATCHER)
**Scope:** core/cross-cutting platform — `apps/gateway-api`, `apps/auth-service`, `apps/billing-service`, `libs/backend-common/src/{auth,middleware,security,utils,http,bootstrap}`. Domain modules (farm/hr/sensor/messaging) explicitly out of scope per orchestrator decision.
**HEAD:** main `a958dc66`, clean tree

## Scope

Reviewed cross-cutting platform surfaces routed to security-reviewer:

- gateway: AuthenticatedDataSource (HMAC + identity propagation), JwtMiddleware, StripInternalHeadersMiddleware, CsrfMiddleware, SecurityHeadersMiddleware, TenantContextMiddleware, TenantIsolationGuard, RateLimitGuard, GlobalExceptionFilter, AuthGuard, alias-limit plugin, ServiceProxyService, AI proxy, JWKS, OPA guard, file upload, CSP report endpoint
- auth-service: AppModule (RS256/HS256 dev fallback), AuthenticationService, TokenService, MfaService, JwtAuthGuard, refresh-token rotation, password util (HMAC-pepper + bcrypt), audit-log entity, RLS module
- billing-service: StripeWebhookController + StripeWebhookService, AppModule (no StripInternalHeadersMiddleware), webhook idempotency
- backend-common: signed-http-client, service-identity util, JwtVerificationUtils, SessionManager, EncryptedColumn transformer, ServiceIdentityGuard

Sibling findings already raised by auth-security-expert, billing-expert, platform-kernel-expert, database-reviewer, multi-tenant-saas-expert, data-expert were read for awareness; this report independently confirms a subset and adds non-overlapping cross-cutting findings.

## Executive summary

Three new CRITICAL findings — unconditional BLOCK:
1. **SECREV-CRITICAL-001** — Stripe webhook trusts unvalidated `metadata.tenantId` for cross-tenant DB writes / Redis-key construction. External-trust-boundary primitive is missing UUID validation, allowing log-injection, Redis-key collision, and (if Stripe metadata is ever sourced from tenant-controlled UI flows) cross-tenant subscription corruption.
2. **SECREV-CRITICAL-002** — billing-service AppModule does NOT register `StripInternalHeadersMiddleware`. Confirms and extends `SEC-CRITICAL-002` (auth-security-expert) — auth-service is the named gap, but billing-service has the same gap and processes Stripe webhooks (`@Public()`) where a forged `x-user-payload` would be honoured by downstream `@CurrentUser()` decorators.
3. **SECREV-CRITICAL-003** — `TenantIsolationGuard.extractRequestedTenantId` accepts query-param + body `tenantId`. Confirms `MT-CRITICAL-001` (multi-tenant-saas-expert, 3rd-cycle unfixed). Header-based + body-based tenant claim is independently exploitable: lower bar than `x-tenant-id` header (subject to CORS) and survives some same-origin filters.

Two HIGH findings worth highlighting:
- **SECREV-HIGH-001** — Empty `apps/auth-service/src/rate-limit/rate-limiter.service.ts` + `throttle.decorator.ts` (0 bytes). Dead-code shell of an aborted per-service rate-limit migration. Confirms login is gateway-rate-limit-only, compounding `SEC-CRITICAL-003` from auth-security-expert.
- **SECREV-HIGH-002** — `MfaService.verifyMfaLogin` calls `this.jwtService.verify(mfaToken)` without `getJwtVerifyOptions(configService)` — algorithm/issuer/audience not enforced for the MFA challenge token. Same defect class as `SEC-CRITICAL-004` (auth-security-expert) raised for `validateToken`. Independent occurrence.

Verdict: **BLOCK**.

## Findings (by severity)

### CRITICAL

#### SECREV-CRITICAL-001 — Stripe webhook trusts unvalidated `metadata.tenantId` (external→internal trust boundary)

**Severity:** CRITICAL
**Layer:** 2 (pattern) — input validation at trust boundary
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:61` — `const tenantId: string | undefined = paymentIntent.metadata?.tenantId;` — used unvalidated.
- `:84-87` — `tenantId` flows directly into `manager.findOne(Invoice, { where: { id: invoiceId, tenantId }, … })`.
- `:337` — `await this.redisService.del(`subscription:${tenantId}`)` — Redis-key interpolation with the same unvalidated value.
- `:90, 311, 375, 458` — `tenantId` interpolated into log strings via template literal (`logger.warn(`...for tenant ${tenantId}`)`). With CRLF in `metadata.tenantId`, log-injection is direct.
- No UUID/format validation anywhere in `stripe-webhook.controller.ts` or `stripe-webhook.service.ts` (verified via grep — zero occurrences of `uuidRegex`/`isUUID`/`validateUuid`).

**Rule violated**
- ASVS V5 (Validation, Sanitization & Encoding) — V5.1.1 (validate input at trust boundary), V5.1.3 (validate against context-specific format).
- Layer-2 patterns — "validate at boundary, narrow before leaving boundary file" (`.claude/knowledge/layer-2-patterns.md`).
- OWASP A03 Injection (log-injection) + A01 Access Control (cross-tenant write surface).

**Proposed fix direction**
- Tier-1: declare `metadata.tenantId` as a branded `TenantId` parsed via `parseTenantId(rawMetadata.tenantId)` at the controller boundary; the parse function rejects non-UUID and non-existent tenants. The webhook service receives a `TenantId`, never `string`.
- Cross-check `metadata.tenantId` against the actual subscription/invoice owner: load row first, ignore metadata-supplied tenantId entirely, derive tenant from the row.
- Add structured-logger contract: never use template literals for tenant/user IDs in log strings — pass as structured key (`{ tenantId }`) so log forwarder masks/escapes.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts` (5 handlers)
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts`
- `libs/backend-common/src/utils/pii-mask.util.ts` (extend with `maskTenantId` for log paths)
- new `parseTenantId` factory in `libs/event-contracts/src` or `libs/backend-common/src/utils`

**Expected closer**
- billing-expert WRITER mode (primary owner) + security-reviewer CATCHER on the rewrite.

---

#### SECREV-CRITICAL-002 — billing-service missing StripInternalHeadersMiddleware (extends SEC-CRITICAL-002)

**Severity:** CRITICAL
**Layer:** 3 (ADR) — defense-in-depth at trust boundary 3→4 (Apollo Router → subgraph)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/app.module.ts:240-249` — `configure(consumer)` applies only `UserContextMiddleware, TenantContextMiddleware`. No `StripInternalHeadersMiddleware`.
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:58` — `@Controller('webhooks')` is a REST endpoint (NOT GraphQL); the global `ServiceIdentityGuard` registered as `APP_GUARD` only enforces on `contextType === 'graphql'` (`libs/backend-common/src/guards/service-identity.guard.ts:55-57`). REST routes bypass the guard entirely.
- `apps/billing-service/src/billing/billing.resolver.ts` and other resolvers consume `req.headers['x-user-payload']` via `UserContextMiddleware` (which trusts it whenever any caller — including a malicious external client that reaches the billing-service port directly — sends it).
- The auth-security-expert raised `SEC-CRITICAL-002` for auth-service. This is the SAME defect class on a SECOND service. SYS-1 candidate (3+ occurrences = SYSTEMIC per agent contract).

**Rule violated**
- ADR-008 (defense in depth — guard strategy).
- ADR-002 (gateway is sole internet-reachable backend — internal services verify inbound HMAC). Inbound verification only runs on GraphQL; REST is unverified.
- CLAUDE.md "Tenant-ID sourcing" — `x-user-payload` is privileged and must be stripped before user-context middleware runs.

**Proposed fix direction**
- Tier-2: every service's `bootstrapService(...)` factory MUST include `StripInternalHeadersMiddleware` in `earlyMiddleware`. Make it default-on and require explicit opt-out (none should opt out).
- Tier-3: `tests/invariants/strip-headers-adoption.spec.ts` — assert every service AppModule (or bootstrap) wires the middleware. Fails CI on omission.
- Same fix simultaneously for auth-service (SEC-CRITICAL-002), billing-service (this finding), and audit every other service in scope.

**Affected surface (ripple set)**
- `libs/backend-common/src/bootstrap/create-service-app.ts` — add as earlyMiddleware default
- `apps/{auth,billing,…}-service/src/app.module.ts` — verify register
- `tests/invariants/` — add adoption invariant
- `apps/billing-service/src/main.ts` (rawBody: true is required for Stripe — middleware ordering must respect that)

**Expected closer**
- platform-kernel-expert WRITER (bootstrap factory) + auth-security-expert CATCHER + security-reviewer CATCHER.

---

#### SECREV-CRITICAL-003 — Gateway TenantIsolationGuard accepts query-param + body `tenantId` (confirms MT-CRITICAL-001)

**Severity:** CRITICAL
**Layer:** 2 (pattern) — JWT is trust anchor on authenticated paths
**State:** OPEN — 3rd cycle (per multi-tenant-saas-expert), now independently confirmed by security-reviewer

**Evidence**
- `apps/gateway-api/src/guards/tenant-isolation.guard.ts:166-201` — extracts `tenantId` from header, URL param, query param, AND body. Each fallback rebuilds the cross-tenant attack surface.
- `:181-184` — `request.query?.['tenantId']` accepted directly, validated only as UUID format.
- `:188-200` — body `tenantId` AND GraphQL variables `tenantId` accepted.
- The JWT-claim `userTenantId` (line 102) is then compared (`requestedTenantId !== userTenantId`) against this attacker-supplied input via `hasCrossTenantAccess`. For `super_admin` and `platform_admin` roles, ANY attacker-supplied tenantId is accepted; for normal users, the value-mismatch raises ForbiddenException, but the surface still exists for log-poisoning, key-collision, and the `accessibleTenants`/`managedTenants` partner-role bypass paths (lines 252-258).

**Rule violated**
- CLAUDE.md "Tenant-ID sourcing" — JWT claims are trust anchor on authenticated paths; `x-tenant-id` header accepted only on explicit pre-auth/cross-tenant-admin/edge-device paths. Query-param and body-tenantId are NOT sanctioned sources.
- ADR-008 (defense-in-depth) — collapses tenant trust anchor.
- ASVS V8.2 (object-level access control) + multi-tenant-saas-expert primary ownership.

**Proposed fix direction**
- Tier-1: remove the query-param + body `tenantId` extraction paths entirely. JWT-claim `tenantId` is the only authoritative source for authenticated requests; header `x-tenant-id` is accepted only on the explicit pre-auth allowlist (already enforced in `TenantContextMiddleware`).
- Tier-3: add a CI invariant test that scans guards for `query?.['tenantId']` / `body?.['tenantId']` / `body?.variables?.['tenantId']` patterns and fails build.
- `super_admin` / `platform_admin` cross-tenant access path: separate dedicated `X-Act-As-Tenant` header gated by an `ImpersonationSession` token (per ADR-008 + impersonation pattern).

**Affected surface (ripple set)**
- `apps/gateway-api/src/guards/tenant-isolation.guard.ts`
- All callers depending on cross-tenant URLs/queries (admin-api, etc.) — must move to header-based impersonation
- `tests/invariants/` — new invariant test
- coordinate with multi-tenant-saas-expert (primary)

**Expected closer**
- multi-tenant-saas-expert WRITER (primary owner) + security-reviewer CATCHER + auth-security-expert CATCHER.

---

### HIGH

#### SECREV-HIGH-001 — auth-service rate-limit module is empty dead code

**Severity:** HIGH
**Layer:** 1 (tech) — file integrity / abandoned migration
**State:** OPEN

**Evidence**
- `apps/auth-service/src/rate-limit/rate-limiter.service.ts` — 0 bytes
- `apps/auth-service/src/rate-limit/throttle.decorator.ts` — 0 bytes
- No imports of these files anywhere in the service.

**Impact**
- Auth-service has NO per-service rate-limit. Login/refresh/reset/MFA-verify rate-limiting depends solely on the gateway's per-IP RateLimitGuard. Compounds `SEC-CRITICAL-003` (auth-security-expert: per-account vs per-IP discussion) — if gateway is ever bypassed (direct service-port reachability via Docker network or misconfigured ingress), there is zero rate-limit.
- Empty files indicate an aborted migration. CI/CD does not flag empty source files; this passed code review undetected. Review-discipline gap.

**Rule violated**
- ASVS V11.1 (rate-limit on authentication endpoints) — defense in depth.
- ADR-008 (defense in depth — gateway-only defense fails on bypass).

**Proposed fix direction**
- Either implement the per-service rate-limiter (preferred — closes the architectural gap) OR delete the empty files and document the gateway-only posture in a tracked finding. Empty files masquerading as a feature are worse than an explicit absence.
- Implement per-account login/refresh/MFA rate-limit (Redis sliding window, NOT just per-IP).

**Affected surface (ripple set)**
- `apps/auth-service/src/rate-limit/` (delete or fill)
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts` (login/refresh consume the limiter)
- `apps/auth-service/src/modules/authentication/services/mfa.service.ts` (verifyMfaLogin)
- coordinate with auth-security-expert

**Expected closer**
- auth-security-expert WRITER + security-reviewer CATCHER.

---

#### SECREV-HIGH-002 — MfaService.verifyMfaLogin uses bare `jwtService.verify` (extends SEC-CRITICAL-004)

**Severity:** HIGH
**Layer:** 2 (pattern) — algorithm-confusion / claim enforcement at library level
**State:** OPEN — same defect class as SEC-CRITICAL-004 (auth-security-expert) on a different code path

**Evidence**
- `apps/auth-service/src/modules/authentication/services/mfa.service.ts:494` — `mfaPayload = this.jwtService.verify(mfaToken);` — no second argument. Algorithm, issuer, audience not enforced at jsonwebtoken library level; relies on the JwtModule's verifyOptions, but the dev-fallback path (`ALLOW_DEV_JWT_SECRET=true`) installs HS256 secrets, so a token signed with HS256 in dev would be accepted with no algorithm pinning at the call site.
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:850` — same defect at `validateToken`.

**Rule violated**
- RFC 8725 §3.1 — algorithm pinning at every verifier.
- Layer-1-nestjs.md JWT discipline — "Every guard MUST call `getJwtVerifyOptions(configService)`".
- The platform's own `getJwtVerifyOptions` exists specifically to prevent this defect; the docblock says "Forgetting to do so causes a compile-time type error" — but bare `jwtService.verify(token)` compiles fine. The Tier-1 promise is broken.

**Proposed fix direction**
- Tier-1 properly: a wrapper `platformVerify(jwt, configService)` that is the only verifier; the un-overridden `jwtService.verify` is banned by ESLint `no-restricted-syntax`.
- Or: extend `getJwtVerifyOptions` to a `PlatformJwtService` injected token; ban direct `JwtService.verify*` injection in security-sensitive code.

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/authentication/services/mfa.service.ts`
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts`
- `libs/backend-common/src/auth/jwt-verification.utils.ts`
- `.eslintrc.json` no-restricted-syntax addition

**Expected closer**
- auth-security-expert WRITER + security-reviewer CATCHER.

---

#### SECREV-HIGH-003 — Webhook signature failures emit no security alert (confirms BILLING-HIGH-004)

**Severity:** HIGH
**Layer:** 3 (ADR) — observability of security events
**State:** OPEN — confirms billing-expert finding

**Evidence**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:111-116` — verification failure only logs `this.logger.warn(...)`. No SecurityEventService publish, no NATS event, no Prometheus counter.
- The platform has `libs/backend-common/src/security/security-event.service.ts` — used elsewhere (CSP report controller, ServiceIdentityGuard) but not here.

**Rule violated**
- ASVS V14.5 (logging of security events with structured semantics).
- OWASP A09 Logging & Monitoring Failures.

**Proposed fix direction**
- Inject `SecurityEventService` + emit a `WebhookSignatureRejected` event on every verification failure.
- Add Prometheus counter `webhook_signature_failures_total{provider="stripe"}` for ratio-based alerting.

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts`
- `libs/backend-common/src/security/security-event.service.ts` (extend types if needed)

**Expected closer**
- billing-expert WRITER + security-reviewer CATCHER.

---

#### SECREV-HIGH-004 — auth-service AppModule retains HS256 dev-fallback path

**Severity:** HIGH
**Layer:** 3 (ADR-016 RS256 rollout — Phase B)
**State:** OPEN — known drift carried forward; not a regression but the closure date has passed

**Evidence**
- `apps/auth-service/src/app.module.ts:155-188` — when `JWT_PRIVATE_KEY/JWT_PUBLIC_KEY` are absent AND `ALLOW_DEV_JWT_SECRET=true`, a HS256 module config is registered. The implementation is gated on `nodeEnv !== 'production'` via `isProduction && (!privateKey || !publicKey)` throw earlier — but the gate is `NODE_ENV` only.
- `apps/gateway-api/src/app.module.ts:255-267` — gateway-api's parallel comment explicitly says "FOLLOW-UP (HIGH-001): docker-compose.dev.yml + docker-compose.yml + apps/gateway-api/test/header-propagation.e2e-spec.ts still reference ALLOW_DEV_JWT_SECRET / DEV_JWT_SECRET. They are now dead env vars for gateway-api but still consumed by auth-service's own dev fallback."
- The combination of HS256-dev-fallback in auth-service + bare `jwtService.verify` calls (SECREV-HIGH-002) means a misconfigured staging environment that sets `NODE_ENV=development` accidentally reactivates the algorithm-confusion attack surface.

**Rule violated**
- ADR-016 (RS256 Phase B) — auth-service is the SOLE issuer; HS256 must be eliminated platform-wide.
- Layer-1-nestjs.md JWT discipline — "HS256 in microservices = CRITICAL".

**Proposed fix direction**
- Remove the HS256 dev fallback entirely. Generate an RSA keypair via `scripts/generate-jwt-keys.sh` and require it in dev too (gateway-api already enforces this). Update dev-onboarding scripts.

**Affected surface (ripple set)**
- `apps/auth-service/src/app.module.ts`
- `docker-compose.dev.yml`, `docker-compose.yml`
- `scripts/generate-jwt-keys.sh` (verify exists / extend)
- `docs/runbooks/jwt-key-rotation.md` (if exists)

**Expected closer**
- auth-security-expert WRITER + security-reviewer CATCHER.

---

### MEDIUM

#### SECREV-MEDIUM-001 — CSRF middleware unconditionally exempts /graphql

**Severity:** MEDIUM
**Layer:** 3 (ADR) — defense in depth
**State:** OPEN

**Evidence**
- `apps/gateway-api/src/middleware/csrf.middleware.ts:30` — `CSRF_EXEMPT_PATHS = new Set(['/', '/graphql', '/health', ...])`.
- Documented rationale (lines 24-26): "GraphQL: Already protected against CSRF by requiring Content-Type: application/json".
- Apollo Server v4 default-on `csrfPrevention` does enforce a preflight-forcing header (`apollo-require-preflight` or `x-apollo-operation-name`/`content-type`). But this is NOT explicitly configured anywhere — relying on framework default-on is fine but should be asserted in tests; the current double-submit-cookie defense is intentionally disabled and the layered backup goes away.

**Rule violated**
- ADR-008 (defense in depth) — single-layer protection.

**Proposed fix direction**
- Either: explicitly configure Apollo's `csrfPrevention: true` in the gateway GraphQL config + document the protection in a test (`tests/integration/graphql-csrf.spec.ts`).
- Or: extend CsrfMiddleware to enforce the same double-submit on `/graphql` mutations (more restrictive — matches Stripe-grade discipline).

**Affected surface (ripple set)**
- `apps/gateway-api/src/app.module.ts` GraphQL config
- `apps/gateway-api/src/middleware/csrf.middleware.ts`
- `apps/gateway-api/test/graphql-csrf.e2e-spec.ts` (new)

**Expected closer**
- auth-security-expert TEACHER → implementation-planner.

---

#### SECREV-MEDIUM-002 — CspReportController exists but is not wired into AppModule

**Severity:** MEDIUM
**Layer:** 1 (tech) — dead code with security implications
**State:** OPEN

**Evidence**
- `apps/gateway-api/src/csp-report/csp-report.controller.ts:44-46` — declared with `@Controller('api')` and `@Public()`.
- `apps/gateway-api/src/csp-report/csp-report.module.ts` exists.
- `apps/gateway-api/src/app.module.ts` — no `CspReportModule` in imports (verified via grep — zero matches in app.module.ts).
- Result: CSP `report-uri` would 404. Browser CSP violation reports are dropped silently.

**Rule violated**
- ASVS V14.5 (logging) — security telemetry visibility.
- Cleanliness — dead code accumulates.

**Proposed fix direction**
- Either register `CspReportModule` in `AppModule.imports` AND configure `report-uri /api/csp-report` (or `report-to` directive) in the CSP header.
- Or: delete the controller + module if CSP reporting is intentionally going elsewhere (Sentry, logger pipeline, …).

**Affected surface (ripple set)**
- `apps/gateway-api/src/app.module.ts`
- `apps/gateway-api/src/middleware/security-headers.middleware.ts` (CSP construction)
- nginx CSP template (if applicable)

**Expected closer**
- platform-kernel-expert (boundary owner).

---

#### SECREV-MEDIUM-003 — Refresh-token cookie uses `sameSite: 'lax'` instead of `'strict'`

**Severity:** MEDIUM
**Layer:** 3 (ADR) — defense in depth, OAuth tradeoff
**State:** OPEN

**Evidence**
- `apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts:60-67` — `setRefreshTokenCookie` uses `sameSite: 'lax'`.
- Same in `mfa.resolver.ts:46-51`, `webauthn.resolver.ts:46-51`.
- No `__Host-` prefix on cookie name (`refresh_token` not `__Host-refresh_token`).

**Rule violated**
- ASVS V3.4.3 (SameSite=Strict on session cookies for non-OAuth flows).
- OWASP A07 (auth failures — strong cookie flags).

**Proposed fix direction**
- Switch to `sameSite: 'strict'` unless an OAuth redirect flow is required. The platform doesn't appear to use OAuth (no provider fields in code grep) — `'lax'` is over-permissive.
- Add `__Host-` prefix (requires `secure: true`, `path: '/'`, no `domain`).

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts`
- `apps/auth-service/src/modules/authentication/resolvers/mfa.resolver.ts`
- `apps/auth-service/src/modules/authentication/resolvers/webauthn.resolver.ts`
- frontend cookie reader (verifies `__Host-refresh_token` is forwarded by gateway)

**Expected closer**
- auth-security-expert WRITER.

---

#### SECREV-MEDIUM-004 — login resolver uses raw `x-forwarded-for` regardless of trust-proxy

**Severity:** MEDIUM
**Layer:** 2 (pattern) — IP attribution integrity
**State:** OPEN

**Evidence**
- `apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts:120-121` — `const forwarded = request.headers['x-forwarded-for']; const ipAddress = request.ip || (Array.isArray(forwarded) ? forwarded[0] : forwarded);`
- The fallback parses `x-forwarded-for` directly even if Express `trust proxy` is `false` (default in `libs/backend-common/src/bootstrap/create-service-app.ts:265`).
- In dev/CI without nginx in front, an attacker can send arbitrary `X-Forwarded-For: <victim-ip>` and that IP is logged + stored in `auth.refresh_tokens.ipAddress` and audit logs — log poisoning + audit-log misattribution.

**Rule violated**
- Layer-1-nestjs.md IP-extraction discipline (only trust forwarded headers when proxy is configured).
- ASVS V14.5 (audit trail integrity).

**Proposed fix direction**
- Use `request.ip` only — same pattern as `gateway-api/src/guards/rate-limit.guard.ts:412-417` already uses with IP-format validation.
- Set `TRUST_PROXY=1` (or appropriate hop count) in production env explicitly — not the default.

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts` (login + refresh paths)
- `libs/backend-common/src/bootstrap/create-service-app.ts` (default value)
- `docker-compose.droplet.yml` (set TRUST_PROXY=1)

**Expected closer**
- auth-security-expert WRITER.

---

#### SECREV-MEDIUM-005 — RequestValidatorMiddleware applied only to /upload + /api/v2; GraphQL body unvalidated for SQL/XSS/path-traversal patterns

**Severity:** MEDIUM
**Layer:** 3 (ADR) — defense in depth
**State:** OPEN

**Evidence**
- `apps/gateway-api/src/app.module.ts:686-688` — `consumer.apply(RequestValidatorMiddleware).forRoutes('upload', 'upload/{*path}', 'api/v2/{*path}');` — GraphQL `/graphql` not included.
- The middleware comment (line 681) says "Applied only to REST routes (upload endpoints, v2 API proxy routes) because GraphQL requests are already validated by Apollo Server's query parser, and applying request-body sanitization to GraphQL would corrupt query strings."
- Acceptable rationale, but variables JSON in GraphQL bodies bypasses the DoS-protection (max body size, max query params, max object depth checks). Apollo's depthLimit catches query depth, not variables-payload depth.

**Rule violated**
- ASVS V11 (DoS protection at API gateway).

**Proposed fix direction**
- Apply a TARGETED middleware to GraphQL: max body size + max object depth on `variables` ONLY (not on the query string).
- Tier-1 alternative: `Content-Length` header check at nginx ingress.

**Affected surface (ripple set)**
- `apps/gateway-api/src/middleware/request-validator.middleware.ts`
- `apps/gateway-api/src/app.module.ts`

**Expected closer**
- platform-kernel-expert TEACHER.

---

#### SECREV-MEDIUM-006 — RemoteGraphQLDataSource forwards `x-user-payload` JSON containing JWT payload to subgraphs as user-controlled-shape header

**Severity:** MEDIUM
**Layer:** 2 (pattern) — header surface area
**State:** OPEN

**Evidence**
- `apps/gateway-api/src/app.module.ts:194-200` — `httpRequest.headers.set('x-user-payload', JSON.stringify(user))` where `user` is the verified JWT payload.
- Subgraphs trust this header (via `UserContextMiddleware`) when StripInternalHeadersMiddleware does not run (SECREV-CRITICAL-002). Per current implementation (auth-service has no Strip middleware), the gateway HMAC-signs the request — so any forgery would be caught at ServiceIdentityGuard for GraphQL.
- BUT: the JSON contains the full JWT payload (incl. `roles[]`, `modules[]`, `resourcePermissions[]`). Any logging of headers (e.g., debug-mode http logger, error stacks, NewRelic / Sentry / similar) leaks the entire RBAC matrix into the error tracker. PII risk + permission-disclosure risk.
- The header is also unbounded in size — modules + resourcePermissions for a SUPER_ADMIN can grow.

**Rule violated**
- ASVS V14.5 PII in logs.
- Layer-1-nestjs.md StructuredLoggerService PII masking (header logging would bypass it).

**Proposed fix direction**
- Replace `x-user-payload` JSON with a minimal `x-user-id`/`x-user-roles` set (already passed at line 196-197). Subgraphs that need richer claims should accept the full JWT in `authorization` header (already forwarded line 132-135) and re-verify locally via the platform JWKS.
- Or: encrypt + sign the user payload header (HMAC-AES256-GCM) so logging tools see ciphertext.

**Affected surface (ripple set)**
- `apps/gateway-api/src/app.module.ts` (AuthenticatedDataSource.willSendRequest)
- `libs/backend-common/src/middleware/UserContextMiddleware`
- All subgraph resolvers using `@CurrentUser()` decorator

**Expected closer**
- platform-kernel-expert WRITER.

---

### LOW

#### SECREV-LOW-001 — `RateLimitGuard` constructs key from `request.url` (substring-match) — potential collision

**Severity:** LOW
**Layer:** 1 (tech)
**State:** OPEN

**Evidence**
- `apps/gateway-api/src/guards/rate-limit.guard.ts:370-378` — endpoint prefix derived via `url.endsWith('/auth/login')` / `url.includes('/upload')`. A path like `/api/auth/login/foo` (404) still matches the login bucket; a request to `/api/v2/wrap/upload-something` (no auth-related) gets the upload limit.
- Side effect: an attacker can trigger lockout for legitimate uploaders by sending requests with `/upload` in the path even on non-upload endpoints.

**Proposed fix direction**
- Use exact-match per route or NestJS handler decorator-based metadata (`@RateLimit({...})`) rather than path-string matching.

**Expected closer**
- platform-kernel-expert TEACHER.

---

#### SECREV-LOW-002 — `SecurityHeadersMiddleware.buildDefaultCsp` sets `'unsafe-inline'` on `style-src` even in production

**Severity:** LOW
**Layer:** 4 (doc) — known accepted CSP weakness
**State:** OPEN

**Evidence**
- `apps/gateway-api/src/middleware/security-headers.middleware.ts:106` — `"style-src 'self' 'unsafe-inline'"` in production CSP.
- Comment line says inline styles "may be needed for rendering" — common but not architectural; tier-2 nonce-based CSP is the modern best practice.

**Proposed fix direction**
- Generate per-request nonces; switch to `style-src 'self' 'nonce-${nonce}'`.
- Or: audit what produces inline styles and refactor to external stylesheets.

**Expected closer**
- frontend-expert TEACHER (CSS architecture decision).

---

## Pattern usage table — N/A (CATCHER review)

## Cross-domain dependencies flagged

- **SECREV-CRITICAL-001** (Stripe webhook UUID validation) → recommend invoking **billing-expert** for the schema/handler rewrite; this finding extends BILLING-CRITICAL-001/002 territory.
- **SECREV-CRITICAL-002** (StripInternalHeadersMiddleware adoption) → recommend **platform-kernel-expert** as primary for the bootstrap factory change; pairs with **auth-security-expert**'s SEC-CRITICAL-002 closure on auth-service.
- **SECREV-CRITICAL-003** (TenantIsolationGuard query/body tenantId) → confirms **MT-CRITICAL-001**; **multi-tenant-saas-expert** is primary owner. Their finding still OPEN after 3 cycles — escalation candidate.
- **SECREV-HIGH-002** (bare jwtService.verify) → confirms class of **SEC-CRITICAL-004**; **auth-security-expert** primary.
- **SECREV-HIGH-003** (webhook signature alert) → confirms **BILLING-HIGH-004**; **billing-expert** primary.
- **SECREV-MEDIUM-006** (x-user-payload JSON header) → would benefit from **platform-kernel-expert** (header design) + **auth-security-expert** (claims strategy) + **architectural-arbiter** if the local-rehydration vs gateway-payload decision is contested.

## Contradictions with sibling findings

None. All confirmed findings align with sibling reports. The only nuance is that **SECREV-CRITICAL-002** broadens the scope of the existing SEC-CRITICAL-002 (auth-security-expert) — auth-security-expert raised it for auth-service, security-reviewer confirms it on billing-service AND raises the systemic invariant.

## Verification

- Reviewed: 25+ files across gateway-api, auth-service, billing-service, backend-common.
- ASVS chapters touched: V2, V4, V8, V9, V11, V14, V16.
- STRIDE per DFD element: applied to trust boundaries 2 (nginx→gateway), 3 (gateway→subgraph), 4 (subgraph→service), 5 (service→Postgres/Redis/NATS), and the external Stripe webhook trust boundary.
- DoS exhaust resource: per-IP login rate-limit at gateway is the first chokepoint (RateLimitGuard incrementOrCreate; in-memory fallback sets bound at process memory).

## Verdict

**BLOCK** — three new CRITICAL findings (SECREV-CRITICAL-001/002/003), four open HIGH findings (SECREV-HIGH-001-004), six MEDIUM, two LOW. CRITICAL-001 is a NEW finding (not previously raised). CRITICAL-002 systematically broadens auth-security-expert's CRITICAL-002. CRITICAL-003 is a 3rd-cycle confirmation of MT-CRITICAL-001 and triggers SYSTEMIC escalation per agent contract.

Per security-reviewer override rule: ANY CRITICAL = unconditional platform BLOCK. No exceptions.

## References

- `.claude/agents/security-reviewer.md` (operating spec)
- `.claude/knowledge/layer-1-{core,nestjs,typeorm}.md`
- `.claude/knowledge/layer-2-patterns.md`
- `.claude/knowledge/layer-3-adrs.md` — ADR-002, ADR-008, ADR-016 are load-bearing
- CLAUDE.md — Tenant-ID sourcing, banned phrases, finding-ID format
- Prior security review: `docs/reviews/security-reviewer/2026-04-10-full-repo-audit.md` (CRITICAL-001 RS256 — resolved; CRITICAL-002 PII on event bus — resolved; HIGH-003 supply chain — partial)
- Sibling findings honoured: SEC-CRITICAL-001/002/003/004, BILLING-CRITICAL-001/002/003, BILLING-HIGH-001/004, PLAT-CRITICAL-001/002, DBR-CRITICAL-001/002, MT-CRITICAL-001/004/005, DATA-CRITICAL-001/002/003.
