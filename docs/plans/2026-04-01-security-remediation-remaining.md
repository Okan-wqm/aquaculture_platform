# Security Audit Remediation Plan -- Remaining Findings

**Date:** 2026-04-01
**Audit Reference:** `/var/aqua-saas/docs/security-audit-2026-03-30.md`
**Scope:** 25 remaining findings (1 P0, 4 P1, ~10 P2, ~10 P3)
**Overall Strategy:** 4 sprints, architectural solutions only

---

## Pre-Planning Assessment: Already Fixed Findings

Before planning, the following findings were verified as already remediated:

**FIXED (14):** H-06, H-11, L-05, L-06, L-07, L-08, L-10, L-12, L-14, M-01, M-06, M-07, M-08, M-22
**PARTIALLY FIXED (3):** L-16 (Web Worker sandbox accepted), M-10 (PG roles created but compose uses shared user), M-18 (format validation + tenant room scoping done, DB ownership check missing)
**WONTFIX (2):** L-13 (`style-src 'unsafe-inline'` required for dynamic styling), L-16 (`new Function()` in Web Worker sandbox)

---

## True Remaining Findings (13 items)

### P0 CRITICAL (1)

| ID | Description | Status |
|----|-------------|--------|
| C-09 | NATS account-level ACLs per service -- HMAC signed but ACLs not configured | REMAINING |

### P1 HIGH (2)

| ID | Description | Status |
|----|-------------|--------|
| H-13 | SUPER_ADMIN cross-tenant access: audit logging exists (`this.logger.warn`), but no persistent audit record via AuditLogModule, and no MFA step-up | REMAINING |
| H-18 | GDPR right-to-erasure orchestrator -- only messaging-service has `GdprService`, auth-service has partial `UserLifecycleService`, but no cross-service orchestrator | REMAINING |

### P2 MEDIUM (5)

| ID | Description | Status |
|----|-------------|--------|
| M-02 | SRI hash-pinning map empty -- `remoteIntegrity.ts` has the map structure and TODO for CI/CD, but CI pipeline not wired | REMAINING |
| M-09 | No TLS for Redis/PostgreSQL/NATS internal connections | REMAINING |
| M-10 | Per-service PG roles exist but compose DATABASE_URL still uses shared `aquaculture` superuser | REMAINING |
| M-15 | NATS subjects not tenant-scoped -- events use flat subjects like `events.UserCreated`, tenant only in payload | REMAINING |
| M-18 | subscribeEdgeIo device ownership verification -- format validated + tenant room scoped, but no database query to confirm device belongs to tenant | REMAINING |

### P3 LOW (5)

| ID | Description | Status |
|----|-------------|--------|
| L-01 | SHA-1 for cache keys in ai-service, hydroponics-service, messaging-service | REMAINING |
| L-02 | MD5 for non-security hashing in gateway-api, farm-service, admin-api | REMAINING |
| L-11 | Shared Module Federation dependency versions use `requiredVersion` range constraints (e.g. `^18.2.0`) but no lockfile pinning | REMAINING |
| L-13 | `style-src 'unsafe-inline'` in CSP -- required for dynamic styling, accepted risk | WONTFIX |
| L-16 | `new Function()` in `workerScript.ts` -- runs inside Web Worker with sandbox restrictions | WONTFIX (accepted risk) |

**Net remaining: 11 actionable findings** (2 accepted as WONTFIX)

---

## Sprint 1: Independent Backend Fixes (No Cross-Service Dependencies)

**Duration:** 2-3 days
**Can start:** Immediately
**Dependencies:** None

### Swarm Configuration

```
topology: hierarchical | agents: 6 | strategy: specialized
Agents: queen(planner), security-1(security-architect: H-13), security-2(security-architect: M-18),
        hash-fix(coder: L-01/L-02), tester, reviewer — all Opus 4.6
```

---

### Finding H-13: SUPER_ADMIN Cross-Tenant Audit + MFA Step-Up

