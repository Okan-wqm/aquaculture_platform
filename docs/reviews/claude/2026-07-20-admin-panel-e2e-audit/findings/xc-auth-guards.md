# Cross-cutting: Auth Guards & CSRF — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the verified severity where status is CONFIRMED, else the auditor's grade pending verification.


## Cross-cutting findings

### APA-366 [HIGH] CSRF double-submit is false security: FE sends X-CSRF-Token but admin-api-service has zero server-side CSRF validation and no server ever sets the XSRF-TOKEN cookie

- **Status:** PENDING
- **Symptom:** The admin-panel http-client (and blob-client / shared-ui api-client) reads a non-httpOnly XSRF-TOKEN cookie and echoes it as X-CSRF-Token on every POST/PUT/PATCH/DELETE, with comments claiming 'server rejects on mismatch'. In reality: (1) NO backend in the repo ever sets an XSRF-TOKEN cookie (repo-wide grep matches only frontend readers + one docs plan); (2) admin-api-service contains no CSRF middleware at all — its only NestMiddleware is CorrelationIdMiddleware, and its bootstrap registers no cookie-parser (main.ts passes no earlyMiddleware/onBeforeListen), so even req.cookies would be undefined; (3) the platform's only CSRF middleware lives in gateway-api, but production nginx (docker-compose.droplet.yml mounts infrastructure/nginx/droplet.conf) routes 'location /api/' DIRECTLY to admin-api-service (rewrite /api/(.*) -> /api/v1/$1), bypassing the gateway entirely; (4) even on a gateway-routed path, gateway-api's CsrfMiddleware uses cookie name 'csrf-token' while the FE reads 'XSRF-TOKEN' — a name mismatch, so the FE would never send the header and every admin mutation would 403. The FE guard clause `if (csrfToken)` silently skips the header when the cookie is absent, so the entire control is dead code end-to-end. Practical exploitability is limited because admin-api auth is a Bearer Authorization header (not a cookie), which a cross-site attacker cannot set — but the advertised CSRF control does not exist, and tenant.security.spec.ts's header even lists 'CSRF protection' as covered while containing no CSRF test. Fix architecturally: either implement the double-submit middleware in admin-api-service (set XSRF-TOKEN on safe methods + cookie-parser + timing-safe validation on mutations, reusing gateway's pattern with a single shared cookie-name constant), or delete the dead FE CSRF code so the codebase stops claiming a control it doesn't have.
- **Evidence:**
  - `web/modules/admin-panel/src/services/http-client.ts:97-106 (reads XSRF-TOKEN cookie, comment claims 'server will reject mutating requests whose X-CSRF-Token header does not match')`
  - `web/modules/admin-panel/src/services/http-client.ts:256-263 (header attached only if cookie exists — silent skip otherwise)`
  - `web/shared-ui/src/utils/api-client.ts:36-37 and web/modules/admin-panel/src/services/blob-client.ts:188 (same dead XSRF-TOKEN pattern)`
  - `apps/gateway-api/src/middleware/csrf.middleware.ts:17-19 (CSRF_COOKIE_NAME = 'csrf-token' — mismatches FE's XSRF-TOKEN) and :56-74 (validation only exists here)`
  - `infrastructure/nginx/droplet.conf:377-385 ('location /api/' proxies straight to admin-api-service:3000 — gateway CSRF middleware bypassed) + docker-compose.droplet.yml:1855 (droplet.conf is the production nginx.conf)`
  - `apps/admin-api-service/src/main.ts:10-36 (no earlyMiddleware / cookieParser / CSRF option) and libs/backend-common/src/bootstrap/create-service-app.ts:743-747 (earlyMiddleware is the only cookieParser hook — unused by admin-api)`
  - `apps/admin-api-service/src/shared/correlation-id.middleware.ts:18 (the only NestMiddleware in the service); repo grep for csrf in admin-api-service matches only an event-type enum literal (security/controllers/security-monitoring.controller.ts:55) and a doc-comment (tenant/__tests__/tenant.security.spec.ts:11 — no actual CSRF test exists)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-367 [HIGH] PlatformAdminGuard never consults the token blacklist — force-logout / revocation is silently ineffective on the most privileged surface

- **Status:** PENDING
- **Symptom:** PlatformAdminGuard validates RS256 signature, issuer/audience, expiry, token type ('access') and jti presence — but never checks the platform token-blacklist / user-token-revocation infrastructure that backend-common ships and that gateway-api's AuthGuard actively consults (RedisTokenBlacklistStore). Because production nginx routes admin-panel /api/ traffic DIRECTLY to admin-api-service (bypassing gateway-api), a revoked SUPER_ADMIN access token remains fully valid on every admin endpoint until natural expiry. This makes admin-api's own security features silently lie: PATCH /users/:id/force-logout claims to 'invalidate all sessions', and impersonation POST /impersonation/sessions/:id/terminate exists precisely for emergency cutoff — yet the actor's bearer token keeps working against admin-api. Architectural fix: inject the shared TokenBlacklistService (jti check) into PlatformAdminGuard, mirroring gateway-api's guard.
- **Evidence:**
  - `apps/admin-api-service/src/guards/platform-admin.guard.ts:108-120 (verifyAsync + enforceAccessTokenType only; no blacklist lookup anywhere in the guard)`
  - `libs/backend-common/src/auth/jwt-verification.utils.ts:73-96 (enforceAccessTokenType checks type + jti presence only — jti is never compared against a revocation store here)`
  - `apps/admin-api-service/src/users/users.controller.ts:341-347 ('Force logout user (invalidate all sessions)' endpoint)`
  - `libs/backend-common/src/security/token-blacklist/token-blacklist.service.ts and user-token-revocation/ (platform revocation infra exists); grep 'TokenBlacklist' hits apps/gateway-api/src/guards/auth.guard.ts + apps/gateway-api/src/guards/redis-token-blacklist.store.ts (gateway consumes it; admin-api does not — zero matches in apps/admin-api-service/src/guards/)`
  - `infrastructure/nginx/droplet.conf:377-385 (admin traffic bypasses gateway-api and its blacklist-checking guard)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-368 [MEDIUM] All app-level rate limiting is in-memory per-process (not Redis) and globally disableable — public password-reset limits are volatile

