# Tenant Schema Middleware Patterns

> Last updated: 2026-03-18

This document defines the correct implementation pattern for tenant schema resolution
middleware and connection-pool-level search_path injection. All services that access
tenant-specific data MUST follow this pattern exactly. Deviations are catalogued in the
"Broken Implementations" section below.

---

## Architecture Overview

Tenant isolation is enforced at two layers that work in concert:

```
Request
  |
  v
CorrelationIdMiddleware          (1) attach X-Correlation-Id
RequestContextMiddleware         (2) create AsyncLocalStorage store
UserContextMiddleware            (3) parse x-user-payload header -> req.user
TenantContextMiddleware          (4) extract tenantId from JWT/headers -> req.tenantId
TenantSchemaMiddleware           (5) resolve schema, store in req + AsyncLocalStorage
  |
  v
Handler / Service / Repository
  |
  v
TypeORM pool.connect()  ------>  TenantConnectionBootstrap (patched)
  |                                  reads schemaName from AsyncLocalStorage
  v                                  SET search_path TO "tenant_xxx", {source}, public
PostgreSQL
```

**Why two layers?** `TenantSchemaMiddleware` resolves *which* schema to use, but TypeORM
repositories internally create their own `QueryRunner` instances from the connection pool.
Those QueryRunners bypass any search_path set on the middleware's own QueryRunner.
`TenantConnectionBootstrap` solves this by monkey-patching `pg Pool.connect()` so that
EVERY connection checkout automatically sets the search_path from AsyncLocalStorage.

---

## Correct Implementation (Reference: farm-service, hydroponics-service)

### Decision Flow

```
tenantId present and != 'default-tenant'?
  |
  YES --> validate UUID format (/^[0-9a-f]{8}-...-[0-9a-f]{12}$/i)
  |         |
  |         INVALID --> throw BadRequestException('Invalid tenant ID format')
  |         |
  |         VALID --> generate schema name: tenant_{first 16 hex chars}
  |                     |
  |                     check schema exists (LRU cache, 5 min TTL)
  |                     |
  |                     EXISTS --> req.schemaName = tenant_xxx
  |                     |
  |                     NOT EXISTS --> THROW UnauthorizedException
  |                                   ** NEVER fallback to source schema **
  |
  NO --> req.schemaName = DEFAULT_SCHEMA (e.g. 'farm', 'hydroponics')
         (unauthenticated/health-check/internal requests)
```

### Critical Rules

1. **UUID Validation (SQL Injection Prevention):** Every tenantId MUST be validated against
   the UUID regex before any schema name derivation. Reject with `BadRequestException`.

2. **Schema Name Generation:** `tenant_` + first 16 hex characters of the UUID (hyphens
   removed, lowercased). Must match `SchemaManagerService.getTenantSchemaName` exactly.
   - Example: `4b529829-ea79-48da-982c-cd6fbec8ffb7` -> `tenant_4b529829ea7948da`

3. **Schema Existence Check:** Query `information_schema.schemata` or
   `pg_catalog.pg_namespace` with parameterized query (`$1`). Cache results in an LRU
   cache (max 1000 entries, 5 min TTL).

4. **NO SILENT FALLBACK (D05-H1):** If an authenticated request provides a tenantId but
   the corresponding schema does not exist, the middleware MUST throw an exception. Falling
   back to the shared/source schema creates a cross-tenant data leak vector where Tenant A's
   queries execute against the shared schema and potentially see Tenant B's data.

5. **AsyncLocalStorage Propagation:** After resolving `schemaName`, store it in both
   `req.schemaName` (for direct handler access) and `getRequestContext().schemaName`
   (for pool-level injection by `TenantConnectionBootstrap`).

6. **Unauthenticated Requests:** When no tenantId is present (health checks, metrics,
   internal calls), default to the service's source schema (e.g. `farm`, `sensor`).

### Reference: farm-service TenantSchemaMiddleware

Source: `apps/farm-service/src/middleware/tenant-schema.middleware.ts`

```typescript
// Key behavior on missing schema -- throws, never falls back:
if (schemaExists) {
  req.schemaName = tenantSchema;
} else {
  // D05-H1: No fallback to shared schema -- cross-tenant data leak risk
  throw new UnauthorizedException(`Tenant schema not found for tenant ${tenantId}`);
}
```