**Complexity:** MEDIUM
**Dependencies:** None
**Estimated time:** 4 hours

#### Current State

The `TenantGuard` at `libs/backend-common/src/guards/tenant.guard.ts:98-108` logs cross-tenant access via `this.logger.warn()`, which writes to stdout only. There is no:
- Persistent audit record in the database via `AuditLogModule`
- MFA step-up requirement for cross-tenant operations
- Structured audit event emission via NATS

#### Files to Modify

1. `libs/backend-common/src/guards/tenant.guard.ts` -- Inject `AuditLogService` and emit a persistent audit record + NATS security event when SUPER_ADMIN accesses a different tenant
2. `libs/backend-common/src/security/security-event.service.ts` -- Add `SUPER_ADMIN_CROSS_TENANT_ACCESS` event type
3. `libs/event-contracts/src/security/security-events.ts` -- Add event contract
4. `libs/backend-common/src/guards/mfa-step-up.guard.ts` (NEW) -- Guard that requires recent MFA verification for sensitive operations
5. `libs/backend-common/src/decorators/require-mfa-stepup.decorator.ts` (NEW) -- Decorator to mark endpoints requiring MFA step-up
6. `apps/auth-service/src/modules/authentication/services/mfa.service.ts` -- Add `verifyRecentMfa(userId, windowMinutes)` method

#### Implementation Approach

1. `MfaStepUpGuard` checks `mfa_verified_at` JWT claim or Redis-cached timestamp. If older than 15min, return 403 `MFA_STEP_UP_REQUIRED`.
2. In `TenantGuard.canActivate()`, inject `AuditLogService.log()` for persistent DB record with userId, sourceTenantId, targetTenantId, endpoint, IP.
3. Emit NATS security event `security.superAdminCrossTenant` for alert-engine.
4. Apply `@RequireMfaStepUp()` decorator to SUPER_ADMIN cross-tenant branch.

---

### Finding M-18: Device Ownership Verification in subscribeEdgeIo

**Complexity:** MEDIUM
**Dependencies:** None
**Estimated time:** 3 hours

#### Current State

`apps/gateway-api/src/websocket/sensor-readings.gateway.ts:332-364` validates device code format and scopes the room to the JWT's `tenantId`, but never queries the database to confirm the device actually belongs to that tenant. A user from Tenant A could subscribe to a device code that happens to exist in Tenant A's database under a different user's site.

#### Files to Modify

1. `apps/gateway-api/src/websocket/sensor-readings.gateway.ts` -- Add device ownership check via a NATS request to sensor-service or a direct database query
2. `apps/sensor-service/src/edge-device/edge-device.service.ts` -- Add `verifyDeviceOwnership(tenantId, deviceCode): Promise<boolean>` method
3. `libs/event-contracts/src/sensor/sensor-queries.ts` (NEW or extend) -- Add `sensor.query.verifyDeviceOwnership` request/response contract

#### Implementation Approach

1. NATS request-reply `sensor.query.verifyDeviceOwnership` with `{ tenantId, deviceCode }` returning `{ owned: boolean }`.
2. In `handleSubscribeEdgeIo`, verify before joining room; reject if `owned === false`.
3. Cache positive results in local Map with 5-minute TTL. Log failures as security events.

---

### Finding L-01/L-02: Replace SHA-1 and MD5 with SHA-256

**Complexity:** LOW
**Dependencies:** None
**Estimated time:** 2 hours

#### Current State

- SHA-1 used for non-security cache keys in `ai-service`, `hydroponics-service`, `messaging-service`
- MD5 used for non-security hashing (ETag generation, cache keys) in `gateway-api`, `farm-service`, `admin-api`

These are non-security uses, but SHA-1 and MD5 are deprecated algorithms that create audit noise and set bad precedents.

#### Files to Modify

