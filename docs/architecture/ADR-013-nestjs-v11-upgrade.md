# ADR-013: NestJS v10 to v11 Monorepo Upgrade

**Status:** Proposed (Reviewed)
**Date:** 2026-03-29
**Reviewed:** 2026-03-30 (4-agent expert review: code-reviewer, architecture, devops/sre, risk-assessment)
**Decision Makers:** Engineering Lead
**Related:** ADR-012 (Messaging Service), ADR-007 (CQRS Usage Strategy), event-driven-architecture.md, microservices-design.md

---

## 1. Context & Problem Statement

The platform runs NestJS v10.3-10.4 across 14 backend services and 3 shared libraries. NestJS v11 was released with Express v5 as the default HTTP adapter, bringing breaking changes to path matching, request handling, and several companion packages. Staying on v10 means:

1. **Security exposure** -- Express v4 reaches maintenance-only status; new CVEs will not receive patches.
2. **Ecosystem drift** -- Community packages increasingly target v11; staying on v10 creates compatibility friction.
3. **Missing features** -- v11 introduces performance improvements, better module deduplication, and streamlined metadata scanning.
4. **Developer experience** -- New hires familiar with v11 encounter unnecessary friction with v10 patterns.

**Goal:** Upgrade all 14 backend services and 3 platform libraries from NestJS v10 to v11 atomically (per-phase), with minimal downtime and safe per-service rollback.

> **Note:** True zero-downtime is not achievable on a single-node Docker Compose deployment without replicas. Expect 5-30 seconds of unavailability per service during container recreation. The gateway (Phase 6) should use a brief blue-green approach to minimize user-facing impact.

### Scope

| Category | Count |
|----------|-------|
| Backend services | 14 (admin-api, ai, alert-engine, auth, billing, config, event-store, farm, gateway-api, hr, hydroponics, messaging, notification, observability) |
| Platform libraries | 3 (libs/backend-common, platform/cqrs, platform/event-bus) |
| Additional workspace libs to audit | 6 (libs/event-contracts, libs/storage, libs/sdk, libs/shared, libs/testing, libs/farm-shared) |
| Affected files (estimated) | ~1,700 |
| Total `@nestjs/` imports | ~2,738 |

---

## 2. Decision Drivers

1. **Express v5 security** -- Express v4 maintenance window is closing; v5 brings hardened path parsing and prototype pollution fixes.
2. **Atomic companion versions** -- NestJS core, companion, and third-party packages must move together to avoid runtime `PeerDependency` crashes.
3. **Minimal downtime** -- Production fish farms rely on 24/7 sensor data ingestion; any outage directly impacts livestock.
4. **Rollback safety** -- Each phase must be independently reversible without data migration. Rollback uses pre-existing Docker images, not new builds.
5. **NATS wire compatibility** -- v10 and v11 services must coexist on the same NATS bus during the phased rollout.
6. **Apollo Federation continuity** -- The gateway must compose subgraph schemas from a mix of v10/v11 services during transition. Composition is ALL-OR-NOTHING: if any single subgraph fails introspection, the entire supergraph composition fails.

---

## 3. Decision

Upgrade 13 `@nestjs/*` packages in a coordinated 6-phase rollout over 3-6 weeks.

> **Timeline note:** Minimum 3 weeks (phases 3/4/5 can run in parallel after Phase 2 succeeds). Maximum 6 weeks with full serial execution and buffer time. Phases 3, 4, and 5 are independent of each other -- they all depend on Phase 2 and the gateway (Phase 6) depends on all of them.

### 3.1 Version Matrix

| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| `@nestjs/common` | ^10.3.0 | 11.0.x (pinned) | Core -- must upgrade first |
| `@nestjs/core` | ^10.3.0 | 11.0.x (pinned) | Core -- must upgrade first |
| `@nestjs/platform-express` | ^10.4.20 | 11.0.x (pinned) | Pulls in Express v5 |
| `@nestjs/graphql` | ^12.2.2 | 13.x (pinned) | Breaking: `installSubscriptionHandlers` removed |
| `@nestjs/apollo` | ^12.2.2 | 13.x (pinned) | Must match `@nestjs/graphql` |
| `@nestjs/typeorm` | ^10.0.2 | 11.x (pinned) | Peer dep on `@nestjs/core` ^11 |
| `@nestjs/config` | ^3.3.0 | 4.x (pinned) | Minor API changes -- audited, no code changes required |
| `@nestjs/swagger` | ^7.4.2 | 8.x (pinned) | Decorator changes -- see section 4.8 |
| `@nestjs/cqrs` | ^10.2.8 | 11.x (pinned) | `.forRoot()` standardization |
| `@nestjs/microservices` | ^10.4.22 | 11.x (pinned) | NATS transport unchanged |
| `@nestjs/platform-socket.io` | ^10.4.20 | 11.x (pinned) | Socket.IO adapter unchanged |
| `@nestjs/websockets` | ^10.4.20 | 11.x (pinned) | Peer dep alignment |
| `@nestjs/testing` | ^10.4.20 | 11.x (pinned) | devDependency -- test compat |

> **IMPORTANT:** Pin exact minor versions from Phase 1 onwards. Do NOT use caret ranges (`^11.x`) during the upgrade window. This prevents mid-upgrade version drift if NestJS releases a patch during the 3-6 week window. Only `npm ci` (never `npm install`) should be used after the initial lockfile is generated.

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
| Apollo packages | latest | `@apollo/*` independent of `@nestjs/apollo`. Verify `@apollo/gateway` v2.12.1 + `@apollo/subgraph` v2.12.1 compatibility with `@nestjs/apollo` v13 |

---

## 4. Breaking Changes

### 4.1 CRITICAL -- Express v5 Path Matching

**Impact:** Application crash on startup if `path-to-regexp` v8 encounters v7 syntax.

Express v5 uses `path-to-regexp` v8 which changes regex-style route parameters. The pattern `(.*)` is no longer valid; use `{*path}` instead.

| File | Line | Current | Required |
|------|------|---------|----------|
| `apps/ai-service/src/app.module.ts` | 235 | `.exclude('health', 'health/(.*)')` | `.exclude('health', 'health/{*path}')` |
| `apps/hydroponics-service/src/app.module.ts` | 215 | `.exclude('health', 'health/(.*)')` | `.exclude('health', 'health/{*path}')` |
| `apps/messaging-service/src/app.module.ts` | 315 | `.exclude('health', 'health/(.*)')` | `.exclude('health', 'health/{*path}')` |

> **WARNING:** FIX-1 must be batched with the version bump commit, NOT merged independently to `main` while services still run v10. The `{*path}` syntax is `path-to-regexp` v8; it may not be backward-compatible with v7 on the current v10 runtime. Verify backward-compat before independent merge.

### 4.2 CRITICAL -- Express v5 `forRoutes('*')` Wildcard

**Impact:** If `path-to-regexp` v8 changes wildcard behavior, ALL middleware silently stops applying to routes. This includes tenant isolation middleware (`TenantContextMiddleware`, `TenantSchemaMiddleware`) -- silent tenant data leakage.