- **Status:** PENDING
- **Symptom:** ThrottlerGuard delegates to SlidingWindowStrategy, which stores counters in a JS Map. It logs its own production warning: 'Rate limits will NOT be enforced across multiple instances. Configure a Redis-backed rate limiter.' Consequences: the unauthenticated, @Public /auth/forgot-password and /auth/reset-password endpoints' 3-per-hour-per-IP limit (ThrottlePasswordReset) resets on every container restart and is per-replica if scaled; the same applies to ThrottleSensitive on impersonation session start, billing subscription mutations, and DB-explorer raw-query/DML endpoints. Additionally THROTTLE_ENABLED=false silently disables ALL app-level throttling (guard returns true). app.module.ts's comment 'Redis for caching and distributed rate limiting' is aspirational — the throttler never touches Redis. nginx limit_req (zone=api, burst=50 nodelay) is the only cross-instance limiter, and it is far looser than the 3/hr password-reset intent.
- **Evidence:**
  - `libs/backend-common/src/security/throttler/sliding-window.strategy.ts:33 (private readonly store = new Map) and :45-52 (production warning that limits are not enforced across instances)`
  - `libs/backend-common/src/security/throttler/throttler.guard.ts:68 (THROTTLE_ENABLED config) and :73-75 (returns true when disabled)`
  - `libs/backend-common/src/security/throttler/throttler.decorator.ts:67 (PASSWORD_RESET: 3/3600s byIp) — enforced only in-memory`
  - `apps/admin-api-service/src/auth/password-reset.controller.ts:74-76,109-111 (@Public + @ThrottlePasswordReset on both endpoints)`
  - `apps/admin-api-service/src/app.module.ts:187-193 (comment 'Redis for caching and distributed rate limiting' — buildRedisOptions marked 'optional'; throttler does not use it)`
  - `infrastructure/nginx/droplet.conf:378-379 (limit_req zone=api burst=50 nodelay — the only distributed limiter)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-369 [MEDIUM] Guard ordering makes failed-auth requests invisible to app-level throttling, and failed admin auth is logged only at debug level

- **Status:** PENDING
- **Symptom:** PlatformAdminGuard is registered as the first APP_GUARD and ThrottlerGuard second, so guards run auth-then-throttle. Any request with a missing/invalid/expired/forged Bearer token throws 401/403 in PlatformAdminGuard BEFORE ThrottlerGuard executes — token brute-force or credential-stuffing against the platform-admin API is never rate-limited at the application layer (only nginx's generous zone=api limit applies) and never produces the RateLimitExceeded SecurityEvent that feeds the incident pipeline (SEC-HIGH-010). Compounding this, every 401 path in the guard logs via this.logger.debug(...), so failed authentication attempts against the most privileged service are invisible at production log levels; only the role-denied (403) path uses logger.warn. Architectural fix: swap APP_GUARD order (throttle before auth, as the anonymousLimit=20 default was clearly designed for) and raise failed-auth logging to warn/security-event.
- **Evidence:**
  - `apps/admin-api-service/src/app.module.ts:283-290 (APP_GUARD order: PlatformAdminGuard then ThrottlerGuard)`
  - `apps/admin-api-service/src/guards/platform-admin.guard.ts:92-97,101-106,185-197 (all 401 rejection paths use logger.debug)`
  - `libs/backend-common/src/security/throttler/throttler.guard.ts:67,110-127 (anonymousLimit=20 default + SecurityEvent publish exist but are unreachable for failed-auth requests due to guard order)`
  - `infrastructure/nginx/droplet.conf:378-379 (edge limit_req is the only control on failed-auth floods)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-370 [MEDIUM] Sensitive admin mutations missing tightened throttles; circuit-breaker reset has no app-level rate limit at all

