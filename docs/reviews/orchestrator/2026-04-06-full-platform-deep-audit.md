# Unified Review Report -- Full Platform Deep Audit

**Date:** 2026-04-06
**Scope:** Full architectural health check and deep audit of the entire Aquaculture IoT SaaS platform at HEAD (b224b37f)
**Agents Invoked:** auth-security-expert, security-reviewer, farm-expert, sensor-expert, data-expert, edge-expert, hr-expert, admin-expert, messaging-expert, frontend-expert, infra-expert, platform-services

---

## Deployment Decision

**BLOCK**

- Blocking findings: 3 CRITICAL issues identified (SEC-C01, SEC-C02, ARCH-C01)

---

## Summary

| Agent | CRITICAL | HIGH | MEDIUM | LOW |
|-------|----------|------|--------|-----|
| auth-security-expert | 1 | 2 | 3 | 1 |
| security-reviewer | 1 | 3 | 4 | 2 |
| farm-expert | 0 | 1 | 3 | 2 |
| sensor-expert | 0 | 1 | 2 | 1 |
| data-expert | 1 | 2 | 2 | 1 |
| edge-expert | 0 | 0 | 2 | 1 |
| hr-expert | 0 | 0 | 1 | 1 |
| admin-expert | 0 | 2 | 2 | 1 |
| messaging-expert | 0 | 0 | 1 | 1 |
| frontend-expert | 0 | 1 | 2 | 1 |
| infra-expert | 0 | 1 | 3 | 2 |
| platform-services | 0 | 1 | 1 | 1 |
| **Total** | **3** | **14** | **26** | **15** |

---

## Critical Findings (Deployment Blockers)

### SEC-C01: Password Reset Token Leaked in Event Bus

**File:** `libs/event-contracts/src/auth-events.ts` lines 43-49

The `PasswordResetRequestedEvent` interface includes the raw `resetToken` as a top-level field:

```typescript
export interface PasswordResetRequestedEvent extends BaseEvent {
  eventType: 'PasswordResetRequested';
  userId: string;
  email: string;
  resetToken: string;   // <-- CRITICAL: raw secret on event bus
  firstName?: string;
}
```

**Impact:** The password reset token is a security credential equivalent to a one-time password. Publishing it on the NATS event bus means:
1. Every service subscribed to auth events can read the raw token.
2. The event-store-service persists it permanently in its event log.
3. Any audit/logging system that captures events will store the token in plaintext.
4. An attacker with read access to NATS or the event store can reset any user's password.

**Fix:** Remove `resetToken` from the event contract. The notification-service should receive the token via a targeted NATS request/response or a dedicated secure channel, not a broadcast event.

---

### SEC-C02: admin-api-service DATABASE_SYNC Defaults to 'true' -- No Production Guard

**File:** `apps/admin-api-service/src/app.module.ts` line 66

```typescript
synchronize: configService.get('DATABASE_SYNC', 'true') === 'true',
```

**File:** `apps/admin-api-service/src/main.ts` -- Does NOT use `bootstrapService()` / `createServiceApp()`

**Impact:** The admin-api-service is one of 10 services that do NOT use the shared bootstrap factory (`createServiceApp`). The shared bootstrap factory contains a critical safety guard (SEC-H15) that crashes the process if `DATABASE_SYNC=true` in production. Since admin-api-service has a custom `main.ts` WITHOUT this guard, AND defaults `DATABASE_SYNC` to `'true'`, TypeORM `synchronize` will run in production unless `DATABASE_SYNC=false` is explicitly set in the environment. TypeORM `synchronize: true` can DROP columns, DELETE data, and break migrations irreversibly.

Services NOT protected by the shared bootstrap guard: admin-api-service, farm-service, sensor-service, auth-service, hr-service, messaging-service, observability-service, event-store-service, ai-service, gateway-api.

**Fix (immediate):** Change the default from `'true'` to `'false'`. Add the SEC-H15 production guard to `admin-api-service/src/main.ts`. Long-term: migrate all 10 custom `main.ts` services to the shared `bootstrapService()` factory.

---

### ARCH-C01: SensorReadingEvent Uses Nested `readings` Object -- Violates Flat-Object Contract

**File:** `libs/event-contracts/src/sensor-events.ts` lines 7-23

