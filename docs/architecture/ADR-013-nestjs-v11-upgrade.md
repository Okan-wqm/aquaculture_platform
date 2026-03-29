# ADR-013: NestJS v10 to v11 Monorepo Upgrade

**Status:** Proposed
**Date:** 2026-03-29
**Decision Makers:** Engineering Lead
**Related:** ADR-012 (Messaging Service), ADR-007 (CQRS Usage Strategy), event-driven-architecture.md, microservices-design.md

---

## 1. Context & Problem Statement

The platform runs NestJS v10.3-10.4 across 14 backend services and 3 shared libraries. NestJS v11 was released with Express v5 as the default HTTP adapter, bringing breaking changes to path matching, request handling, and several companion packages. Staying on v10 means:

1. **Security exposure** -- Express v4 reaches maintenance-only status; new CVEs will not receive patches.
2. **Ecosystem drift** -- Community packages increasingly target v11; staying on v10 creates compatibility friction.
3. **Missing features** -- v11 introduces performance improvements, better module deduplication, and streamlined metadata scanning.
4. **Developer experience** -- New hires familiar with v11 encounter unnecessary friction with v10 patterns.

**Goal:** Upgrade all 14 backend services and 3 platform libraries from NestJS v10 to v11 atomically (per-phase), with zero downtime and safe per-service rollback.

### Scope

| Category | Count |
|----------|-------|
| Backend services | 14 (admin-api, ai, alert-engine, auth, billing, config, event-store, farm, gateway-api, hr, hydroponics, messaging, notification, observability) |
| Platform libraries | 3 (libs/backend-common, platform/cqrs, platform/event-bus) |
| Affected files (estimated) | ~1,700 |
| Total `@nestjs/` imports | ~2,738 |

---

## 2. Decision Drivers

1. **Express v5 security** -- Express v4 maintenance window is closing; v5 brings hardened path parsing and prototype pollution fixes.
2. **Atomic companion versions** -- NestJS core, companion, and third-party packages must move together to avoid runtime `PeerDependency` crashes.
3. **Zero downtime** -- Production fish farms rely on 24/7 sensor data ingestion; any outage directly impacts livestock.
4. **Rollback safety** -- Each phase must be independently reversible without data migration.
5. **NATS wire compatibility** -- v10 and v11 services must coexist on the same NATS bus during the phased rollout.
6. **Apollo Federation continuity** -- The gateway must compose subgraph schemas from a mix of v10/v11 services during transition.

---

## 3. Decision

Upgrade 13 `@nestjs/*` packages in a coordinated 6-phase rollout over 5-6 weeks.

### 3.1 Version Matrix

| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| `@nestjs/common` | ^10.3.0 | ^11.x | Core -- must upgrade first |
| `@nestjs/core` | ^10.3.0 | ^11.x | Core -- must upgrade first |
| `@nestjs/platform-express` | ^10.4.20 | ^11.x | Pulls in Express v5 |
| `@nestjs/graphql` | ^12.2.2 | ^13.x | Breaking: `installSubscriptionHandlers` removed |
| `@nestjs/apollo` | ^12.2.2 | ^13.x | Must match `@nestjs/graphql` |
| `@nestjs/typeorm` | ^10.0.2 | ^11.x | Peer dep on `@nestjs/core` ^11 |
| `@nestjs/config` | ^3.3.0 | ^4.x | Minor API changes only |
| `@nestjs/swagger` | ^7.4.2 | ^8.x | Decorator changes |
| `@nestjs/cqrs` | ^10.2.8 | ^11.x | `.forRoot()` standardization |
| `@nestjs/microservices` | ^10.4.22 | ^11.x | NATS transport unchanged |
| `@nestjs/platform-socket.io` | ^10.4.20 | ^11.x | Socket.IO adapter unchanged |
| `@nestjs/websockets` | ^10.4.20 | ^11.x | Peer dep alignment |
| `@nestjs/testing` | ^10.4.20 | ^11.x | devDependency -- test compat |

