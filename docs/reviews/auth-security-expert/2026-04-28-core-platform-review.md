# auth-security-expert — review (CATCHER) — 2026-04-28-core-platform

## Scope

Full audit of the core/cross-cutting authentication, authorization, tenant-context, and inter-service trust surface on `main` (commit `a958dc66`). Files reviewed:

- `apps/auth-service/src/**` (authentication, MFA, WebAuthn, tenant provisioning, GDPR, audit, rate-limit, app.module)
- `apps/gateway-api/src/**` (auth.guard, JWT middleware, strip-internal-headers, rate-limit guards, MutationRateLimitGuard, opa, app.module)
- `apps/billing-service/src/**` (Stripe webhook signature verification, controllers)
- `libs/backend-common/src/auth/**`, `guards/**`, `middleware/**`, `security/**`, `audit/**`, `redis/**`, `utils/service-identity.util.ts`

Domain modules (farm, hr, sensor, messaging, alert-engine) intentionally excluded per the request scope.

## Executive summary

The auth surface has shipped substantial hardening (RS256 cutover, peppered bcrypt, AES-256-GCM TOTP secrets, alias-limit plugin, gateway StripInternalHeaders, MFA step-up for cross-tenant). However, **multiple high-impact invariants from this agent's contract are still violated**:

1. **HMAC canonical input is incomplete** — `${timestamp}:${serviceName}:${tenantId}` is signed; `method+path+bodyHash` are NOT bound, so cross-endpoint replay and body tampering are wide open (SEC-HIGH-002/003 still OPEN, supersedes prior cycle).
2. **Login rate-limit key is per-IP only** — no `(ip + username)` composite, botnet credential-stuffing window. Per-username account lockout exists in DB layer but is not coordinated with the IP bucket; the gateway never reads the email out of the GraphQL body.
3. **Two `jwtService.verify*()` callsites in auth-service do not pass `algorithms`/`issuer`/`audience`** — the global `JwtModule` carries `verifyOptions: { algorithms: ['RS256'] }`, so `alg:none` is blocked, but `iss`/`aud` are silently optional and Token-Type discriminator (purpose check) runs *after* signature verification with no algorithm pin per call.
4. **Refresh token bcrypt input exceeds 72 bytes** (128 hex chars) — bcrypt silently truncates. No HMAC-SHA-256 pre-hash. Effective entropy after truncation is still adequate, but the agent's invariant is violated and audit trail will surface this.
5. **TOTP one-time-use is not enforced** — `lastUsedTimeStep` is not tracked. A captured 6-digit code can be replayed within the 30 s window for both login MFA and step-up.
6. **Refresh token rotation has no reuse-detection / family invalidation** — presenting a revoked refresh token returns a generic 401 but does NOT invalidate the entire token family. RFC 6749 §10.4 / OAuth 2 BCP best practice missed.
7. **`auth-service` has no `StripInternalHeadersMiddleware`** — `x-user-payload`, `x-user-id`, `x-user-roles` are accepted from any caller because auth-service relies on the gateway being the only ingress, but the federated subgraph endpoint is reachable on the docker network. `ServiceIdentityGuard` runs only on GraphQL contexts, not on REST endpoints (e.g. JWKS).
8. **`x-act-as-tenant` header is not in the strip list at the gateway**, so forwarding policy depends entirely on the JWT-SUPER_ADMIN check at TenantGuard. A leaked SUPER_ADMIN access token can pivot tenants without re-MFA *if* `MFA_REQUIRED_FOR_CROSS_TENANT` is overridden.
9. **OPA policy enforcer is dead code** (SEC-HIGH-004 carry-forward) — no resolver/handler calls `PolicyEnforcerService.isAuthorized`. W4 decision still pending.
10. **`MutationRateLimitGuard` is in-memory only** — no Redis fallback; multi-pod deployments multiply the bucket by replica count and lose the limit on rolling restart.

Verdict: **BLOCK** for production until at least SEC-CRITICAL-001..003 close (HMAC canonical input, missing strip middleware in auth-service, login rate-limit composite key). HIGH/MEDIUM findings track separately.

## Findings (by severity)

### CRITICAL

### SEC-CRITICAL-001 — HMAC canonical input omits method, path, bodyHash; cross-endpoint replay + body tampering possible

**Severity:** CRITICAL
**Layer:** 2 (pattern) — service-to-service trust contract
**State:** OPEN (carry-forward of SEC-HIGH-002/003 — escalated +1 because still unfixed; ADR-002 + agent contract explicitly require canonical input)

**Evidence**
- `libs/backend-common/src/utils/service-identity.util.ts:53-55` — `createHmac('sha256', secret).update(\`${timestamp}:${serviceName}:${tenantId}\`)`
- `libs/backend-common/src/utils/service-identity.util.ts:103-105` — verifier signs the same 3-field string
- `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts:71-74` — strip middleware verifies `HMAC(secret, identity)` *only*, not even with timestamp; this fails-open (returns false → strips headers safely) but offers no positive identity guarantee
- `apps/gateway-api/src/app.module.ts:206-217` — `AuthenticatedDataSource.willSendRequest` calls `generateServiceIdentityHeaders('gateway-api', secret, signedTenantId)` with only 3 fields

**Rule violated**
Agent contract — "Canonical signing input is **exactly**: `${serviceIdentity}|${timestamp}|${method}|${path}|${bodyHash}|${tenantId}`. Omitting any field is CRITICAL — missing `method+path` allows cross-endpoint replay; missing `bodyHash` allows body tampering with valid signature." (auth-security-expert.md:84-89)