1. `apps/ai-service/src/**` -- Replace `createHash('sha1')` with `createHash('sha256')`
2. `apps/hydroponics-service/src/**` -- Same replacement
3. `apps/messaging-service/src/**` -- Same replacement
4. `apps/gateway-api/src/interceptors/cache-control.interceptor.ts` -- Replace `createHash('md5')` with `createHash('sha256')`
5. `apps/farm-service/src/feeding/services/feeding-cron.service.ts` -- Same replacement
6. `apps/admin-api-service/src/system-management/services/global-settings.service.ts` -- Same replacement

#### Implementation Approach

1. Global find-and-replace of `createHash('sha1')` and `createHash('md5')` with `createHash('sha256')` across all application source files.
2. For cache keys that are truncated (e.g., `.digest('hex').substring(0, 16)`), the truncation length can remain the same since SHA-256 output is always >= 64 hex chars.
3. Run existing tests to verify no regressions.

---

## Sprint 2: Cross-Service Architecture Changes

**Duration:** 3-5 days
**Can start:** After Sprint 1
**Dependencies:** Sprint 1 (MFA step-up guard, audit infrastructure)

### Swarm Configuration

```
topology: hierarchical | agents: 8 | strategy: specialized
Agents: queen(planner), nats-arch(security-architect), nats-impl(coder), gdpr-arch(security-architect),
        gdpr-impl(coder), pg-impl(coder), tester, reviewer — all Opus 4.6
```

---

### Finding C-09: NATS Account-Level ACLs Per Service

**Complexity:** HIGH
**Dependencies:** None (infrastructure change)
**Estimated time:** 8 hours

#### Current State

Single shared NATS user/password (`$NATS_USER:$NATS_PASS`) in `nats.conf`. All services share credentials, so any service can publish/subscribe to any subject. HMAC ServiceIdentityGuard covers HTTP only, not NATS handlers.

#### Files to Modify

1. `infrastructure/docker/nats/nats.conf` -- Add multi-account configuration with per-service publish/subscribe permissions
2. `infrastructure/docker/nats/nats-accounts.conf` (NEW) -- Account definitions for each service with subject ACLs
3. `docker-compose.droplet.yml` -- Add per-service NATS credentials as environment variables
4. `docker-compose.yml` -- Same for development
5. `docker-compose.prod.yml` -- Same for production
6. `libs/backend-common/src/nats/nats-connection.factory.ts` (or equivalent) -- Support per-service NATS credentials from env vars
7. All 15 `apps/*/src/app.module.ts` -- Update NATS connection configuration to use service-specific credentials

#### Implementation Approach

1. NATS multi-account model: each service gets its own account with scoped publish/subscribe permissions (e.g., `auth_service` can publish `events.User*`, `events.Auth*`, `security.*` but not `events.Sensor*`). Include `_INBOX.>` for request-reply.
2. Each service reads its own `NATS_USER`/`NATS_PASS` from env vars (already supported by `NatsConnectionFactory`).
3. Principle of least privilege: services can only publish events they own and subscribe to events they consume.
4. Negative test: verify Service A cannot publish Service B's events.

---

### Finding M-15: Tenant-Scoped NATS Subjects

**Complexity:** HIGH
**Dependencies:** C-09 (NATS ACLs should be in place first)
**Estimated time:** 6 hours

#### Current State

Flat NATS subjects (`events.UserCreated`) with tenant only in payload. No subject-level tenant filtering or tenant-aware ACLs possible. Contracts in `libs/event-contracts/src/`.

#### Files to Modify

1. `libs/event-contracts/src/base-event.ts` -- Update subject patterns to include tenant namespace: `events.{tenantId}.UserCreated`
2. `libs/event-contracts/src/tenant-commands.ts` -- Update subject patterns
3. `libs/event-contracts/src/security/security-events.ts` -- Update subject patterns
4. All NATS publishers across 15 services -- Use tenant-scoped subjects
5. All NATS subscribers (currently only `apps/messaging-service/src/event-handlers/messaging-nats.handler.ts`) -- Subscribe with tenant-aware wildcard patterns
6. `infrastructure/docker/nats/nats-accounts.conf` -- Update ACLs to allow `events.*.{EventType}` patterns