### Reference: hydroponics-service TenantSchemaMiddleware

Source: `apps/hydroponics-service/src/middleware/tenant-schema.middleware.ts`

```typescript
// Same behavior -- all services now standardized to UnauthorizedException:
if (schemaExists) {
  req.schemaName = tenantSchema;
} else {
  this.logger.warn(`Tenant ${tenantId}: schema '${tenantSchema}' does not exist`);
  throw new UnauthorizedException(`Tenant schema not found for tenant ${tenantId}`);
}
```

All 6 services now throw `UnauthorizedException` consistently.

### Shared Infrastructure (Adopted Across All Services)

The following improvements from the post-review standardization are now used by all 6 services:

1. **Shared `SchemaLRUCache`:** Imported from `@platform/backend-common`. Provides dual-TTL
   (5 min positive / 30s negative) and built-in request coalescing via `getOrCheck()`,
   preventing a thundering herd against Postgres when many requests for the same tenant
   arrive simultaneously.

2. **Outer try/catch with re-throw:** Wraps the entire middleware body; known exceptions
   (`BadRequestException`, `UnauthorizedException`) are re-thrown; unknown errors become
   `BadRequestException('Failed to resolve tenant schema')` to avoid leaking stack traces.

---

## TenantConnectionBootstrap (Reference: farm-service)

Source: `apps/farm-service/src/infrastructure/tenant-connection-bootstrap.service.ts`

### What It Does

On module init (`OnModuleInit`), it monkey-patches `pg Pool.connect()` on the TypeORM
DataSource's master pool. On every connection checkout:

1. Read `schemaName` from `AsyncLocalStorage` via `getRequestContext()`.
2. If a tenant schema is present and passes `/^[a-z0-9_]+$/` validation:
   execute `SET search_path TO "{schemaName}", {SOURCE_SCHEMA}, public`.
3. If no schema in context (migrations, cron jobs, startup): skip, use default search_path.

### Key Implementation Details

```typescript
// Schema name validation -- prevents injection in SET search_path
if (schemaName && schemaName !== sourceSchema && /^[a-z0-9_]+$/.test(schemaName)) {
  client.query(
    `SET search_path TO "${schemaName}", ${sourceSchema}, public`,
    (qErr: any) => { ... }
  );
}
```

- **Callback style:** TypeORM's `PostgresDriver.obtainMasterConnection` uses callback-style
  `pool.connect(callback)`. The patch handles both callback and promise styles.
- **Schema validation regex:** `/^[a-z0-9_]+$/` -- only lowercase alphanumeric and underscores.
  This is the second layer of defense after UUID validation in the middleware.
- **search_path order:** `"tenant_xxx", {source_schema}, public` -- tenant schema first for
  data isolation, source schema second for shared reference/lookup tables, public last for
  PostgreSQL extensions (`uuid-ossp`, etc.).
- **SOURCE_SCHEMA constant:** Must match the service's default schema (e.g. `farm`, `sensor`,
  `hr`, `hydroponics`).

### Why Monkey-Patching?

TypeORM does not expose a hook for "on connection checkout". The `QueryRunner.connect()` path
only covers QueryRunners created explicitly -- but `repository.find()`, `repository.save()`,
etc. create internal QueryRunners that bypass any middleware-set search_path. Patching at the
`pg Pool` level is the only reliable interception point.

---

## Previously Broken Implementations (RESOLVED)

> The following issues were identified during the 2026-03-18 audit and have since been fixed.
> They are preserved here for historical reference.

### sensor-service: Silent Fallback (FIXED)

**Status:** RESOLVED -- The middleware now throws `UnauthorizedException` on missing schema.
The silent fallback and the partial catch-block mitigation have both been replaced with
a clean throw-on-missing-schema pattern matching the farm-service reference implementation.

### hr-service: Double Silent Fallback (FIXED)

**Status:** RESOLVED -- Both the primary `else` branch and the `catch` block have been
rewritten. The middleware now throws `UnauthorizedException` on missing schema, matching
the farm-service reference implementation.

### alert-engine: No Middleware (FIXED)

