---
name: backend-common
description: Knowledge base for libs/backend-common - SchemaManagerService, MODULE_SCHEMAS, Redis, guards, decorators, filters, and telemetry shared across all backend services
---

# Backend-Common Knowledge Base

## Overview

`libs/backend-common` is the shared library used by all NestJS backend services. It provides the critical multi-tenant schema management, Redis caching, tenant guard, decorators, exception filters, and OpenTelemetry tracing. Every backend service depends on this library.

## Directory Structure

```
libs/backend-common/src/
  database/
    schema-manager.service.ts  # CRITICAL: MODULE_SCHEMAS, REFERENCE_DATA_TABLES, tenant schema provisioning
    index.ts
  redis/
    redis.service.ts           # RedisService (ioredis wrapper with key prefix)
    redis.module.ts            # RedisModule (DynamicModule factory)
    index.ts
  decorators/
    roles.decorator.ts         # @Roles(), @SkipTenantGuard() decorators + SKIP_TENANT_GUARD_KEY
    tenant.decorator.ts        # @Tenant() decorator to extract tenantId from request
    cacheable.decorator.ts     # @Cacheable(), @CacheInvalidate(), @CacheInvalidatePattern()
    index.ts
  guards/
    tenant.guard.ts            # TenantGuard - validates tenant context on every request
  filters/
    http-exception.filter.ts   # Global HTTP exception filter
  telemetry/
    tracing.ts                 # OpenTelemetry OTLP initialization
    index.ts
  README.md
```

## Key Files & Configurations

### SchemaManagerService (database/schema-manager.service.ts)

**The most critical file in the platform.** Manages tenant schema creation and table provisioning.

#### MODULE_SCHEMAS

Defines which tables belong to each module. Used during tenant provisioning to create tables in the tenant schema.

```typescript
export const MODULE_SCHEMAS: ModuleSchema[] = [
  {
    moduleName: 'sensor',
    sourceSchema: 'sensor',
    tables: [
      'sensors', 'sensor_readings', 'sensor_metrics', 'sensor_data_channels',
      'sensor_protocols', 'processes', 'vfd_devices', 'vfd_readings',
      'vfd_register_mappings', 'dashboard_layouts', 'edge_devices',
      'device_io_configs', 'plc_connections', 'plc_alarms', 'plc_telemetry',
      'feeding_parameters', 'automation_programs', 'program_steps',
      'program_transitions', 'program_variables', 'step_actions',
      'tenant_provisioning_keys', 'device_events', 'deployment_logs',
    ],
  },
  {
    moduleName: 'farm',
    sourceSchema: 'farm',
    tables: [
      // Core: farms, sites, departments, ponds, tanks, tank_allocations, tank_batches, tank_operations
      // Batch: batches, batches_v2, batch_documents, batch_feed_assignments, batch_locations, species
      // Equipment: systems, sub_systems, equipment_types, equipment, equipment_systems,
      //            sub_equipment_types, sub_equipment, feeder_calibrations
      // Maintenance: maintenance_schedules, work_orders, spare_parts
      // Feed: feed_types, feed_type_species, feeds, feed_inventory, feed_sites,
      //       feeding_protocols, feeding_records, feeding_tables, feeding_programs,
      //       feeding_program_tanks, daily_feeding_executions
      // Chemical: chemical_types, chemicals, chemical_sites
      // Production: growth_measurements, mortality_records, water_quality_measurements,
      //             health_events, harvest_plans, harvest_records
      // Suppliers: supplier_types, suppliers, supplier_sites
      // Site contacts: site_contacts
      // Supporting: code_sequences, farm_audit_logs
      // Storage: storage_locations, consumables, storage_inventory, stock_movements,
      //          purchase_orders, purchase_order_items
      // Regulatory: regulatory_settings, sentinel_hub_settings
      // Weather: weather_observations, marine_observations, weather_settings
      // Security/Compliance (tenant-specific): activity_logs, api_usage_logs, login_attempts,
      //   user_sessions, user_permissions, user_consents, compliance_reports,
      //   gdpr_data_requests, data_requests, retention_policies, security_events,
      //   security_incidents, threat_intelligence
      // Mobile: mobile_user_settings
    ],
  },
  {
    moduleName: 'hr',
    sourceSchema: 'hr',
    tables: [
      'employees', 'payrolls', 'leave_types', 'leave_balances', 'leave_requests',
      'shifts', 'schedules', 'schedule_entries', 'scheduling_settings',
      'attendance_records', 'weekly_plans', 'weekly_plan_entries', 'holidays',
      'training_courses', 'training_enrollments', 'certification_types',
      'employee_certifications', 'work_areas', 'work_rotations',
      'safety_training_records',
    ],
  },
  {
    moduleName: 'hydroponics',
    sourceSchema: 'hydroponics',
    tables: ['hydroponics_config'],
  },
];
```