**Proposed fix direction**
- Tier-1: change `generateServiceIdentityHeaders`/`verifyServiceIdentity` signatures to require `(method, path, bodyHash)` arguments — TS rejects every existing callsite at compile time. Update gateway `AuthenticatedDataSource.willSendRequest` to compute `crypto.createHash('sha256').update(serializedBody).digest('hex')`. Subgraph guard recomputes the same and `timingSafeEqual`s.
- Tier-3 follow-on: invariant test asserting signing/verification share an identical canonical-input formatter (one helper, both sides import it).
- `StripInternalHeadersMiddleware.isValidInternalRequest` MUST also validate `timestamp` freshness *and* the full canonical input, not just `HMAC(secret, identity)`. The current check is bypassable with any valid `(identity, signature)` pair seen on the wire.

**Affected surface (ripple set)**
- `libs/backend-common/src/utils/service-identity.util.ts` (signing + verifying)
- `apps/gateway-api/src/app.module.ts` (gateway → subgraph signer)
- `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts` (gateway-side incoming verifier)
- `libs/backend-common/src/guards/service-identity.guard.ts` (subgraph-side verifier; line 115 currently only passes `tenantHeader`)
- Every backend service registering `ServiceIdentityGuard` (12+) — they pick up the change via the import.
- `e2e/tests/integration/service-identity.spec.ts` (new — replay + body-tamper test cases)

**Expected closer**
auth-security-expert WRITER mode (no skill yet) + ripple-tracer notification to all services consuming `verifyServiceIdentity`.

---

### SEC-CRITICAL-002 — auth-service has NO StripInternalHeadersMiddleware; forged x-user-payload accepted on every endpoint

**Severity:** CRITICAL
**Layer:** 2 (pattern) — pipeline trust anchor
**State:** OPEN (new this cycle)

**Evidence**
- `apps/auth-service/src/app.module.ts:330-342` — middleware order is `MetricsMiddleware, CorrelationIdMiddleware, RequestContextMiddleware, UserContextMiddleware, TenantContextMiddleware, RequestLoggingMiddleware`. **No StripInternalHeaders.**
- `libs/backend-common/src/middleware/tenant-context.middleware.ts:54-67` — `UserContextMiddleware` parses `x-user-payload` JSON unconditionally and assigns `req.user = user`.
- `libs/backend-common/src/guards/service-identity.guard.ts:50-54` — `ServiceIdentityGuard` only fires on GraphQL context; HTTP routes (`/health`, `/metrics`, JWKS endpoint at `apps/auth-service/src/modules/authentication/jwks.controller.ts`) are NOT protected.
- `apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.ts:56-63` — when `Authorization: Bearer …` is missing, the guard throws *unless* the route is `@Public()`. But `req.user` was already populated by `UserContextMiddleware` from `x-user-payload`, and resolvers using `@CurrentUser()` decorator read from `req.user` directly without re-validating signature.

A network attacker with Docker-network access (or any compromised co-tenant container) can issue a request with `x-user-payload: {"sub":"...","role":"SUPER_ADMIN","tenantId":null}` to a `@Public()` or `@SkipTenantGuard` route on auth-service and the resolver-layer `@CurrentUser()` reads it as authentic.

**Rule violated**
Agent contract — "StripInternalHeadersMiddleware MUST be pipeline position #1 on every public-facing app; misorder lets an attacker spoof `x-user-payload: {"role":"SUPER_ADMIN"}` = platform compromise." (auth-security-expert.md:78)

**Proposed fix direction**
- Tier-2 (automatic): export `StripInternalHeadersMiddleware` from `@aquaculture/backend-common/middleware`, mandate it as the FIRST middleware in every service's `app.module.ts`. Add CI invariant test that walks every `app.module.ts`'s `configure(consumer)` block and asserts `StripInternalHeadersMiddleware` is the first applied middleware.
- Tier-1 alt: replace the two-stage `UserContext + JwtMiddleware` with a single middleware that ALWAYS clears `req.user` first, then re-derives it from a verified JWT.
- Bonus: add `req.user` re-set to `undefined` at the top of every middleware that examines `x-user-payload` so a service identity bypass cannot survive a misorder.

**Affected surface (ripple set)**
- `libs/backend-common/src/middleware/index.ts` (export)
- `apps/auth-service/src/app.module.ts` and ALL services missing the middleware (audit `farm-service`, `hr-service`, `sensor-service`, `messaging-service`, `hydroponics-service`, `alert-engine`, `billing-service`, `notification-service`, `admin-api-service`, `ai-service`, `config-service`, `event-store-service`, `observability-service`)
- `e2e/tests/integration/middleware-order-invariants.spec.ts` (new)

**Expected closer**
auth-security-expert WRITER + multi-tenant-saas-expert co-review. Also handoffs to every domain expert via ripple-set.

---

### SEC-CRITICAL-003 — Login rate limit is per-IP only; no (ip + username) composite — botnet credential stuffing succeeds

**Severity:** CRITICAL
**Layer:** 2 (pattern) — fail-closed rate limiter discipline
**State:** OPEN (new this cycle)