#### Implementation Approach

1. Subject convention: `events.{domain}.{tenantId}.{eventType}` (system events: `events.system.{eventType}`).
2. Shared `NatsSubjectBuilder` utility in `libs/backend-common` constructs subjects from domain, tenantId, event type.
3. Subscribers use wildcards: `events.auth.*.UserCreated` (all tenants) or `events.auth.{tenant}.>` (single tenant).
4. Backward compatibility: dual-subscribe old + new patterns during migration with deprecation warning.

---

### Finding H-18: GDPR Cross-Service Erasure Orchestrator

**Complexity:** HIGH
**Dependencies:** M-15 (tenant-scoped subjects improve event routing)
**Estimated time:** 8 hours

#### Current State

Messaging-service has comprehensive GDPR erasure. Auth-service has consent management + partial user lifecycle deletion. No GDPR erasure for: farm, hr, billing, sensor, hydroponics services.

#### Files to Modify

1. `libs/event-contracts/src/gdpr/gdpr-events.ts` (NEW) -- Define GDPR event contracts: `GdprErasureRequested`, `GdprErasureCompleted`, `GdprErasureFailed`
2. `libs/backend-common/src/gdpr/gdpr-erasure.interface.ts` (NEW) -- Define `GdprErasureHandler` interface that each service implements
3. `apps/admin-api-service/src/security/services/compliance.service.ts` -- Add erasure orchestration endpoint that emits `GdprErasureRequested` event
4. `apps/auth-service/src/modules/gdpr/services/gdpr-erasure.handler.ts` (NEW) -- Handle user data anonymization in auth schema
5. `apps/farm-service/src/gdpr/gdpr-erasure.handler.ts` (NEW) -- Anonymize farm data (ownership records, notes, comments)
6. `apps/hr-service/src/gdpr/gdpr-erasure.handler.ts` (NEW) -- Anonymize HR records (employee PII)
7. `apps/billing-service/src/gdpr/gdpr-erasure.handler.ts` (NEW) -- Anonymize billing data (retain financial records with anonymized PII per legal retention requirements)
8. `apps/sensor-service/src/gdpr/gdpr-erasure.handler.ts` (NEW) -- Anonymize operator assignments on devices
9. `apps/hydroponics-service/src/gdpr/gdpr-erasure.handler.ts` (NEW) -- Anonymize operator references

#### Implementation Approach

1. **Saga pattern**: Orchestrator emits `GdprErasureRequested` with `{ userId, tenantId, requestedBy, legalBasis }`.
2. Each service listens, replaces PII with `REDACTED-{hash(userId)}`, retains non-PII, emits `GdprErasureCompleted` or `GdprErasureFailed`.
3. Orchestrator tracks per-service completion; marks complete only when ALL services report success.
4. Legal hold check before erasure (extend messaging-service pattern to orchestrator).
5. Each action audit-logged via `AuditLogModule` with legal basis and timestamp.

---

### Finding M-10: Per-Service PostgreSQL Connection Strings

**Complexity:** MEDIUM
**Dependencies:** None (init-scripts already create per-service roles)
**Estimated time:** 3 hours

#### Current State

Per-service PG roles exist in `00-init-schemas.sh` with schema-specific grants, but compose files still use shared `aquaculture` superuser in `DATABASE_USER`.

#### Files to Modify

1. `docker-compose.droplet.yml` -- Update each service's `DATABASE_USER` and `DATABASE_PASSWORD` to use its own role
2. `docker-compose.yml` -- Same for development
3. `docker-compose.prod.yml` -- Same for production
4. `.env.example` or equivalent -- Document per-service database credentials
5. `infrastructure/docker/init-scripts/00-init-schemas.sh` -- Ensure GRANT statements cover all necessary schemas per service (including tenant_* schemas)

#### Implementation Approach

1. Change each service's `DATABASE_USER` from `aquaculture` to its per-service role (e.g., `auth_service`).
2. Add per-service `DATABASE_PASSWORD` env vars mapping to `00-init-schemas.sh` passwords.
3. Grants: own schema = full CRUD, `public` = SELECT only, `tenant_*` = via `search_path`.
4. Negative test: verify cross-schema access denied.

