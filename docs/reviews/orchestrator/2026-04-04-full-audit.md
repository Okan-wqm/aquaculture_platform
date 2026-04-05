# Full Codebase Audit Report

**Date:** 2026-04-04
**Auditor:** Review Orchestrator (13-domain parallel audit)
**Scope:** Entire Aquaculture IoT SaaS Platform
**Commit:** 7c0ce694

---

## Executive Summary

The Aquaculture IoT SaaS platform demonstrates **strong security posture** across most domains. The codebase exhibits well-implemented tenant isolation, defense-in-depth security patterns, and proper CQRS/event-sourcing architecture. No critical blocking issues were identified. Several HIGH-severity items warrant attention before production hardening.

### Decision: **PASS WITH CONDITIONS**

- **CRITICAL:** 0
- **HIGH:** 4
- **MEDIUM:** 12
- **LOW:** 9

**Deployment Conditions:**
1. Resolve all HIGH findings before next production release
2. Schedule MEDIUM findings for the next 2 sprints

---

## Domain Reports

### 1. AUTH & SECURITY (auth-service, gateway-api, backend-common)

**Overall Grade: A-**

#### Strengths
- JWT tokens use explicit algorithm restriction (`HS256`) preventing algorithm confusion attacks (`auth.guard.ts:189`)
- Token blacklisting implemented with Redis-backed store and in-memory fallback
- PII removed from JWT payloads (H-08 fix) -- only `sub`, `role`, `tenantId` included (`token.service.ts:173-182`)
- Refresh tokens hashed with bcrypt before storage (`token.service.ts:197-199`)
- Token type discriminator (`type: 'access' | 'refresh' | 'mfa_challenge'`) prevents token confusion
- Session limits enforced per user (`maxSessionsPerUser`)
- Timing-safe comparison used for Stripe webhook signatures (`stripe-webhook.controller.ts:233`)

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| AUTH-H1 | **HIGH** | JWT audience validation is conditional -- tokens without `aud` claim pass validation. Should reject tokens missing audience in production. | `apps/gateway-api/src/guards/auth.guard.ts` | 204-210 |
| AUTH-H2 | **HIGH** | JWT issuer validation is also conditional -- tokens without `iss` claim are accepted. | `apps/gateway-api/src/guards/auth.guard.ts` | 196-200 |
| AUTH-M1 | MEDIUM | Schema name interpolated into SQL via string template. Validation regex is applied but the pattern uses `${schemaName}` in template literal for query construction. | `apps/auth-service/src/modules/authentication/services/token.service.ts` | 321-328 |
| AUTH-M2 | MEDIUM | Module cache (`moduleCache`) in TokenService has no upper bound on map size. Could grow unbounded with many users. | `apps/auth-service/src/modules/authentication/services/token.service.ts` | 112-116 |
| AUTH-L1 | LOW | `jwtIssuer` defaults to `'aquaculture-platform'` -- should be explicitly required in production via env var. | `apps/gateway-api/src/guards/auth.guard.ts` | 94 |

---

### 2. TENANT ISOLATION (gateway-api, backend-common)

**Overall Grade: A**

#### Strengths
- `TenantIsolationGuard` validates UUID format to prevent injection (`tenant-isolation.guard.ts:282-284`)
- Cross-tenant access attempts logged with audit trail (`tenant-isolation.guard.ts:263-271`)
- `TenantAwareRepository` extracts tenant ID only from JWT-verified sources -- X-Tenant-Id header explicitly excluded (`tenant-aware.repository.ts:60-73`)
- Row-Level Security (RLS) implemented via `TenantRlsService` with parameterized `set_config` (`tenant-rls.service.ts:126-129`)
- `executeRaw` uses transaction-scoped `SET LOCAL` to prevent search_path leakage (`tenant-aware.repository.ts:383-388`)
- `getRepository()` throws error by design -- forces callers to use `getScopedRepository()` or explicitly opt into `getUnfilteredRepository()` (`tenant-aware.repository.ts:269-275`)
- PII redacted from cross-tenant access logs (H-14 fix)

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| TEN-M1 | MEDIUM | Rate limit guard uses JWT `tenantId` for elevated limits, but the key generation function includes `request.tenantId` as fallback which could come from middleware-set header values. | `apps/gateway-api/src/guards/rate-limit.guard.ts` | 357 |
| TEN-L1 | LOW | `TenantIsolationGuard` accepts both `user.roles` (array) and `user.role` (singular) for admin check, creating two code paths. Should consolidate to single pattern. | `apps/gateway-api/src/guards/tenant-isolation.guard.ts` | 94 |