### 3.2 Already v11-Compatible (No Upgrade Needed)

| Package | Version | Reason |
|---------|---------|--------|
| `@nestjs/schedule` | 6.0.1 | Already supports v11 peer |
| `@nestjs/jwt` | 11.0.1 | Already supports v11 peer |
| `@nestjs/passport` | 11.0.5 | Already supports v11 peer |
| `@nestjs/terminus` | 11.0.0 | Already supports v11 peer |
| `@nestjs/event-emitter` | 3.0.1 | Already supports v11 peer |

### 3.3 No Change Needed

| Package | Version | Reason |
|---------|---------|--------|
| TypeORM | ^0.3.28 | No NestJS peer dep |
| rxjs | ^7.8 | v11 still uses rxjs 7 |
| graphql | ^16.12 | Stable, no breaking change |
| class-validator | latest | No NestJS coupling |
| class-transformer | latest | No NestJS coupling |
| Apollo packages | latest | `@apollo/*` independent of `@nestjs/apollo` |

---

## 4. Breaking Changes

### 4.1 CRITICAL -- Express v5 Path Matching

**Impact:** Application crash on startup if `path-to-regexp` v8 encounters v7 syntax.

Express v5 uses `path-to-regexp` v8 which changes regex-style route parameters. The pattern `(.*)` is no longer valid; use `{*path}` instead.

| File | Line | Current | Required |
|------|------|---------|----------|
| `apps/ai-service/src/app.module.ts` | 235 | `.exclude('health', 'health/(.*)')` | `.exclude('health', 'health/{*path}')` |
| `apps/hydroponics-service/src/app.module.ts` | 215 | `.exclude('health', 'health/(.*)')` | `.exclude('health', 'health/{*path}')` |
| `apps/messaging-service/src/app.module.ts` | 299 | `.exclude('health', 'health/(.*)')` | `.exclude('health', 'health/{*path}')` |

### 4.2 CRITICAL -- `installSubscriptionHandlers` Removed

**Impact:** `@nestjs/graphql` v13 removes this option entirely. Passing it throws `UnknownOptionError`.

| File | Line | Current | Required |
|------|------|---------|----------|
| `apps/config-service/src/app.module.ts` | 67 | `installSubscriptionHandlers: false,` | Delete the entire line |

### 4.3 HIGH -- `MetadataScanner.scanFromPrototype()` Deprecated

**Impact:** Runtime deprecation warning in v11; will be removed in v12. Replace with `getAllMethodNames()`.

| File | Line | Current | Required |
|------|------|---------|----------|
| `platform/libs/event-bus/src/nats/nats.module.ts` | 134 | `this.metadataScanner.scanFromPrototype(instance, Object.getPrototypeOf(instance), (methodKey) => { ... })` | `for (const methodKey of this.metadataScanner.getAllMethodNames(Object.getPrototypeOf(instance))) { ... }` |

### 4.4 HIGH -- `req.ip` Can Be `undefined` in Express v5

**Impact:** Runtime `TypeError` where code assumes `req.ip` is always a string. Express v5 returns `undefined` when the request has no remote address (e.g., during proxy trust evaluation failure).

Files requiring null guards:

| File | Line | Pattern |
|------|------|---------|
| `apps/gateway-api/src/middleware/correlation-id.middleware.ts` | 200 | `ip: req.ip \|\| req.headers['x-forwarded-for']` -- already safe |
| `apps/gateway-api/src/middleware/device-fingerprint.middleware.ts` | 144 | `req.ip \|\| ...` -- already has fallback to `'unknown'` |
| `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts` | 41 | `req.ip` in template literal -- needs `?? 'unknown'` |
| `apps/gateway-api/src/middleware/timeout.middleware.ts` | 90 | `ip: req.ip` -- needs `ip: req.ip ?? 'unknown'` |
| `apps/gateway-api/src/middleware/request-validator.middleware.ts` | 208 | `ip: req.ip` -- needs `ip: req.ip ?? 'unknown'` |
| `apps/gateway-api/src/csp-report/csp-report.controller.ts` | 81, 87 | `req.ip` -- needs null guard |
| `apps/gateway-api/src/interceptors/request-logging.interceptor.ts` | 97 | `req.ip` -- needs null guard |
| `apps/gateway-api/src/guards/rate-limit.guard.ts` | 359, 405 | `req.ip` -- needs null guard |
| `apps/gateway-api/src/guards/opa-policy.guard.ts` | 378 | `req.ip` -- needs null guard |
| `libs/backend-common/src/security/throttler/throttler.guard.ts` | 218 | `req.ip` -- needs null guard |
| `libs/backend-common/src/logging/request-context.middleware.ts` | 65 | `ip: req.ip` -- needs null guard |
| `apps/observability-service/src/main.ts` | 42 | `req.ip \|\|` -- already safe |
| `apps/auth-service/src/modules/gdpr/resolvers/user-consent.resolver.ts` | 299-300 | `req.ip` guarded by `if` -- already safe |
| `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts` | 352 | `req.ip \|\| req.socket.remoteAddress` -- already safe |

### 4.5 MEDIUM -- `CqrsModule` Must Use `.forRoot()` in App Modules

**Impact:** v11 DynamicModule deduplication changes mean bare `CqrsModule` imports (without `.forRoot()`) may not register the internal `CommandBus`/`QueryBus`/`EventBus` providers correctly when multiple feature modules also import `CqrsModule`.

| File | Line | Current | Required |
|------|------|---------|----------|
| `apps/config-service/src/app.module.ts` | 82 | `CqrsModule,` | `CqrsModule.forRoot(),` |
| `apps/admin-api-service/src/app.module.ts` | 100 | `CqrsModule,` | `CqrsModule.forRoot(),` |
| `apps/event-store-service/src/app.module.ts` | 58 | `CqrsModule,` | `CqrsModule.forRoot(),` |

### 4.6 MEDIUM -- Duplicate `CqrsModule` Imports in farm-service

**Impact:** With v11's `@Global()` module deduplication, importing `CqrsModule` in both the root `AppModule` and every feature module is redundant and may cause unexpected behavior if the platform wrapper (`@platform/cqrs`) is not marked `@Global()`.

20 feature modules in farm-service import `CqrsModule` from `@platform/cqrs`:

| Feature Module File |
|---------------------|
| `apps/farm-service/src/batch/batch.module.ts` |
| `apps/farm-service/src/chemical/chemical.module.ts` |
| `apps/farm-service/src/consumable/consumable.module.ts` |
| `apps/farm-service/src/department/department.module.ts` |
| `apps/farm-service/src/equipment/equipment.module.ts` |
| `apps/farm-service/src/farm/farm.module.ts` |
| `apps/farm-service/src/feed/feed.module.ts` |
| `apps/farm-service/src/feeding/feeding.module.ts` |
| `apps/farm-service/src/fish-health/fish-health.module.ts` |
| `apps/farm-service/src/growth/growth.module.ts` |
| `apps/farm-service/src/harvest/harvest.module.ts` |
| `apps/farm-service/src/maintenance/maintenance.module.ts` |
| `apps/farm-service/src/site/site.module.ts` |
| `apps/farm-service/src/species/species.module.ts` |
| `apps/farm-service/src/storage/storage.module.ts` |
| `apps/farm-service/src/supplier/supplier.module.ts` |
| `apps/farm-service/src/system/system.module.ts` |
| `apps/farm-service/src/tank/tank.module.ts` |
| `apps/farm-service/src/water-quality/water-quality.module.ts` |
| `apps/farm-service/src/worker/worker.module.ts` |

**Resolution:** If `@platform/cqrs` `CqrsModule` is marked `@Global()`, remove `CqrsModule` from all feature module `imports` arrays and keep only the root `AppModule.forRoot()` import. If not `@Global()`, the per-feature imports are correct -- but verify dedup behavior in v11.

