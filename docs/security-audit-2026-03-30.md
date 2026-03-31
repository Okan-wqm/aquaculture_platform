# Aquaculture SaaS Platform - Consolidated Security Audit Report

**Date:** 2026-03-30
**Methodology:** 8-agent parallel enterprise security analysis (Opus 4.6)
**Scope:** 15 backend services, 10+ frontend modules, infrastructure, Docker, NGINX, NATS, Redis, PostgreSQL, MQTT
**Overall Rating:** B+ (Good with notable gaps)

---

## Executive Summary

| Severity | Count | Key Risk Areas |
|----------|-------|----------------|
| **CRITICAL** | 14 | Tenant isolation bypass, PostgreSQL trust auth, encryption flaws, unauthenticated services |
| **HIGH** | 18 | NATS auth disabled, JWT mismatches, missing depth limits, PII in logs/tokens, CORS wildcard |
| **MEDIUM** | 22 | Docker image pinning, TLS gaps, rate limit bypass, CSRF inconsistency, source maps |
| **LOW** | 16 | SHA-1/MD5 usage, dev-mode risks, minor info leakage |

**Positive Controls:** In-memory token storage, bcrypt with timing-safe ops, schema-per-tenant isolation, global ValidationPipe, Helmet headers, SCADA sandbox, CrossTenantProbe watchdog, event sourcing, token blacklisting, file upload magic-byte validation.

---

## P0 - CRITICAL Findings (Fix Immediately)

### C-01: PostgreSQL Trust Authentication Bypass
- **Domain:** Infrastructure
- **File:** `infrastructure/docker/init-scripts/00-trust-auth.sh:3`
- **Description:** `host all all 0.0.0.0/0 trust` allows ANY connection without password. Mounted by ALL compose files.
- **Impact:** Complete database access bypass if script runs on production.
- **Remediation:** Delete this file or guard with `NODE_ENV != production`. Never mount in production init-scripts volume.

### C-02: Hardcoded CREDENTIAL_ENCRYPTION_KEY in Production Compose
- **Domain:** Infrastructure
- **File:** `docker-compose.droplet.yml:395`
- **Description:** Default hex key `233cdc92caa...` used if env var not set. Publicly visible in repo.
- **Impact:** All stored edge device MQTT credentials decryptable by anyone reading the repo.
- **Remediation:** Change to `${CREDENTIAL_ENCRYPTION_KEY:?CREDENTIAL_ENCRYPTION_KEY required}` (no default).

### C-03: @Tenant Decorator Trusts Untrusted Sources
- **Domain:** Tenant Isolation
- **File:** `libs/backend-common/src/decorators/tenant.decorator.ts:34-47`
- **Description:** Falls back to `X-Tenant-Id` header, query param, and request body. Combined with `@SkipTenantGuard()`, attacker can inject any tenantId.
- **Impact:** Cross-tenant data access on any endpoint using `@SkipTenantGuard()` + `@Tenant()`.
- **Remediation:** `@Tenant` must ONLY extract from `req.user.tenantId` (JWT claim). Remove all fallbacks.

### C-04: TenantGuard Accepts Query/Body tenantId
- **Domain:** Tenant Isolation
- **File:** `libs/backend-common/src/guards/tenant.guard.ts:113-124`
- **Description:** `extractTenantId()` accepts tenantId from `request.query` and `request.body` as fallback sources.
- **Impact:** Token refresh race conditions or SUPER_ADMIN without explicit tenantId could have body-supplied tenantId accepted.
- **Remediation:** For non-SUPER_ADMIN, ONLY accept `req.user.tenantId`. Remove query/body fallbacks.

### C-05: RLS Not Enabled on Any Table
- **Domain:** Tenant Isolation
- **File:** `libs/backend-common/src/database/rls/tenant-rls.service.ts` (exists but unused)
- **Description:** `TenantRlsService` infrastructure exists but no `ALTER TABLE ENABLE ROW LEVEL SECURITY` in any migration. No database-level safety net.
- **Impact:** Any bug in search_path management directly exposes cross-tenant data.
- **Remediation:** Create migration enabling RLS + FORCE RLS on ALL tenant-scoped tables. Create policies using `USING ("tenantId" = current_setting('app.current_tenant')::uuid)`.

