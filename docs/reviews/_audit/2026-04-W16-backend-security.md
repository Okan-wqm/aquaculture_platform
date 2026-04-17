# W1 Part A — Backend Security Pattern Audit (NestJS 11 / ADR-008 / ADR-016)

**Date:** 2026-04-16
**Slice:** Backend Security
**Scope:** NestJS 11.1.17 guards/interceptors/pipes/filters, `@nestjs/jwt` 11, `@nestjs/passport` 11, tenant middleware, OPA integration, rate limiting, CSP, gateway→subgraph HMAC.
**Tech anchors:** NestJS 11.1 (`CanActivate`, `OnModuleInit`), JWT RS256 post-ADR-016-Phase-B (HS256 forbidden, `JWT_SECRET` reads ESLint-banned via `.eslintrc.json:97-111`), ValidationPipe enterprise defaults (`{ whitelist, forbidNonWhitelisted, transform, enableImplicitConversion: false }`), tenant-ID sourcing: JWT claims primary / `x-tenant-id` header only on pre-auth & edge-device paths per CLAUDE.md.
**Primary ADRs:** 008 (Guard defense-in-depth), 014 (NATS mTLS-only), 015 (NATS cert-is-identity SSoT), 016 (Deploy resilience — Phase B = RS256 JWT migration).
**Mode:** READ-ONLY. Grep / Glob / Read. No code / nx / npm invoked.

---

## Methodology

Evidence collected via ripgrep/Read on every production source tree under `apps/*/src/`, `libs/backend-common/`, and `platform/libs/`. Test files (`__tests__/`, `.e2e-spec.ts`, `.integration.spec.ts`) and E2E scaffolding under `tests/e2e/v11-upgrade/` are explicitly excluded from anti-pattern counts unless otherwise noted. Every row cites the concrete file+line it is derived from.

---

## Table 1 — Pattern Usage (what the security baseline looks like today)

