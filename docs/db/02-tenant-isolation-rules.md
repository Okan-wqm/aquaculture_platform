# Tenant Isolation Rules - Zero Tolerance Policy

## Principle

Every piece of tenant module data (farm, sensor, hr, hydroponics) MUST be stored in and read from the tenant's own schema (`tenant_xxx`). No exceptions. A single row landing in a shared source schema constitutes a data leak between tenants and is treated as a **P0 security incident**.

---

## Rule 1: Schema-Level Isolation for ALL Module Services

- `farm-service`, `sensor-service`, `hr-service`, `hydroponics-service`, `ai-service`, `alert-engine` MUST use `TenantSchemaMiddleware` + `TenantConnectionBootstrap`.
- `search_path` MUST be set to `"tenant_xxx", {source_schema}, public` on every connection acquired from the pool.
- **NEVER** fall back to the source schema for authenticated requests. If a tenant schema cannot be resolved, **THROW** an `UnauthorizedException`. Silent fallback is an isolation violation.

## Rule 2: Every Entity Table MUST Be in MODULE_SCHEMAS

- If a TypeORM entity exists in a module service, its table name MUST be listed in `MODULE_SCHEMAS`.
- This ensures the table is created in every tenant schema during provisioning.
- A missing table means tenant data silently writes to the shared source schema. This is an **ISOLATION VIOLATION**.
- When adding a new entity, updating `MODULE_SCHEMAS` is a mandatory part of the PR checklist.

## Rule 3: No Hardcoded Schema in Entity Decorators

Correct:

```typescript
@Entity('table_name')
```

**Forbidden:**

```typescript
@Entity('table_name', { schema: 'farm' })
```

Hardcoded `schema` in the decorator bypasses `search_path` and sends all reads/writes to the shared source schema regardless of tenant context. This breaks isolation completely.

## Rule 4: Unique Table Names Across Modules

Since all modules share a single tenant schema (`tenant_xxx`), table names MUST be globally unique across every module service.

- `employees` in farm-service vs `employees` in hr-service = **TABLE COLLISION**.
- Convention: prefix with the module name when collision risk exists (`farm_workers`, `hr_employees`, `sensor_audit_logs`).
- Before naming a new table, grep all entity files across all services to confirm uniqueness.

## Rule 5: Cron Jobs MUST Iterate Tenant Schemas

Background jobs and scheduled tasks run outside HTTP request context. There is no `AsyncLocalStorage`, no middleware, and `search_path` defaults to the source schema.

Required pattern:

1. Query all active tenant schemas from the system database.
2. For each tenant schema, create a dedicated `QueryRunner`.
3. Execute `SET search_path TO "tenant_xxx", {source_schema}, public` on that runner.
4. Perform the work.
5. Release the `QueryRunner`.

Reference implementation: `feeding-cron.service.ts` lines 662-693.

**NEVER** run a cron job against the default connection without explicitly setting `search_path` per tenant.

## Rule 6: No Raw SQL with Hardcoded Schema Names

**Forbidden:**

```sql
SELECT * FROM "sensor"."deployment_logs"
```

Correct approaches:

- Use TypeORM repository methods that respect the current `search_path`.
- If raw SQL is unavoidable, rely on the connection's current `search_path` (unqualified table names).
- If schema qualification is truly required, parameterize the schema name from the tenant context --- never hardcode it.

## Rule 7: Middleware MUST Throw on Missing Schema

- If a request carries a valid JWT but the tenant schema does not exist in PostgreSQL, the middleware MUST throw `UnauthorizedException`.
- **NEVER** silently fall back to the source schema. Silent fallback means the request reads/writes shared data as if it were tenant data.
- Current status (as of 2026-03-18):
  - `farm-service`: **CORRECT** --- throws `UnauthorizedException` on missing schema.
  - `hydroponics-service`: **CORRECT** --- throws `UnauthorizedException` on missing schema (standardized from previous `NotFoundException`).
  - `sensor-service`: **CORRECT** --- throws `UnauthorizedException` on missing schema (fixed from previous silent fallback).
  - `hr-service`: **CORRECT** --- throws `UnauthorizedException` on missing schema (fixed from previous double fallback).
  - `ai-service`: **CORRECT** --- throws `UnauthorizedException` on missing schema (standardized from previous `NotFoundException`).
  - `alert-engine`: **CORRECT** --- throws `UnauthorizedException` on missing schema.