### C-06: Messaging Queries Missing Tenant Filter
- **Domain:** Tenant Isolation
- **File:** `apps/messaging-service/src/message/queries/get-messages.handler.ts:77-81`
- **Description:** Queries by `channelId` only, no `tenantId` filter. Channel membership check also lacks tenant filter.
- **Impact:** Cross-tenant message reading if channelId is known/guessed.
- **Remediation:** Add `tenantId` WHERE clause to ALL messaging query handlers and membership checks.

### C-07: Knowledge Extraction Queries ALL Tenants
- **Domain:** Tenant Isolation
- **File:** `apps/messaging-service/src/ai/services/knowledge-extraction.service.ts:110-119`
- **Description:** `runBatch()` queries messages table without tenant filter. Extracted knowledge not properly tenant-scoped.
- **Impact:** Cross-tenant data leakage through AI knowledge entries.
- **Remediation:** Process per-tenant using schema iteration pattern (same as cron jobs).

### C-08: event-store-service Has No Authentication
- **Domain:** API Surface
- **File:** `apps/event-store-service/src/event-store/event-store.controller.ts:52`
- **Description:** No `APP_GUARD` registered. Only manual `x-tenant-id` UUID format check. No identity verification.
- **Impact:** Any container on the network can read/write/delete ANY tenant's event streams.
- **Remediation:** Register global APP_GUARD (ServiceIdentityGuard + JwtAuthGuard + TenantGuard).

### C-09: Unauthenticated NATS Service Impersonation
- **Domain:** API Surface
- **File:** All NATS `@MessagePattern`/`@EventPattern` handlers
- **Description:** NATS handlers have no authentication. ServiceIdentityGuard only validates HTTP headers, not NATS.
- **Impact:** Any compromised container can send `events.UserDeleted`, `events.TenantProvisioned`, etc.
- **Remediation:** Implement HMAC-signed NATS payloads or NATS account-level ACLs per service.

### C-10: Static Salt in scrypt KDF (admin-api-service)
- **Domain:** Cryptography
- **File:** `apps/admin-api-service/src/settings/services/system-setting.service.ts:938-939`
- **Description:** Literal `'salt'` string as scrypt salt. Same in `tenant-configuration.service.ts:694-696` with hardcoded fallback key.
- **Impact:** Identical master keys always derive same encryption key. Precomputation attacks enabled.
- **Remediation:** Random 16-byte salt per encryption. Store alongside ciphertext. Remove hardcoded fallback keys.

### C-11: AES-256-CBC Without Authentication (Padding Oracle)
- **Domain:** Cryptography
- **File:** `apps/admin-api-service/src/settings/services/system-setting.service.ts:938` + 3 more locations
- **Description:** CBC mode without HMAC/GCM. Vulnerable to padding oracle attacks.
- **Impact:** Ciphertext modification can lead to full decryption.
- **Remediation:** Migrate to AES-256-GCM (pattern already correct in config-service `EncryptionService`).

### C-12: Math.random() for Discount Code Generation
- **Domain:** Cryptography
- **File:** `apps/admin-api-service/src/billing/services/discount-code.service.ts:487`
- **Description:** Non-cryptographic PRNG for discount codes.
- **Impact:** Predictable codes; brute-force enumeration of valid discounts.
- **Remediation:** Replace with `crypto.randomInt(0, chars.length)`.

### C-13: EXPLAIN Query SQL Injection
- **Domain:** Injection
- **File:** `apps/admin-api-service/src/database-management/services/database-monitoring.service.ts:618`
- **Description:** User-supplied query concatenated into `EXPLAIN (FORMAT JSON) ${query}`. Blocklist bypassable.
- **Impact:** Full SQL injection via EXPLAIN endpoint.
- **Remediation:** Allowlist-based parse-tree validation. Execute in `SET TRANSACTION READ ONLY`.

### C-14: OAuth Access Tokens Exposed to Frontend
- **Domain:** Data Security
- **File:** `apps/farm-service/src/sentinel-hub/entities/sentinel-hub-settings.entity.ts:97-115`
- **Description:** Raw Sentinel Hub OAuth2 `accessToken` returned via GraphQL to browser.
- **Impact:** XSS can exfiltrate tokens; direct API reuse by attackers.
- **Remediation:** Proxy CDSE API calls through backend. Never expose raw OAuth tokens to frontend.

---

## P1 - HIGH Findings (Fix Before Next Deploy)