**Status:** RESOLVED -- `TenantSchemaMiddleware` and `TenantConnectionBootstrap` have been
added to the alert-engine service. The alert module is also registered in `MODULE_SCHEMAS`
with 5 tables.

---

## Service Status Summary

| Service       | Middleware | Throws on Missing Schema | Bootstrap | Shared Cache | Status  |
|---------------|-----------|--------------------------|-----------|-------------|---------|
| farm          | Yes       | Yes (UnauthorizedException) | Yes    | Yes (SchemaLRUCache) | CORRECT |
| hydroponics   | Yes       | Yes (UnauthorizedException) | Yes    | Yes (SchemaLRUCache) | CORRECT |
| ai            | Yes       | Yes (UnauthorizedException) | Yes    | Yes (SchemaLRUCache) | CORRECT |
| sensor        | Yes       | Yes (UnauthorizedException) | Yes    | Yes (SchemaLRUCache) | CORRECT |
| hr            | Yes       | Yes (UnauthorizedException) | Yes    | Yes (SchemaLRUCache) | CORRECT |
| alert-engine  | Yes       | Yes (UnauthorizedException) | Yes    | Yes (SchemaLRUCache) | CORRECT |

> **Note:** All 6 services now use `UnauthorizedException` (401) consistently. Previous inconsistency where hydroponics/ai used `NotFoundException` has been resolved.

---

## Template for New Services

### 1. TenantSchemaMiddleware

File: `src/middleware/tenant-schema.middleware.ts`

Replace `YOUR_SERVICE` with your service's source schema name (e.g. `alert`, `billing`).

```typescript
import {
  Injectable,
  NestMiddleware,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { DataSource } from 'typeorm';
import { getRequestContext, SchemaLRUCache } from '@platform/backend-common';

interface TenantRequest extends Request {
  tenantId?: string;
  user?: {
    tenantId?: string;
    sub?: string;
    email?: string;
    role?: string;
  };
  schemaName?: string;
}

/**
 * Tenant Schema Middleware for YOUR_SERVICE Service
 *
 * Resolves the tenant schema name from the request and stores it in:
 * 1. req.schemaName - for direct access by handlers
 * 2. AsyncLocalStorage RequestContext.schemaName - for pool-level search_path injection
 *
 * The actual SET search_path is handled transparently by TenantConnectionBootstrap,
 * which patches pg Pool.connect() to read schemaName from AsyncLocalStorage on every
 * connection checkout.
 *
 * search_path: "tenant_xxx", YOUR_SERVICE, public
 */
@Injectable()
export class TenantSchemaMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantSchemaMiddleware.name);
  private readonly DEFAULT_SCHEMA = 'YOUR_SERVICE'; // <-- CHANGE THIS

  /** LRU cache with dual-TTL (5 min positive, 30s negative) and request coalescing */
  private readonly schemaCache = new SchemaLRUCache(1000, 5 * 60 * 1000, 30_000);

  constructor(private readonly dataSource: DataSource) {}

  async use(req: TenantRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // Extract tenant ID from request (set by UserContextMiddleware/TenantContextMiddleware)
      const tenantId = req.tenantId || req.user?.tenantId;

      if (tenantId && tenantId !== 'default-tenant') {
        // Validate UUID format (SQL injection prevention)
        if (!this.isValidUUID(tenantId)) {
          throw new BadRequestException('Invalid tenant ID format');
        }

        const tenantSchema = this.getTenantSchemaName(tenantId);
        const schemaExists = await this.checkSchemaExists(tenantSchema);

        if (schemaExists) {
          req.schemaName = tenantSchema;
        } else {
          // CRITICAL: Never fallback to source schema -- cross-tenant data leak risk (D05-H1)
          this.logger.warn(`Tenant ${tenantId}: schema '${tenantSchema}' does not exist`);
          throw new UnauthorizedException(`Tenant schema not found for tenant ${tenantId}`);
        }
      } else {
        // Unauthenticated / health-check / internal requests use source schema
        req.schemaName = this.DEFAULT_SCHEMA;
      }
    } catch (error) {
      // Re-throw known HTTP exceptions
      if (error instanceof BadRequestException || error instanceof UnauthorizedException) {
        throw error;
      }
      // Unknown errors (DB connectivity, etc.) -- do NOT fallback for authenticated requests
      this.logger.error(
        `Schema middleware error: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException('Failed to resolve tenant schema');
    }

    // Store in request context (AsyncLocalStorage) for pool-level search_path injection
    try {
      const ctx = getRequestContext();
      if (ctx) {
        ctx.schemaName = req.schemaName;
      }
    } catch {
      // RequestContext not available -- schemaName still on req
    }

    next();
  }

  /**
   * Validate UUID format
   */
  private isValidUUID(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }

  /**
   * Generate tenant schema name from tenant ID.
   * Format: tenant_{first 16 hex chars of UUID without hyphens}
   * Must match SchemaManagerService.getTenantSchemaName exactly.
   */
  private getTenantSchemaName(tenantId: string): string {
    const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    return `tenant_${cleanId}`;
  }

  /**
   * Check schema existence with LRU caching and request coalescing.
   * Uses SchemaLRUCache.getOrCheck() which handles caching, TTL, and
   * request deduplication automatically.
   */
  private async checkSchemaExists(schemaName: string): Promise<boolean> {
    return this.schemaCache.getOrCheck(schemaName, async () => {
      try {
        const result = await this.dataSource.query(
          `SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1`,
          [schemaName],
        );
        return result.length > 0;
      } catch {
        return false;
      }
    });
  }

  /**
   * Invalidate cache for a schema.
   * Call this after schema creation/deletion.
   */
  invalidateCache(schemaName: string): void {
    this.schemaCache.invalidate(schemaName);
  }
}
```

### 2. TenantConnectionBootstrap

File: `src/infrastructure/tenant-connection-bootstrap.service.ts`

Replace `YOUR_SERVICE` with your service's source schema name.

```typescript
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getRequestContext } from '@platform/backend-common';