---

### 3. MESSAGING & AI (messaging-service, ai-service)

**Overall Grade: A-**

#### Strengths
- Transactional outbox pattern correctly implemented with polling, retry, and dead-letter queue (`outbox-worker.service.ts`)
- GDPR compliance: export with chunked pagination (OOM prevention), anonymization in single transaction with legal hold check (`gdpr.service.ts`)
- Password verification via NATS before data anonymization
- AI tool executor enforces permission checks before execution (`tool-executor.service.ts:39-50`)
- AI tools have `requiresConfirmation` flag for actuation tools
- Rate limiting on GDPR exports (24h cooldown via Redis)
- Message partitioning service exists for scalability

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| MSG-H3 | **HIGH** | GDPR export queries (`exportMyMessages`) use raw SQL without tenant filtering on `channel_members`, `message_receipts`, and `message_reactions` tables. While `userId` provides some scoping, a user could theoretically access data from channels across tenants if they had the same userId. | `apps/messaging-service/src/gdpr/gdpr.service.ts` | 162-177 |
| MSG-M1 | MEDIUM | Outbox worker uses `processing` boolean flag for concurrency control, which is not atomic in clustered deployments. Multiple instances could poll simultaneously. | `apps/messaging-service/src/outbox/outbox-worker.service.ts` | 32 |
| MSG-M2 | MEDIUM | AI tool audit logging is a TODO -- `tool-executor.service.ts:84` says "Write to tool_execution_audit table when AuditService is implemented." | `apps/ai-service/src/tools/core/tool-executor.service.ts` | 84 |
| MSG-L1 | LOW | Outbox cleanup deletes all published events older than 7 days without tenant isolation filter. | `apps/messaging-service/src/outbox/outbox-worker.service.ts` | 109 |

---

### 4. SENSOR & EDGE (sensor-service)

**Overall Grade: A-**

#### Strengths
- Comprehensive protocol adapter architecture (40+ industrial protocols: Modbus, OPC-UA, PROFINET, EtherNet/IP, etc.)
- VFD (Variable Frequency Drive) safety: risk evaluator service with parameter risk rules
- TimescaleDB hypertables and continuous aggregates properly configured
- Input sanitizer service exists for sensor data validation
- MQTT authentication service with separate auth controller
- Edge device provisioning with tenant-scoped provisioning keys
- Credential vault with encryption transformer for stored secrets

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| SEN-M1 | MEDIUM | `validation.service.ts` appears to be empty (1 line). Sensor data validation may not be active at the ingestion boundary. | `apps/sensor-service/src/ingestion/validation.service.ts` | 1 |
| SEN-M2 | MEDIUM | SCADA package deployment lacks explicit tenant isolation check in the deployment log service. | `apps/sensor-service/src/process/services/scada-deploy-log.service.ts` | N/A |
| SEN-L1 | LOW | MQTT listener service should validate topic format to prevent topic injection on incoming messages. | `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` | N/A |

---

### 5. FARM SERVICE (farm-service)

**Overall Grade: A**

#### Strengths
- Batch lifecycle properly transactional with query runner and explicit rollback (`create-batch.handler.ts:87-352`)
- Domain events published AFTER transaction commit (not inside transaction) -- correct pattern (`create-batch.handler.ts:354-379`)
- Species-based FCR calculation with user override capability
- Tank biomass and capacity tracking with over-capacity detection
- Code generation service for batch numbering

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| FARM-M1 | MEDIUM | Species lookup (`findOne`) before transaction does not use `SELECT FOR UPDATE`, so concurrent batch creation could use stale species data. Low risk since species data changes infrequently. | `apps/farm-service/src/batch/handlers/create-batch.handler.ts` | 52-56 |
| FARM-L1 | LOW | Batch number fallback (`B-${new Date().getFullYear()}-${Date.now()}`) is not guaranteed unique across concurrent requests. | `apps/farm-service/src/batch/handlers/create-batch.handler.ts` | 66 |