```typescript
export interface SensorReadingEvent extends BaseEvent {
  eventType: 'SensorReading';
  sensorId: string;
  readings: {                        // <-- Nested object
    temperature?: number;
    ph?: number;
    dissolvedOxygen?: number;
    [key: string]: number | undefined;
  };
}
```

The platform's own `base-event.ts` doc block states: "All events MUST be flat objects. Never wrap business fields inside a nested `payload` or `metadata` object."

**Impact:** The highest-throughput event violates the platform's foundational event contract. The dynamic `[key: string]` index signature makes type safety impossible for consumers. Event-store projections that assume flat structure will mishandle this event.

**Fix:** Flatten `readings` into top-level fields or introduce a documented exception with a migration path.

---

## High Priority Findings

### SEC-H01: 10 of 15 Services Do Not Use Shared Bootstrap Factory

**Files:** `apps/{service}/src/main.ts` for admin-api-service, farm-service, sensor-service, auth-service, hr-service, messaging-service, observability-service, event-store-service, ai-service, gateway-api

Only 5 services use `bootstrapService()`: billing-service, notification-service, alert-engine, config-service, hydroponics-service. The remaining 10 have custom `main.ts` files that may diverge from the security baseline (Helmet, CORS, ValidationPipe, trust-proxy, SEC-H15 DATABASE_SYNC guard).

### SEC-H02: farm-service and sensor-service synchronize Config Lacks Production Guard

**Files:** `apps/farm-service/src/app.module.ts` line 120, `apps/sensor-service/src/app.module.ts` line 189

While these default to `'false'`, there is no runtime guard preventing `DATABASE_SYNC=true` in production since they don't use the shared bootstrap.

### SEC-H03: `as any` Used 346 Times Across 105 Backend Files

The project's CLAUDE.md explicitly forbids `as any`. Production-code offenders include: `opcua.adapter.ts` (9), `provisioning.service.ts` (5), `work-order.service.ts` (4), `maintenance-schedule.service.ts` (3).

### SEC-H04: `as unknown as X` Casting Used 355 Times Across 140 Files

CLAUDE.md forbids this pattern. Notable production-code offenders: `billing.controller.ts` (22), `impersonation.controller.ts` (5), `plc-connection.service.ts` (5).

### SEC-H05: console.log/error/warn Used in 21 Backend Files

CLAUDE.md requires NestJS Logger. 27 occurrences across 21 files.

### SEC-H06: @ts-ignore / @ts-expect-error in 2 Files

**Files:** `apps/sensor-service/src/automation/compiler/worker/st-worker-pool.service.ts`, `apps/gateway-api/src/app.module.ts`

### DATA-H01: SensorReadingEvent Index Signature Defeats Typed Contracts

**File:** `libs/event-contracts/src/sensor-events.ts` line 22 -- `[key: string]: number | undefined`

### DATA-H02: TenantProvisioningFailedEvent Uses `unknown[]`

**File:** `libs/event-contracts/src/tenant-events.ts` line 76 -- `steps?: unknown[]`

### ADMIN-H01: admin-api-service Custom Bootstrap Without SEC-H15 Guard

See SEC-C02.

### ADMIN-H02: admin-api-service Uses console.warn in Production Code

**File:** `apps/admin-api-service/src/app.module.ts` line 78

### FRONT-H01: Module Federation dist/ Files Committed to Repository

**Files:** `web/modules/*/dist/assets/remoteEntry.js` (7 files)

### INFRA-H01: Configuration Drift Risk from 10 Custom Bootstraps

Same as SEC-H01.

### PLAT-H01: billing-service Uses `as any` in Scheduler

**File:** `apps/billing-service/src/billing/billing-scheduler.service.ts` (2 occurrences)

### SENSOR-H01: Protocol Adapters Use Heavy `as any` Casting

**File:** `apps/sensor-service/src/protocol/adapters/industrial/opcua.adapter.ts` (9 occurrences)

---

## Cross-Domain Dependencies

| From Agent | To Agent | Issue | Status |
|-----------|----------|-------|--------|
| auth-security-expert | data-expert | PasswordResetRequestedEvent leaks reset token to event store | Open -- SEC-C01 |
| security-reviewer | infra-expert | 10 services bypass shared bootstrap security baseline | Open -- SEC-H01 |
| data-expert | sensor-expert | SensorReadingEvent violates flat-object contract | Open -- ARCH-C01 |
| data-expert | all consumers | TenantProvisioningFailedEvent uses unknown[] | Open -- DATA-H02 |
| admin-expert | data-expert | DATABASE_SYNC defaults to 'true' in admin-api-service | Open -- SEC-C02 |
| frontend-expert | infra-expert | dist/ artifacts committed to repository | Open -- FRONT-H01 |