/**
 * Enterprise-grade tenant schema routing at the PostgreSQL connection pool level.
 *
 * Problem: TenantSchemaMiddleware sets search_path context, but TypeORM repositories
 * internally create their OWN QueryRunners from the pool. Those QueryRunners use the
 * default search_path, so all queries hit the source schema instead of tenant schemas.
 *
 * Solution: Monkey-patch pg Pool's connect() method to auto-set search_path from
 * AsyncLocalStorage (populated by the middleware chain) on EVERY connection checkout.
 *
 * Flow:
 * 1. Request arrives -> RequestContextMiddleware populates AsyncLocalStorage
 * 2. TenantSchemaMiddleware resolves tenantId -> stores schemaName in request context
 * 3. Handler calls repository.find() -> TypeORM internally calls pool.connect()
 * 4. OUR PATCH: Before returning the connection, SET search_path from context
 * 5. TypeORM executes query on correct tenant schema
 * 6. Connection returned to pool -> next checkout will set new search_path
 */
@Injectable()
export class TenantConnectionBootstrap implements OnModuleInit {
  private readonly logger = new Logger(TenantConnectionBootstrap.name);
  private readonly SOURCE_SCHEMA = 'YOUR_SERVICE'; // <-- CHANGE THIS

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.patchConnectionPool();
  }

  private patchConnectionPool(): void {
    const driver = this.dataSource.driver as any;
    const pool = driver.master;

    if (!pool || typeof pool.connect !== 'function') {
      this.logger.error('Cannot patch connection pool -- pg Pool not found on DataSource driver');
      return;
    }

    const originalConnect = pool.connect.bind(pool);
    const sourceSchema = this.SOURCE_SCHEMA;
    const logger = this.logger;

    // Patch pool.connect() -- TypeORM uses callback style internally
    pool.connect = function (callback?: any) {
      if (typeof callback === 'function') {
        // Callback style (used by TypeORM's PostgresDriver.obtainMasterConnection)
        return originalConnect((err: any, client: any, done: any) => {
          if (err) return callback(err, client, done);

          // Read tenant schema from AsyncLocalStorage (set by middleware chain)
          let schemaName: string | undefined;
          try {
            const ctx = getRequestContext();
            schemaName = ctx?.schemaName;
          } catch {
            // Not in request context (migrations, cron jobs) -- use default
          }

          if (schemaName && schemaName !== sourceSchema && /^[a-z0-9_]+$/.test(schemaName)) {
            client.query(
              `SET search_path TO "${schemaName}", ${sourceSchema}, public`,
              (qErr: any) => {
                if (qErr) {
                  logger.error(`Failed to set search_path to ${schemaName}: ${qErr.message}`);
                }
                callback(null, client, done);
              },
            );
          } else {
            callback(null, client, done);
          }
        });
      }

      // Promise style (fallback)
      return originalConnect().then(async (client: any) => {
        let schemaName: string | undefined;
        try {
          const ctx = getRequestContext();
          schemaName = ctx?.schemaName;
        } catch {
          // Not in request context
        }

        if (schemaName && schemaName !== sourceSchema && /^[a-z0-9_]+$/.test(schemaName)) {
          await client.query(`SET search_path TO "${schemaName}", ${sourceSchema}, public`);
        }
        return client;
      });
    };

    this.logger.log('PostgreSQL connection pool patched for tenant-aware search_path routing');
  }
}
```

### 3. AppModule Middleware Configuration

File: `src/app.module.ts`

```typescript
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  RequestContextMiddleware,
  UserContextMiddleware,
  SourceSchemaBootstrapService,
} from '@platform/backend-common';
import { TenantSchemaMiddleware } from './middleware/tenant-schema.middleware';
import { TenantConnectionBootstrap } from './infrastructure/tenant-connection-bootstrap.service';