---

### 6. DATA & SCHEMA (backend-common, database/migrations)

**Overall Grade: A-**

#### Strengths
- Schema manager validates all SQL identifiers with regex before interpolation
- Tenant schema names derived from UUID with strict format validation (`tenant_[a-f0-9]{16}`)
- Module schema definitions maintained as single source of truth (`MODULE_SCHEMAS`)
- Watchdog services: cross-tenant probe, schema drift detector, source schema scanner
- RLS policies use `COALESCE(current_setting('app.current_tenant', true), '')::uuid` pattern -- empty string fails UUID cast ensuring no rows leak

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| DATA-M1 | MEDIUM | `SchemaManagerService` is ~1,400 lines (acknowledged in code comments as TODO). Should be decomposed for maintainability and reduced blast radius during changes. | `libs/backend-common/src/database/schema-manager.service.ts` | 1-8 |

---

### 7. FRONTEND (web/shell, shared-ui, modules, aquamobil)

**Overall Grade: B+**

#### Strengths
- `dangerouslySetInnerHTML` is explicitly documented as avoided (`ApiError.tsx:23`)
- SCADA scripting engine runs user code in a Web Worker sandbox, not on the main thread
- Worker uses `new Function()` (not `eval()`) with restricted scope (`workerScript.ts:16-22`)
- Module Federation with proper cache control (remoteEntry.js = no-cache, assets = immutable)

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| FE-L2 | LOW | `dangerouslySetInnerHTML` is mentioned only in a warning comment (SEC-008). Actual rendering uses safe React JSX text interpolation. No XSS risk -- good defensive coding practice documented. | `web/modules/tenant-admin/src/pages/TenantAnnouncementsPage.tsx` | 479 |
| FE-M1 | MEDIUM | SCADA scripting worker sandbox uses `new Function()` constructor. While isolated in a worker, the sandbox should be hardened with a Content Security Policy that blocks `new Function()` escape attempts. Code at `workerScript.ts:267` acknowledges this. | `web/modules/sensor-module/src/engine/scripting/workerScript.ts` | 242 |

---

### 8. INFRASTRUCTURE (docker-compose, nginx, CI/CD, Helm)

**Overall Grade: A**

#### Strengths
- Docker Compose uses env-var substitution for all passwords -- no hardcoded secrets
- Per-service database passwords supported (SEC-015)
- Redis requires authentication (`--requirepass`)
- Redis healthcheck uses `REDISCLI_AUTH` env var to avoid password in process list (SEC-014)
- NATS monitoring port bound to localhost only (SEC-009)
- Nginx: TLS 1.2+ only, strong cipher suite, HSTS with preload, OCSP stapling
- CSP properly configured: no `unsafe-eval`, no `unsafe-inline` for script-src in production
- All GitHub Actions pinned to full commit SHAs (SEC-CI-002)
- CI concurrency groups prevent parallel runs
- Permissions-Policy header blocks geolocation, camera, microphone, payment

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| INF-M1 | MEDIUM | `docker-compose.yml` MinIO uses `minioadmin`/`minioadmin` as default credentials. While behind env-var substitution, the fallback defaults are insecure. | `docker-compose.yml` | 84-85 |
| INF-L1 | LOW | Nginx config uses wildcard `server_name _` instead of explicit domain. Should be restricted to known domains in production. | `nginx/nginx.conf` | 76 |

---

### 9. PLATFORM SERVICES (billing, notification, config, event-store)

**Overall Grade: A**

#### Strengths
- Stripe webhook signature verification implemented from scratch using HMAC-SHA256 with timing-safe comparison (`stripe-webhook.controller.ts:188-246`)
- Replay attack prevention via timestamp skew check (5-minute window)
- Redis-based idempotency for webhook events (72h TTL)
- Config service encryption uses AES-256-GCM with authenticated encryption
- Encryption key validation: hex format for direct use or scrypt derivation
- Production mode requires `CONFIG_ENCRYPTION_KEY` (throws on missing)
- Event store service has internal API key guard

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| PLAT-M1 | MEDIUM | Encryption service derives salt from hash of master key (`sha256(masterKey)`) for scrypt. Static salt derivation means identical master keys always produce identical derived keys. Should use random salt stored alongside. | `apps/config-service/src/configuration/services/encryption.service.ts` | 38 |

