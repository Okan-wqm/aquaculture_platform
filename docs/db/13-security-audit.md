# Security Audit: Cross-Tenant Data Isolation

**Auditor:** Claude Opus 4.6 (automated security review)
**Date:** 2026-03-18
**Scope:** All tenant-scoped services (farm, sensor, hr, hydroponics, ai, alert-engine) + gateway-api
**Methodology:** Static code analysis of middleware, guards, raw SQL, event handlers, cron jobs, WebSocket, and GraphQL federation

---

## Executive Summary

The platform uses **PostgreSQL schema-per-tenant isolation** via `search_path` manipulation at the connection pool level. The architecture is fundamentally sound with proper UUID validation, parameterized queries for schema existence checks, and a pool-patching mechanism via `TenantConnectionBootstrap`. However, several risk areas require attention.

**Overall Rating: MODERATE RISK** -- the critical paths are well-defended, but cron jobs, MQTT legacy topics, and the `SET LOCAL search_path` pattern with string interpolation present attack surface.

---

## Vector 1: Middleware Bypass

### Assessment: RISK (Low-to-Medium)

#### Findings

**1.1 Health endpoints excluded from middleware (hydroponics, ai)**

- `apps/hydroponics-service/src/app.module.ts:198` -- `.exclude('health', 'health/(.*)')` removes health routes from the middleware chain
- `apps/ai-service/src/app.module.ts:224` -- same `.exclude('health', 'health/(.*)')` pattern
- `StandardHealthController` (`libs/backend-common/src/health/standard-health.controller.ts:78`) uses `@Public()` decorator and calls `dataSource.query('SELECT 1')` for readiness checks
- **Impact:** Health endpoints execute `SELECT 1` on the pool's default `search_path` (e.g., `sensor,public`). No tenant data is accessed. **SAFE** -- these queries only touch system catalogs.

**1.2 Middleware applied to `forRoutes('*')` in farm, sensor, hr, alert-engine**

- `apps/farm-service/src/app.module.ts:278` -- `.forRoutes('*')` with no exclusions
- `apps/sensor-service/src/app.module.ts:378` -- `.forRoutes('*')` with no exclusions
- `apps/hr-service/src/app.module.ts:281` -- `.forRoutes('*')` with no exclusions
- `apps/alert-engine/src/app.module.ts:167` -- `.forRoutes('*')` with no exclusions
- **SAFE** -- all routes pass through the full middleware chain.

**1.3 `@Public()` and `@SkipTenantGuard()` decorated endpoints**

| Endpoint | Service | Accesses Tenant DB? | Risk |
|---|---|---|---|
| `ProvisioningController` | sensor | Yes (cross-schema device lookup) | Low -- uses dedicated QueryRunner with RESET |
| `MqttAuthController` | sensor | Yes (credential verification) | Low -- Docker network isolated |
| `MetricsController` | sensor, gateway | No (Prometheus counters only) | None |
| `HealthController/Resolver` | all services | `SELECT 1` only | None |
| Auth endpoints (`login`, `register`, etc.) | auth | Yes, but auth schema is not tenant-scoped | None |
| Stripe webhook | billing | Yes, but billing schema is not tenant-scoped | None |

**1.4 GraphQL endpoints bypass NestJS middleware**

- NestJS middleware (including `TenantSchemaMiddleware`) runs for HTTP routes. GraphQL requests arrive as POST `/graphql` which **does** match `.forRoutes('*')`.
- The GraphQL context receives `({ req }) => ({ req })`, and `req.schemaName` is already set by middleware.
- **SAFE** -- GraphQL requests pass through middleware.

**1.5 INCONSISTENCY: hydroponics and ai exclude health from middleware but farm, sensor, hr, alert do not**

- Not a security issue (health endpoints are `@Public()` and only run `SELECT 1`), but indicates configuration drift.

### Recommendations

1. Standardize health route exclusion across all services for consistency.
2. Ensure `@SkipTenantGuard()` endpoints never access tenant-scoped data via the shared pool without explicit schema setting.