@Module({
  imports: [
    // ... TypeOrmModule.forRootAsync, GraphQLModule, etc.
    //
    // IMPORTANT: Do NOT set 'schema' in TypeORM config!
    // Schema is managed dynamically by TenantSchemaMiddleware.
    // Setting schema here causes TypeORM to add explicit schema prefix
    // to all queries, overriding search_path and breaking isolation.
    //
    // In TypeORM 'extra', set default search_path for migrations/sync:
    //   extra: { options: '-c search_path=YOUR_SERVICE,public' }
  ],
  providers: [
    // Bootstrap source schema tables on startup
    SourceSchemaBootstrapService,
    // Pool-level tenant schema routing (patches pg Pool.connect)
    TenantConnectionBootstrap,
    // ... other providers
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Middleware execution order matters:
    // 1. CorrelationIdMiddleware   - Add X-Correlation-Id for request tracing
    // 2. RequestContextMiddleware  - Populate AsyncLocalStorage store
    // 3. UserContextMiddleware     - Parse x-user-payload header -> req.user
    // 4. TenantContextMiddleware   - Extract tenantId from JWT/headers -> req.tenantId
    // 5. TenantSchemaMiddleware    - Resolve schema, store in req + AsyncLocalStorage
    consumer
      .apply(
        CorrelationIdMiddleware,
        RequestContextMiddleware,
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,
      )
      .forRoutes('*');
  }
}
```

### Checklist for Adding Tenant Isolation to a Service

- [ ] Create `src/middleware/tenant-schema.middleware.ts` (template above)
- [ ] Create `src/infrastructure/tenant-connection-bootstrap.service.ts` (template above)
- [ ] Update `DEFAULT_SCHEMA` / `SOURCE_SCHEMA` constants to match your service name
- [ ] Register `TenantConnectionBootstrap` and `SourceSchemaBootstrapService` in `providers`
- [ ] Configure middleware chain in `AppModule.configure()` (order matters!)
- [ ] Set `extra.options: '-c search_path=YOUR_SERVICE,public'` in TypeORM config
- [ ] Do NOT set `schema` property in TypeORM config
- [ ] Verify: authenticated request with missing schema returns 401/404, NOT a fallback
- [ ] Verify: unauthenticated request (no tenantId) uses source schema
- [ ] Verify: `SET search_path` appears in Postgres logs for tenant requests

---

## Related Documentation

- `docs/db/00-architecture-overview.md` -- Overall database architecture
- `docs/db/02-tenant-isolation-rules.md` -- Tenant isolation security rules
- `libs/backend-common/src/logging/request-context.ts` -- AsyncLocalStorage definition
- `libs/backend-common/src/database/schema-lru-cache.ts` -- Shared SchemaLRUCache (dual-TTL + request coalescing)
- `libs/backend-common/src/database/tenant-schema.utils.ts` -- Shared schema utilities (getTenantSchemaName, isValidUUID, listTenantSchemas)