**Evidence**
- `apps/gateway-api/src/guards/rate-limit.guard.ts:362-388` — `generateKey()` builds `ratelimit:login:ip:${ip}` for unauthenticated login. No body inspection; the resolver receives the email AFTER the guard runs.
- `apps/gateway-api/src/guards/rate-limit.guard.ts:467-477` — login limit is 5/15 min per the IP-only key.
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:937-971` — per-username DB-side lockout exists (`failedLoginAttempts` column) and triggers after 5 misses in 30 min. Independent counter, no coordination with IP bucket.
- No path that extracts `email` from the GraphQL request body for rate-limit key composition.

A 1000-IP botnet can each try 5 logins/15 min = 5 000 attempts at a SINGLE high-value username before the per-username DB lockout fires (which it does — but at the cost of legitimate-user DoS unless the IP-side bucket also catches the spread).

**Rule violated**
Agent contract — "Login key composite `(ip + username)` — per-IP-only = botnet bypass, per-username-only = legitimate-user DoS. Both are CRITICAL." (auth-security-expert.md:97)

**Proposed fix direction**
- Tier-2: add a `BodyAwareRateLimitGuard` that runs AFTER GraphQL parsing for the `login` and `verifyMfaLogin` mutations specifically. Compose the key as `ratelimit:login:ip:${ip}:user:${sha256(emailLowercase)}`.
- Two atomic Redis Lua INCRs per attempt: one keyed on (ip), one on (ip + user-hash). Trip if either threshold exceeded.
- Keep the DB-side per-username counter independently as defense-in-depth.

**Affected surface (ripple set)**
- `apps/gateway-api/src/guards/rate-limit.guard.ts` (new key composer)
- `apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts` (annotate login/verifyMfa with composite-key meta)
- `apps/gateway-api/src/plugins/graphql-alias-limit.plugin.ts` (already protects against alias amplification — confirm)
- `e2e/tests/integration/rate-limit-composite-key.spec.ts` (new)

**Expected closer**
auth-security-expert WRITER + skill `add-composite-rate-limit-key`.

---

### SEC-CRITICAL-004 — `jwtService.verify()` in MFA flow does not pin `algorithms`; `verifyAsync()` in validateToken omits issuer/audience too

**Severity:** CRITICAL
**Layer:** 1 (tech) — JWT RFC 8725 §2.1
**State:** OPEN (new this cycle)

**Evidence**
- `apps/auth-service/src/modules/authentication/services/mfa.service.ts:494` — `mfaPayload = this.jwtService.verify(mfaToken)` — synchronous verify, no options object passed; relies entirely on `JwtModule` `verifyOptions` defaults.
- `apps/auth-service/src/app.module.ts:202-204` — JwtModule `verifyOptions` only sets `algorithms: ['RS256']`. `issuer` and `audience` are NOT in `verifyOptions` (they are only in `signOptions`). So `verify()` will accept a token with the right RSA key signature regardless of `iss`/`aud`.
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:850` — `validateToken()` uses `await this.jwtService.verifyAsync<JwtPayload>(token)` with no options either; same gap.

Compare to the centralized `getJwtVerifyOptions()` in `libs/backend-common/src/auth/jwt-verification.utils.ts:148-170` — gateway/auth-service guards use it correctly, but these two service-layer callsites bypass it.

**Rule violated**
Agent contract — "Every `verifyAsync()` / `verify()` passes `algorithms: ['RS256']` … `aud` and `iss` are validated on every verification (RFC 9068)" (auth-security-expert.md:60-64).

**Proposed fix direction**
- Tier-1: ESLint rule `no-bare-jwt-verify` that bans `JwtService.verify(...)` / `verifyAsync(...)` outside files that pass `getJwtVerifyOptions(configService)`. Pre-existing rule for `JWT_SECRET` reads exists at `.eslintrc.json:97-111`; extend pattern.
- Replace both call sites with `getJwtVerifyOptions(configService)` injection.
- Bonus: also re-issue the MFA token with explicit `audience: 'mfa-challenge'` (NOT the same audience as access tokens) so even with a future bug an MFA token cannot be verified as a bearer.

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/authentication/services/mfa.service.ts`
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts`
- `.eslintrc.json` (new rule)
- `apps/auth-service/src/modules/authentication/__tests__/mfa-token-audience.spec.ts` (new)

**Expected closer**
auth-security-expert WRITER mode.

---

### HIGH

### SEC-HIGH-001 — `req.query['tenantId']` fallback in TenantContextMiddleware is still present (SEC-CRITICAL-001 carry-forward, downgraded because pre-auth-only)

**Severity:** HIGH
**Layer:** 2 (pattern)
**State:** OPEN (carry-forward; layer-1-nestjs.md:32 expected W5 to remove it)

**Evidence**
- `libs/backend-common/src/middleware/tenant-context.middleware.ts:108-112` — query-string `tenantId` accepted as a tenant context source.

**Rule violated**
Agent contract + CLAUDE.md "Tenant-ID sourcing" — only JWT/`x-tenant-id` (and only on enumerated pre-auth/admin paths). Query-string tenant is unreviewed.

**Proposed fix direction**
- Tier-1: delete the `req.query['tenantId']` branch. Add unit test asserting query-string tenant is ignored.
- Audit any remaining caller relying on `?tenantId=` (likely none — the gateway forwards `x-tenant-id` from JWT only).

**Affected surface (ripple set)**
- `libs/backend-common/src/middleware/tenant-context.middleware.ts`
- `libs/backend-common/src/middleware/__tests__/tenant-context.spec.ts`