---

## Sprint 3: Infrastructure / DevOps Changes

**Duration:** 3-4 days
**Can start:** After Sprint 2
**Dependencies:** Sprint 2 (NATS ACLs, per-service PG roles)

### Swarm Configuration

```
topology: hierarchical | agents: 6 | strategy: specialized
Agents: queen(planner), devops-1(coder: TLS), devops-2(coder: SRI),
        infra(security-architect: certs), tester, reviewer — all Opus 4.6
```

---

### Finding M-09: TLS for Redis/PostgreSQL/NATS Internal Connections

**Complexity:** HIGH
**Dependencies:** C-09 + M-10 (NATS ACLs and per-service PG roles should be in place)
**Estimated time:** 8 hours

#### Current State

Redis on port 6379 unencrypted, PG with `DATABASE_SSL=false`, NATS TLS configs exist but unused. All on internal Docker network (mitigates but does not meet zero-trust).

#### Files to Modify

1. `infrastructure/docker/redis/redis-tls.conf` (NEW) -- TLS-enabled Redis configuration
2. `infrastructure/docker/nats/nats-tls-enabled.conf` -- Verify and finalize TLS configuration
3. `docker-compose.droplet.yml` -- Switch to TLS configs for Redis, PG, NATS; mount certificates
4. `docker-compose.prod.yml` -- Same for production
5. `infrastructure/scripts/generate-internal-certs.sh` (NEW) -- Script to generate internal CA and service certificates using OpenSSL
6. All 15 service `app.module.ts` files -- Enable `DATABASE_SSL=true` and configure TLS options for Redis/NATS connections
7. `libs/backend-common/src/redis/redis.module.ts` -- Add TLS support to RedisModule connection factory

#### Implementation Approach