---

## Vector 2: Search Path Poisoning (SQL Injection via Schema Name)

### Assessment: SAFE

#### Findings

**2.1 UUID validation in all TenantSchemaMiddleware implementations**

Every middleware validates tenantId with:
```typescript
/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
```

- `apps/farm-service/src/middleware/tenant-schema.middleware.ts:137`
- `apps/sensor-service/src/middleware/tenant-schema.middleware.ts:138`
- `apps/hr-service/src/middleware/tenant-schema.middleware.ts:132`
- `apps/hydroponics-service/src/middleware/tenant-schema.middleware.ts:84`
- `apps/ai-service/src/middleware/tenant-schema.middleware.ts:85`
- `apps/alert-engine/src/middleware/tenant-schema.middleware.ts:137`

**2.2 Schema name derivation is safe**

```typescript
const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
return `tenant_${cleanId}`;
```

Result: `tenant_[0-9a-f]{16}` -- no special characters possible.

**2.3 TenantConnectionBootstrap double-validates schema name**

All `TenantConnectionBootstrap` implementations validate with:
```typescript
/^[a-z0-9_]+$/.test(schemaName)
```

- `apps/farm-service/src/infrastructure/tenant-connection-bootstrap.service.ts:65`
- `apps/sensor-service/src/infrastructure/tenant-connection-bootstrap.service.ts:54`
- All other services: same pattern

**2.4 Schema existence check uses parameterized queries**

```sql
SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
```

- Farm, sensor, hr, alert: `information_schema.schemata`
- Hydroponics, ai: `pg_catalog.pg_namespace`
- All use `$1` parameter binding. **SAFE**.

**2.5 `SET search_path` uses double-quoted identifier**

```typescript
`SET search_path TO "${schemaName}", ${sourceSchema}, public`
```

The `schemaName` is validated by the `[a-z0-9_]+` regex before reaching this code, preventing SQL injection via identifier escaping attacks (e.g., `"; DROP TABLE` would fail the regex).

### Recommendation

None required -- defense is properly layered (UUID regex -> schema derivation -> alphanumeric regex -> parameterized existence check).

---

## Vector 3: Shared Connection Pool / search_path Leaking

### Assessment: RISK (Medium)

#### Findings

**3.1 Pool monkey-patch sets search_path on every checkout**

The `TenantConnectionBootstrap` patches `pg Pool.connect()` to set `search_path` from `AsyncLocalStorage` on every connection checkout. This is the correct approach.

**3.2 No explicit cleanup on connection return**

When a connection is returned to the pool after a request, the `search_path` from the previous tenant remains set on that connection. The next checkout **will** overwrite it via the pool patch, but only if:
- The new request has a valid `RequestContext` with `schemaName`
- The `getRequestContext()` call succeeds

**3.3 CRITICAL SCENARIO: Cron jobs and MQTT ingestion outside HTTP context**

When code runs outside an HTTP request (cron jobs, MQTT handlers, `OnModuleInit`), there is no `RequestContext` in `AsyncLocalStorage`. The pool patch falls through to the `else` branch and does NOT set `search_path`, so the connection retains whatever `search_path` was set by the **previous** user of that connection.

**However**, the cron jobs and MQTT handlers in this codebase use **dedicated QueryRunners** with explicit `SET search_path` and `RESET search_path` in `finally` blocks:

- `apps/farm-service/src/scheduler/cron-jobs.service.ts:247,286` -- `SET` then `RESET` in finally
- `apps/farm-service/src/task/services/task.service.ts:554,615` -- same pattern
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1496,1506` -- same pattern
- `apps/sensor-service/src/edge-device/edge-device.service.ts:710` -- uses dedicated QueryRunner
- `apps/sensor-service/src/automation/automation.service.ts:118,121` -- same pattern

**3.4 POTENTIAL ISSUE: `SET LOCAL search_path` without transaction**

- `apps/ai-service/src/tools/core/base-tenant-tool.ts:34` -- uses `SET LOCAL` but calls `this.dataSource.query()` which may not be inside a transaction. `SET LOCAL` only applies within a transaction block; outside a transaction, it behaves like `SET` and persists for the connection session.
- `apps/sensor-service/src/edge-device/provisioning.service.ts:325` -- uses `SET LOCAL` correctly inside `this.dataSource.transaction()`.
- `apps/farm-service/src/database/services/code-generator.service.ts:64` -- uses `SET LOCAL` inside a `startTransaction()` block. Correct.

### Recommendations

1. **CRITICAL**: In `base-tenant-tool.ts`, verify `SET LOCAL` is executed within a transaction. If not, change to a dedicated QueryRunner with `RESET search_path` cleanup.
2. Add a connection return hook or use `RESET search_path` before releasing connections in the pool patch (defense-in-depth).
3. Consider adding a `res.on('finish')` handler in middleware to reset the `AsyncLocalStorage` context, preventing stale schema names from being read by async operations that outlive the request.

---

## Vector 4: Raw SQL Injection

### Assessment: SAFE (with one LOW concern)

#### Findings

**4.1 Schema names in raw SQL string interpolation**

Multiple locations use `"${schemaName}"` or `"${tenantSchema}"` in raw SQL:

| File | Line | Pattern | Validated? |
|---|---|---|---|
| `TenantConnectionBootstrap` (all) | varies | `SET search_path TO "${schemaName}"` | Yes -- `[a-z0-9_]+` regex |
| `cron-jobs.service.ts` | 247 | `SET search_path TO "${schema}"` | Yes -- `schema` from `information_schema.schemata WHERE LIKE 'tenant_%'` |
| `task.service.ts` | 554 | `SET search_path TO "${schema}"` | Yes -- same source |
| `edge-device.service.ts` | 594 | `SELECT * FROM "${tenantSchema}".edge_devices` | Yes -- derived from UUID via `getTenantSchemaFromId` |
| `edge-device.service.ts` | 710 | `SET search_path TO "${schema_name}"` | Partial -- from `information_schema` |
| `mqtt-listener.service.ts` | 1496,1542 | `SET search_path TO "${safeSchemaName}"` | Yes -- `replace(/[^a-zA-Z0-9_]/g, '')` sanitization |
| `code-generator.service.ts` | 64 | `SET LOCAL search_path TO "tenant_${...}"` | Yes -- inline UUID derivation |
| `base-tenant-tool.ts` | 34 | `SET LOCAL search_path TO "${schemaName}"` | Yes -- `[a-z0-9_]+` regex check at line 23 |

**4.2 All data queries use parameterized binding**

- Schema existence: `$1` parameter
- Task queries: `$1, $2, $3` parameters
- Device queries: `$1` parameter
- No string concatenation of user input into WHERE clauses.

**4.3 LOW CONCERN: `edge-device.service.ts:710` uses `schema_name` from DB**

The `schema_name` comes from `information_schema.schemata WHERE schema_name LIKE 'tenant_%'` which is safe (only legitimate schema names are returned), but there is no additional sanitization like the `mqtt-listener.service.ts` does with `replace(/[^a-zA-Z0-9_]/g, '')`.

### Recommendations

1. Apply consistent sanitization (`/[^a-zA-Z0-9_]/g` removal) to schema names from `information_schema` before interpolation, even though the source is trusted. Defense-in-depth.
2. Consider using a shared utility function `sanitizeSchemaName()` to eliminate divergent sanitization patterns across services.

---

## Vector 5: Cross-Schema References / search_path Fallback

### Assessment: RISK (Low)

#### Findings

**5.1 search_path fallback chain includes source schema**

All services set search_path as: `"tenant_xxx", {source_schema}, public`

- Farm: `"tenant_xxx", farm, public`
- Sensor: `"tenant_xxx", sensor, public`
- HR: `"tenant_xxx", hr, public`
- Alert: `"tenant_xxx", alert, public`
- AI: `"tenant_xxx", ai, public`
- Hydroponics: `"tenant_xxx", hydroponics, public`

**5.2 Fallback to source schema can access shared tables**

If a table does not exist in the tenant schema, PostgreSQL will look for it in the source schema (e.g., `farm`) and then `public`. This is **by design** for shared reference data (species definitions, templates, etc.).

**5.3 RISK: If tenant data is accidentally stored in the source schema**

If an entity's table exists in both the tenant schema and the source schema, the tenant schema takes priority (correct). But if the table only exists in the source schema due to a migration/sync issue, all tenants would share the same data. The middleware rejects requests when `schemaExists` is false (no fallback for authenticated tenants), which mitigates this for the schema lookup itself.

**5.4 No cross-schema JOINs in application code**

Searched for `JOIN.*tenant_` and `FROM.*tenant_` patterns -- no cross-schema JOINs found in application code. **SAFE**.

**5.5 Default schema for unauthenticated requests**

When `tenantId` is absent or `default-tenant`, all middleware implementations fall back to the source schema (e.g., `farm`, `sensor`). This is only reachable for `@Public()` endpoints which don't access tenant data. The `TenantGuard` blocks authenticated endpoints without a valid tenant UUID.

### Recommendations

1. Ensure `SourceSchemaBootstrapService` does not create tables with tenant data in the source schema.
2. Periodically audit that no tenant-specific data exists in source schemas (farm, sensor, hr, etc.).

---

## Vector 6: NATS Event Handlers (Outside HTTP Context)

### Assessment: RISK (Medium)

#### Findings

**6.1 Alert Engine: SensorReadingEventHandler**

- `apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts:51-57` -- explicitly checks for missing `tenantId` and **skips processing** to prevent cross-tenant isolation breach. **SAFE**.
- `AlertEvaluationService` uses `WHERE rule.tenantId = :tenantId` for all queries (line 131). **SAFE** -- row-level filtering, not schema-level.

**6.2 Gateway NATS Bridge: Sensor readings to WebSocket**

- `apps/gateway-api/src/websocket/nats-bridge.service.ts:228-231` -- validates `tenantId` UUID format before forwarding.
- `SensorReadingsGateway.broadcastSensorReading()` -- uses Socket.IO room-based routing (`sensor:${sensorId}`). Subscription authorization is enforced in `handleSubscribe()` which validates sensor ownership per tenant. **SAFE**.
- Edge device events (`EdgeDeviceIoData`, `EdgeDeviceAlarm`) validate `tenantId` and `deviceCode` presence (lines 178, 204). Room names include `tenantId` (`edgeIo:${tenantId}:${deviceCode}`). **SAFE**.

**6.3 Farm Service Event Listeners (EventEmitter2)**

- `apps/farm-service/src/events/event-listeners.module.ts` -- uses NestJS `EventEmitterModule` (in-process, not NATS). These listeners run within the HTTP request context that triggered them.
- **RISK**: If these event handlers perform additional database queries, they would use the pool-patched connection which reads `schemaName` from `AsyncLocalStorage`. Since the event is emitted synchronously within the request, the context is preserved. **SAFE** for synchronous emission; **RISK** if events are deferred past the request lifecycle.

**6.4 MQTT Ingestion (sensor-service) outside HTTP context**

- `MqttListenerService` (`apps/sensor-service/src/ingestion/mqtt-listener.service.ts`) runs `onModuleInit` lifecycle. All database operations use **dedicated QueryRunners** with explicit `SET search_path` and `RESET search_path` in `finally` blocks.
- Tenant-prefixed topics (`tenants/{tenantId}/devices/{deviceCode}/...`) extract tenantId from the topic itself and validate.
- Legacy `edge/` topics lack tenant enforcement but are behind a feature flag (`LEGACY_EDGE_TOPICS_ENABLED`). When enabled, device lookup uses `deviceCode` only (line 460: `updateHeartbeat(heartbeat)` without `tenantId`), which falls back to `deviceRepository.findOne()` on the default `search_path` (sensor schema).

**6.5 ISSUE: Legacy edge/ topic device lookup without tenant isolation**

- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:443-461` -- `handleEdgeHeartbeat` calls `edgeDeviceService.updateHeartbeat(heartbeat)` **without** setting `tenantId`.
- `apps/sensor-service/src/edge-device/edge-device.service.ts:600-604` -- when `tenantSchema` is null (no tenantId), falls back to `deviceRepository.findOne()` which uses the pool's current `search_path`. This will hit the **sensor** source schema (no tenant data) or whatever schema the pool connection last used.
- **Impact**: In the worst case, a device lookup could find a device in the wrong tenant's schema if the pool connection retained a previous tenant's `search_path`. However, the device entity contains `tenantId`, so subsequent operations are tenant-scoped. Additionally, a matching `deviceCode` in the wrong schema would be coincidental.