**Expected closer**
auth-security-expert WRITER (one-line change).

---

### SEC-HIGH-002 — Refresh-token bcrypt input exceeds 72 bytes; silent truncation, agent invariant violated

**Severity:** HIGH
**Layer:** 1 (tech)
**State:** OPEN (new this cycle)

**Evidence**
- `apps/auth-service/src/modules/authentication/services/token.service.ts:201` — `crypto.randomBytes(64).toString('hex')` produces 128 ASCII characters / 128 UTF-8 bytes.
- `apps/auth-service/src/modules/authentication/services/token.service.ts:211` — `bcrypt.hash(refreshTokenRandom, 12)`. bcryptjs (and node-bcrypt) silently truncate input to 72 bytes.

Effective uniqueness after truncation: ~36 bytes of randomness still survives, so collision is not a practical concern, but the agent contract explicitly requires HMAC-SHA-256 pre-hash for inputs > 72 bytes.

**Rule violated**
Agent contract — "Inputs > 72 bytes HMAC-SHA-256 pre-hashed to stay under bcrypt's input limit." (auth-security-expert.md:69)

**Proposed fix direction**
- Tier-2: write a `refreshTokenHash(plain)` helper in `libs/backend-common/src/auth` that pre-HMACs to a 32-byte digest then bcrypts. All call sites use the helper.
- Migration: bcrypt of HMAC(input) is a different stored value, so existing tokens are rotated naturally on next refresh; no DB migration needed (TTL is at most 30 days).

**Affected surface (ripple set)**
- `libs/backend-common/src/auth/index.ts` (export new helper)
- `apps/auth-service/src/modules/authentication/services/token.service.ts` (hash + verify both)
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:745` (verify path uses `bcrypt.compare(tokenPart, storedToken.token)` directly)

**Expected closer**
auth-security-expert WRITER.

---

### SEC-HIGH-003 — TOTP one-time-use not enforced; 6-digit code replayable for 30s window across login, step-up, disable

**Severity:** HIGH
**Layer:** 1 (tech)
**State:** OPEN (new this cycle)

**Evidence**
- `apps/auth-service/src/modules/authentication/services/mfa.service.ts:172-193` — `verifyTOTP()` accepts any matching window step; no `lastUsedTimeStep` field on User entity.
- `apps/auth-service/src/modules/authentication/entities/user.entity.ts:212-223` — `mfaFailedAttempts`, `mfaLockedUntil` exist; no `mfaLastUsedTimeStep` column.

An attacker who observes a TOTP code (shoulder-surf, malware, network MITM on a non-TLS hop, or the user pasting it into a phishing page) can replay the same code within the remaining 30 s window for `verifyMfaLogin`, `verifyStepUp`, `disableMfa`, or `regenerateRecoveryCodes`.

**Rule violated**
Agent contract — "One-time use: track `lastUsedTimeStep`, reject incoming `step ≤ stored`. Prevents OTP replay within the 30 s window." (auth-security-expert.md:108)

**Proposed fix direction**
- Tier-2: add `mfaLastUsedTimeStep BIGINT NULL` column on User. After successful TOTP verify, persist `floor(now/30) + matched_offset`. Reject any step `<=` stored.
- Recovery code consumption already deletes the hash → no-replay; preserve.

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/authentication/entities/user.entity.ts` (column)
- `apps/auth-service/src/database/migrations/*-AddMfaLastUsedTimeStep.ts` (new migration)
- `apps/auth-service/src/modules/authentication/services/mfa.service.ts` (4 verifyTOTP call sites + setup verify)
- Tests for replay

**Expected closer**
auth-security-expert WRITER + database-reviewer (migration shape).

---

### SEC-HIGH-004 — Refresh-token rotation has no reuse detection / family invalidation

**Severity:** HIGH
**Layer:** 2 (pattern) — OAuth 2 BCP §4.12
**State:** OPEN (new this cycle)

**Evidence**
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:646-783` — both refresh paths revoke the matched token and issue a new one. On presenting an already-revoked refresh token, line 753 throws `UnauthorizedException(GENERIC_AUTH_ERROR_MSG)` without further action.
- `apps/auth-service/src/modules/authentication/entities/refresh-token.entity.ts` (file inspected separately) — no `parentId` / `familyId` column tying rotated tokens to a lineage.

If an attacker steals a refresh token, the legitimate user's first post-theft refresh rotates them out — but the attacker's stolen refresh on the *previous* token still has 30-day validity until the user rotates again. Without family invalidation, the platform cannot detect "two parties holding tokens from the same lineage" and revoke proactively.

**Rule violated**
Agent contract — "Presenting an already-invalidated refresh token triggers full family/session invalidation AND emits `SecurityEvent` with actor + family-id." (auth-security-expert.md:71)

**Proposed fix direction**
- Tier-2: add `familyId UUID NOT NULL` and `parentTokenId UUID NULL` columns on `auth.refresh_tokens`. Issue families at first login; child tokens inherit `familyId`.
- On presenting a revoked refresh token: revoke ALL tokens with the same `familyId`, force `revokeAllForUser`, emit `SecurityEvent` `RefreshTokenReuseDetected` with hashed actor IP, user-agent, familyId.

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/authentication/entities/refresh-token.entity.ts`
- migration
- `apps/auth-service/src/modules/authentication/services/{authentication,token}.service.ts`
- `libs/event-contracts/src/security-events.ts` (new event contract)
- Tests