1. **Internal CA**: Self-signed CA for internal communication (Let's Encrypt handles external TLS).
2. **Cert gen script**: Creates server certs for redis, postgres, nats signed by internal CA.
3. **Redis**: `redis-tls.conf` with `tls-port 6380`, disable plain 6379.
4. **PostgreSQL**: `ssl = on` in postgresql.conf, `hostssl` in pg_hba.conf.
5. **NATS**: Use existing `nats-tls-enabled.conf`.
6. **Clients**: `DATABASE_SSL_CA=/certs/internal-ca.pem`, TLS options in Redis/NATS factories.
7. Dev: TLS optional. Production: TLS-only enforced.

---

### Finding M-02: SRI Hash-Pinning CI/CD Pipeline

**Complexity:** MEDIUM
**Dependencies:** None
**Estimated time:** 4 hours

#### Current State

`remoteIntegrity.ts` has empty `REMOTE_HASH_PINS` map with CI/CD TODO. Guard function is wired in bootstrap and handles empty maps gracefully.

#### Files to Modify

1. `.github/workflows/build.yml` (or equivalent CI workflow) -- Add a post-build step that computes SHA-256 hashes of all `remoteEntry.js` files
2. `web/shell/src/generated/remoteHashes.json` (NEW, generated) -- JSON file with path-to-hash mappings
3. `web/shell/src/utils/remoteIntegrity.ts` -- Import from `../generated/remoteHashes.json` instead of inline empty map
4. `infrastructure/scripts/generate-sri-hashes.sh` (NEW) -- Standalone script to compute hashes (can be run locally or in CI)

#### Implementation Approach

1. `generate-sri-hashes.sh` computes SHA-256 of each `remoteEntry.js` and writes to `web/shell/src/generated/remoteHashes.json`.
2. GitHub Actions: after frontend build, run script then rebuild shell with populated hashes.
3. `remoteIntegrity.ts` imports from generated JSON. File added to `.gitignore`.

---

## Sprint 4: Frontend + Cleanup

**Duration:** 1-2 days
**Can start:** After Sprint 3
**Dependencies:** Sprint 3 (SRI pipeline)

### Swarm Configuration

```
topology: hierarchical | agents: 4 | strategy: specialized
Agents: queen(planner), frontend(coder: L-11), tester, reviewer — all Opus 4.6
```

---

### Finding L-11: Pin Shared Module Federation Dependency Versions

**Complexity:** LOW
**Dependencies:** M-02 (SRI pipeline should be in place for hash regeneration)
**Estimated time:** 2 hours

#### Current State

`web/shell/vite.config.ts` uses `requiredVersion: '^18.2.0'` for React and similar range constraints for other shared dependencies. While Module Federation enforces singleton behavior, the range constraints allow minor/patch version drift between host and remotes, which could cause subtle runtime issues.

#### Files to Modify

1. `web/shell/vite.config.ts` -- Pin `requiredVersion` to exact versions matching the workspace lockfile
2. All `web/modules/*/vite.config.ts` (7 modules) -- Same pinning for shared dependencies
3. `web/shared-ui/vite.config.ts` -- Same pinning

#### Implementation Approach

1. Extract exact versions from workspace `package-lock.json` for all shared deps.
2. Replace range constraints (e.g., `^18.2.0`) with exact versions (e.g., `18.3.1`) across shell and all 7 module configs.
3. Verify build succeeds with pinned versions.

---

## Dependency Graph

```
Sprint 1 (independent)
  |-- H-13: SUPER_ADMIN audit + MFA step-up
  |-- M-18: Device ownership verification
  |-- L-01/L-02: SHA-1/MD5 replacement
  |
  v
Sprint 2 (cross-service)
  |-- C-09: NATS account-level ACLs ----+
  |-- M-15: Tenant-scoped NATS subjects  |  (C-09 first, then M-15)
  |-- H-18: GDPR erasure orchestrator    |  (can parallelize with NATS work)
  |-- M-10: Per-service PG connections   |  (independent within sprint)
  |                                      |
  v                                      v
Sprint 3 (infrastructure)
  |-- M-09: Internal TLS (depends on C-09 + M-10)
  |-- M-02: SRI hash CI/CD pipeline (independent)
  |
  v
Sprint 4 (frontend)
  |-- L-11: Version pinning (depends on M-02 for hash regen)
```

---

## Critical Path

```
C-09 (NATS ACLs) --> M-15 (tenant subjects) --> M-09 (internal TLS)
```

This is the longest sequential dependency chain (approximately 22 hours of work). All other findings can be parallelized around this chain.

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| NATS ACL misconfiguration breaks inter-service communication | CRITICAL | Stage-test full mesh. Keep rollback config ready. |
| Tenant-scoped subjects break existing consumers | HIGH | Dual-subscribe old + new patterns during migration. |
| TLS cert rotation causes downtime | HIGH | Automate 90-day rotation. Monitor expiry via alert-engine. |
| GDPR saga partial failure | MEDIUM | Compensating transactions + per-service retry. |
| Per-service PG roles missing grants | HIGH | Integration test per service with its own role. |

## Success Criteria

1. All 11 actionable findings resolved, no regressions, full test suite passes
2. Each fix has tests + English JSDoc comments, CI/CD build succeeds
3. NATS ACLs: negative test proves cross-service publish denied
4. GDPR erasure: end-to-end test with mock user across all 7 data-holding services
5. Internal TLS: plaintext connections rejected; per-service PG: cross-schema access denied

---

## Estimated Total Effort

| Sprint | Duration | Parallel Agents | Total Agent-Hours |
|--------|----------|-----------------|-------------------|
| Sprint 1 | 2-3 days | 6 | ~9 hours |
| Sprint 2 | 3-5 days | 8 | ~25 hours |
| Sprint 3 | 3-4 days | 6 | ~12 hours |
| Sprint 4 | 1-2 days | 4 | ~2 hours |
| **Total** | **9-14 days** | - | **~48 hours** |

---

*Plan generated by Claude Opus 4.6*