12 files use `forRoutes('*')`:

| File | Line |
|------|------|
| `apps/ai-service/src/app.module.ts` | 236 |
| `apps/hydroponics-service/src/app.module.ts` | 216 |
| `apps/alert-engine/src/app.module.ts` | 183 |
| `apps/auth-service/src/app.module.ts` | 240 |
| `apps/notification-service/src/app.module.ts` | 165 |
| `apps/farm-service/src/app.module.ts` | 329 |
| `apps/billing-service/src/app.module.ts` | 162 |
| `apps/hr-service/src/app.module.ts` | 308 |
| `apps/sensor-service/src/app.module.ts` | 410 |
| `apps/gateway-api/src/app.module.ts` | 622 |
| `apps/messaging-service/src/app.module.ts` | 316 |
| `libs/backend-common/src/logging/logging.module.ts` | 23 |

> **BLOCKER:** Before Phase 1, verify `forRoutes('*')` works in NestJS v11 + Express v5 by standing up a minimal test app. If it fails, change all instances to `forRoutes({ path: '*', method: RequestMethod.ALL })`.

### 4.3 CRITICAL -- `installSubscriptionHandlers` Removed

**Impact:** `@nestjs/graphql` v13 removes this option entirely. Passing it throws `UnknownOptionError`.

| File | Line | Current | Required |
|------|------|---------|----------|
| `apps/config-service/src/app.module.ts` | 67 | `installSubscriptionHandlers: false,` | Delete the entire line |

### 4.4 HIGH -- `MetadataScanner.scanFromPrototype()` Deprecated

**Impact:** Runtime deprecation warning in v11; will be removed in v12. Replace with `getAllMethodNames()`.

| File | Line | Current | Required |
|------|------|---------|----------|
| `platform/libs/event-bus/src/nats/nats.module.ts` | 134 | `this.metadataScanner.scanFromPrototype(instance, Object.getPrototypeOf(instance), (methodKey) => { ... })` | `for (const methodKey of this.metadataScanner.getAllMethodNames(Object.getPrototypeOf(instance))) { ... }` |

> **RISK:** If the replacement is incorrect, NATS event subscriptions silently fail to register. Sensor data flows into NATS but is never consumed -- data loss without crash or error log. Write a handler count assertion test before applying this fix.

### 4.5 HIGH -- `req.ip` Can Be `undefined` in Express v5

**Impact:** Runtime `TypeError` where code assumes `req.ip` is always a string. Express v5 returns `undefined` when the request has no remote address (e.g., during proxy trust evaluation failure).

Files **requiring** null guards:

| File | Line | Pattern |
|------|------|---------|
| `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts` | 41 | `req.ip` in template literal -- needs `?? 'unknown'` |
| `apps/gateway-api/src/middleware/timeout.middleware.ts` | 90 | `ip: req.ip` -- needs `ip: req.ip ?? 'unknown'` |
| `apps/gateway-api/src/middleware/request-validator.middleware.ts` | 208 | `ip: req.ip` -- needs `ip: req.ip ?? 'unknown'` |
| `apps/gateway-api/src/csp-report/csp-report.controller.ts` | 81, 87 | `req.ip` -- needs null guard |
| `libs/backend-common/src/security/throttler/throttler.guard.ts` | 218 | `req.ip` -- needs null guard |
| `libs/backend-common/src/logging/request-context.middleware.ts` | 65 | `ip: req.ip` -- needs null guard |

Files **already safe** (no changes needed):

| File | Line | Pattern |
|------|------|---------|
| `apps/gateway-api/src/middleware/correlation-id.middleware.ts` | 200 | `ip: req.ip \|\| req.headers['x-forwarded-for']` -- already safe |
| `apps/gateway-api/src/middleware/device-fingerprint.middleware.ts` | 144 | `req.ip \|\| ...` -- already has fallback to `'unknown'` |
| `apps/gateway-api/src/interceptors/request-logging.interceptor.ts` | 106 | `ip: request.ip \|\| request.connection?.remoteAddress` -- already safe |
| `apps/gateway-api/src/guards/rate-limit.guard.ts` | 407 | `if (request.ip && ...)` -- already has truthy check |
| `apps/gateway-api/src/guards/opa-policy.guard.ts` | 380 | `ip: request.ip ?? request.connection?.remoteAddress` -- already safe |
| `apps/observability-service/src/main.ts` | 42 | `req.ip \|\|` -- already safe |
| `apps/auth-service/src/modules/gdpr/resolvers/user-consent.resolver.ts` | 299-300 | `req.ip` guarded by `if` -- already safe |
| `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts` | 352 | `req.ip \|\| req.socket.remoteAddress` -- already safe |
| `libs/backend-common/src/security/ip-validation/ip-validator.service.ts` | 108 | `if (request.ip && ...)` -- already safe |

> **WARNING (rate-limiting):** The fallback `'unknown'` groups all unresolvable IPs into a single rate-limit bucket. Consider using `req.socket?.remoteAddress ?? 'unknown'` instead to preserve per-client discrimination.

### 4.6 HIGH -- `trust proxy` Behavior Under Express v5

**Impact:** Express v5 changes how `trust proxy` interacts with `req.ip`. If proxy trust evaluation fails, `req.ip` returns `undefined` rather than `req.connection.remoteAddress`. All 10 services configure `trust proxy` via `app.getHttpAdapter().getInstance().set('trust proxy', ...)`.

**Verification:** After Phase 6 (gateway), confirm `req.ip` returns the correct client IP when behind the nginx reverse proxy. Verify `set('trust proxy', 1)` works identically in Express v5.

### 4.7 MEDIUM -- `CqrsModule` Must Use `.forRoot()` in App Modules

**Impact:** v11 DynamicModule deduplication changes mean bare `CqrsModule` imports (without `.forRoot()`) may not register the internal `CommandBus`/`QueryBus`/`EventBus` providers correctly when multiple feature modules also import `CqrsModule`.

| File | Line | Current | Required |
|------|------|---------|----------|
| `apps/config-service/src/app.module.ts` | 82 | `CqrsModule,` | `CqrsModule.forRoot(),` |
| `apps/admin-api-service/src/app.module.ts` | 100 | `CqrsModule,` | `CqrsModule.forRoot(),` |
| `apps/event-store-service/src/app.module.ts` | 58 | `CqrsModule,` | `CqrsModule.forRoot(),` |
| `apps/farm-service/src/app.module.ts` | 235 | `CqrsModule,` (from `@platform/cqrs`) | `CqrsModule.forRoot(),` |

Services **already correct** (no changes needed):

| File | Line | Status |
|------|------|--------|
| `apps/hr-service/src/app.module.ts` | 235 | Already uses `CqrsModule.forRoot()` |
| `apps/messaging-service/src/app.module.ts` | 245 | Already uses `CqrsModule.forRoot()` |

### 4.8 MEDIUM -- Dual CQRS Systems With Different v11 Dedup Behaviors