**Expected closer**
auth-security-expert WRITER + data-expert (event contract).

---

### SEC-HIGH-005 — `MutationRateLimitGuard` is in-memory only; multi-pod loses limit, restart wipes state

**Severity:** HIGH
**Layer:** 2 (pattern)
**State:** OPEN (new this cycle)

**Evidence**
- `apps/gateway-api/src/guards/mutation-rate-limit.guard.ts:33` — `private readonly entries = new Map<string, RateLimitEntry>()`.
- No Redis fallback, no `RateLimitStore` interface, registered as `useClass` (no factory) in `app.module.ts:606-608`.

Production deployment of gateway-api with N replicas allows N×30 mutations/min/key. Pod restart resets the bucket entirely. The neighbouring `RateLimitGuard` already has a Redis-backed store with fail-closed; mutation-side does not benefit.

**Rule violated**
Agent contract — "Atomic increment: Lua `INCR + PEXPIRE` or MULTI/EXEC. Non-atomic `GET → SET` has a race window… Fail-closed in production (CRITICAL): when Redis is unavailable, auth endpoints reject with 503." (auth-security-expert.md:99-100)

**Proposed fix direction**
- Tier-2: extract a `RateLimitStore` abstraction shared between `RateLimitGuard` and `MutationRateLimitGuard`. Both fail-closed on Redis outage in production.
- Or: delete `MutationRateLimitGuard` and rely on `RateLimitGuard` with per-mutation `@RateLimit()` annotations. The current setup duplicates concerns.

**Affected surface (ripple set)**
- `apps/gateway-api/src/guards/mutation-rate-limit.guard.ts`
- `apps/gateway-api/src/guards/rate-limit.guard.ts`
- `apps/gateway-api/src/app.module.ts`

**Expected closer**
auth-security-expert WRITER.

---

### SEC-HIGH-006 — OPA `PolicyEnforcerService` is unused dead stack; no resolver/handler invokes `isAuthorized()`

**Severity:** HIGH (carry-forward — was SEC-HIGH-004)
**Layer:** 3 (ADR-008 partial)
**State:** OPEN (W4 decision still pending; carried forward from cycle 2026-04-10)

**Evidence**
- `apps/gateway-api/src/opa/policy-enforcer.service.ts` exists with full evaluator + fallback logic.
- Repo-wide grep: `policyEnforcer.isAuthorized` has zero hits in production code (only spec files).
- `ai-safety` and other guard fragments do not chain through the enforcer.

ADR-008 defense-in-depth requires OPA at the policy tier. Either commit to wiring it system-wide (every mutation/query carries `@OpaPolicy(...)`) or remove the dead stack — leaving it half-implemented invites future bugs.

**Rule violated**
agent contract SEC-HIGH-004 + ADR-008.

**Proposed fix direction**
- Tier-4 (decision): architectural-arbiter ruling — adopt or remove. Once decided:
  - adopt → implementation-planner + skill `wire-opa-on-mutation` + per-domain CATCHER pass
  - remove → delete `apps/gateway-api/src/opa/**`, drop ADR-008 mention.

**Affected surface (ripple set)**
- `apps/gateway-api/src/opa/**`, every resolver in every subgraph (if adopt).

**Expected closer**
architectural-arbiter ruling first.

---

### SEC-HIGH-007 — `x-act-as-tenant` not in StripInternalHeaders strip list; leaked SUPER_ADMIN token can pivot with the right env override

**Severity:** HIGH
**Layer:** 2 (pattern)
**State:** OPEN (new this cycle)

**Evidence**
- `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts:21-26` — `INTERNAL_HEADERS_TO_STRIP = ['x-user-payload', 'x-user-id', 'x-user-roles', 'x-tenant-id']`. **Missing `x-act-as-tenant`.**
- `libs/backend-common/src/guards/tenant.guard.ts:332-335` — `extractActAsTenantHeader` reads the header if it's a string. Trust is enforced by `isSuperAdmin(user)` (line 139) plus optional MFA step-up (line 152-154) gated by `MFA_REQUIRED_FOR_CROSS_TENANT` env var (default `'true'`).

If `MFA_REQUIRED_FOR_CROSS_TENANT=false` is ever set in production (e.g. during MFA rollout) AND a SUPER_ADMIN access token leaks (browser sync, debug log), the attacker can pivot tenants without challenge. The strip list should defense-in-depth this header so external callers cannot forward it through any path.

**Rule violated**
Defense-in-depth principle on impersonation vectors; CLAUDE.md "Tenant-ID sourcing" — this is the *only* legitimate impersonation header and should be tightly controlled.

**Proposed fix direction**
- Tier-2: add `'x-act-as-tenant'` to `INTERNAL_HEADERS_TO_STRIP`. Internal services that need to forward it must include it in their HMAC canonical input (composes with SEC-CRITICAL-001).
- Tier-3: `MFA_REQUIRED_FOR_CROSS_TENANT` should be a hard-coded `true` in production (env-var override only allowed in non-prod).

**Affected surface (ripple set)**
- `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts`
- `libs/backend-common/src/guards/tenant.guard.ts:82-83`

**Expected closer**
auth-security-expert WRITER (one-line strip + env hardening).

---

### SEC-HIGH-008 — User PII (email, name) still optional in JWT payload; consumers can still rely on it