| # | Pattern | Adoption / Count | Evidence | Version / Correctness |
|---|---|---|---|---|
| 1 | Central `ValidationPipe` with enterprise defaults (`whitelist=true`, `forbidNonWhitelisted=true`, `transform=true`, `enableImplicitConversion=false`, `validationError.target/value=false`, `disableErrorMessages=isProduction`) | 1 canonical factory (`configureValidationPipe`) + applied to every service via `createServiceApp()` | `libs/backend-common/src/bootstrap/create-service-app.ts:407-444` | Compliant with CLAUDE.md security section; `enableImplicitConversion=true` nowhere in codebase (verified 0 hits). |
| 2 | Global `AuthGuard` with `APP_GUARD` at gateway (Public-decorator opt-out) | 1 gateway guard (`useFactory`-built) | `apps/gateway-api/src/app.module.ts:565-583`, `apps/gateway-api/src/guards/auth.guard.ts:69-234` | ADR-008 compliant. JWT verification defers to `getJwtVerifyOptions()` which enforces RS256 + iss + aud at library level (`libs/backend-common/src/auth/jwt-verification.utils.ts:148-171`). |
| 3 | Guard stack order at gateway: AuthGuard → TenantIsolationGuard → RateLimitGuard → MutationRateLimitGuard | 4 guards chained via `APP_GUARD` entries | `apps/gateway-api/src/app.module.ts:566-614` (comment at 591-594 documents order) | Correct per ADR-008. Tenant check follows authentication. |
| 4 | Middleware pipeline order at gateway (pipeline is the first security gate) | 9 middlewares, `SecurityHeadersMiddleware` first, then `Metrics → CorrelationId → RequestContext → StripInternalHeaders → Csrf → Jwt → UserContext → TenantContext → RequestLogging` | `apps/gateway-api/src/app.module.ts:644-678` | `StripInternalHeadersMiddleware` runs BEFORE `JwtMiddleware` (prevents forged `x-user-payload` from being trusted). Matches auth pipeline spec. |
| 5 | HMAC-signed service identity (gateway→subgraph) with tenant binding | 1 canonical util + `ServiceIdentityGuard` on every subgraph | `libs/backend-common/src/utils/service-identity.util.ts:47-116`, `libs/backend-common/src/guards/service-identity.guard.ts:49-131` | `HMAC-SHA256(timestamp:serviceName:tenantId, INTERNAL_SERVICE_SECRET)`; tenant bound into signature (HIGH-003 fix); 5-min replay window; `crypto.timingSafeEqual` used. **See T2-A6** (canonical-string is narrow). |
| 6 | RS256 JWT verification via shared `PlatformJwtModule` (consumer services) | 1 canonical module, `algorithms: ['RS256']` hardcoded | `libs/backend-common/src/auth/platform-jwt.module.ts:78-103` | ADR-016 Phase B landed. `JWT_SECRET` ESLint `no-restricted-syntax` ban (5 patterns, `.eslintrc.json:97-125`). Zero `JWT_SECRET` reads in production source (only in tests, dev-fallback comments, and WS gateway docstrings). |
| 7 | JWT `type === 'access'` enforcement (token-type discrimination) | 1 canonical helper used by every guard | `libs/backend-common/src/auth/jwt-verification.utils.ts:73-96` → called by `auth.guard.ts:144,191`, `farm/common/guards/gql-auth.guard.ts:140`, `messaging.gateway.ts:518`, `jwt.middleware.ts:55` | Prevents refresh-as-bearer / MFA-challenge-as-bearer escalation. `jti` required in production. |
| 8 | Blacklist-check-BEFORE-req.user ordering in `JwtMiddleware` | Correct: blacklist checked before `req.user` is populated | `apps/gateway-api/src/middleware/jwt.middleware.ts:57-72` | Uses `isValidToken(jti, sub, iat)` composite (blacklist + `tokensInvalidBefore`). Invalid token never sets `req.user`. |
| 9 | Tenant ID sourcing precedence (JWT primary; header pre-auth only) | `extractTenantContext` in `TenantContextMiddleware` tries JWT → header → query → subdomain | `libs/backend-common/src/middleware/tenant-context.middleware.ts:95-150` | JWT preferred when `req.user` present. **See T2-A2** — for regular users `TenantGuard` REJECTS anything that did not arrive via JWT (`libs/backend-common/src/guards/tenant.guard.ts:154-173`). |
| 10 | `StripInternalHeadersMiddleware` strips spoofable internal headers on external requests | Single middleware on gateway; strips `x-user-payload`, `x-user-id`, `x-user-roles`, `x-tenant-id`; HMAC-verified requests skip strip | `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts:21-89` | Runs position #4 in gateway pipeline, BEFORE `JwtMiddleware`. **See T2-A3** — canonical input only signs `identity` (no timestamp/body). |
| 11 | OPA integration (`OpaPolicyGuard` + `PolicyEnforcerService`) | 1 guard, 1 enforcer, 1 client service, 3 tests | `apps/gateway-api/src/guards/opa-policy.guard.ts`, `apps/gateway-api/src/opa/policy-enforcer.service.ts`, `apps/gateway-api/src/opa/opa-client.service.ts` | In production: defaults to enabled, `fail-open` refused (`opa-policy.guard.ts:317-327`; `policy-enforcer.service.ts:173-188`). **Zero production adoption**: no `@OpaPolicy(...)` decorator usage anywhere under `apps/*/src/`. |
| 12 | Rate limiting (gateway): `RateLimitGuard` atomic `incrementOrCreate` + `MutationRateLimitGuard` + `AliasLimitPlugin` | 1 guard + in-memory fallback store + Redis store, 1 alias-limit plugin | `apps/gateway-api/src/guards/rate-limit.guard.ts:115-136`, `apps/gateway-api/src/guards/mutation-rate-limit.guard.ts`, `apps/gateway-api/src/plugins/graphql-alias-limit.plugin.ts`, `apps/gateway-api/src/app.module.ts:364` (`allowBatchedHttpRequests: false`) | Three-way defense against GraphQL alias/batch brute-force. Atomic increment on single-threaded Node.js (InMemoryStore) + Redis store for distribution. |
| 13 | CSP + security headers defense-in-depth (middleware + Helmet) | `SecurityHeadersMiddleware` on `*` routes + `buildHelmetOptions` in bootstrap | `apps/gateway-api/src/middleware/security-headers.middleware.ts:48-120`, `libs/backend-common/src/bootstrap/create-service-app.ts:286-323` | Prod CSP: `default-src 'self'`, `script-src 'self'` (no `unsafe-inline`), `object-src 'none'`, `frame-ancestors 'none'`, HSTS preload 1y. CSP report endpoint at `apps/gateway-api/src/csp-report/csp-report.controller.ts`. |
| 14 | `Scope.REQUEST` usage constrained to DataLoaders + `TenantAwareRepository` | 4 services total carry `Scope.REQUEST` | `libs/backend-common/src/database/tenant-aware.repository.ts:29`, `apps/farm-service/src/batch/dataloaders/*.ts` (3 files) | Compliant with NestJS 11.1 guidance (`Scope.DEFAULT` is the default; Request-scope only when request-context demands). No paranoid request-scoping. |
| 15 | PII mask helper + sensitive-field redaction centralized | `libs/backend-common/src/utils/pii-mask.util.ts` (159 LOC) with `maskPii`, `maskPiiDeep`, `maskEmail`, `maskPhone`; auto-applied by `StructuredLoggerService` | `libs/backend-common/src/logging/structured-logger.service.ts`, `libs/backend-common/src/utils/pii-mask.util.ts:122-155` | Single source of truth. **See T2-A7** — the auto-apply path covers the logger wrapper, but ad-hoc `logger.debug(\`...${email}...\`)` calls bypass `maskPiiDeep`. |
| 16 | Gateway-wide `allowBatchedHttpRequests: false` on every GraphQL subgraph | 11 services set `allowBatchedHttpRequests: false` | `apps/gateway-api/src/app.module.ts:364`; auth/farm/sensor/alert/hr/billing/hydroponics/config/notification/messaging/ai all set it | Consistent across the subgraph fleet. Rate-limit bypass via HTTP batching is structurally prevented. |