**Impact:** The codebase uses TWO CQRS implementations:
- `@nestjs/cqrs` (official) -- used by config-service, event-store-service, admin-api-service, billing-service, hr-service, messaging-service (~215 import occurrences)
- `@platform/cqrs` (custom, `@Global()`) -- used by farm-service and its 20 feature modules (~250 import occurrences)

The custom `@platform/cqrs` CqrsModule at `platform/libs/cqrs/src/cqrs.module.ts:21` IS marked `@Global()`. Under v11's module deduplication, the 20 feature modules importing it redundantly may cause handler registration issues.

**Resolution:** Since `@platform/cqrs` is `@Global()`, remove `CqrsModule` from all 20 farm-service feature module `imports` arrays and keep only the root `AppModule.forRoot()` import:

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

> **Validation:** Write a smoke test that executes at least one command and one query from each of the 20 feature modules. Add a debug log at `CqrsModule.registerHandlers()` that logs the total handler count. Establish a v10 baseline and verify it matches on v11.

### 4.9 MEDIUM -- `@nestjs/swagger` v8 Decorator Changes

**Impact:** `@ApiProperty()` metadata inference may differ. Mostly transparent, but custom decorators wrapping Swagger metadata should be regression-tested. `admin-api-service` has 30+ controllers with `@ApiTags` decorators.

**Verification:** After deploying `admin-api-service` (Phase 4), compare the auto-generated OpenAPI JSON document against the v10 output. Use `diff` on the schema output to catch any changes.

### 4.10 MEDIUM -- `@nestjs/graphql` v13 Schema Generation

**Impact:** `@nestjs/graphql` v12 to v13 is a MAJOR version bump affecting every service with `ApolloFederationDriver`. Beyond `installSubscriptionHandlers` removal, v13 may change:
- Federation SDL generation (entity references, `@key` directives)
- Schema-first vs code-first behavior
- Module deduplication interaction with GraphQL resolvers

**Verification:** In Phase 1, generate the federation SDL from each subgraph under v13 and compare byte-for-byte with the v12 output. Verify `@Directive('@key')`, `@ResolveReference()`, and entity reference resolution work identically.

### 4.11 CRITICAL -- Module Opaque Key Change (DynamicModule Deduplication)

**Impact:** In v10, NestJS used a hash function to generate opaque keys for DynamicModules. In v11, it uses object references instead. This means if the same DynamicModule is imported in multiple places using separate `forRoot()` / `forFeature()` calls, v11 treats each call as a DIFFERENT module instance (because different call = different object reference). To share a single module instance, you must assign the DynamicModule to a variable and import that variable everywhere.

**Critical for this codebase:**

1. **`@platform/cqrs` CqrsModule** -- Used via `CqrsModule.forRoot()` at app level and potentially `CqrsModule` (bare or `.forFeature()`) in 20+ feature modules. If each import creates a new object reference, v11 may create 20+ separate CqrsModule instances, each with their own `CommandBus`/`EventBus`. Commands published in one module's bus would not reach handlers in another.

2. **`EventBusModule.forRootAsync()`** -- Used in 10 services. Each service creates a single instance (app-level only), so this is safe. But verify no feature module also imports `EventBusModule`.

3. **`ConfigModule.forRoot()` / `ConfigModule.forFeature()`** -- Used across all services. Since `ConfigModule` is typically `@Global()` and imported once at app level, this should be safe. Verify no duplicate imports.

**Resolution:**
- For `@platform/cqrs`: Since it is `@Global()` and FIX-6 removes it from all feature modules, only the single app-level `CqrsModule.forRoot()` import remains. This eliminates the opaque key dedup problem.
- For any other DynamicModule used in multiple places: assign to a variable:

```typescript
// WRONG in v11 -- creates separate module instances
imports: [TypeOrmModule.forFeature([Entity1]), TypeOrmModule.forFeature([Entity2])]

// CORRECT in v11 -- but only relevant if sharing the exact same config
const sharedModule = TypeOrmModule.forFeature([Entity1, Entity2]);
imports: [sharedModule]
```

> **NOTE:** `TypeOrmModule.forFeature()` calls with DIFFERENT entity lists are intentionally different modules -- this is correct behavior. The opaque key change only matters when the SAME config is imported multiple times.

### 4.12 HIGH -- Middleware Ordering Change for @Global() Modules

**Impact:** In v11, middleware defined in `@Global()` modules now ALWAYS runs first, regardless of its position in the module dependency graph. In v10, global modules were ordered like normal modules.

**Critical for this codebase:**

This affects `libs/backend-common` which exports several `@Global()` modules with middleware:
- `LoggingModule` (line 23 of `logging.module.ts`) -- applies request-context middleware via `forRoutes('*')`
- `ThrottlerModule` -- applies throttler guard globally

**Potential issue:** If logging middleware now runs BEFORE tenant middleware (which sets `X-Tenant-Id` context), log entries may lack tenant information. Similarly, if throttler runs before auth middleware, rate-limiting may not have access to authenticated user info.

**Verification needed in Phase 1:**
1. Document the current v10 middleware execution order for gateway-api (the most middleware-heavy service)
2. After upgrading, verify the v11 order and identify any behavioral changes
3. Pay special attention to: TenantContextMiddleware vs LoggingModule middleware ordering

### 4.13 HIGH -- `ConfigService#get` Resolution Order Change

**Impact:** In v11, `ConfigService#get` changes the order in which it resolves configuration values. `process.env` values can now override custom config factory values. A new `skipProcessEnv` option is available.

**Critical for this codebase:**

All 14 services use `ConfigModule.forRoot()` with custom config factories (via `load: [configuration]`). If any service relies on config factory values taking precedence over environment variables with the same key, v11 may silently return different values.

**High-risk examples:**
- Database connection strings (`DATABASE_HOST`, `DATABASE_PORT`) -- if `.env` has different values than the config factory
- Service URLs (`AUTH_SERVICE_URL`, `SENSOR_SERVICE_URL`) -- gateway uses these for subgraph composition
- NATS connection (`NATS_URL`) -- affects inter-service messaging

**Verification needed in Phase 1:**
1. Audit all `ConfigService.get()` calls that might conflict with `process.env` keys
2. If config factories should take precedence, add `skipProcessEnv: true` to `ConfigModule.forRoot()` options
3. Compare resolved config values between v10 and v11 for each service

### 4.14 HIGH -- Lifecycle Hook Ordering Reversed

**Impact:** `OnModuleDestroy` and `OnApplicationShutdown` hooks now execute in **reverse module order** during shutdown. In v10, shutdown hooks followed the same order as initialization. In v11, they are reversed -- this is the correct behavior (destroy dependencies last), but it changes the shutdown sequence.

**Scope:** 46 files across the codebase implement `OnModuleDestroy` or `OnApplicationShutdown` (92 total occurrences). Key services with graceful shutdown logic:

| Service | File | Concern |
|---------|------|---------|
| `admin-api-service` | `lifecycle/graceful-shutdown.service.ts` | Explicit shutdown orchestration -- verify order still correct |
| `sensor-service` | `mqtt-client.service.ts`, `data-ingestion.service.ts`, `batch-processor.service.ts` | MQTT disconnect must happen AFTER in-flight batches flush |
| `gateway-api` | `http-pool.service.ts`, `nats-bridge.service.ts`, WebSocket bridges | HTTP pool cleanup must happen AFTER WebSocket connections close |
| `alert-engine` | `escalation-manager.service.ts`, `rules-engine.service.ts` | Rule engine shutdown must happen AFTER pending escalations complete |
| `messaging-service` | `embedding.service.ts`, `messaging-metrics.service.ts` | Metrics flush must happen BEFORE service disconnect |
| `platform/event-bus` | `nats-event-bus.ts` | NATS disconnect must be LAST -- all services depend on it |

**Verification needed in Phase 1:**
1. Document current v10 shutdown order for sensor-service and gateway-api (most complex)
2. After upgrade, verify v11 shutdown order does not cause data loss (e.g., NATS disconnects before batch processor flushes)
3. If ordering is critical, use explicit shutdown orchestration (like admin-api's `graceful-shutdown.service.ts`) rather than relying on hook ordering

### 4.15 MEDIUM -- Express v5 Route Path Syntax Changes (Beyond Wildcards)

**Impact:** Express v5 (`path-to-regexp` v8) has additional route syntax changes beyond the `(.*)` wildcard:

| Change | Old Syntax | New Syntax | Status in Codebase |
|--------|-----------|------------|-------------------|
| Wildcard must be named | `/users/*` | `/users/*path` | Covered by FIX-1 + FIX-7 |
| Optional char `?` removed | `/:file.:ext?` | `/:file{.:ext}` | **Not used** -- no optional params found |
| Regex in routes removed | `/:id(\\d+)` | Not supported | **Not used** -- all `@Param()` use simple strings |
| Reserved chars must be escaped | `(`, `)`, `[`, `]`, `?`, `+`, `!` | `\(`, `\)`, etc. | **Not used** in route definitions |
| Param names must be valid JS identifiers | `:"this"` for non-identifier names | Quoted params | **Not used** -- all params are valid identifiers |

**Status:** Codebase audit shows NO route definitions using optional params, regex in paths, or reserved characters. All 1,210 `@Param()` usages are simple string parameters. The only breaking pattern is `(.*)` in `.exclude()` calls (FIX-1). **No additional fixes needed.**

### 4.16 LOW -- CacheModule Updated to cache-manager v6

**Impact:** NestJS v11's `CacheModule` uses `cache-manager` v6 with Keyv-based storage interface. Old cache configurations need updating.

**Status:** `CacheModule` is NOT used in this codebase. Redis caching is handled directly via `libs/backend-common/src/redis/redis.service.ts` using `ioredis`. **No action needed.**

### 4.17 LOW -- Node.js Minimum Version Requirement

**Impact:** NestJS v11 drops support for Node.js v16 and v18. Minimum required version is Node.js v20.

**Status:** Already satisfied. The platform uses `node:22-alpine` in Dockerfiles and `engines: ">=20.11.0"` in `package.json`. No action needed.

### 4.18 INFO -- New Features Available After Upgrade

These are NOT breaking changes but new capabilities available after the upgrade:

| Feature | Description | Potential Use |
|---------|-------------|---------------|
| `ConsoleLogger({ json: true })` | JSON log format built-in | Replace custom JSON logging in container environments |
| `unwrap()` on transporters | Direct access to native NATS/Redis/Kafka client | Advanced NATS operations in sensor-service and event-bus |
| `on()` on transporters | Listen to internal client events (disconnect, error) | Better error handling in messaging-service NATS clients |
| `status` observable | Real-time connection state stream (connected, disconnected, reconnecting) | Monitor NATS/MQTT connection health in sensor-service |
| `ClientProxy` consistency | `unwrap`, `on`, `status` available on both server and client side | Unified API for messaging-service (23 files, 47 usages of ClientProxy/ClientsModule) |
| Microservice options from DI | Config from `ConfigService` injectable into microservice setup | Dynamic NATS/MQTT broker URLs without hardcoding |
| `ParseDatePipe` | Built-in date parsing pipe | Simplify date parameter handling in controllers |
| `IntrinsicException` | Non-logged exceptions | Prevent sensitive error details from appearing in logs |
| CQRS request-scoped providers | Strongly-typed commands/events/queries + request scope | Improve type safety in CQRS handlers across all services |
| `skipProcessEnv` in ConfigService | Opt out of process.env override | Explicit config factory precedence control |

---

## 5. Pre-Upgrade Fixes (Blocking)

> **Sequencing:** FIX-3, FIX-4, and FIX-5 are safe to merge independently on v10. FIX-1 and FIX-2 must be batched with the version bump commit (Phase 1) because the replacement syntax may not be backward-compatible with `path-to-regexp` v7.

- [ ] **FIX-1:** Replace `health/(.*)` with `health/{*path}` in `.exclude()` calls (**batch with version bump**)
  - `apps/ai-service/src/app.module.ts:235`
  - `apps/hydroponics-service/src/app.module.ts:215`
  - `apps/messaging-service/src/app.module.ts:315`

- [ ] **FIX-2:** Remove `installSubscriptionHandlers: false` from GraphQL config (**batch with version bump**)
  - `apps/config-service/src/app.module.ts:67`

- [ ] **FIX-3:** Standardize `CqrsModule` to `.forRoot()` in app-level modules (**safe to merge on v10**)
  - `apps/config-service/src/app.module.ts:82` -- change `CqrsModule,` to `CqrsModule.forRoot(),`
  - `apps/admin-api-service/src/app.module.ts:100` -- change `CqrsModule,` to `CqrsModule.forRoot(),`
  - `apps/event-store-service/src/app.module.ts:58` -- change `CqrsModule,` to `CqrsModule.forRoot(),`
  - `apps/farm-service/src/app.module.ts:235` -- change `CqrsModule,` to `CqrsModule.forRoot(),`

- [ ] **FIX-4:** Add `req.ip` null guards (**safe to merge on v10**)
  - `apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts:41`
  - `apps/gateway-api/src/middleware/timeout.middleware.ts:90`
  - `apps/gateway-api/src/middleware/request-validator.middleware.ts:208`
  - `apps/gateway-api/src/csp-report/csp-report.controller.ts:81,87`
  - `libs/backend-common/src/security/throttler/throttler.guard.ts:218`
  - `libs/backend-common/src/logging/request-context.middleware.ts:65`

- [ ] **FIX-5:** Replace `scanFromPrototype()` with `getAllMethodNames()` in event-bus (**safe to merge on v10**)
  - `platform/libs/event-bus/src/nats/nats.module.ts:134`
  - Write handler count assertion test to verify all `@SubscribeTo` methods are discovered

- [ ] **FIX-6:** Remove redundant `CqrsModule` from farm-service feature modules (**safe to merge on v10**)
  - Remove `CqrsModule` from all 20 feature module `imports` arrays (see section 4.8)
  - Keep only the root `AppModule.forRoot()` import since `@platform/cqrs` is `@Global()`

- [ ] **FIX-7:** Verify `forRoutes('*')` compatibility (**BLOCKER for Phase 1**)
  - Stand up a minimal NestJS v11 + Express v5 app with middleware using `forRoutes('*')`
  - If it fails, change all 13 instances to `forRoutes({ path: '*', method: RequestMethod.ALL })`

---

## 6. Six-Phase Upgrade Plan

### Critical Path

```
Phase 1 (libs) → Phase 2 (canary) → Phase 3 (subgraphs) ─┐
                                   → Phase 4 (heavy)      ├→ Phase 6 (gateway)
                                   → Phase 5 (critical)   ┘
```

Phases 3, 4, and 5 are independent -- they CAN run in parallel if Phase 2 results are satisfactory. Running them in parallel compresses timeline from 6 weeks to 3-4 weeks but increases rollback complexity.

### Go/No-Go Gates

| Gate | Criteria |
|------|----------|
| Phase 1 → 2 | All tests pass, build succeeds, `npm ci` resolves, `forRoutes('*')` verified |
| Phase 2 → 3/4/5 | All canary services healthy for 24h, no NATS cross-version issues, error rate unchanged |
| Phase 3/4/5 → 6 | All subgraph services healthy, `rover supergraph compose` succeeds, zero regression in E2E queries |
| Phase 6 → Done | Gateway healthy for 48h, full E2E test suite passes, no stakeholder-reported issues |

### Phase 1 -- Foundation (Week 1)

**Target:** All shared libraries + root `package.json` + full monorepo build verification

> **IMPORTANT:** This is an npm workspaces monorepo with a single root `package.json`. The moment `npm install` runs with v11 ranges, EVERY service resolves `@nestjs/core` to v11 from hoisted `node_modules`. ALL 14 services must be buildable after this phase, not just the libraries.

**Before starting Phase 1:**
- [ ] Tag and preserve ALL current production Docker images as `v10-baseline-{service}` in GHCR with 90-day retention policy
- [ ] Record production SHA for every service
- [ ] Take a full database backup
- [ ] Verify FIX-7 (`forRoutes('*')` backward compatibility) -- BLOCKER
- [ ] Verify FIX-1 (`{*path}` syntax) backward compatibility with `path-to-regexp` v7

**Phase 1 tasks:**
- [ ] Merge FIX-3, FIX-4, FIX-5, FIX-6 to `main` (these are safe on v10)
- [ ] Update root `package.json` with pinned v11 version ranges + apply FIX-1, FIX-2 in the same commit
- [ ] Run `npm install` and resolve peer dependency conflicts (note: `--legacy-peer-deps` is already used in CI)
- [ ] Commit regenerated `package-lock.json` -- all subsequent builds must use `npm ci` only
- [ ] Audit ALL workspace libs for `@nestjs/*` imports: `libs/event-contracts`, `libs/storage`, `libs/sdk`, `libs/shared`, `libs/testing`, `libs/farm-shared`
- [ ] Upgrade `libs/backend-common` -- fix `req.ip` null guards, throttler guard
- [ ] Upgrade `platform/libs/cqrs` -- verify `CqrsModule.forRoot()` / `@Global()` behavior under v11
- [ ] Upgrade `platform/libs/event-bus` -- replace `scanFromPrototype()` with `getAllMethodNames()`, run handler count assertion test
- [ ] Generate federation SDL from each subgraph under v13 and diff against v12 output
- [ ] Run full lint + build for **ALL 14 services** (not just libraries): `npm run build`
- [ ] Run full test suite: `npm test`
- [ ] Run `npm run codegen:check` to detect GraphQL schema changes
- [ ] Verify TypeScript compilation with `--noEmit` across the monorepo
- [ ] Verify `@apollo/gateway` v2.12.1 + `@apollo/subgraph` v2.12.1 compatibility with `@nestjs/apollo` v13

**CI/CD protection:**
- [ ] The Phase 1 commit that updates `package.json` MUST NOT trigger automatic deployment. Use `[skip deploy]` in commit message or use `workflow_dispatch` for all phase deployments. The `deploy-digitalocean.yml` change detection triggers full deploy on `package.json` changes.
- [ ] All phase deployments use manual `workflow_dispatch` with explicit service names (already supported by deploy workflow)

### Phase 2 -- Canary Services (Week 1-2)

**Target:** event-store-service, observability-service (2 services)

> **Note:** `config-service` was moved to Phase 3. It is an Apollo Federation subgraph (registered in gateway's `IntrospectAndCompose` list) -- deploying it without federation validation risks ALL-OR-NOTHING composition failure.

- [ ] Deploy `event-store-service` via `workflow_dispatch`
  - Verify module bootstrap succeeds
  - Verify FIX-3 (`CqrsModule.forRoot()`) applied correctly
  - Verify NATS event consumption works
  - Verify `StoredEvent` serialization: read existing events AND write new events, check `BigIntTransformer` `globalPosition` values
  - Run `npm test -- --scope=event-store-service`
- [ ] Deploy `observability-service` via `workflow_dispatch`
  - Verify health endpoint responds
  - Verify `PrometheusModule` and `MetricsAggregatorModule` still work
  - Run `npm test -- --scope=observability-service`
- [ ] Verify NATS cross-version compatibility: publish event from v10 service, consume in v11 service (and vice versa)
- [ ] Monitor both services for 24 hours before proceeding
- [ ] Record baseline metrics: average response time, memory usage per container (`docker stats --no-stream`), NATS consumer lag

### Phase 3 -- GraphQL Subgraphs (Week 2-3)

**Target:** config-service, notification-service, billing-service, alert-engine, hydroponics-service (5 services)

> **Note:** `ai-service` was moved to Phase 4. It is NOT registered in the gateway's `IntrospectAndCompose` subgraph list -- it has zero Federation composition risk.

> **CRITICAL:** Deploy one subgraph at a time. After EACH deploy, immediately run `rover supergraph compose` to verify composition. Have the rollback Docker image SHA ready for each subgraph.

- [ ] Deploy `config-service` -- verify `installSubscriptionHandlers` removal (FIX-2), verify `CqrsModule.forRoot()` bootstraps, verify subgraph schema registers with gateway
- [ ] Run `rover supergraph compose` -- verify composition succeeds
- [ ] Deploy `notification-service` -- verify subgraph schema registers with gateway
- [ ] Run `rover supergraph compose` -- verify composition succeeds
- [ ] Deploy `billing-service` -- verify subgraph schema registers, verify CQRS event handlers
- [ ] Run `rover supergraph compose` -- verify composition succeeds
- [ ] Deploy `alert-engine` -- verify alerting pipeline end-to-end
- [ ] Run `rover supergraph compose` -- verify composition succeeds
- [ ] Deploy `hydroponics-service` -- verify `.exclude('health/{*path}')` fix
- [ ] Run `rover supergraph compose` -- verify composition succeeds
- [ ] Verify gateway can query all v11 subgraphs without error
- [ ] Run `npm run codegen:check` -- diff generated `graphql-types.ts` against pre-upgrade version
- [ ] Run full test suite for each service
- [ ] Monitor for 24 hours before proceeding

### Phase 4 -- Heavy Services (Week 3-4)

**Target:** admin-api-service, hr-service, messaging-service, ai-service (4 services)

- [ ] Deploy `admin-api-service`
  - Verify `CqrsModule.forRoot()` + tenant module CQRS handlers
  - Compare auto-generated OpenAPI JSON against v10 output (Swagger v8 regression test)
  - Set `DATABASE_SYNC=false` during deployment, verify schema matches before re-enabling
  - Verify deprecation interceptor (`apps/admin-api-service/src/shared/deprecation.interceptor.ts`)
  - Verify `EventBusModule.forRootAsync()` (uses upgraded `getAllMethodNames`)
  - Run `npm test -- --scope=admin-api-service`
- [ ] Deploy `hr-service`
  - Verify all 7 feature modules bootstrap
  - Verify `CqrsModule.forRoot()` at app level (already correct at line 235)
  - Run `npm test -- --scope=hr-service`
- [ ] Deploy `messaging-service`
  - Verify `.exclude('health/{*path}')` fix
  - Verify NATS publish/subscribe across all 6 `ClientsModule.register()` modules (app, message, ai, outbox, gdpr, notification)
  - Verify CQRS event handlers in message, ai, compliance modules
  - Run `npm test -- --scope=messaging-service`
- [ ] Deploy `ai-service`
  - Verify `.exclude('health/{*path}')` fix
  - Verify `ThrottlerModule` and `EventBusModule.forRootAsync()` work
  - Run `npm test -- --scope=ai-service`
- [ ] Monitor for 24 hours before proceeding

> **Note:** WebSocket verification belongs in Phase 6 (gateway), not here. The WebSocket gateways (`messaging.gateway.ts`, `sensor-readings.gateway.ts`, `st-language.gateway.ts`) are in `gateway-api`, not `messaging-service`.

### Phase 5 -- Critical Services (Week 4-5)

**Target:** auth-service, sensor-service, farm-service (3 services)

> **Deploy order within phase:** auth → sensor → farm (ascending blast radius)

- [ ] Take database backup before this phase
- [ ] Deploy `auth-service`
  - Verify JWT authentication flow end-to-end
  - Canary token validation: issue JWT on v10, validate on v11 (and vice versa during rollback window)
  - Verify GDPR consent resolver `req.ip` handling (already safe)
  - Verify passport strategies work with v11
  - Run `npm test -- --scope=auth-service`
- [ ] Deploy `sensor-service`
  - Verify MQTT and NATS data ingestion pipelines end-to-end (publish MQTT message, verify it reaches database)
  - Verify `SharedMqttModule` (`@Global`) interacts correctly with v11 module deduplication
  - Verify TypeORM schema sync with `SourceSchemaBootstrapService` (known issue: TypeORM sync runs BEFORE this service's bootstrap logic)
  - Verify sensor data timestamps are preserved correctly (`timestamptz` columns)
  - Monitor registered NATS event handler count (compare to v10 baseline)
  - Run `npm test -- --scope=sensor-service`
- [ ] Deploy `farm-service`
  - Verify all 20 feature modules bootstrap correctly with deduplicated `CqrsModule`
  - Run farm-service handler registration smoke test: at least one command + one query from EACH of the 20 feature modules
  - Verify registered handler count matches v10 baseline
  - Verify GraphQL resolvers for all entities
  - Run `rover supergraph compose` -- verify subgraph composition
  - Run `npm test -- --scope=farm-service`
- [ ] Monitor for 24 hours before proceeding

### Phase 6 -- Gateway (Week 5-6)

**Target:** gateway-api (LAST -- depends on all subgraphs being v11)

The gateway must be upgraded last because it composes all 10 subgraph schemas (auth, farm, sensor, alert, hr, billing, hydroponics, config, notification, messaging) and handles all inbound traffic.

- [ ] Deploy `gateway-api` (consider brief blue-green: start new container on different port, validate, update nginx upstream, remove old container)
  - Verify all `req.ip` null guards are in place
  - Verify all middleware (device-fingerprint, correlation-id, strip-internal-headers, timeout, request-validator) works
  - Verify rate-limit guard and OPA policy guard
  - Verify `trust proxy` configuration works correctly with Express v5 behind nginx
  - Verify Apollo Federation supergraph composition with all v11 subgraphs
  - Verify `RetryableIntrospectAndCompose` works with `@nestjs/apollo` v13
  - Verify `AuthenticatedDataSource` (custom `RemoteGraphQLDataSource`) works with `@apollo/gateway` v2 under new package versions
  - Verify all 3 WebSocket gateways (`messaging.gateway.ts`, `sensor-readings.gateway.ts`, `st-language.gateway.ts`)
  - Verify `@nestjs/platform-socket.io` v11 + Socket.IO v4 + `@socket.io/redis-adapter` v8 compatibility
  - Verify `helmet@7.2.0` works with Express v5 (check security headers: CSP, HSTS, X-Frame-Options)
  - Verify CSRF middleware with Express v5 request parsing
  - Verify `cookie-parser` middleware
  - Run `npm test -- --scope=gateway-api`
- [ ] Run full end-to-end test suite
- [ ] Run Apollo Federation composition test one final time
- [ ] Run security header scan against gateway
- [ ] Monitor for 48 hours
- [ ] **Post-monitoring cleanup (separate commit):**
  - Remove any v10-specific compatibility shims
  - Run `npm audit` to establish new security baseline
  - Document final resolved v11 version matrix from `package-lock.json`

---

## 7. Rollback Strategy

### Prerequisites

- All Docker images are tagged with git SHA (already enforced by CI)
- All pre-upgrade production images tagged as `v10-baseline-{service}` in GHCR with 90-day retention
- Record the production-deployed SHA for each service before starting each phase
- Database backup taken before Phase 1 and before Phase 5

### Important Constraint: npm Workspace Hoisting

This is an npm workspaces monorepo with a single root `package.json`. Once the root is updated to v11 ranges (Phase 1), you CANNOT build a "v10 image" from the same branch. Rollback means deploying pre-existing Docker images (tagged with pre-upgrade SHA or `v10-baseline`), NOT building new images from a reverted branch.

### Per-Service Rollback

```bash
# 1. Identify the last-known-good SHA
export GOOD_SHA=<sha-before-upgrade>

# 2. Pull the previous image
docker pull ghcr.io/okan-wqm/aquaculture_platform/<service>:${GOOD_SHA}

# 3. Tag it as latest so the compose file picks it up
docker tag ghcr.io/okan-wqm/aquaculture_platform/<service>:${GOOD_SHA} \
           ghcr.io/okan-wqm/aquaculture_platform/<service>:latest

# 4. Recreate just that service using the production compose file
docker compose -f docker-compose.droplet.yml up -d --no-deps --no-build <service-name>

# 5. Reload nginx to re-resolve the upstream (container gets new IP on Docker bridge)
docker exec aqua-nginx nginx -s reload

# 6. Verify supergraph composition if the service is a subgraph
rover supergraph compose --config supergraph-config.yaml
```

### Bulk Phase Rollback

```bash
# Roll back all services in a phase at once
for SERVICE in service1 service2 service3; do
  docker pull ghcr.io/okan-wqm/aquaculture_platform/${SERVICE}:${GOOD_SHA}
  docker tag ghcr.io/okan-wqm/aquaculture_platform/${SERVICE}:${GOOD_SHA} \
             ghcr.io/okan-wqm/aquaculture_platform/${SERVICE}:latest
done
docker compose -f docker-compose.droplet.yml up -d --no-deps --no-build service1 service2 service3
docker exec aqua-nginx nginx -s reload
```

### Nuclear Option: Abort Entire Upgrade

If a systemic issue is found in Phase 4 or 5 that affects all v11 services:

1. Deploy ALL services from `v10-baseline` images
2. Revert `package.json` and `package-lock.json` to the pre-upgrade commit
3. Run full deploy via `workflow_dispatch`

### Rollback Safety Guarantees

| Concern | Status |
|---------|--------|
| Database migrations | No database schema changes in this upgrade -- safe to rollback |
| Database sync | Set `DATABASE_SYNC=false` for admin-api and event-store during upgrade to prevent unintended DDL |
| NATS wire protocol | `@platform/event-bus` uses the `nats` npm package directly, not `@nestjs/microservices` serialization -- format unchanged |
| Apollo Federation | v10 gateway can route to v11 subgraphs and vice versa. Verify with `rover supergraph compose` after rollback |
| Redis sessions | Session format unchanged -- no invalidation needed |
| JWT tokens | Token format unchanged -- no re-authentication needed |

### Rollback Decision Criteria

Roll back a service immediately if any of these occur:

1. Module bootstrap fails (service does not start)
2. Health check fails for 3 consecutive cycles (~90 seconds with 30s interval)
3. Error rate exceeds 1% for 15 minutes
4. NATS message processing latency exceeds 2x baseline
5. Apollo Federation composition fails (check with `rover supergraph compose`)
6. Registered CQRS/NATS handler count drops below v10 baseline
7. Tenant middleware verification fails (`X-Tenant-Id` header not processed)

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
| Apollo Federation composition | `rover supergraph compose` against all subgraph URLs (**after EACH subgraph deploy, not just end of phase**) | Schema composes without conflict |
| NATS cross-version wire test | Publish event from v10 service, consume in v11 service (and vice versa) | Events delivered, deserialized correctly |
| NATS handler count | Compare registered event handler count to v10 baseline | Count matches or exceeds baseline |
| Gateway integration | Hit gateway with sample queries spanning multiple subgraphs | Responses match expected schema |
| GraphQL codegen | `npm run codegen:check` -- diff generated types against pre-upgrade baseline | No unexpected changes |

### 8.3 End-to-End Tests (Required After Phase 6)

| Test Type | Description | Pass Criteria |
|-----------|-------------|---------------|
| Auth flow | Login, token refresh, logout | Tokens issued and validated correctly |
| Cross-version JWT | Issue JWT on v10, validate on v11 | Token accepted, claims preserved |
| Sensor ingestion | Publish MQTT message, verify it reaches sensor-service via NATS | Data appears in database within 5s with correct timestamp |
| Farm CRUD | Create farm, site, tank, batch via GraphQL | All mutations succeed, queries return data |
| Farm handler coverage | Execute one command + one query from each of farm-service's 20 feature modules | All handlers respond correctly |
| Alert pipeline | Trigger threshold breach, verify alert fires | Alert created and notification sent |
| Tenant isolation | Verify `X-Tenant-Id` header processing for requests through gateway | Correct schema used per tenant |
| Security headers | Scan gateway for CSP, HSTS, X-Frame-Options headers | All headers present and correct |

### 8.4 Monitoring (Required After Each Phase)

- 24-hour monitoring window (48 hours for gateway)
- Watch: error rate, p99 latency, NATS consumer lag, memory usage, container restart count
- Baseline capture before Phase 2: `docker stats --no-stream`, NATS monitoring at `http://aqua-nats:8222/connz`
- Container health: `docker compose -f docker-compose.droplet.yml ps`
- Container restart count: `docker inspect --format='{{.RestartCount}}' <container>`
- Application error logs: `docker logs --since 1h <container> | grep -c ERROR`

**Version identification during mixed state:** Add NestJS version to health endpoint response:

```typescript
@Get('live')
live() {
  return { status: 'ok', nestjs: require('@nestjs/core/package.json').version };
}
```

---

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `forRoutes('*')` wildcard breaks middleware | **Medium** | **Critical** -- silent tenant data leakage | FIX-7: verify before Phase 1 (BLOCKER) |
| Express v5 path-to-regexp crash | **High** if FIX-1 missed | **Critical** -- service fails to start | FIX-1 applied in version bump commit |
| `installSubscriptionHandlers` crash | **High** if FIX-2 missed | **Critical** -- config-service fails to start | FIX-2 applied in version bump commit |
| ALL-OR-NOTHING gateway composition failure | **Medium** | **Critical** -- total GraphQL API outage | Per-subgraph `rover supergraph compose` after each deploy |
| `scanFromPrototype` replacement breaks NATS handlers | **Medium** | **Critical** -- sensor data loss, no crash | Handler count assertion test, sensor e2e test |
| npm workspace hoisting prevents per-service rollback builds | **Very High** | **Critical** -- rollback limited to pre-existing images | Pre-tag `v10-baseline` images, 90-day retention |
| Dual CQRS dedup breaks farm-service handlers | **Medium** | **High** -- commands silently dropped | Handler count baseline, FIX-6 removes redundant imports |
| `CqrsModule` dedup breaks DI | **Medium** | **High** -- commands/queries silently fail | FIX-3 standardizes `.forRoot()` |
| `req.ip` undefined causes TypeError | **Medium** | **Medium** -- rate-limiting breaks | FIX-4 adds null guards; use `req.socket?.remoteAddress` fallback |
| `trust proxy` behavior change | **Medium** | **High** -- rate-limiting groups all users | Verify after Phase 6 behind nginx |
| `@nestjs/graphql` v13 changes schema generation | **Low-Medium** | **Medium** -- frontend type mismatch | `codegen:check` after each phase |
| CI/CD triggers full deploy on package.json change | **Very High** | **High** -- defeats phased rollout | Use `[skip deploy]` + manual `workflow_dispatch` |
| NestJS v11.1 released during upgrade window | **Medium** | **Medium** -- version drift between phases | Pin exact versions, use only `npm ci` |
| `@nestjs/typeorm` v11 changes sync behavior | **Low** | **High** -- schema corruption | Set `DATABASE_SYNC=false` during upgrade, DB backup |
| Express v5 rejects IoT device requests | **Low-Medium** | **Medium** -- edge devices fail to provision | Replay real production requests against staging |
| Module Opaque Key change breaks DynamicModule dedup | **Medium** | **High** -- separate module instances = separate buses | FIX-6 eliminates redundant imports; verify single instance per service |
| @Global middleware ordering change | **Medium** | **High** -- logging/throttler runs before tenant context | Document v10 order, verify v11 order in Phase 1 |
| ConfigService#get resolution order change | **Medium** | **High** -- services silently read wrong config values | Audit ConfigService.get() vs process.env conflicts; add `skipProcessEnv` if needed |
| Lifecycle hook reverse ordering on shutdown | **Medium** | **High** -- NATS disconnect before batch flush = data loss | Document v10 shutdown order for sensor/gateway; verify v11 order |
| `helmet` v7 + Express v5 incompatibility | **Low** | **High** -- missing security headers | Security header scan after Phase 6 |
| Third-party package peer dep conflict | **Medium** | **Low** -- build fails, caught before deploy | Resolved in Phase 1 during `npm install` |
| Swagger v8 decorator regression | **Low** | **Low** -- API docs render incorrectly | OpenAPI JSON diff in Phase 4 |

### Services Requiring NO Code Changes (Dependency-Only Upgrade)

These services were audited and require only the version bump -- no breaking changes apply:

- `sensor-service` -- no `(.*)` patterns, no `CqrsModule`, no `installSubscriptionHandlers`, no `req.ip`
- `notification-service` -- subgraph only, no breaking change patterns
- `billing-service` -- subgraph only, CQRS in feature module (not app level)
- `alert-engine` -- no breaking change patterns

---

## 10. CI/CD & Deployment

### Deployment Mechanism

All production commands use `docker-compose.droplet.yml` (NOT `docker-compose.prod.yml`).

**Per-service deploy:**
```bash
docker compose -f docker-compose.droplet.yml up -d --no-deps --no-build ${SERVICE_NAME}
docker exec aqua-nginx nginx -s reload
```

**Phase deployments use manual `workflow_dispatch`** with explicit service names to avoid automatic full-deploy triggers.

### CI/CD Pipeline Protection During Upgrade

1. Phase 1 commit uses `[skip deploy]` in commit message
2. All phase deployments triggered via `workflow_dispatch` with explicit `services` parameter
3. Change detection in `deploy-digitalocean.yml` triggers full deploy on `package.json` / `libs/` / `platform/` changes -- this MUST be bypassed during the upgrade
4. `--legacy-peer-deps` is already configured in CI (line 287 of deploy workflow) -- peer dependency conflicts will be suppressed

### Nx Build Cache

The Nx cache key is based on `hashFiles('**/package-lock.json')`. Changing `package-lock.json` invalidates the entire cache. The first build after Phase 1 will be a full cold build (~20-30 minutes instead of 5-10 minutes). Budget time accordingly.

---

## 11. Incident Response During Upgrade

### Deployment Windows

- Deploy on Tuesday, Wednesday, or Thursday during business hours (9:00-17:00)
- Never deploy on Friday or before a holiday
- 24-hour monitoring window covers business hours + overnight

### Mixed-Version Decision Tree

```
1. Is the failing service on v11?
   YES → Is the failure a known v11 breaking change (FIX-1 through FIX-7)?
         YES → Apply the fix or roll back that service
         NO  → Is this a new Express v5 or NestJS v11 issue?
               YES → Roll back the service to v10-baseline image
               NO  → Treat as normal production bug
   NO (still v10) →
     Is the failure related to cross-version communication?
     YES → Check NATS message format, Apollo Federation composition
           Roll back the v11 services recently deployed
     NO  → Treat as normal production bug
```

### Common Failure Runbook

| Scenario | Symptom | Fix |
|----------|---------|-----|
| path-to-regexp crash | Service fails to start, log shows `Invalid path` | FIX-1 was missed; apply and redeploy |
| `installSubscriptionHandlers` crash | config-service fails to start | FIX-2 was missed; apply and redeploy |
| `CqrsModule` DI failure | `No handler found` errors | Verify `.forRoot()` applied; check `@Global()` on platform wrapper |
| `req.ip` TypeError | 500 errors in gateway rate-limiting/logging | Apply null guard; FIX-4 was missed |
| Federation composition failure | Gateway returns 500 on all GraphQL queries | `rover supergraph compose`; if fails, roll back last deployed subgraph |
| NATS handler not registered | Consumer lag growing, events not processing | Check handler count; compare to baseline; verify FIX-5 |
| Memory spike | Container OOM-killed | Increase memory limit; investigate with `node --inspect` |
| Middleware not applying | No tenant headers, all requests hit wrong schema | `forRoutes('*')` broken; apply FIX-7 fix pattern |

---

## 12. Safe Deployment Checklist

Use this checklist on the day of each phase deployment:

- [ ] All pre-upgrade fixes for this phase merged to `main`
- [ ] Current production SHA recorded for each service in this phase
- [ ] Pre-upgrade images tagged as `v10-baseline-{service}` in GHCR
- [ ] Database backup taken (especially before Phase 5)
- [ ] Docker images built and pushed to GHCR with SHA tag
- [ ] `npm test` passes for all services in this phase
- [ ] `npm run build` succeeds for the entire monorepo
- [ ] TypeScript `--noEmit` compilation succeeds
- [ ] Deployment window communicated to stakeholders (Tue/Wed/Thu, business hours)
- [ ] Rollback procedure reviewed: correct compose file (`docker-compose.droplet.yml`), nginx reload, `rover supergraph compose`
- [ ] Services deployed one at a time via `workflow_dispatch`
- [ ] `rover supergraph compose` verified after each subgraph deploy (Phases 3, 5, 6)
- [ ] Health checks verified after each service deploy
- [ ] Handler count verified (CQRS + NATS) after each service deploy
- [ ] 24-hour monitoring window started (48 hours for gateway)
- [ ] Phase sign-off from engineering lead before proceeding to next phase

---

## 13. Consequences

### Positive

- **Security:** Express v5 hardens path parsing, eliminates prototype pollution vectors, and receives active CVE patches.
- **Performance:** NestJS v11 module deduplication reduces memory footprint in large services like farm-service (20+ modules).
- **Ecosystem alignment:** Unlocks `@nestjs/graphql` v13, `@nestjs/swagger` v8, and other companion packages that require v11 core.
- **Developer experience:** Developers work with the latest stable NestJS, reducing documentation mismatch and onboarding friction.
- **Future-proofing:** `scanFromPrototype` removal in v12 will not require emergency patches.

### Negative

- **3-6 week timeline:** The phased rollout is deliberately cautious to minimize risk, but it means 3-6 weeks of mixed v10/v11 in production.
- **Testing overhead:** Each phase requires 24-48 hours of monitoring, extending the calendar timeline.
- **Cognitive load:** During the transition, developers must be aware of both v10 and v11 patterns when debugging production issues.
- **Express v4 CVEs remain exploitable** on services not yet upgraded. The gateway (most exposed) is upgraded LAST.

### Neutral

- **No database changes:** TypeORM ^0.3.28 is unaffected; no migrations are introduced by this upgrade.
- **No frontend impact:** All `@nestjs/*` packages are backend-only; MFE modules are unaffected. However, run `codegen:check` to verify GraphQL types.
- **No NATS protocol change:** The `@platform/event-bus` uses the `nats` npm package directly; wire format is stable.
- **No JWT/auth token change:** Token structure, signing, and validation are unchanged.