### H-01: NATS Authentication Disabled
- **File:** `infrastructure/docker/nats/nats.conf:30-45` (auth block commented out)
- **Remediation:** Uncomment auth block. Mount `nats-auth-enabled.conf` in production. Switch droplet compose from CLI flags to config file.

### H-02: Wildcard CORS on /remotes/ in Production NGINX
- **File:** `infrastructure/nginx/droplet.conf:305-362` (`Access-Control-Allow-Origin *`)
- **Remediation:** Replace `*` with `$cors_origin` map (already exists in nginx.prod.conf).

### H-03: JWT `type` Claim Missing (Auth-Service vs Gateway Mismatch)
- **File:** `apps/auth-service/src/modules/authentication/services/token.service.ts:148-162`
- **Remediation:** Add `type: 'access'` to JWT payload in auth-service.

### H-04: JWT Audience Default Mismatch
- **File:** Auth-service: `aquaculture-platform`, Gateway: `aquaculture-api`
- **Remediation:** Unify defaults across both services.

### H-05: Missing GraphQL depthLimit on 5 Subgraphs
- **Files:** farm-service, auth-service, billing-service, alert-engine, notification-service
- **Remediation:** Add `validationRules: [depthLimit(10)]` to all 5 services.

### H-06: notification-service No Global APP_GUARD
- **File:** `apps/notification-service/src/app.module.ts`
- **Remediation:** Register ServiceIdentityGuard + TenantGuard + RolesGuard.

### H-07: ai-service ChatController No JWT Guard
- **File:** `apps/ai-service/src/chat/chat.controller.ts:47`
- **Remediation:** Add JwtAuthGuard as global APP_GUARD or controller-level guard.

### H-08: PII in JWT Payload (email, firstName, lastName)
- **File:** `apps/auth-service/src/modules/authentication/services/token.service.ts:26-39`
- **Remediation:** Remove PII from JWT. Downstream services query auth-service when needed.

### H-09: API Keys Stored with Unsalted SHA-256
- **File:** `apps/gateway-api/src/guards/auth.guard.ts:431`
- **Remediation:** Use HMAC-SHA256 with server-side secret.

### H-10: Alias Limit Plugin Mismatches Mutation Names
- **File:** `apps/gateway-api/src/plugins/graphql-alias-limit.plugin.ts:16-22`
- **Description:** References `loginWithCredentials` but actual mutation is `login`.
- **Remediation:** Add `'login'`, `'forgotPassword'`, `'verifyMfaLogin'` to SENSITIVE_MUTATIONS.

### H-11: RequestValidatorMiddleware Not Registered (Dead Code)
- **File:** `apps/gateway-api/src/middleware/request-validator.middleware.ts`
- **Remediation:** Register for REST routes (upload, v2).

### H-12: Messaging Media Download Without Tenant Validation
- **File:** `apps/messaging-service/src/message/services/media.service.ts:142-153`
- **Remediation:** Validate `storageKey.startsWith(\`messaging/\${tenantId}/\`)`.

### H-13: SUPER_ADMIN Cross-Tenant Access Without Audit
- **File:** `libs/backend-common/src/guards/tenant.guard.ts:63-74`
- **Remediation:** Add mandatory audit logging. Require MFA step-up for cross-tenant ops.

### H-14: PII (Emails) Logged in Production (30+ Locations)
- **Files:** auth-service, admin-api-service, notification-service
- **Remediation:** Replace `user.email` with `user.id` or masked form in all log statements.

### H-15: DATABASE_SYNC=true Guard Missing
- **File:** `docker-compose.yml` (7 services)
- **Remediation:** Add startup guard: `if (DATABASE_SYNC === 'true' && NODE_ENV === 'production') throw`.

### H-16: Math.random() for Transaction IDs
- **File:** `apps/admin-api-service/src/billing/services/payment-management.service.ts:190`
- **Remediation:** Use `crypto.randomUUID()`.

### H-17: MFA Secrets Stored Plaintext Without Encryption Key
- **File:** `apps/auth-service/src/modules/authentication/services/mfa.service.ts:630-633`
- **Remediation:** Fail startup in production if `MFA_ENCRYPTION_KEY` not set.

### H-18: GDPR Right-to-Erasure Only in Messaging
- **Files:** auth-service, farm-service, hr-service, billing-service, sensor-service
- **Remediation:** Implement cross-service GDPR erasure orchestrator.

---