---

### 10. HR SERVICE (hr-service)

**Overall Grade: A-**

#### Strengths
- Employee entity uses `@HideField()` for sensitive data: `dateOfBirth`, `nationalId`, `baseSalary`, `bankDetails` (`employee.entity.ts`)
- `BankDetails` class deliberately NOT decorated with `@ObjectType()` -- prevents GraphQL exposure
- Input sanitization via `@BeforeInsert`/`@BeforeUpdate` hooks (email normalization, name trimming)
- Composite indexes include `tenantId` for efficient tenant-scoped queries
- Certification expiry tracking service for compliance
- Work rotation system with offshore/onshore classification

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| HR-L1 | LOW | `emergencyInfo` containing medical conditions and blood type is hidden via `@HideField()` but stored as plain JSONB. Consider encryption at rest for this PII. | `apps/hr-service/src/hr/entities/employee.entity.ts` | 283-284 |

---

### 11. ADMIN SERVICE (admin-api-service)

**Overall Grade: A-**

#### Strengths
- Impersonation security: explicit tenant whitelist (fail-closed if empty), rate limiting, session ownership checks, token hashing (SHA-256), permission intersection (request can only restrict, never expand)
- Database explorer: restricted to `ALLOWED_SCHEMAS` (public, auth, admin, billing), module tables excluded
- Sensitive column masking always applied (C12 fix -- `includeSensitive` option removed)
- Platform admin guard required for all admin endpoints
- Graceful shutdown service for clean termination

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| ADM-H5 | **HIGH** | Impersonation `endImpersonation` error message contains Turkish text (`'Bu oturumu sonlandirma yetkiniz yok'`). Error messages should be in English for consistency and should not leak locale information. Same issue in `extendSession`. | `apps/admin-api-service/src/impersonation/services/impersonation.service.ts` | 459, 530 |
| ADM-L1 | LOW | `notifyTenantAdmin` is a stub (logs only). The `notifyTenantAdmin` flag defaults to `false` as noted by LOW-003 fix. Should be fully implemented for production. | `apps/admin-api-service/src/impersonation/services/impersonation.service.ts` | 875-879 |

---

### 12. EDGE GATEWAY (sens-api-gateway, Rust)

**Overall Grade: A**

#### Strengths
- SQLite offline queue with SQLCipher encryption using HMAC-SHA256 derived key from machine-id + device-local secret
- Secret key file created with `mode(0o400)` and `create_new(true)` to prevent TOCTOU race
- TLS certificate expiry monitoring with in-process x509 parsing (no subprocess spawning)
- Private key file permission validation (rejects world/group-readable)
- Log sanitization: control characters filtered, length capped at 1000 chars
- Secret masking: shows only first/last 4 chars, UTF-8 safe
- MQTT client ID includes random UUID to prevent session hijacking
- Oversized MQTT payload rejection (1 MiB limit)
- Backpressure handling with retry logic on channel full
- Exponential backoff for MQTT reconnection
- Monotonic time used for rate limiting (NTP-safe)
- Comprehensive IEC 62443 SL2 compliance documentation

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| EDGE-L1 | LOW | `unwrap()` calls exist in test code only (not in production paths). Production code properly uses `?` operator and `Result` types. No safety concern. | `sens-api-gateway/src/offline_queue.rs` | 1285+ |

---

### 13. TEST & BUILD HEALTH

**Overall Grade: B+**

#### Strengths
- E2E tests cover security scenarios: tenant isolation, RBAC escalation, rate limiting, GraphQL limits, header spoofing, CSRF, token lifecycle
- Integration tests for schema provisioning, data isolation chain, permission propagation
- Unit tests for guards, middleware, interceptors (auth guard, tenant isolation, rate limit, OPA policy, etc.)
- Farm service has batch lifecycle and tank operations integration tests
- Sensor service has VFD, calibration, data quality unit tests
- HR service has scheduling conflict detection, overtime calculator, payroll tests
- CI runs on both `ci-affected` (PR) and `ci-full` (weekly/release) pipelines