---

## Table 2 — Anti-Pattern Spots (slice-specific)

| # ID | Anti-pattern | Count / Severity | Evidence | Impact |
|---|---|---|---|---|
| A1 | `JWT_SECRET` reads in production code | **0** in `apps/*/src/` production paths. All hits in: (a) e2e test fixtures, (b) dev-fallback comments in `auth-service`, (c) historical comments | `grep "JWT_SECRET" apps/*/src/**/*.ts` → only comments + `libs/backend-common/src/config/secrets.provider.ts:17` docstring example. Auth-service keeps its own issuer wiring (exempt by design). ESLint rule active (`.eslintrc.json:97-125`). | CLEAN. The 2026-04-14 hydroponics crash class is closed. |
| A2 | `getRepository()` direct calls bypassing tenant scope (CLAUDE.md ban) | **Production-source hits: 45 files.** Most are inside `queryRunner.manager.getRepository()` within explicit transactions (acceptable per CLAUDE.md — `manager.getRepository` is scoped to the tx). **However:** `apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts:1070,1719,1788` calls `this.dataSource.getRepository(...)` directly — the banned pattern. `platform/libs/outbox/src/outbox-worker.service.ts:126` also calls `dataSource.getRepository(entityClass)`. `apps/config-service/src/configuration/handlers/upsert-configuration.handler.ts:30,82` same. `apps/messaging-service/src/compliance/services/*.service.ts:72,120,53,77` same. | **HIGH.** ESLint rule `no-restricted-syntax` targets `getRepository()` via AST selector `CallExpression[callee.property.name='getRepository']` — the queryRunner.manager variants evidently match the selector but appear whitelisted by intent. The feeding-program.resolver + outbox-worker + compliance-service violations are IDOR risk: every find/save runs without `tenantId` injection. |
| A3 | HMAC canonical signing input missing method/path/body-hash | Canonical input = `${timestamp}:${serviceName}:${tenantId}` only | `libs/backend-common/src/utils/service-identity.util.ts:52-55,103-105` | **HIGH.** Per `claudeMd` spec: canonical input MUST include `method`, `path`, and `bodyHash`. Absence allows cross-endpoint replay within the 5-min window (attacker captures a valid signature, replays it against a different mutation). Tenant binding (HIGH-003) is a good partial fix; body/path/method binding is the missing half. |
| A4 | `StripInternalHeadersMiddleware` HMAC check signs only the identity string, not `timestamp+method+path+body` | `expectedSignature = HMAC(identity)` | `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts:71-74` | **HIGH.** Verifies `expectedSig == HMAC(x-service-identity, secret)`. No timestamp, no method, no path. A leaked identity→signature pair for one service is reusable forever against ANY endpoint. Combined with A3 this produces two orthogonal replay surfaces. |
| A5 | OPA policy decorator adoption across the fleet | **Zero** `@OpaPolicy()` decorations in `apps/*/src/` production code | grep for `@OpaPolicy\(` → only 3 hits, all in `apps/gateway-api/src/guards/opa-policy.guard.ts` (definition), its test, and a gateway-federation e2e | **HIGH.** In production, `OpaPolicyGuard` enforces "no policy configured → 403" fail-closed (`opa-policy.guard.ts:268-277`). If this guard were globally registered today, EVERY gateway route would break in prod. It is NOT globally registered — it is referenced only by tests and the e2e. OPA is defense-in-depth infra that is wired but unused. Either wire it as APP_GUARD and begin annotating mutations, or remove the dead code. |
| A6 | `PolicyEnforcerService.evaluateWithFallback` uses `FALLBACK_POLICIES` that silently allow certain actions even when OPA is unhealthy | Fallback contains `systemAdmin` (allow), `tenantIsolation` (allow when resource.tenantId is empty), `ownerAccess` (allow when subject.id == resource.ownerId) | `apps/gateway-api/src/opa/policy-enforcer.service.ts:107-118,430-450` | **MEDIUM.** `tenantIsolation` fallback allows when `!ctx.resource.tenantId` — any resource lacking a tenantId is passable without OPA. In practice the gateway subject always has a tenantId, but the callers of `isAuthorized()` don't validate that `resource.tenantId` is present before evaluation. When OPA is down, a carefully-shaped input would pass the fallback. |
| A7 | PII in logs without `maskPii()` — string-concatenation in logger calls | `TenantContextMiddleware` logs `"Tenant context set: ${tenantContext.tenantId} (source: ${tenantContext.source})"`; `UserContextMiddleware` logs `"User context set: ${user.email} ..."`; `JwtMiddleware` logs `"JWT decoded: user=${payload.sub}, tenant=${payload.tenantId}"` | `libs/backend-common/src/middleware/tenant-context.middleware.ts:62,87`; `apps/gateway-api/src/middleware/jwt.middleware.ts:74` | **HIGH (GDPR Art. 32).** `logger.debug` with string concatenation bypasses `StructuredLoggerService.maskPiiDeep`. Email + `sub` are leaked into debug logs. Even though `SENSITIVE_FIELDS` covers `email`, string-concat evades the auto-mask because it runs on the structured payload, not on the message template. CLAUDE.md: "string concatenation in log calls is banned" — violated. |
| A8 | `tenant-context.middleware.ts` query-param tenant source | `extractTenantContext` falls back to `req.query['tenantId']` BEFORE subdomain | `libs/backend-common/src/middleware/tenant-context.middleware.ts:108-112` | **CRITICAL.** An authenticated user can attach `?tenantId=<victim-tenant>` to any request and the middleware will populate `tenantContext` from it — BUT `TenantGuard` later rejects mismatches (`tenant.guard.ts:154-173`). If a route marks `@SkipTenantGuard()` or `@Public()` AND the handler consumes `req.tenantId` (populated by this middleware) for data access, cross-tenant data leak is possible. CLAUDE.md: "Regular users: tenant ID comes EXCLUSIVELY from the JWT claim … Headers, query params, and body are NEVER consulted." — the middleware still reads them. |
| A9 | `as any` casts in production source | 261 occurrences across 57 files (production `apps/*/src/**/*.ts`) | e.g. `apps/auth-service/src/modules/authentication/services/webauthn.service.ts`, multiple alert-engine handlers, farm-service batch handlers | **MEDIUM.** Many are in test files (not counted), integration handlers, and MQTT adapters where external protocol types are unavoidable. But 50+ sit inside auth/security-sensitive code (webauthn.service, authentication.resolver, stripe-webhook.controller). Each `as any` erases a DI / runtime-type invariant and is a latent coercion-bug surface. CLAUDE.md: "`as any` is FORBIDDEN". |
| A10 | `as unknown as X` casting hacks in production source | 205 occurrences across 80 files | e.g. `apps/auth-service/src/modules/authentication/services/webauthn.service.ts:1`, multiple protocol adapters | **MEDIUM.** Same severity as A9 but usually indicates interface mismatch between DTOs and entities. CLAUDE.md banned phrase. |
| A11 | Defensive `?.` on injected services (DI invariants violated) | 60 hits across 48 production files for the narrow pattern `user?.tenantId / this.jwt?/ this.configService?` | e.g. `apps/gateway-api/src/guards/rate-limit.guard.ts:4`, `apps/gateway-api/src/guards/ip-whitelist.guard.ts:1`, `libs/backend-common/src/audit/audit-log.interceptor.ts:1` | **MEDIUM.** `configService?.get(...)` on an `@Inject(ConfigService)` field is always defined — the `?.` is defensive noise that hides future DI bugs. CLAUDE.md: "Interface/type mismatch → fix the interface, not hide with `?.`". |
| A12 | `x-tenant-id` header trust on authenticated paths | `TenantContextMiddleware:103` reads `x-tenant-id`; several audit/filter utilities fall back to it | `libs/backend-common/src/audit/audit-log.interceptor.ts:218`, `libs/backend-common/src/audit/audited-operation.interceptor.ts:335`, `libs/backend-common/src/filters/http-exception.filter.ts:100,166,213,277`, `libs/backend-common/src/logging/request-context.middleware.ts:54`, `libs/shared/src/errors/global-exception.filter.ts:212` | **HIGH.** Per CLAUDE.md: `x-tenant-id` is only acceptable on "explicit pre-auth / cross-tenant admin / edge-device ingestion paths". Audit interceptors and error filters are post-auth paths and SHOULD read `user?.tenantId ?? request.tenantId` — the nullish fallback to the raw header is exactly the shape flagged. For audit records this is the MOST load-bearing surface (spoofed tenant = corrupt forensic trail). |
| A13 | `console.*` in production code | 2 hits | `apps/admin-api-service/src/__tests__/contract-validation.spec.ts:1`, `apps/farm-service/src/__tests__/e2e/p0-fixes-verification.e2e-spec.ts:1` | CLEAN outside test scaffolding. `no-console: error` ESLint rule is effective. |
| A14 | Console.log CSP violation bypass (`disposition` processed unsafely) | `CspReportController` logs whole `report` object via `Logger.warn` with nested `disposition`, `sourceFile`, etc. | `apps/gateway-api/src/csp-report/csp-report.controller.ts:65-83` | **LOW.** `@Public()`, no rate-limit on the endpoint, and the browser-submitted report is piped directly into a structured log attribute. An attacker can flood it from any browser-like HTTP client. Consider per-IP throttling on the `csp-report` POST. |
| A15 | WebSocket gateways carry stale `HS256` docstrings — code is RS256 | `messaging.gateway.ts:503`, `st-language.gateway.ts:479`, `farm.gateway.ts:114`, `sensor-readings.gateway.ts:103` all still reference `algorithms: ['HS256']` in explanatory comments | code around those lines uses `getJwtVerifyOptions(this.configService)` which is RS256-only | **LOW** (documentation drift). Auditors may be misled during code review that HS256 is still in play. Purely cosmetic but worth a doc sweep. |
| A16 | ValidationPipe consistency across services | The centralised factory is always applied via `createServiceApp()`. 2 service-level `ValidationPipe({ transform: true })` (missing `whitelist` & `forbidNonWhitelisted`) exist only in test files: `apps/farm-service/test/farm-workflow.e2e-spec.ts:37`, `apps/farm-service/test/batch.e2e-spec.ts:29`, `apps/admin-api-service/src/tenant/__tests__/tenant.integration.spec.ts:250` | grep `ValidationPipe\s*\(\s*\{` narrow | CLEAN in production source. Test-harness Pipes are deliberately relaxed (acceptable, but worth a convention check). |