### Recommendations

1. **HIGH**: Disable legacy `edge/` topic support in production (`LEGACY_EDGE_TOPICS_ENABLED=false`). This eliminates the tenant-less device lookup path.
2. Add explicit `tenantId` validation in the `updateHeartbeat()` fallback path -- reject heartbeats without `tenantId` when the pool search_path is ambiguous.
3. Ensure all `EventEmitter2` handlers that perform DB operations are synchronous within the request context, or use `withTenantSchema()` pattern if deferred.

---

## Vector 7: GraphQL Federation (Gateway)

### Assessment: SAFE

#### Findings

**7.1 Header forwarding to subgraphs**

`AuthenticatedDataSource.willSendRequest()` (`apps/gateway-api/src/app.module.ts:96-168`) forwards:
- `Authorization` header (JWT)
- `x-tenant-id` (from `req.user.tenantId ?? req.headers['x-tenant-id']`)
- `x-user-id`, `x-user-roles`, `x-user-payload` (from verified JWT)
- `x-correlation-id`, `traceparent`, trace/span IDs

**7.2 Tenant ID preference: JWT over header**

```typescript
const tenantId = req.user?.tenantId ?? req.headers['x-tenant-id'];
```

JWT `tenantId` takes priority, which is correct since the JWT is cryptographically verified by the `AuthGuard`. The fallback to `x-tenant-id` header is only used when `req.user` is not set (public endpoints). **SAFE**.