#### Findings

| ID | Severity | Finding | File | Line |
|----|----------|---------|------|------|
| TEST-M1 | MEDIUM | `validation.service.ts` in sensor-service is empty (1 line). No validation tests exist for this service. | `apps/sensor-service/src/ingestion/validation.service.ts` | 1 |
| TEST-L1 | LOW | AI tool audit logging has no implementation (TODO comment). No tests exist for audit trail of AI tool executions. | `apps/ai-service/src/tools/core/tool-executor.service.ts` | 84 |

---

## Cross-Domain Issues

### 1. Tenant Isolation Consistency
The platform uses three complementary isolation mechanisms: (a) JWT-derived tenant ID in application layer, (b) PostgreSQL RLS policies, and (c) per-tenant schema separation. This defense-in-depth approach is excellent. However, the GDPR service in messaging uses raw SQL queries that bypass the `TenantAwareRepository` pattern (MSG-H3). This should be addressed.

### 2. Error Message Localization
Turkish error messages appear in the impersonation service (ADM-H5). The codebase should standardize on English for all error messages, with i18n handled at the presentation layer.

### 3. Schema Manager Decomposition
At ~1,400 lines, the `SchemaManagerService` is a monolith that touches provisioning, migration, search path management, and introspection. A fault in any of these areas affects all of them. The recommended decomposition is already documented in code comments.

---

## Security Posture Summary (OWASP Top 10)

| OWASP Category | Status | Notes |
|----------------|--------|-------|
| A01 - Broken Access Control | **STRONG** | Tenant isolation guard, RLS, JWT validation, RBAC |
| A02 - Cryptographic Failures | **STRONG** | AES-256-GCM encryption, bcrypt hashing, TLS 1.2+ |
| A03 - Injection | **STRONG** | Parameterized queries, SQL identifier validation, input sanitization |
| A04 - Insecure Design | **GOOD** | CQRS/event sourcing, defense-in-depth, fail-closed defaults |
| A05 - Security Misconfiguration | **GOOD** | Security headers, CSP, HSTS, server info removal |
| A06 - Vulnerable Components | **GOOD** | Snyk + Trivy scanning in CI, pinned action SHAs |
| A07 - Authentication Failures | **STRONG** | MFA, WebAuthn, session limits, token blacklisting |
| A08 - Data Integrity Failures | **GOOD** | Stripe webhook HMAC verification, outbox pattern |
| A09 - Logging Failures | **GOOD** | Structured logging, audit trails, PII masking |
| A10 - SSRF | **ADEQUATE** | No evidence of user-controlled URL fetching in backend services |

---

## STRIDE Threat Model Summary

| Threat | Mitigation Status |
|--------|-------------------|
| **Spoofing** | JWT + MFA + WebAuthn; MQTT mTLS; API key + Basic auth strategies |
| **Tampering** | Stripe HMAC; event store immutability; database transactions |
| **Repudiation** | Comprehensive audit logging; impersonation action logging; compliance audit |
| **Information Disclosure** | PII removed from JWTs; @HideField on sensitive entities; log sanitization; column masking |
| **Denial of Service** | Rate limiting (per-user/tenant/IP); fail-closed Redis; bounded queues; GraphQL alias limiting |
| **Elevation of Privilege** | RBAC guards; permission intersection for impersonation; platform admin guard |

---

## Recommended Priority Actions

### Immediate (Before Next Release)
1. **AUTH-H1/H2**: Make JWT `aud` and `iss` claims mandatory in production (reject tokens without them)
2. **MSG-H3**: Add tenant filtering to GDPR raw SQL queries in messaging service
3. **ADM-H5**: Standardize error messages to English

### Next 2 Sprints
5. Address all MEDIUM findings (schema manager decomposition, validation service implementation, outbox concurrency, encryption salt, MinIO defaults)
6. Implement AI tool audit logging (MSG-M2/TEST-L1)
7. Implement tenant admin notification for impersonation sessions (ADM-L1)

---

*Report generated by Review Orchestrator on 2026-04-04. All 13 domain audits executed in parallel.*