**Critical Rule**: When a new TypeORM entity is added to a module, its table name MUST be added to the corresponding `MODULE_SCHEMAS` entry. If it's not listed here, the table will not exist in tenant schemas, causing runtime errors.

#### How Schema Provisioning Works

1. `admin-api-service` calls `TenantProvisioningService`
2. **Module assignment happens FIRST** (before schema creation) - queries `tenant_modules` table to know which modules to provision
3. For each assigned module, the schema manager creates tables in `tenant_{first16chars_of_uuid}` schema
4. Tables are created with the same structure as in the source schema (`sensor`, `farm`, `hr`, etc.)
5. Reference data tables are copied from source schema

#### REFERENCE_DATA_TABLES

Tables with lookup/seed data that are copied from the source schema to each tenant schema during provisioning. Not visible in the truncated file but include tables like `equipment_types`, `leave_types`, etc.

### RedisService (redis/redis.service.ts)

Wraps `ioredis` with:
- Key prefix: `aqua:` (configurable via `options.keyPrefix`)
- All methods transparently prefix keys

```typescript
// Key operations
async set(key: string, value: string, ttlSeconds?: number): Promise<void>
async get(key: string): Promise<string | null>
async del(key: string): Promise<number>
async exists(key: string): Promise<boolean>
async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void>
async getJson<T>(key: string): Promise<T | null>

// Pattern operations
async keys(pattern: string): Promise<string[]>          // Returns unprefixed keys
async deletePattern(pattern: string): Promise<number>   // Deletes all matching keys

// TTL operations
async expire(key: string, ttlSeconds: number): Promise<boolean>
async ttl(key: string): Promise<number>

// Hash operations
async hset/hget/hgetall/hdel(key: string, ...)

// Increment/decrement
async incr/decr(key: string): Promise<number>

// Advanced
getClient(): Redis                 // Returns raw ioredis client
isConnected(): boolean             // Checks if status === 'ready'
async ping(): Promise<boolean>     // Health check
```

### TenantGuard (guards/tenant.guard.ts)

Applied globally on all NestJS services. Validates:
1. Request has a `tenantId` (from JWT user, `x-tenant-id` header, query param, or body)
2. JWT user's `tenantId` matches the request's tenantId

TenantId extraction priority:
1. `request.user.tenantId` (from JWT - highest priority)
2. `x-tenant-id` header
3. `tenantId` query parameter
4. `tenantId` in request body

Works with both HTTP (`context.switchToHttp()`) and GraphQL (`GqlExecutionContext`) contexts.

Skip with `@SkipTenantGuard()` decorator on public endpoints.

### Decorators

**@Roles(...roles: string[])**:
```typescript
@Roles('admin', 'manager')
async sensitiveOperation() { ... }
```

**@SkipTenantGuard()**:
```typescript
@SkipTenantGuard()
@Query()
async publicQuery() { ... }
```
Uses metadata key `SKIP_TENANT_GUARD_KEY`.

**@Tenant()**:
Extracts `tenantId` from request and injects as method parameter.

