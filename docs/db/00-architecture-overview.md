# Aquaculture Platform - Database Architecture

## Overview

Single PostgreSQL instance (`aquaculture` database) with schema-based multi-tenancy.

## Schema Tiers

### Tier 1: System Schemas (Shared, row-level tenant filtering via tenantId)

| Schema | Owner Service | Purpose |
|--------|-------------|---------|
| `auth` | auth-service | Users, tenants, invitations, modules, refresh tokens, announcements, messaging, support tickets |
| `admin` | admin-api-service | Tenant configs, plan definitions, analytics, security audit, feature toggles, system management |
| `billing` | billing-service | Subscriptions, invoices, payments, plans, usage metrics |

### Tier 2: Source/Template Schemas (Structure only, NO tenant data)

| Schema | Module | Table Count | Purpose |
|--------|--------|-------------|---------|
| `farm` | farm | 66 | Template for farm module tables |
| `sensor` | sensor | 34 | Template for sensor module tables |
| `hr` | hr | 24 | Template for HR module tables |
| `hydroponics` | hydroponics | 1 | Template for hydroponics tables |
| `alert` | alert | 5 | Template for alert module tables |
| `ai` | ai | 3 | Template for AI module tables |

### Tier 3: Tenant Schemas (Per-tenant isolation)

- Format: `tenant_{first16hex_of_uuid}` (e.g., `tenant_4b529829ea7948da`)
- Contains cloned tables from ALL 6 modules (farm, sensor, hr, hydroponics, alert, ai)
- Created during tenant provisioning via `CREATE TABLE ... (LIKE source INCLUDING ALL)`
- Runtime routing via `SET search_path TO "tenant_xxx", {source}, public`

## Isolation Model

| Service Type | Isolation Method | Mechanism |
|-------------|-----------------|-----------|
| System services (auth, admin, billing) | Row-level | `WHERE tenantId = :id` |
| Module services (farm, sensor, hr, hydroponics, alert-engine, ai) | Schema-level | `SET search_path` per request |

## Key Components

1. **SchemaManagerService** (`libs/backend-common/src/database/schema-manager.service.ts`) - MODULE_SCHEMAS registry, tenant schema creation/deletion
2. **TenantSchemaMiddleware** (per service) - Resolves tenant schema from JWT, validates existence
3. **TenantConnectionBootstrap** (per service) - Monkey-patches pg Pool.connect() to SET search_path
4. **SourceSchemaBootstrapService** (`libs/backend-common`) - Creates template tables in source schemas on startup
5. **tenant-schema.utils.ts** (`libs/backend-common/src/database/tenant-schema.utils.ts`) - Shared utilities for schema name derivation (`getTenantSchemaName`), UUID validation (`isValidUUID`, `UUID_V4_REGEX`), schema name validation (`isValidSchemaName`, `SCHEMA_NAME_REGEX`), and tenant discovery (`listTenantSchemas`)
6. **SchemaLRUCache** (`libs/backend-common/src/database/schema-lru-cache.ts`) - Shared LRU cache with dual-TTL (5 min positive, 30s negative) and request coalescing via `getOrCheck()` to prevent thundering herd on cache misses
7. **DEFAULT_TENANT_MODULES** (in `schema-manager.service.ts`) - Single source of truth for the default module list, derived from `MODULE_SCHEMAS.map(m => m.moduleName)`. Used by `createTenantSchema()` and `syncTenantSchema()` as the default `modules` parameter

## Separate Databases

| Database | Service |
|----------|---------|
| `config_service` | config-service |
| `aquaculture_events` | event-store-service |
| `notification_service` | notification-service |
| `aquaculture_observability` | observability-service |

## Documents in This Directory

- `01-schema-separation.md` - What belongs where (system vs tenant)
- `02-tenant-isolation-rules.md` - Isolation guarantees and patterns
- `03-module-schemas-registry.md` - MODULE_SCHEMAS canonical reference
- `04-middleware-patterns.md` - TenantSchemaMiddleware correct implementation
- `05-cron-job-patterns.md` - Background job tenant iteration
- `06-entity-guidelines.md` - Entity design rules
- `07-migration-plan.md` - Step-by-step fix plan
- `08-audit-findings.md` - Complete audit results
- `09-frontend-data-flow.md` - Frontend tenant context
- `10-init-sql-reference.md` - Database initialization script reference
- `15-consistency-check.md` - Cross-document consistency audit
- `ALERT_ENGINE_SCHEMAS_NEEDED.md` - Alert engine MODULE_SCHEMAS tracking
- `18-final-review-report.md` - Final end-to-end review report with post-review improvements