### 4.7 LOW -- `@nestjs/swagger` v8 Decorator Changes

**Impact:** `@ApiProperty()` metadata inference may differ. Mostly transparent, but custom decorators wrapping Swagger metadata should be regression-tested.

---

## 5. Pre-Upgrade Fixes (Blocking)

These fixes MUST be applied and merged to `main` before starting the v11 upgrade. They are safe to apply on v10 and will prevent crashes when v11 is installed.

- [ ] **FIX-1:** Replace `health/(.*)` with `health/{*path}` in `.exclude()` calls
  - `apps/ai-service/src/app.module.ts:235`
  - `apps/hydroponics-service/src/app.module.ts:215`
  - `apps/messaging-service/src/app.module.ts:299`

- [ ] **FIX-2:** Remove `installSubscriptionHandlers: false` from GraphQL config
  - `apps/config-service/src/app.module.ts:67`

- [ ] **FIX-3:** Standardize `CqrsModule` to `.forRoot()` in app-level modules
  - `apps/config-service/src/app.module.ts:82` -- change `CqrsModule,` to `CqrsModule.forRoot(),`
  - `apps/admin-api-service/src/app.module.ts:100` -- change `CqrsModule,` to `CqrsModule.forRoot(),`
  - `apps/event-store-service/src/app.module.ts:58` -- change `CqrsModule,` to `CqrsModule.forRoot(),`

- [ ] **FIX-4:** Add `req.ip ?? 'unknown'` null guards across gateway and shared libs
  - `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts:41`
  - `apps/gateway-api/src/middleware/timeout.middleware.ts:90`
  - `apps/gateway-api/src/middleware/request-validator.middleware.ts:208`
  - `apps/gateway-api/src/csp-report/csp-report.controller.ts:81,87`
  - `apps/gateway-api/src/interceptors/request-logging.interceptor.ts:97`
  - `apps/gateway-api/src/guards/rate-limit.guard.ts:359,405`
  - `apps/gateway-api/src/guards/opa-policy.guard.ts:378`
  - `libs/backend-common/src/security/throttler/throttler.guard.ts:218`
  - `libs/backend-common/src/logging/request-context.middleware.ts:65`

- [ ] **FIX-5:** Replace `scanFromPrototype()` with `getAllMethodNames()` in event-bus
  - `platform/libs/event-bus/src/nats/nats.module.ts:134`

---

## 6. Six-Phase Upgrade Plan

### Phase 1 -- Foundation (Week 1)

**Target:** Shared libraries + root `package.json`

This phase upgrades the dependency versions in `package.json` and fixes the three shared libraries that all services depend on. No service is redeployed yet.

- [ ] Apply all pre-upgrade fixes (FIX-1 through FIX-5) and merge to `main`
- [ ] Update root `package.json` with v11 version ranges for all 13 packages
- [ ] Run `npm install` and resolve any peer dependency conflicts
- [ ] Upgrade `libs/backend-common` -- fix `req.ip` null guards, throttler guard
- [ ] Upgrade `platform/libs/cqrs` -- verify `CqrsModule.forRoot()` / `@Global()` behavior under v11
- [ ] Upgrade `platform/libs/event-bus` -- replace `scanFromPrototype()` with `getAllMethodNames()`
- [ ] Run full lint + build for all libraries: `npm run build`
- [ ] Run full test suite for all libraries: `npm test`
- [ ] Verify TypeScript compilation succeeds with `--noEmit` across the monorepo

### Phase 2 -- Canary Services (Week 1-2)

**Target:** event-store-service, observability-service, config-service

These services have the lowest blast radius -- no direct user-facing traffic, no GraphQL subgraphs exposed to the gateway.

- [ ] Deploy `event-store-service` with v11 dependencies
  - Verify module bootstrap succeeds
  - Verify NATS event consumption works
  - Run `npm test -- --scope=event-store-service`