**@Cacheable(keyPattern, ttlSeconds, options)**:
```typescript
@Cacheable('user:{0}', 3600)  // {0} = first argument
async getUser(userId: string): Promise<User>

@Cacheable('tenant:{0}:stats', 1800, { skipCache: (r) => !r })
async getTenantStats(tenantId: string): Promise<Stats | null>
```
Requires the service to have a `redisService`, `redis`, or `cacheService` property.

Key pattern interpolation: `{0}` = first arg, `{1}` = second arg, `{0.tenantId}` = property access on object arg.

**@CacheInvalidate(keyPattern)**:
Deletes specific cache key after method execution.

**@CacheInvalidatePattern(keyPattern)**:
Deletes all cache keys matching wildcard pattern after method execution.

### Telemetry (telemetry/tracing.ts)

OpenTelemetry initialization:

```typescript
export const initTelemetry = (serviceName: string) => {
  // Only enabled if ENABLE_TRACING=true
  // OTLP endpoint: OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces'
  // Uses getNodeAutoInstrumentations() (HTTP, DB, etc.)
  // fs instrumentation disabled by default (too noisy)
}
```

Called in each service's `main.ts` BEFORE the NestJS app is created.

## Dependencies / Integrations

- **All backend services** import from `@app/backend-common` (NX path alias)
- **admin-api-service**: Calls `SchemaManagerService` for tenant provisioning
- **Redis**: Used by auth-service (sessions), gateway-api (caching), farm-service (query caching)
- **TenantGuard**: Applied in all services' root modules
- **Telemetry**: Initialized in each service's `main.ts`

## Known Gotchas

1. **Adding new entities - MUST update MODULE_SCHEMAS** - The most common mistake. When you add a new TypeORM entity to `farm-service` or `sensor-service`, you MUST add its table name to `MODULE_SCHEMAS` in this file. Otherwise, the table won't be created during tenant provisioning and runtime queries will fail with "table does not exist".

2. **Module assignment BEFORE schema creation** - The `CreateTenantHandler` sequence is: assign modules → create schema. The schema manager queries `tenant_modules` to know which modules to provision. Reversing this order means no tables get created.

3. **No global SnakeNamingStrategy** - Each TypeORM entity column needs explicit `name:` mapping for snake_case DB columns:
   ```typescript
   @Column({ type: 'uuid', name: 'tenant_id' })
   tenantId: string;
   ```

4. **Entity schema decorators for tenant-scoped tables** - Do NOT use `{ schema: 'sensor' }` in `@Entity()` decorator for tenant-scoped tables. This overrides `search_path` and routes writes to the shared `sensor` schema instead of the tenant schema. Only shared reference tables can use explicit schemas.

5. **`@Cacheable` requires `redisService` property** - The decorator looks for `this.redisService || this.redis || this.cacheService`. If the service doesn't inject Redis under one of these names, caching silently falls through to the original method.

6. **`deletePattern` uses Redis KEYS command** - Redis `KEYS *` is blocking and slow on large datasets. Prefer `SCAN`-based patterns for production. The current implementation uses `client.keys()` which calls Redis `KEYS`. For large Redis datasets, consider switching to `SCAN`.

7. **TenantGuard on GraphQL** - The guard creates a `GqlExecutionContext` when `contextType === 'graphql'`. The request object must be available at `context.req`. Ensure NestJS GraphQL is configured with `context: ({ req }) => ({ req })`.

8. **OpenTelemetry must be initialized before NestJS** - `initTelemetry()` must be called before `NestFactory.create()`. If called after, instrumentation misses early module initialization events.

9. **Redis key prefix** - All keys are prefixed with `aqua:`. When debugging in Redis CLI, use `KEYS aqua:*` to see all platform keys. When using `keys(pattern)`, the returned keys have the prefix stripped automatically.

10. **`schema-manager.service.ts` grows as entities are added** - This is a known technical debt. The list of tables per module must be manually kept in sync with entity definitions. There is no automated validation.