---

## Systemic Issues

### SYSTEMIC-01: Shared Bootstrap Factory Adoption Gap

Only 5 of 15 services use `bootstrapService()`. Security hardening applied to the shared factory only protects 1/3 of the platform. Every security fix must be manually replicated across 10 custom `main.ts` files.

### SYSTEMIC-02: Type Safety Bypass at Scale

346 `as any` casts, 355 `as unknown as X` casts, and 3 `@ts-ignore` suppressions. Approximately 150+ are in production code across critical services (billing, auth, sensor/PLC control, admin).

### SYSTEMIC-03: Event Contract Schema Enforcement Gap

Enforcement is purely compile-time. No runtime schema validation on event publish/consume. Combined with SensorReadingEvent flat-object violation and `unknown[]` in TenantProvisioningFailedEvent.

### SYSTEMIC-04: Test Coverage Asymmetry

- Backend: 197 test files for ~2,800 source files (7% file-level coverage)
- Frontend: 65 test files for ~16,300 source files (<0.4%)
- Edge (Rust): 1 test module for 68 source files

---

## Positive Findings (Architectural Strengths)

1. **JWT Verification Centralized** (`getJwtVerifyOptions`) -- HS256-only, mandatory issuer/audience at library level
2. **Token Type Enforcement** (`enforceAccessTokenType`) -- prevents refresh/MFA tokens as access tokens
3. **CSRF Double-Submit Cookie** -- timing-safe comparison, SameSite=Strict
4. **Tenant Schema Middleware** -- UUID validation, parameterized queries, LRU caching
5. **IDOR Guard** -- opt-in with audit logging for uncovered routes
6. **Token Blacklist** -- Redis enforced in production, per-token and per-user invalidation
7. **Input Sanitization Service** -- comprehensive HTML, SQL, path, filename, tenant ID sanitization
8. **Edge Gateway Security (Rust)** -- IEC 62443, TLS/mTLS, credential zeroize, cert expiry monitoring
9. **CI/CD Security** -- SHA-pinned actions, minimum permissions, npm integrity verification
10. **Nginx Hardening** -- strict CSP, HSTS preload, rate limiting, metrics blocked, MFE cache control
11. **Kubernetes Secrets** -- no real credentials, External Secrets Operator support
12. **Shared Bootstrap Factory** -- comprehensive security baseline for adopting services

---

## Recommendations Priority Matrix

**Immediate (Before Next Deploy):**
1. SEC-C01: Remove `resetToken` from `PasswordResetRequestedEvent`
2. SEC-C02: Change admin-api-service `DATABASE_SYNC` default to `'false'`, add SEC-H15 guard
3. ARCH-C01: Document SensorReadingEvent exception or flatten

**Short-Term (Next Sprint):**
4. SEC-H01: Migrate remaining 10 services to `bootstrapService()` factory
5. FRONT-H01: Add `dist/` to `.gitignore` for web modules
6. SEC-M04: Change `isAllowedBaseDomain()` to fail-closed when ALLOWED_BASE_DOMAINS unset

**Medium-Term (Next 2 Sprints):**
7. SEC-H03/H04: Systematic `as any` / `as unknown as X` reduction in production code
8. DATA-H01: Replace `[key: string]` with explicit sensor parameter fields
9. SEC-M07: Remove PII from event contracts or use hashed identifiers

**Long-Term (Quarterly):**
10. SYSTEMIC-02: ESLint rules to prevent type-safety bypasses
11. SYSTEMIC-03: Runtime event schema validation (zod/class-validator)
12. FARM-M01: Evaluate decomposing farm-service (816 files, 35+ domains)
13. SYSTEMIC-04: Frontend test coverage baseline and CI gate

---

## Codebase Statistics

| Metric | Value |
|--------|-------|
| Total source files | 19,178 |
| Backend services | 15 |
| Frontend modules | 10 |
| Rust edge gateway | 1 |
| Shared libraries | 9 |
| Database migrations | 20 |
| CI/CD workflows | 16 |
| Backend tests | 197 |
| Frontend tests | 65 |