- [ ] Deploy `observability-service` with v11 dependencies
  - Verify health endpoint responds
  - Verify metrics collection works
  - Run `npm test -- --scope=observability-service`
- [ ] Deploy `config-service` with v11 dependencies
  - Verify `installSubscriptionHandlers` removal does not break GraphQL schema
  - Verify `CqrsModule.forRoot()` bootstraps correctly
  - Run `npm test -- --scope=config-service`
- [ ] Monitor all three services for 24 hours before proceeding
- [ ] Verify NATS cross-version compatibility: v10 services can still publish/subscribe alongside v11 canaries

### Phase 3 -- GraphQL Subgraphs (Week 2-3)

**Target:** notification-service, billing-service, alert-engine, hydroponics-service, ai-service

These services expose GraphQL subgraphs to the gateway. The gateway itself stays on v10 during this phase -- Apollo Federation composition must work across the version boundary.

- [ ] Deploy `notification-service` -- verify subgraph schema registers with gateway
- [ ] Deploy `billing-service` -- verify subgraph schema registers, verify CQRS event handlers
- [ ] Deploy `alert-engine` -- verify alerting pipeline end-to-end
- [ ] Deploy `hydroponics-service` -- verify `.exclude('health/{*path}')` fix, subgraph composition
- [ ] Deploy `ai-service` -- verify `.exclude('health/{*path}')` fix, subgraph composition
- [ ] Run Apollo Federation composition test: `rover supergraph compose` against all subgraph endpoints
- [ ] Verify gateway can query all v11 subgraphs without error
- [ ] Run full test suite for each service
- [ ] Monitor for 24 hours before proceeding

### Phase 4 -- Heavy Services (Week 3-4)

**Target:** admin-api-service, hr-service, messaging-service

These services have the most complex module trees, the most CQRS usage, and the most middleware. They carry higher risk.

- [ ] Deploy `admin-api-service`
  - Verify `CqrsModule.forRoot()` + tenant module CQRS handlers
  - Verify Swagger documentation generates correctly with v8
  - Verify deprecation interceptor (`apps/admin-api-service/src/shared/deprecation.interceptor.ts`)
  - Run `npm test -- --scope=admin-api-service`
- [ ] Deploy `hr-service`
  - Verify all 7 feature modules (hr, aquaculture, attendance, performance, leave, scheduling, training) bootstrap
  - Verify `CqrsModule.forRoot()` at app level
  - Run `npm test -- --scope=hr-service`
- [ ] Deploy `messaging-service`
  - Verify `.exclude('health/{*path}')` fix
  - Verify WebSocket/Socket.IO connections with v11 `@nestjs/platform-socket.io`
  - Verify CQRS event handlers in message, ai, compliance modules
  - Run `npm test -- --scope=messaging-service`
- [ ] Monitor for 24 hours before proceeding

### Phase 5 -- Critical Services (Week 4-5)

**Target:** auth-service, sensor-service, farm-service

These are the highest-risk services: auth handles all authentication flows, sensor handles real-time MQTT/NATS data ingestion, farm is the largest service by module count.

- [ ] Deploy `auth-service`
  - Verify JWT authentication flow end-to-end
  - Verify GDPR consent resolver `req.ip` handling
  - Verify passport strategies work with v11
  - Run `npm test -- --scope=auth-service`
- [ ] Deploy `sensor-service`
  - Verify MQTT and NATS data ingestion pipelines
  - Verify TypeORM schema sync with `SourceSchemaBootstrapService`
  - Run `npm test -- --scope=sensor-service`
- [ ] Deploy `farm-service`
  - Verify all 20 feature modules bootstrap correctly with deduplicated `CqrsModule`
  - Verify GraphQL resolvers for all entities
  - Verify subgraph composition with gateway
  - Run `npm test -- --scope=farm-service`
- [ ] Monitor for 24 hours before proceeding