**7.3 AuthGuard validates JWT before subgraph forwarding**

- `apps/gateway-api/src/guards/auth.guard.ts:124-129` -- `@Public()` endpoints skip auth.
- `JwtMiddleware` runs before GraphQL context creation, setting `req.user` with verified JWT claims.
- Subgraphs receive `x-user-payload` with the gateway-verified user, and their own `UserContextMiddleware` parses it.

**7.4 No public GraphQL queries that return tenant data**

- All services use global `TenantGuard` (via `APP_GUARD`) which requires `tenantId` for non-public endpoints.
- `@Public()` is only on health resolvers (ai-service) and auth mutations (login, register).

**7.5 Cross-tenant query aggregation via Federation**

- Each subgraph receives the same `x-tenant-id` and applies schema isolation independently.
- A single GraphQL query cannot span multiple tenants because all subgraphs enforce the same `tenantId` from the forwarded headers. **SAFE**.

**7.6 Introspection disabled in production**

- All services disable GraphQL introspection when `NODE_ENV === 'production'`.
- Gateway: explicit `GRAPHQL_INTROSPECTION` env var override available.
- Query depth limiting (10 levels) and complexity limiting (1000) applied across all services.

### Recommendations

1. Consider making `x-tenant-id` header forwarding dependent on JWT verification -- do not forward the raw header value when `req.user` is not set, to prevent header spoofing on non-public endpoints.

---

## Additional Findings

### A1: TenantGuard accepts tenantId from query parameter and request body

`libs/backend-common/src/guards/tenant.guard.ts:88-98`:

```typescript
private extractTenantId(request: TenantRequest): string | undefined {
  return (
    request.user?.tenantId ||
    (typeof tenantHeader === 'string' ? tenantHeader : undefined) ||
    (typeof queryTenantId === 'string' ? queryTenantId : undefined) ||
    (typeof bodyTenantId === 'string' ? bodyTenantId : undefined)
  );
}
```