**Severity:** HIGH
**Layer:** 1 (tech)
**State:** OPEN (new this cycle)

**Evidence**
- `apps/auth-service/src/modules/authentication/services/token.service.ts:36-53` — `JwtPayload.email`, `firstName`, `lastName` are marked `@deprecated` but still present in the type. The active issuer (token.service:183-195) does NOT include them now, but consumers that `payload.email` will silently get `undefined` instead of a compile error.
- `libs/backend-common/src/middleware/tenant-context.middleware.ts:11-21` — `UserPayload.email: string` (NOT optional). Anything reading `req.user.email` will get `undefined` at runtime.

This is a soft-deprecation that loses the compile-time guarantee. If a consumer reads `payload.email` for an audit log, the audit silently logs `undefined`.

**Rule violated**
Agent contract — "JWTs MUST NOT carry PII (`email`, `firstName`, `lastName`, `phone`)." (auth-security-expert.md:66) — also tier-claim discipline: deprecation is Tier-4, the right fix is Tier-1 type removal.

**Proposed fix direction**
- Tier-1: delete the deprecated fields from `JwtPayload` and `UserPayload`. Audit/refactor every callsite reading `user.email` to fetch via NATS `auth.user.get`.
- Tier-3 follow: ESLint rule banning `payload.email`, `user.email` reads outside auth-service.

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/authentication/services/token.service.ts` (interface)
- `libs/backend-common/src/middleware/tenant-context.middleware.ts` (UserPayload)
- Every service reading `req.user.email` (likely 30+ callsites — needs ripple-tracer)
- `web/**` JWT decoding for display name (move to `me` query)

**Expected closer**
auth-security-expert TEACHER recommendation → implementation-planner for the cross-service ripple.

---

### MEDIUM

### SEC-MEDIUM-001 — Synchronous fire-and-forget audit log on critical events instead of `recordAwait`

**Severity:** MEDIUM
**Layer:** 2 (pattern)
**State:** OPEN

**Evidence**
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:103-137` — `logSecurityEvent` calls `this.auditLogService.log()` (different from `record/recordAwait`).
- `apps/auth-service/src/audit/audit-log.service.ts` — service shape differs from `libs/backend-common/src/audit/audit-log.service.ts`; uses `.log()` method (not the platform `record/recordAwait`).
- The auth-service's `AuditLogService.log()` awaits internally but is called inside a `try/catch` that swallows any throw with just a `logger.error`. If the DB write fails, the security event is lost silently.

**Rule violated**
Agent contract — "`recordAwait()` (guaranteed persistence — request blocks until row committed) for every SUPER_ADMIN action, cross-tenant access attempt … refresh-token reuse detection, bulk revocation. Fire-and-forget audit is FORBIDDEN on these events." (auth-security-expert.md:130)

**Proposed fix direction**
- Tier-2: converge `apps/auth-service/src/audit/audit-log.service.ts` onto the platform `IAuditLogService` interface. Use `recordAwait` for `LOGIN_BLOCKED_ACCOUNT_LOCKED`, `ACCOUNT_LOCKED`, `MFA_LOCKOUT`, password reset success, refresh reuse (when SEC-HIGH-004 lands).

**Affected surface**
- `apps/auth-service/src/audit/audit-log.service.ts`
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts`
- `apps/auth-service/src/modules/authentication/services/mfa.service.ts`

**Expected closer**
auth-security-expert WRITER.

---

### SEC-MEDIUM-002 — GDPR erasure email anonymization includes raw userId — predictable replacement

**Severity:** MEDIUM
**Layer:** 2 (pattern)
**State:** OPEN (new this cycle)

**Evidence**
- `apps/auth-service/src/privacy/gdpr-compliance.service.ts:99` — `email: \`deleted-${userId}@gdpr.local\``.

The email is anonymized but contains the still-present database userId, which is predictable and links back to the original record. Anonymization should use `crypto.randomUUID()` or `crypto.randomBytes(16).toString('hex')` so the replaced email cannot be cross-referenced. The `audit_logs.userId` is preserved for forensic audit per the policy — but the `email` column should not become a back-channel for the userId.

**Rule violated**
Agent contract — "Anonymization uses `crypto.randomBytes`/`randomUUID`. Predictable replacements (`user_${id}`) are CRITICAL." (auth-security-expert.md:124) — downgraded to MEDIUM here because `audit_logs.userId` is *intentionally* preserved per the same paragraph; the leakage path is narrower than the agent's worst-case framing.

**Proposed fix direction**
- Tier-1: replace with `email: \`deleted-${crypto.randomUUID()}@gdpr.local\`` and persist a mapping `(originalUserId, anonymizationId)` in a separate `gdpr_erasure_proof` table only readable by the platform GDPR officer role.
- Audit-log actor remains `DELETED_USER_<uuid>` per CLAUDE.md.

**Affected surface**
- `apps/auth-service/src/privacy/gdpr-compliance.service.ts`
- new migration if introducing the proof table
- `apps/auth-service/src/modules/authentication/services/webauthn.service.ts:removeAllCredentials` (already deletes; OK)

**Expected closer**
auth-security-expert WRITER + (new) skill `gdpr-erasure-anonymization`.

---

### SEC-MEDIUM-003 — Stripe webhook controller allows fall-through accept (HTTP 200 even on handler exception); intentional but masks operational failures

**Severity:** MEDIUM
**Layer:** 2 (pattern)
**State:** OPEN — design intent but worth a finding

**Evidence**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:159-174` — handler `try/catch` returns `200 received: true` even on processing errors. Comment says "always 200 to prevent retry storms".

This is a deliberate trade-off (Stripe will retry indefinitely on non-200 with exponential backoff and eventually disable the webhook), but means a billing-side bug is invisible to Stripe's monitoring. The mitigation should be alerting on the `routeEvent` exception log line — confirm a Prometheus counter increments + alert fires.

**Rule violated**
A09:2025 — security event logging requires alerting; the current pattern logs but does not increment a counter or emit a `SecurityEvent`.

**Proposed fix direction**
- Tier-3: Prometheus counter `billing_webhook_handler_failures_total{event_type}` incremented in the `catch`. Alert rule fires at >0/5min.
- Optionally: write a dead-letter queue row for failed events so the billing handler can re-process after a fix.

**Affected surface**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts`
- `apps/billing-service/src/billing/billing-metrics.module.ts` (if present)

**Expected closer**
platform-services CATCHER + auth-security-expert co-review.

---

### SEC-MEDIUM-004 — Tenant-status check at login does not include `PENDING` state; users on a PENDING tenant can authenticate

**Severity:** MEDIUM
**Layer:** 2 (pattern)
**State:** OPEN

**Evidence**
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:259-275` — only `SUSPENDED` and `CANCELLED` block login. PENDING (provisioning incomplete) does not.
- `apps/auth-service/src/modules/tenant/services/tenant.service.ts:172-208` — provisioning failures leave tenant in PENDING; tenant admins can be issued tokens before schema creation completes.

A PENDING tenant whose schema_creation failed but admin user was created (race or partial-failure path) lets the admin authenticate — and any subsequent `getScopedRepository()` call for tenant-scoped data hits an empty schema or fails at `TenantSchemaMiddleware:61` with "Tenant not provisioned". The auth gate should be aligned with the schema gate.

**Proposed fix direction**
- Tier-2: extend the login status check to also block `PENDING` tenants. If a tenant is intentionally in PENDING (mid-provisioning), the user should see a "Your tenant is being set up — please wait" message rather than auth tokens.

**Affected surface**
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:259-275`
- tests

**Expected closer**
auth-security-expert WRITER.

---

### SEC-MEDIUM-005 — `JwtAuthGuard` `enforceAccessTokenType` runs after blacklist check is skipped if `payload.iat` missing (legacy tokens)

**Severity:** MEDIUM
**Layer:** 1 (tech)
**State:** OPEN

**Evidence**
- `apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.ts:82-92` — composite blacklist check is gated on `payload.jti && payload.sub && payload.iat`. If any are missing (legacy or malformed token), the user blacklist check is silently skipped.
- `enforceAccessTokenType` (libs/backend-common/src/auth/jwt-verification.utils.ts:73-96) throws if `jti` missing in production — but only after the bypass branch runs.

Token without `iat` would still pass the `valid` check at line 89 because `isValidToken` is never called.

**Proposed fix direction**
- Tier-1: tighten the guard — if `iat` missing, reject in production (parallel to `jti` rule).

**Affected surface**
- `apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.ts`

**Expected closer**
auth-security-expert WRITER.

---

### SEC-MEDIUM-006 — Token blacklist `add()` has divergent signatures across implementations

**Severity:** MEDIUM
**Layer:** 1 (tech)
**State:** OPEN

**Evidence**
- `apps/gateway-api/src/guards/redis-token-blacklist.store.ts:13` — `add(jti, exp: number)` (Unix seconds, no reason)
- `libs/backend-common/src/security/token-blacklist/token-blacklist.service.ts:87` — `add(jti, expiresAt: Date, reason?: string)` (Date, with reason)
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:801` — calls `this.tokenBlacklist.add(jti, accessTokenExpiry, 'user_logout')` against the `ITokenBlacklist` symbol — depends on which provider is wired.

This creates a TypeScript drift bomb: depending on `TOKEN_BLACKLIST` token resolution, a 3-arg `add` call may silently lose its third arg or throw.

**Proposed fix direction**
- Tier-1: unify on a single `ITokenBlacklist` interface in `libs/backend-common/src/security/interfaces` and remove the second contract in `redis-token-blacklist.store.ts`. Both implementations conform.

**Affected surface**
- `libs/backend-common/src/security/interfaces/token-blacklist.interface.ts`
- `apps/gateway-api/src/guards/redis-token-blacklist.store.ts`
- consumers

**Expected closer**
auth-security-expert WRITER.

---

### SEC-MEDIUM-007 — `RateLimitGuard.RATE_LIMIT_USE_REDIS` defaults to `false`; production deployments without explicit override silently use in-memory limiter

**Severity:** MEDIUM
**Layer:** 2 (pattern)
**State:** OPEN

**Evidence**
- `apps/gateway-api/src/guards/rate-limit.guard.ts:217` — `this.useRedis = this.configService.get<boolean>('RATE_LIMIT_USE_REDIS', false);`.
- `RATE_LIMIT_FAIL_CLOSED` defaults to `isProduction`; but if `useRedis=false`, the in-memory fallback is selected and `failClosed` is irrelevant — every pod has its own bucket.

A production deployment that forgets `RATE_LIMIT_USE_REDIS=true` runs N independent buckets per pod.

**Proposed fix direction**
- Tier-2: in production, default `RATE_LIMIT_USE_REDIS=true` and fail-fast at boot if Redis is configured but the env var is `false`. Mirrors the pattern at `apps/gateway-api/src/main.ts:110-119` for `REDIS_URL`.

**Affected surface**
- `apps/gateway-api/src/guards/rate-limit.guard.ts`
- `apps/gateway-api/src/main.ts`

**Expected closer**
auth-security-expert WRITER.

---

### LOW

### SEC-LOW-001 — `JwtAuthGuard` and gateway `AuthGuard` have separate `@Optional() TokenBlacklist` injection patterns; minor maintainability drift

**Severity:** LOW
**Layer:** 1 (tech)
**State:** OPEN

**Evidence**
- `apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.ts:43` uses `TOKEN_BLACKLIST` symbol from `@aquaculture/backend-common/security`
- `apps/gateway-api/src/guards/auth.guard.ts:86` uses `TOKEN_BLACKLIST_STORE` from local `redis-token-blacklist.store`

Different DI tokens with different interfaces; consolidation would simplify the surface.

**Proposed fix direction**
- Tier-2: merge tokens after SEC-MEDIUM-006 lands.

**Expected closer**
auth-security-expert refactor.

---

### SEC-LOW-002 — TenantContextMiddleware logs `req.user.email` at debug level

**Severity:** LOW
**Layer:** 2 (pattern)
**State:** OPEN

**Evidence**
- `libs/backend-common/src/middleware/tenant-context.middleware.ts:60-62` — `this.logger.debug('User context set: ${user.email} (tenant: ${user.tenantId})')`. PII at debug level.

Per agent contract: "Mask PII in logs. String concatenation in log calls is banned."

**Proposed fix direction**
- Tier-1: log `user.sub` (userId), not `user.email`. The email is also a deprecated JWT field (see SEC-HIGH-008).

**Expected closer**
auth-security-expert WRITER (1-line).

---

### SEC-LOW-003 — `tenant-schema.middleware.ts` debug logs leak `req.headers['x-tenant-id']` raw

**Severity:** LOW
**Layer:** 2 (pattern)
**State:** OPEN

**Evidence**
- `libs/backend-common/src/middleware/tenant-schema.middleware.ts:43` — `[DEBUG] Incoming headers: x-tenant-id=${req.headers['x-tenant-id']}, x-user-payload exists=${!!req.headers['x-user-payload']}`

Tenant UUID is not strictly PII but combined with other logs could enable tenant enumeration. The `x-user-payload exists=true` boolean is fine; the raw tenant value is verbose-debug-only and should be stripped in production.

**Proposed fix direction**
- Tier-3: convert the two `[DEBUG]` lines to a structured `this.logger.debug('schema-resolution', { tenantHash: sha256(tenantId).slice(0, 8) })`.

**Expected closer**
auth-security-expert WRITER (small).

---

## Cross-domain dependencies flagged

- **SEC-CRITICAL-001 (HMAC canonical input)** — ripples into every backend service registering `ServiceIdentityGuard`. Recommend `data-expert` review the canonical-input util as the SSoT, and `multi-tenant-saas-expert` confirm the tenantId-binding remains correct under impersonation paths.
- **SEC-CRITICAL-002 (StripInternalHeaders)** — ripples into ALL 14+ services. Recommend invoking every domain expert in parallel to confirm middleware order, with `multi-tenant-saas-expert` as cross-cutting reviewer.
- **SEC-HIGH-004 (refresh-token reuse detection)** — touches `libs/event-contracts/src/security-events.ts`. Notify `data-expert` for new event contract shape + upcaster.
- **SEC-HIGH-006 (OPA dead stack)** — `architectural-arbiter` ruling required (W4) before any code lands.
- **SEC-HIGH-008 (deprecated JWT PII fields)** — touches `frontend-expert` (login response handling) and every consuming service.
- **SEC-MEDIUM-001 (audit-log convergence)** — `platform-kernel-expert` should opine on whether auth-service's local audit service should be deleted in favour of the platform one.
- **SEC-MEDIUM-002 (GDPR erasure)** — recommend joint review with whichever agent now owns GDPR (no dedicated agent — likely `data-expert` for the cross-service event contract piece).

## Verdict

**BLOCK** for production until SEC-CRITICAL-001 through SEC-CRITICAL-004 close. SEC-HIGH-001..008 must close in the same release cycle (or be tracked as accepted-risk findings with explicit owner + deadline + finding-registry entry per CLAUDE.md). MEDIUM/LOW track separately.

## References

- ADR-002 single gateway-api edge service (HMAC partial wire)
- ADR-008 guard defense-in-depth (OPA pending W4)
- ADR-016 deploy resilience + RS256 rollout (Phase B verified at consumer side, Phase C+ doc only)
- CLAUDE.md — Security § Tenant-ID sourcing trust anchor, PII masking
- Layer-1 NestJS — `algorithms: ['RS256']` invariant; `getJwtVerifyOptions` SSoT
- Layer-2 patterns — Tenant isolation; outbox pattern alignment
- Prior cycle: `docs/reviews/auth-security-expert/2026-04-10-full-repo-audit.md` — SEC-HIGH-002/003/004 supersede this cycle's CRITICAL-001 / HIGH-006
- RFC 8725 §2.1 (algorithm confusion); RFC 9068 (issuer/audience); OAuth 2 BCP §4.12 (refresh-token reuse detection); RFC 6238 (TOTP one-time use)