### Phase 6 -- Gateway (Week 5-6)

**Target:** gateway-api (LAST -- depends on all subgraphs being v11)

The gateway must be upgraded last because it composes all subgraph schemas and handles all inbound traffic.

- [ ] Deploy `gateway-api`
  - Verify all `req.ip` null guards are in place
  - Verify all middleware (device-fingerprint, correlation-id, strip-internal-headers, timeout, request-validator) works
  - Verify rate-limit guard and OPA policy guard
  - Verify Apollo Federation supergraph composition with all v11 subgraphs
  - Verify WebSocket proxy for messaging-service
  - Run `npm test -- --scope=gateway-api`
- [ ] Run full end-to-end test suite
- [ ] Run Apollo Federation composition test one final time
- [ ] Monitor for 48 hours
- [ ] Remove any v10-specific compatibility shims
- [ ] Update `package.json` to pin exact v11 minor versions (remove caret ranges)

---

## 7. Rollback Strategy

### Prerequisites

- All Docker images are tagged with git SHA (already enforced by CI)
- Record the production-deployed SHA for each service before starting each phase

### Per-Service Rollback

```bash
# 1. Identify the last-known-good SHA
export GOOD_SHA=<sha-before-upgrade>

# 2. Pull and run the previous image
docker compose stop <service-name>
docker compose run -d --name <container-name> ghcr.io/okan-wqm/aquaculture_platform/<service>:${GOOD_SHA}
```

### Rollback Safety Guarantees

| Concern | Status |
|---------|--------|
| Database migrations | No database schema changes in this upgrade -- safe to rollback |
| NATS wire protocol | v10 and v11 use identical NATS client protocol -- cross-version compatible |
| Apollo Federation | v10 gateway can route to v11 subgraphs and vice versa |
| Redis sessions | Session format unchanged -- no invalidation needed |
| JWT tokens | Token format unchanged -- no re-authentication needed |

### Rollback Decision Criteria

Roll back a service immediately if any of these occur:

1. Module bootstrap fails (service does not start)
2. Health check fails for 3 consecutive cycles
3. Error rate exceeds 1% for 15 minutes
4. NATS message processing latency exceeds 2x baseline
5. Apollo Federation composition fails

---

## 8. Testing Strategy

### 8.1 Per-Service Tests (Required Before Each Deploy)

| Test Type | Command | Pass Criteria |
|-----------|---------|---------------|
| Unit + Integration | `npm test -- --scope=<service>` | All tests pass, zero failures |
| Module bootstrap | Start service, verify health endpoint returns 200 | Service starts without error |
| TypeScript compilation | `npx tsc --noEmit -p apps/<service>/tsconfig.json` | Zero type errors |
| Lint | `npm run lint -- --scope=<service>` | Zero lint errors |

### 8.2 Cross-Service Tests (Required After Each Phase)

| Test Type | Description | Pass Criteria |
|-----------|-------------|---------------|
| Apollo Federation composition | `rover supergraph compose` against all subgraph URLs | Schema composes without conflict |
| NATS cross-version wire test | Publish event from v10 service, consume in v11 service (and vice versa) | Events delivered, deserialized correctly |
| Gateway integration | Hit gateway with sample queries spanning multiple subgraphs | Responses match expected schema |

### 8.3 End-to-End Tests (Required After Phase 6)

| Test Type | Description | Pass Criteria |
|-----------|-------------|---------------|
| Auth flow | Login, token refresh, logout | Tokens issued and validated correctly |
| Sensor ingestion | Publish MQTT message, verify it reaches sensor-service via NATS | Data appears in database within 5s |
| Farm CRUD | Create farm, site, tank, batch via GraphQL | All mutations succeed, queries return data |
| Alert pipeline | Trigger threshold breach, verify alert fires | Alert created and notification sent |

### 8.4 Monitoring (Required After Each Phase)