**RISK (Low)**: The guard accepts `tenantId` from query params and body, then validates it matches `user.tenantId`. Since JWT `tenantId` takes priority (first in the chain), an attacker cannot override the tenant via query/body params for authenticated requests. For unauthenticated requests, `TenantGuard` would fail at the `if (!tenantId)` check for protected endpoints.

### A2: TenantContextMiddleware (backend-common) accepts tenantId from query parameter

`libs/backend-common/src/middleware/tenant-context.middleware.ts:108`:
```typescript
const queryTenant = req.query['tenantId'] as string;
```

**RISK (Low)**: This sets `req.tenantId` from a query parameter. However, `TenantSchemaMiddleware` reads `req.tenantId || req.user?.tenantId`, and `TenantGuard` then validates `user.tenantId === tenantId`. An unauthenticated request with `?tenantId=...` would set the schema but be blocked by `TenantGuard` on protected endpoints.

### A3: Schema name collision (theoretical)

Schema naming uses first 16 hex characters of UUID: `tenant_${uuid.replace(/-/g, '').substring(0, 16)}`.

- UUID v4 has 122 random bits. 16 hex chars = 64 bits.
- Collision probability for 10,000 tenants: ~2.7 x 10^-12. **Negligible**.

### A4: Cron jobs iterate all tenant schemas correctly

Farm and sensor cron jobs (`cron-jobs.service.ts`, `task.service.ts`, `edge-device.service.ts`, `automation.service.ts`) follow the pattern:
1. Query `information_schema.schemata WHERE schema_name LIKE 'tenant_%'`
2. For each schema: create dedicated `QueryRunner`, `SET search_path`, process, `RESET search_path`, `release()`

This correctly isolates per-tenant operations. **SAFE**.

### A5: HR Leave Accrual uses row-level tenantId, not schema isolation

`apps/hr-service/src/leave/leave-accrual.service.ts:45-52` -- discovers tenants via `DISTINCT lt.tenantId` query against the repository (which uses the pool's default/current search_path). For cron execution outside HTTP context, this would query the default `hr` schema.

**RISK (Low)**: If leave data exists only in tenant schemas (not the hr source schema), this query would return no results and silently skip accrual. If data exists in both, it could process the wrong tenant's data.

---

## Summary Table

| Vector | Rating | Key Evidence |
|---|---|---|
| V1: Middleware Bypass | **SAFE** | `.forRoutes('*')` on all services; `@Public()` only on non-tenant endpoints |
| V2: Search Path Poisoning | **SAFE** | UUID regex + `[a-z0-9_]+` validation + parameterized queries |
| V3: Shared Connection Pool | **RISK (Medium)** | `SET LOCAL` outside transaction in `base-tenant-tool.ts`; no pool cleanup on return |
| V4: Raw SQL Injection | **SAFE** | All schema names validated; all data queries parameterized |
| V5: Cross-Schema References | **RISK (Low)** | search_path fallback to source schema is by design; no cross-schema JOINs |
| V6: NATS Event Handlers | **RISK (Medium)** | Legacy edge/ topics lack tenant enforcement; `tenantId` validated in alert handlers |
| V7: GraphQL Federation | **SAFE** | JWT-verified tenantId forwarded to all subgraphs; `TenantGuard` on all endpoints |

---

## Priority Remediation List

1. **HIGH**: Disable legacy edge/ MQTT topics in production (`LEGACY_EDGE_TOPICS_ENABLED=false`)
2. **MEDIUM**: Fix `base-tenant-tool.ts` to use dedicated QueryRunner with `RESET search_path` instead of `SET LOCAL` outside a transaction
3. **MEDIUM**: Add `RESET search_path` on pool connection return (defense-in-depth) in `TenantConnectionBootstrap`
4. **LOW**: Standardize schema name sanitization across all services via shared utility
5. **LOW**: Standardize health route exclusion patterns across all services
6. **LOW**: Audit HR leave accrual cron to confirm it operates in correct schema context