## Rule 8: System Data STAYS in System Schemas

The following data belongs in dedicated system schemas and MUST NOT appear in `MODULE_SCHEMAS` or tenant schemas:

| Data Category | Target Schema |
|---|---|
| Security audit (`activity_logs`, `security_events`, etc.) | `admin` |
| User data (`users`, `consents`, `permissions`) | `auth` |
| Billing data (`subscriptions`, `invoices`, etc.) | `billing` |

System entities must never be registered as module entities. If a module service needs to reference system data, it queries the system schema directly or uses an inter-service call.

## Rule 9: Reference Data

- Lookup tables (`equipment_types`, `sensor_protocols`, species data, etc.) are **copied** into each tenant schema during provisioning.
- Tenants may customize their own copy without affecting other tenants.
- The source schema copy serves as the **seed template only** and is never read at runtime for tenant requests.
- When reference data is updated in the seed template, a migration must propagate changes to existing tenant schemas if needed.

## Rule 10: No Cross-Schema Foreign Keys

- Tenant entities that reference system entities (e.g., a farm referencing its owner user) MUST use UUID soft references only.
- **No PostgreSQL `FOREIGN KEY` constraints** may span across schemas (`tenant_xxx` -> `auth`, `tenant_xxx` -> `admin`, etc.).
- Referential integrity between schemas is enforced at the **application level** only.
- This ensures tenant schemas can be created, migrated, and dropped independently of system schemas.

## Rule 11: Use Shared SchemaLRUCache from backend-common

All services MUST use the shared `SchemaLRUCache` class from `@platform/backend-common` for tenant schema existence caching. Local/inline LRU cache implementations are forbidden.

```typescript
import { SchemaLRUCache } from '@platform/backend-common';
private readonly schemaCache = new SchemaLRUCache(1000, 5 * 60 * 1000, 30_000);
```

The shared implementation provides:
- Dual-TTL (5 min positive / 30s negative) for fast new-tenant detection
- Built-in request coalescing via `getOrCheck()` to prevent thundering herd
- Consistent cache eviction behavior across all services

## Rule 12: Use Shared Tenant Schema Utilities from backend-common

All services MUST use `getTenantSchemaName()` and `isValidUUID()` from `@platform/backend-common` (not local copies) for schema name derivation and UUID validation. This ensures consistency with `SchemaManagerService.getTenantSchemaName()`.

```typescript
import { getTenantSchemaName, isValidUUID } from '@platform/backend-common';
```

## Rule 13: Cron Jobs MUST Use listTenantSchemas()

Cron jobs and background tasks that iterate over tenant schemas MUST use `listTenantSchemas()` from `@platform/backend-common` instead of inline SQL queries.

```typescript
import { listTenantSchemas } from '@platform/backend-common';

const schemas = await listTenantSchemas(this.dataSource);
for (const schemaName of schemas) {
  // ... process each tenant
}
```

---

## Verification Checklist

For **each** module service (`farm`, `sensor`, `hr`, `hydroponics`, `ai`, `alert-engine`), verify all of the following:

- [ ] `TenantSchemaMiddleware` exists and **throws** `UnauthorizedException` on missing schema (not silent fallback).
- [ ] `TenantConnectionBootstrap` exists and patches `Pool.connect()` to set `search_path` on every acquired connection.
- [ ] **ALL** entity table names are listed in `MODULE_SCHEMAS`.
- [ ] No `@Entity()` decorator contains a hardcoded `{ schema: 'xxx' }` option.
- [ ] All cron jobs and background tasks iterate tenant schemas with explicit `search_path` per tenant.
- [ ] No raw SQL contains hardcoded schema names.
- [ ] No table name collides with tables in other module services.
- [ ] Schema existence cache uses shared `SchemaLRUCache` from `@platform/backend-common` (not a local implementation).
- [ ] UUID validation and schema name derivation use shared utilities from `@platform/backend-common`.
- [ ] Cron jobs use `listTenantSchemas()` from `@platform/backend-common` for tenant discovery.

A PR that violates any of the above rules MUST be rejected during code review. No exceptions.
