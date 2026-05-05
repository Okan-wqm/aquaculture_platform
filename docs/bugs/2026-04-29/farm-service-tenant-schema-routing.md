# Farm Service Tenant Schema Routing

Date: 2026-04-29

## Problem
Farm-service is designed to route tenant requests through PostgreSQL `search_path`, but tenant-owned entities were decorated with `schema: 'farm'`. That makes TypeORM generate source-schema-qualified SQL and bypasses the tenant schema selected by `TenantConnectionBootstrap`.

## Root Cause
The service-level TypeORM factory explicitly documents that `schema` must not be applied because per-request search path controls tenant isolation. Entity decorators drifted from that contract and pinned tables to the source schema.

## Enterprise Fix
Remove explicit `schema: 'farm'` from tenant-owned entities so repository and handler queries resolve through the active tenant `search_path`. Keep only source-owned infrastructure tables, such as `farm_outbox`, schema-qualified.

## Why The Tests Were Added
`tenant-schema-routing.architecture.spec.ts` prevents future entity decorator drift. `site-tenant-isolation.postgres.spec.ts` proves with real Postgres/Testcontainers that site, system, tank, feed, feed inventory, and water-quality parameter config flows use the tenant schema, never the source schema, and updated values are immediately visible in the same tenant only.

The feed tests were added because feed availability is displayed through site-scoped list queries that join `feed_sites`; the test guards the full create/update/delete/list/get path against cross-tenant leakage and stale reads.

The feed inventory tests were added because inventory merges existing lots and then performs stock adjustments; the test proves the merge key is tenant-scoped and that low-stock/status updates are immediately visible without leaking to another tenant using the same lot number.

The water-quality parameter config cache test was added because this code path can show stale frontend data even when the database row is already updated; the test warms two tenant cache entries, mutates one tenant, and proves invalidation reloads only that tenant while the other tenant remains isolated.

## Verification
Run:

```bash
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/tenant-schema-routing.architecture.spec.ts
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/site-tenant-isolation.postgres.spec.ts --runInBand
npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit
```

## Status
Implemented and verified with Docker/Testcontainers on 2026-04-29.