## P2 - MEDIUM Findings (Fix Within Sprint)

| # | Domain | Description | File |
|---|--------|-------------|------|
| M-01 | Frontend | Global CSP headers missing at nginx/application level | N/A (not configured) |
| M-02 | Frontend | SRI hash-pinning map empty in Module Federation | `web/shell/src/utils/remoteIntegrity.ts:71-80` |
| M-03 | Frontend | CSRF header missing from shared-ui api-client | `web/shared-ui/src/utils/api-client.ts:382-398` |
| M-04 | Frontend | Source maps enabled in shared-ui production build | `web/shared-ui/vite.config.ts:55` |
| M-05 | Frontend | Dev service worker caches GraphQL responses | `web/apps/aquamobil/dev-dist/sw.js:91-100` |
| M-06 | Infra | Docker base images unpinned (`node:22-alpine`, `nginx:alpine`) | Multiple Dockerfiles |
| M-07 | Infra | CSP `connect-src` allows unencrypted `ws:` in prod | `infrastructure/nginx/droplet.conf:169` |
| M-08 | Infra | Redis dangerous commands not disabled | `infrastructure/docker/redis/redis.conf:34-36` |
| M-09 | Infra | No TLS for Redis/PostgreSQL/NATS internal connections | All compose files |
| M-10 | Infra | PostgreSQL services use shared superuser, not per-service users | docker-compose.droplet.yml |
| M-11 | Auth | Gateway TenantIsolationGuard not registered as global guard | `apps/gateway-api/src/app.module.ts:548-596` |
| M-12 | Auth | enableImplicitConversion:true in auth-service (type confusion risk) | `apps/auth-service/src/main.ts:63` |
| M-13 | Auth | Dynamic schema name interpolated into SQL without validation | `apps/auth-service/src/.../token.service.ts:288-289` |
| M-14 | Auth | No explicit algorithm restriction on HS256 JWT verify | `apps/auth-service/src/app.module.ts:176-183` |
| M-15 | Tenant | NATS subjects not tenant-scoped (payload-only) | All NATS event patterns |
| M-16 | Tenant | Sensor topic cache not tenant-keyed | `apps/sensor-service/src/ingestion/sensor-topic-cache.service.ts:73` |
| M-17 | Tenant | Messaging NATS handler schema injection (weak sanitization) | `apps/messaging-service/src/.../messaging-nats.handler.ts:86-88` |
| M-18 | API | subscribeEdgeIo lacks device ownership verification | `apps/gateway-api/src/websocket/sensor-readings.gateway.ts:326-342` |
| M-19 | API | Admin provisioning config endpoint @Public() override | `apps/admin-api-service/src/.../global-settings.controller.ts:679` |
| M-20 | Injection | Inconsistent search_path sanitization (20+ locations) | Multiple services |
| M-21 | Injection | GraphQL batching protection only on gateway | Subgraph app.module.ts files |
| M-22 | Compliance | 6 services have NO audit logging (billing, HR, hydroponics, notification, config, AI) | Multiple app.module.ts |

---

## P3 - LOW Findings (Scheduled Maintenance)

| # | Description | File |
|---|-------------|------|
| L-01 | SHA-1 for cache keys (3 services) | ai-service, hydroponics-service, messaging-service |
| L-02 | MD5 for non-security hashing (3 services) | gateway-api, farm-service, admin-api |
| L-03 | Math.random() in frontend request ID generation | `web/modules/admin-panel/src/services/http-client.ts:45` |
| L-04 | Math.random() in rate limit member generation | `messaging-service/.../messaging-rate-limit.interceptor.ts:156` |
| L-05 | JWT secret min length constant not shared between services | auth-service vs gateway-api |
| L-06 | /health/detail lacks role-based access control | `apps/gateway-api/src/health/health.controller.ts:124` |
| L-07 | WebSocket CORS allows all origins in development | All 3 WS gateways |
| L-08 | SecurityHeadersMiddleware not registered (dead code) | `apps/gateway-api/src/middleware/security-headers.middleware.ts` |
| L-09 | Timing-unsafe API key comparison in event-store | `apps/event-store-service/src/guards/internal-api-key.guard.ts:44` |
| L-10 | postMessage wildcard origin in FUXA iframe | `web/modules/sensor-module/.../FuxaWidgetRenderer.tsx:75` |
| L-11 | Shared Module Federation dependency versions unpinned | `web/shell/vite.config.ts:33-36` |
| L-12 | NGINX OCSP stapling missing in droplet.conf | `infrastructure/nginx/droplet.conf` |
| L-13 | `style-src 'unsafe-inline'` in CSP | Multiple nginx configs |
| L-14 | Swagger UI can be enabled in prod via env var | `apps/admin-api-service/src/main.ts:122` |
| L-15 | Sensitive field redaction lists inconsistent across audit services | Multiple audit services |
| L-16 | `new Function()` on main thread for expression preview | `web/modules/sensor-module/.../expressionUtils.ts:166` |