- **Status:** PENDING
- **Symptom:** Rate-limit hardening is inconsistent across sensitive endpoints. PATCH /users/:id/reset-password (a SUPER_ADMIN directly setting another user's password) has no @ThrottleSensitive while the adjacent POST /users/invite does. POST /impersonation/permissions (grant) and /impersonation/permissions/:superAdminId/revoke are unthrottled beyond the 100/min default even though the session-lifecycle endpoints below them all carry @ThrottleSensitive. POST /health/circuit-breakers/:name/reset is a mutating operational endpoint inside a class-level @SkipThrottle() controller, so it has NO application rate limiting whatsoever (it does require SUPER_ADMIN auth — the class-level @SkipThrottle was clearly intended for the public GET probes). All remain auth-guarded, so this is degraded defense-in-depth rather than a broken flow.
- **Evidence:**
  - `apps/admin-api-service/src/users/users.controller.ts:330-339 (reset-password, no throttle decorator) vs :376-377 (invite carries @ThrottleSensitive)`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:304,326 (permissions grant/revoke unthrottled) vs :345-346,371-372,387-388,403-404 (@ThrottleSensitive on session lifecycle)`
  - `apps/admin-api-service/src/health/health.controller.ts:46-47 (class-level @SkipThrottle) and :159-167 (POST circuit-breakers/:name/reset — mutating, unthrottled, auth-required)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-371 [LOW] Public-route metadata key is string-coupled and triplicated; password-reset controller redefines its own @Public

- **Status:** PENDING
- **Symptom:** The 'isPublic' bypass key is defined independently in three places: guards/platform-admin.guard.ts (IS_PUBLIC_KEY export), decorators/public.decorator.ts (the canonical decorator used by health.controller), and a private re-implementation inside password-reset.controller.ts (local const IS_PUBLIC_KEY + local Public()). The guard bypass works only because all three string literals happen to match. A rename in any one location would either silently expose endpoints or silently break the public password-reset flow with no compile-time error. Backend-common's MetricsController relies on a fourth definition (decorators/roles.decorator.ts in backend-common) matching the same string. Tier-1 fix: one shared constant/decorator imported everywhere.
- **Evidence:**
  - `apps/admin-api-service/src/auth/password-reset.controller.ts:45-47 (local IS_PUBLIC_KEY + local Public definition)`
  - `apps/admin-api-service/src/decorators/public.decorator.ts:3-4 (canonical definition)`
  - `apps/admin-api-service/src/guards/platform-admin.guard.ts:55,80-87 (guard's own IS_PUBLIC_KEY export + reflector read)`
  - `libs/backend-common/src/metrics/metrics.controller.ts:13-19 (documents the cross-package string coupling explicitly)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-372 [LOW] Unauthenticated Prometheus /metrics endpoint exposed on the container network

- **Status:** PENDING
- **Symptom:** ServiceMetricsModule mounts backend-common's MetricsController at /metrics (excluded from the api/v1 global prefix) with a class-level @Public(), so PlatformAdminGuard is bypassed by design (OBS-HIGH-001). It is not internet-reachable through droplet nginx (which only proxies /api/, /health/, etc.), but any workload on the shared docker network can scrape admin-api's operational metrics (route timings, error counts) with no auth token. Acceptable as a deliberate trade-off; noted for completeness since this is the only fully unauthenticated non-probe surface in the service.
- **Evidence:**
  - `libs/backend-common/src/metrics/metrics.controller.ts:29-31 (@Controller('metrics') @Public()) and :25-27 (excluded from global prefix, reachable at /metrics)`
  - `apps/admin-api-service/src/app.module.ts:215-218 (ServiceMetricsModule registered)`
  - `infrastructure/nginx/droplet.conf:309-319,377-385 (no external route to bare /metrics)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-373 [LOW] CORS allowlist drift: dead X-Impersonate-User header allowed; X-CSRF-Token not allowed

- **Status:** PENDING
- **Symptom:** admin-api's bootstrap adds 'X-Impersonate-User' to the CORS allowedHeaders, but a repo-wide grep shows nothing anywhere reads that header (impersonation works through /impersonation REST endpoints + JWT, not a header) — a misleading remnant implying header-based impersonation exists. Conversely 'X-CSRF-Token' is absent from both DEFAULT_CORS_HEADERS and admin-api's additions, so if the admin panel were ever served cross-origin, every mutating request carrying the CSRF header would fail preflight. Both are moot in the current same-origin nginx topology but represent config drift on a security-sensitive surface.
- **Evidence:**
  - `apps/admin-api-service/src/main.ts:31-35 (additionalCorsHeaders: X-Tenant-ID, X-Request-ID, X-Impersonate-User — no X-CSRF-Token)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:232-238 (DEFAULT_CORS_HEADERS lacks X-CSRF-Token) and :386-394 (merge into allowedHeaders)`
  - `repo-wide grep for 'X-Impersonate-User': single match = apps/admin-api-service/src/main.ts:34 (no consumer exists)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-374 [LOW] AdminBypassRlsInterceptor wraps ALL requests — including unauthenticated @Public routes — in RLS bypass

- **Status:** PENDING
- **Symptom:** The APP_INTERCEPTOR AdminBypassRlsInterceptor runs BypassRlsService.withBypass() on every request so cross-schema admin reads succeed. Because it is unconditional, the unauthenticated @Public endpoints (health probes, /auth/forgot-password, /auth/reset-password) also execute with app.bypass_rls granted. Today those handlers only touch NATS or the health DB ping, so nothing is exploitable — but pre-auth code paths running with row-level-security disabled by default is a defense-in-depth inversion: a future public endpoint that touches TypeORM would silently inherit tenant-RLS bypass. Tier-2 fix: skip the bypass wrap when the 'isPublic' metadata is set.
- **Evidence:**
  - `apps/admin-api-service/src/app.module.ts:295-304 (APP_INTERCEPTOR AdminBypassRlsInterceptor, 'EVERY request automatically runs inside BypassRlsService.withBypass()')`
  - `apps/admin-api-service/src/app.module.ts:244-260 (RlsModule.forPoolService rationale — bypass exists for cross-tenant reads, not for pre-auth paths)`
  - `apps/admin-api-service/src/auth/password-reset.controller.ts:74-76,109-111 (@Public pre-auth endpoints covered by the interceptor)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-375 [LOW] Coverage summary (provable): all 35 HTTP controllers sit behind global PlatformAdminGuard (RS256 JWT + SUPER_ADMIN) with no widening path; only intended @Public escapes exist

- **Status:** PENDING
- **Symptom:** Positive attestation for auditability. app.module.ts registers PlatformAdminGuard as the first APP_GUARD and ThrottlerGuard second, so every route in the service requires a valid RS256 access token (issuer/audience/type enforced via getJwtVerifyOptions + enforceAccessTokenType) AND a SUPER_ADMIN role unless explicitly marked isPublic. Role widening is structurally impossible: the guard filters any @Roles(...) decoration down to SUPER_ADMIN and re-adds SUPER_ADMIN if the filter empties (platform-admin.guard.ts:151-159); even decorators/roles.decorator.ts's AllowAuthenticated resolves to Roles('SUPER_ADMIN'). Fully guarded with zero @Public/skip escapes (verified by decorator grep over every non-test controller): analytics, reports, audit-logs, billing, database/{backups,explorer,migrations,monitoring,schemas}, impersonation + debug (both ALSO carry explicit class-level @UseGuards(PlatformAdminGuard); debug additionally requires ENABLE_DEBUG_TOOLS=true via DebugToolsModule.forRoot() and nginx returns 404 for /api/debug in production), messaging, system (metrics), modules, security/{activities,audit,compliance,monitoring}, settings + settings/{email-templates,ip-access,tenant}, support/{announcements,messages,onboarding,tickets}, system/{errors,settings,jobs,performance} (global-settings' former @Public on provisioning-config was removed per SEC-M19), tenants + admin/tenants, users. Intentional @Public surfaces: health GET probes (live/ready//startup — read-only) and the two password-reset POSTs (pre-auth by nature, IP-throttled 3/hr). The only non-HTTP @Controller is the NATS tenant-onboarding-ack handler (@MessagePattern, no HTTP route). ThrottleSensitive/ThrottleExport are present on the highest-risk mutations (billing subscription/invoice ops, DB-explorer DML + raw query + export, impersonation session lifecycle, settings writes, tenant bulk-suspend/activate/erasure/reconcile, users/invite).
- **Evidence:**
  - `apps/admin-api-service/src/app.module.ts:277-290 (PlatformAdminGuard provider + APP_GUARD useExisting, then ThrottlerGuard)`
  - `apps/admin-api-service/src/guards/platform-admin.guard.ts:59,151-177 (DEFAULT_ADMIN_ROLES=SUPER_ADMIN; decorated roles filtered to SUPER_ADMIN only — cannot widen)`
  - `apps/admin-api-service/src/decorators/roles.decorator.ts:27-34 (PlatformAdminOnly and AllowAuthenticated both resolve to SUPER_ADMIN)`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:280-281 and impersonation/controllers/debug-tools.controller.ts:369-370 (explicit @UseGuards(PlatformAdminGuard))`
  - `apps/admin-api-service/src/debug-tools/debug-tools.module.ts:53-61 (ENABLE_DEBUG_TOOLS gate) + infrastructure/nginx/droplet.conf:198-200 (/api/debug returns 404 in production)`
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:674-681 (SEC-M19: @Public removed from provisioning-config)`
  - `apps/admin-api-service/src/health/health.controller.ts:55-56,67-68,98-99,127-128 (the only GET @Public probes) and auth/password-reset.controller.ts:74-76,109-111 (the only POST @Public, IP-throttled)`
  - `apps/admin-api-service/src/tenant/handlers/tenant-onboarding-ack.handler.ts:10 (sole non-HTTP @Controller — NATS message pattern)`
  - `Decorator sweep across all 35 controller files (grep @Controller/@UseGuards/@Public/@Throttle/@Roles): no other isPublic or skip-auth metadata exists outside tests`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).