- 24-hour monitoring window (48 hours for gateway)
- Watch: error rate, p99 latency, NATS consumer lag, memory usage, pod restart count
- Automated Grafana alerts for anomaly detection

---

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Express v5 path-to-regexp crash | **High** if FIX-1 missed | **Critical** -- service fails to start | Pre-upgrade FIX-1 applied before any v11 code |
| `installSubscriptionHandlers` crash | **High** if FIX-2 missed | **Critical** -- config-service fails to start | Pre-upgrade FIX-2 applied before any v11 code |
| `CqrsModule` dedup breaks DI | **Medium** | **High** -- commands/queries silently fail | FIX-3 standardizes `.forRoot()`, Phase 2 canary validates |
| `req.ip` undefined causes TypeError | **Medium** | **Medium** -- request logging/rate-limiting breaks | FIX-4 adds null guards preemptively |
| `scanFromPrototype` deprecation | **Low** | **Low** -- warning only in v11, removed in v12 | FIX-5 applies the replacement pattern |
| farm-service 20-module CqrsModule dedup | **Medium** | **Medium** -- handlers may not register | Validated in Phase 5 with full module bootstrap test |
| Apollo Federation v10/v11 mismatch | **Low** | **High** -- gateway cannot compose supergraph | Phase 3 explicitly tests cross-version composition |
| NATS protocol incompatibility | **Very Low** | **Critical** -- inter-service messaging breaks | NATS client protocol is version-agnostic; validated in Phase 2 |
| Third-party package peer dep conflict | **Medium** | **Low** -- build fails, caught before deploy | Resolved in Phase 1 during `npm install` |
| Swagger v8 decorator regression | **Low** | **Low** -- API docs render incorrectly | Validated per-service in Phase 4 (admin-api) |

---

## 10. Safe Deployment Checklist

Use this checklist on the day of each phase deployment:

- [ ] All pre-upgrade fixes (FIX-1 through FIX-5) merged to `main`
- [ ] Current production SHA recorded for each service in this phase
- [ ] Docker images built and pushed to GHCR with SHA tag
- [ ] `npm test` passes for all services in this phase
- [ ] `npm run build` succeeds for the entire monorepo
- [ ] TypeScript `--noEmit` compilation succeeds
- [ ] Deployment window communicated to stakeholders
- [ ] Grafana dashboards open for real-time monitoring
- [ ] Rollback procedure reviewed by on-call engineer
- [ ] Services deployed one at a time within the phase
- [ ] Health checks verified after each service deploy
- [ ] 24-hour monitoring window started (48 hours for gateway)
- [ ] Phase sign-off from engineering lead before proceeding to next phase

---

## 11. Consequences

### Positive

- **Security:** Express v5 hardens path parsing, eliminates prototype pollution vectors, and receives active CVE patches.
- **Performance:** NestJS v11 module deduplication reduces memory footprint in large services like farm-service (20+ modules).
- **Ecosystem alignment:** Unlocks `@nestjs/graphql` v13, `@nestjs/swagger` v8, and other companion packages that require v11 core.
- **Developer experience:** Developers work with the latest stable NestJS, reducing documentation mismatch and onboarding friction.
- **Future-proofing:** `scanFromPrototype` removal in v12 will not require emergency patches.

### Negative

- **6-week timeline:** The phased rollout is deliberately slow to minimize risk, but it means 6 weeks of mixed v10/v11 in production.
- **Testing overhead:** Each phase requires 24-48 hours of monitoring, extending the calendar timeline.
- **Cognitive load:** During the transition, developers must be aware of both v10 and v11 patterns when debugging production issues.

### Neutral

- **No database changes:** TypeORM ^0.3.28 is unaffected; no migrations are introduced by this upgrade.
- **No frontend impact:** All `@nestjs/*` packages are backend-only; MFE modules are unaffected.
- **No NATS protocol change:** The NATS client library is independent of NestJS version; wire format is stable.
- **No JWT/auth token change:** Token structure, signing, and validation are unchanged.