---

## Positive Security Controls (Already Implemented Well)

| Area | Grade | Details |
|------|-------|---------|
| **Token Management** | A | In-memory access tokens, httpOnly refresh cookies, token blacklisting, refresh rotation with pessimistic locking |
| **Password Security** | A | bcrypt-12, timing-safe dummy hash, min login duration (200ms), account lockout (5/30min) |
| **Input Validation** | A- | Global ValidationPipe (whitelist+forbidNonWhitelisted) on all 15 services, class-validator DTOs |
| **Error Handling** | A | Production exception filters strip stack traces, sensitive pattern filtering, generic messages |
| **File Upload** | A- | Magic byte validation, path traversal prevention, filename sanitization, tenant-scoped paths |
| **WebSocket Auth** | A | JWT on connect, production query-param rejection, periodic re-auth, tenant-scoped rooms |
| **SCADA Sandbox** | A | Web Worker with global deletion, controlled API surface, rate limiting, prototype pollution guards |
| **Offline Security** | A | AES-GCM with per-session non-extractable keys, logout cleanup of IndexedDB/Cache |
| **Anti-Enumeration** | A | Generic login errors, dummy bcrypt for nonexistent users, constant-time operations |
| **Schema Isolation** | B+ | Per-tenant PostgreSQL schemas, search_path switching, CrossTenantProbe watchdog |
| **Audit Trail** | B | Comprehensive in auth/farm/sensor/messaging/admin; absent in billing/HR/hydroponics |
| **GDPR Compliance** | B | Exemplary in messaging (erasure, export, legal hold); missing in other services |
| **Security Headers** | B+ | Helmet, HSTS, X-Frame-Options, nosniff, Referrer-Policy. Missing global CSP. |
| **Rate Limiting** | B+ | Multi-layer (per-endpoint, mutation, alias). Minor bypass via mutation name mismatch. |

---

## Remediation Roadmap

### Week 1 (P0 Critical)
1. Delete/guard `00-trust-auth.sh`
2. Remove hardcoded CREDENTIAL_ENCRYPTION_KEY default from droplet compose
3. Fix `@Tenant` decorator to only accept JWT-sourced tenantId
4. Fix `TenantGuard.extractTenantId()` to remove query/body fallbacks
5. Add tenantId filter to messaging query handlers
6. Add APP_GUARD to event-store-service
7. Fix AES-256-CBC -> GCM migration in admin-api-service
8. Fix Math.random() in billing/financial code
9. Fix EXPLAIN query injection
10. Proxy Sentinel Hub tokens through backend

### Week 2-3 (P1 High)
11. Enable NATS authentication in production
12. Fix wildcard CORS in droplet.conf
13. Add JWT `type` claim and unify audience defaults
14. Add depthLimit to 5 unprotected subgraphs
15. Add APP_GUARD to notification-service and ai-service
16. Remove PII from JWT payload and log statements
17. Enable RLS on all tenant-scoped tables
18. Implement SUPER_ADMIN audit logging

### Week 4-6 (P2 Medium)
19. Implement global CSP headers
20. Populate SRI hash-pinning map in CI/CD
21. Pin Docker base image versions
22. Enable TLS for Redis/PostgreSQL/NATS
23. Centralize search_path SET operations
24. Add audit logging to remaining 6 services
25. Implement GDPR erasure orchestrator

### Backlog (P3 Low)
26. Replace SHA-1/MD5 with SHA-256
27. Replace Math.random() in non-critical paths
28. Pin Module Federation shared dependency versions
29. Add OCSP stapling to droplet.conf
30. Register dead-code middlewares or remove them

---

*Report generated by 8 parallel security audit agents using Opus 4.6*
*Swarm ID: swarm-1774901415017-w9s9eh*