---

## Table 3 — Modernization Opportunities

| # | Modernization | Win | Blocking / Notes |
|---|---|---|---|
| M1 | Extend the HMAC canonical signing input to `${timestamp}|${serviceName}|${method}|${path}|${bodyHash}|${tenantId}` (closes A3, A4). Field count matches the auth-security-expert's `claudeMd` spec for the service-to-service signing input. | Makes request replay against a different endpoint or with a mutated body structurally impossible. | One-commit fix on `service-identity.util.ts` + `strip-internal-headers.middleware.ts` + `ServiceIdentityGuard.canActivate`; all callers funnel through these 3 files. Coordinated gateway+subgraph rollout (dual-accept window). |
| M2 | Wire `OpaPolicyGuard` as a gateway `APP_GUARD`; add `@OpaPolicy()` to every mutation; delete the dead fallback path in `PolicyEnforcerService` once all gateway routes have explicit policies (closes A5, A6). | Defense-in-depth that is currently code-only becomes actually enforced. Removes a dead-code class of risk. | ~5-day engineering effort to write Rego policies (`aquaculture/authz/resource_access`, `module_access`, etc.) that map today's `TenantGuard` + `RolesGuard` intent. Fail-closed already correct. |
| M3 | Remove `x-tenant-id` query/header fallback from `TenantContextMiddleware` for authenticated paths (closes A8, A12). Keep the header only for routes explicitly decorated `@PreAuthTenantHeader()` (edge-device ingestion, cross-tenant admin). | Enforces the CLAUDE.md trust-anchor rule at the structural layer, not the guard layer. Turns the secondary guard from a "rejects" into a "never sees". | Requires auditing 10+ `x-tenant-id` read sites (audit interceptor, exception filters, request-context middleware) and replacing with `user?.tenantId ?? req.tenantId` with the header path gated by a decorator-backed allowlist. |
| M4 | Migrate `console.log`-concatenation debug lines in middleware/guards to structured `Logger.debug({ msg, ...context })` so `maskPiiDeep` applies (closes A7). Add a lint rule `no-restricted-syntax` that blocks `logger.(debug|log|warn|error)` with backtick template literals. | PII redaction becomes automatic; CLAUDE.md "string concatenation in log calls is banned" becomes enforceable. | ESLint rule + 4-5 file edits in middleware/guards. Zero ADR impact. |
| M5 | Adopt `noUncheckedIndexedAccess` in `auth-service` and `libs/backend-common` to surface missing JWT claim accesses at compile time. `payload.jti` → `string | undefined` forces explicit handling (today it's implicit `string` and production code asserts with `!`). | Catches the next ADR-016-class bug (silent dependency on optional claim) at `tsc`, not at runtime. | Per-service opt-in. Expect ~40 TS errors in auth-service on first compile — all architectural fixes, none `as any`. |
| M6 | Split `TenantContextMiddleware` into `TenantContextFromJwtMiddleware` (authenticated routes) and `TenantContextFromHeaderMiddleware` (pre-auth allowlist). Tier-1 "make-impossible": a JWT-authenticated request's tenant never transits through `x-tenant-id`. | Architectural separation matches the spec. Removes the "check guard after the fact" pattern. | Requires decorator metadata on pre-auth routes + MiddlewareConsumer branching. Larger refactor than M3 but cleaner. |
| M7 | Replace `as any` / `as unknown as` in auth-service + gateway guard paths (A9, A10) with proper generics + `satisfies` operator (TS 5.3). Target first: `webauthn.service.ts`, `authentication.resolver.ts`, `auth.guard.ts`. | Type-safety restores; NestJS DI contracts become verifiable. | ~1 week of focused work. CLAUDE.md mandates this anyway — tracked debt. |
| M8 | Add rate-limit to `CspReportController` (A14) via `@RateLimit({ limit: 50, windowMs: 60000 })` keyed by IP. | Prevents CSP-report flood-as-DoS (external, unauthenticated endpoint today). | Single-decorator change. |
| M9 | Sweep WebSocket gateway docstrings for HS256 references (A15). | Documentation correctness. | Cosmetic. |
| M10 | Promote every `configService?.get(...)` on a non-`@Optional()` injection to `configService.get(...)` (A11). Matches NestJS 11.1 DI semantics. | Encodes DI guarantee into the code surface; future refactors that change a provider from required→optional will break compile, not hide. | Grep + sed scope. |

---

## Findings (finding IDs follow `SEC-{severity}-{NNN}`)

### SEC-CRITICAL-001 — `TenantContextMiddleware` accepts tenant ID from `?tenantId=` query param
**File:** `libs/backend-common/src/middleware/tenant-context.middleware.ts:108-112`
**Severity:** CRITICAL — active cross-tenant context-spoofing risk on any `@SkipTenantGuard()` or `@Public()` route that reads `req.tenantId`.
**Issue:** After the JWT-claim check, the middleware falls back to `req.query['tenantId']` (then to `x-tenant-id` header, then to subdomain). Per CLAUDE.md *Security* section: *"Regular users: tenant ID comes EXCLUSIVELY from the JWT claim. Headers, query params, and body are NEVER consulted."* `TenantGuard` rejects mismatches on guarded routes, but any route annotated `@SkipTenantGuard()`/`@Public()` that subsequently reads `req.tenantId` (e.g. to select a tenant DataSource or log a tenant-scoped audit event) inherits the spoofed value.
**Root cause:** The middleware was designed as "try multiple sources" before the CLAUDE.md rule crystallised; the query/header paths are now fossil code.
**Evidence of observed consumers reading `req.tenantId` post-middleware:** `libs/backend-common/src/audit/audit-log.interceptor.ts:218`, `libs/backend-common/src/middleware/tenant-schema.middleware.ts:43`, `libs/backend-common/src/logging/request-context.middleware.ts:54`.
**Fix (Tier-1 — make impossible):** Remove the `query['tenantId']` branch entirely; gate the `x-tenant-id` branch behind a `@PreAuthTenantHeader()` decorator that allowlists pre-auth/edge-device routes per CLAUDE.md. See Modernization M3/M6.

### SEC-HIGH-002 — Gateway→subgraph HMAC canonical input omits method/path/body-hash
**File:** `libs/backend-common/src/utils/service-identity.util.ts:52-55, 103-105`
**Severity:** HIGH.
**Issue:** `signature = HMAC-SHA256(\`${timestamp}:${serviceName}:${tenantId}\`, secret)`. Any signed message is interchangeable across endpoints of the same service within the 5-min replay window. The tenant-binding (HIGH-003) prevents tenant swap, but not endpoint swap or body mutation.
**Root cause:** Signing scope was scoped to identity only during initial HMAC rollout.
**Fix:** Include `${method}|${path}|${sha256(body)}|${tenantId}|${timestamp}|${serviceName}` in canonical input. Add Redis-backed in-window replay cache (5-min TTL) for high-sensitivity endpoints per CLAUDE.md.

### SEC-HIGH-003 — `StripInternalHeadersMiddleware` HMAC verification signs only `x-service-identity`
**File:** `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts:71-74`
**Severity:** HIGH.
**Issue:** `expectedSignature = HMAC(identity, secret)`. No timestamp, no method, no path, no body, no tenant. A single identity/signature pair leaked from logs or from the gateway → subgraph direction is reusable forever AGAINST the gateway to skip the strip step. This is a second, independent replay surface paired with SEC-HIGH-002.
**Fix:** Drive the middleware from `verifyServiceIdentity(...)` (the fuller util in `utils/service-identity.util.ts`) so the same canonical-input rule applies in both directions.

### SEC-HIGH-004 — `OpaPolicyGuard` wired but unused in production
**Files:** `apps/gateway-api/src/guards/opa-policy.guard.ts`, `apps/gateway-api/src/opa/policy-enforcer.service.ts`
**Severity:** HIGH (dead-code exposure / false sense of defense-in-depth).
**Issue:** Zero `@OpaPolicy()` decorations across `apps/*/src/` (only in the guard's own source + tests). The guard is not registered as `APP_GUARD`, so it never runs. Per ADR-008 (defense-in-depth) and CLAUDE.md's RBAC/OPA requirements, this is the intended third layer of authorization — currently AWOL.
**Fix:** Either (a) register as global `APP_GUARD`, write Rego policies for the gateway's mutation surface, and annotate mutations (M2), or (b) delete the guard + service + client + tests and open an ADR recording the decision. Keeping dead defense code is an architectural liability — reviewers assume OPA protects paths it does not.

### SEC-HIGH-005 — Audit interceptors + error filters accept `x-tenant-id` header as fallback on authenticated paths
**Files:** `libs/backend-common/src/audit/audit-log.interceptor.ts:218`, `libs/backend-common/src/audit/audited-operation.interceptor.ts:335`, `libs/backend-common/src/filters/http-exception.filter.ts:100,166,213,277`, `libs/shared/src/errors/global-exception.filter.ts:212`, `libs/backend-common/src/logging/request-context.middleware.ts:54`
**Severity:** HIGH (audit trail integrity).
**Issue:** `tenantId: user?.tenantId ?? (headers['x-tenant-id'] as string) ?? null` — when `user.tenantId` is absent but the header is present, the audit row is tagged with an attacker-controllable tenant. Every forensic query downstream (who did what, to whom) can be misled.
**Root cause:** Defensive fallback pattern predates the JWT-is-trust-anchor rule.
**Fix:** Drop the header fallback in audit/filter code; only use `user?.tenantId` + `req.tenantId` (where `req.tenantId` was set from JWT by TenantGuard). On pre-auth paths the audit record should carry `tenantId: null` rather than an attacker-supplied value.

### SEC-HIGH-006 — PII in structured logs via string-concatenation
**Files:** `apps/gateway-api/src/middleware/jwt.middleware.ts:74`, `libs/backend-common/src/middleware/tenant-context.middleware.ts:62,87`
**Severity:** HIGH (GDPR Art. 32).
**Issue:** Backtick-template logs (`"User context set: ${user.email} (tenant: ${user.tenantId})"`) bypass `StructuredLoggerService.maskPiiDeep` because mask runs on the structured object, not on the text message. CLAUDE.md: *"String concatenation in log calls is banned."*
**Fix:** Rewrite as structured: `this.logger.debug('user_context_set', { userId: user.sub, tenantId: user.tenantId })` and rely on `maskPiiDeep` + `SENSITIVE_FIELDS`. Add lint rule to block template-literal args to `Logger.*` methods.

### SEC-HIGH-007 — `getRepository()` direct calls bypass tenant scope (IDOR)
**Files:** `apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts:1070,1719,1788`, `platform/libs/outbox/src/outbox-worker.service.ts:126`, `apps/config-service/src/configuration/handlers/upsert-configuration.handler.ts:30,82`, `apps/messaging-service/src/compliance/services/legal-hold.service.ts:72,120`, `apps/messaging-service/src/compliance/services/retention-policy.service.ts:53`, `apps/messaging-service/src/compliance/services/compliance-audit.service.ts:77`
**Severity:** HIGH (IDOR — same-role cross-tenant leak).
**Issue:** CLAUDE.md bans `getRepository()` in favour of `getScopedRepository()`. These direct calls pull the un-tenanted repository; find/save operations run WITHOUT `tenantId` injection.
**Root cause:** Either a missed ESLint scope (the rule uses AST selector `CallExpression[callee.property.name='getRepository']`; `dataSource.getRepository(...)` matches but appears to have slipped or been `// eslint-disable`'d historically) or the rule doesn't fire on `dataSource.getRepository` vs `manager.getRepository`. Needs verification.
**Fix:** Replace each with `getScopedRepository<T>(...)` or `getUnfilteredRepository()` with explicit justification. For outbox-worker, the outbox table is cross-tenant by design — acceptable but should use `getUnfilteredRepository()` with a comment.

### SEC-MEDIUM-008 — `PolicyEnforcerService.FALLBACK_POLICIES.tenantIsolation` allows resources without tenantId
**File:** `apps/gateway-api/src/opa/policy-enforcer.service.ts:111-113`
**Severity:** MEDIUM.
**Issue:** `tenantIsolation: (ctx) => !ctx.resource.tenantId || ctx.subject.tenantId === ctx.resource.tenantId` — when the resource has no tenantId, the fallback is PERMIT. OPA-unhealthy windows + a caller that forgot to set `resource.tenantId` = accidental allow.
**Fix:** Change to strict: `!!ctx.resource.tenantId && ctx.subject.tenantId === ctx.resource.tenantId`. Callers missing tenantId will correctly deny. Tied to M2 (if OPA is wired, this code path becomes unreachable entirely).

### SEC-MEDIUM-009 — `as any` / `as unknown as` in auth & security modules
**Files (auth-relevant subset):** `apps/auth-service/src/modules/authentication/services/webauthn.service.ts`, `apps/auth-service/src/modules/authentication/resolvers/webauthn.resolver.ts`, `apps/auth-service/src/modules/tenant/__tests__/tenant-user-management.service.spec.ts` (prod), several rate-limit + OPA test files.
**Severity:** MEDIUM.
**Issue:** CLAUDE.md: `as any` FORBIDDEN. Current platform-wide count under `apps/*/src/`: `as any` = 261 hits / 57 files; `as unknown as` = 205 hits / 80 files. A subset sits in webauthn + auth resolver paths — the highest-leverage security-critical surface.
**Fix:** Track as debt. Replace each cast with proper typing via generics, branded types, or `satisfies`. Prioritise auth-service + gateway guards.

### SEC-MEDIUM-010 — Defensive `?.` on non-Optional DI fields (`configService?.get`)
**Files:** `apps/gateway-api/src/guards/rate-limit.guard.ts:4`, `apps/gateway-api/src/guards/ip-whitelist.guard.ts:1`, `libs/backend-common/src/audit/audit-log.interceptor.ts:1`, others (60 hits / 48 files narrow pattern).
**Severity:** MEDIUM.
**Issue:** `@Inject(ConfigService)` field is NEVER undefined per NestJS DI contract; `configService?.get(...)` is noise that hides (a) future DI regressions and (b) reviewer confusion about what is optional. Flagged by CLAUDE.md Architectural Approach.
**Fix:** Replace `?.` with `.` where the field is non-optional; add `@Optional()` explicitly where it is optional. Automatable.

### SEC-LOW-011 — WebSocket gateway JSDoc refers to legacy HS256
**Files:** `apps/gateway-api/src/websocket/messaging.gateway.ts:503`, `apps/gateway-api/src/websocket/st-language.gateway.ts:479`, `apps/gateway-api/src/websocket/farm.gateway.ts:114`, `apps/gateway-api/src/websocket/sensor-readings.gateway.ts:103`
**Severity:** LOW (doc drift).
**Issue:** Comments describe pre-ADR-016-Phase-B HS256 behaviour; code is RS256 via `getJwtVerifyOptions()`.
**Fix:** One-pass doc sweep.

### SEC-LOW-012 — `CspReportController` is `@Public()` + unthrottled
**File:** `apps/gateway-api/src/csp-report/csp-report.controller.ts:44-46`
**Severity:** LOW.
**Issue:** Any external client can flood `POST /api/csp-report`; each report is logged with `Logger.warn(...)` + published to NATS via `SecurityEventService.publishCspViolation`. Without throttling this is an unauthenticated write amplifier.
**Fix:** Add `@RateLimit({ limit: 50, windowMs: 60000 })` keyed by IP.

---

## Surprises

1. **OPA is fully implemented but 100% unused.** Guard + enforcer + client + tests + config module exist. Zero annotations in production code. This is the single largest dead-code security-adjacent surface in the audit scope. Either wire it or delete it — leaving it in the tree misleads every subsequent reviewer (and the agent corpus) about the platform's actual enforcement surface.
2. **The service-to-service HMAC and the internal-header-strip middleware have drifted.** They use two different canonical-input schemes (`{timestamp:service:tenant}` vs. `{identity}`). Both should funnel through `verifyServiceIdentity()` in `libs/backend-common/src/utils/service-identity.util.ts`. This is the shape of a future near-miss.
3. **`TenantContextMiddleware` still contains the query-param fallback** that CLAUDE.md explicitly outlaws. The project-level invariant (`TenantGuard` rejects the mismatch) is the only thing preventing CRITICAL exploitation on authenticated routes, but any `@Public()` or `@SkipTenantGuard()` route that reads `req.tenantId` downstream is exposed. CLAUDE.md expects this to be a Tier-1 "make-impossible" property; it is currently a Tier-3 "make-detectable" (the guard catches what the middleware should never have set).
4. **Zero production `JWT_SECRET` reads** — the ESLint hardening + `PlatformJwtModule` migration is clean. This is the cleanest signal in the audit scope; the W1 tightening work evidently landed properly.

---

## Verdict for Part B inputs

The backend-security slice is ~85% compliant with CLAUDE.md and ADR-008/016. The tooling baseline (RS256, `PlatformJwtModule`, `StripInternalHeadersMiddleware`, `TenantGuard`, `ValidationPipe` enterprise defaults, HMAC service identity, rate-limit atomicity, alias-limit plugin, `allowBatchedHttpRequests=false`) is enterprise-grade. The residual gaps are (a) one CRITICAL (query-param tenant fallback), (b) two HIGH signing-scope omissions that form a replay-compatible pair, (c) HIGH but low-complexity audit trail fallback, and (d) a dead-code OPA system that must be landed or removed.

**Recommended Part B priorities:**
1. SEC-CRITICAL-001 → Tier-1 architectural fix (middleware split).
2. SEC-HIGH-002 + SEC-HIGH-003 → joint commit (unify the canonical HMAC input).
3. SEC-HIGH-004 → ADR + decision (wire OPA vs. delete).
4. SEC-HIGH-005 → sweep-commit (7 call sites).
5. SEC-HIGH-006 → sweep-commit + lint rule.
6. SEC-HIGH-007 → per-file replacement with `getScopedRepository`.

All above fit comfortably in a single 2-week sprint given the narrow scope of each fix.
