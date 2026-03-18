# Performance Analysis: Multi-Tenant Architecture Changes

**Date:** 2026-03-18
**Scope:** TenantConnectionBootstrap (pool patching), TenantSchemaMiddleware (LRU cache), cron job tenant iteration, index redundancy, table/schema count scalability

---

## 1. Connection Pool Impact — SET search_path on Every Checkout

### Current Implementation

All 6 tenant-aware services (farm, sensor, hr, hydroponics, ai, alert-engine) use an identical `TenantConnectionBootstrap` pattern that monkey-patches `pg.Pool.connect()`. On every connection checkout:

1. Read `schemaName` from `AsyncLocalStorage` (set by middleware chain)
2. If tenant schema detected: execute `SET search_path TO "tenant_xxx", <source>, public`
3. Return the connection to the caller

### Overhead per Connection Checkout

| Operation | Cost |
|-----------|------|
| `AsyncLocalStorage.getStore()` | ~50ns (memory read, no syscall) |
| Regex test `/^[a-z0-9_]+$/` | ~100ns |
| `SET search_path TO ...` | **~0.1-0.3ms** (PostgreSQL session variable, no disk I/O) |

`SET search_path` is a **session-level GUC parameter change**. PostgreSQL handles it entirely in shared memory -- no WAL writes, no catalog lookups, no lock acquisition. Benchmarks consistently show `SET` commands completing in under 300 microseconds.

**Total overhead per request:** Assuming a typical GraphQL request performs 3-5 pool checkouts (one per repository call), the added latency is **0.3-1.5ms per request**. At 100 concurrent users, this is negligible compared to actual query execution time.

### Connection Pinning Risk

**No pinning occurs.** The patch operates at the `pool.connect()` level, not at the connection level. The flow is:

1. Pool hands out a connection
2. Patch sets search_path
3. TypeORM uses the connection for one query
4. TypeORM calls `done()` to return the connection to the pool
5. Next checkout sets search_path again (possibly for a different tenant)

This is the **correct** approach. There is no connection affinity -- any connection can serve any tenant on the next checkout. The search_path is always reset before each use.

### Pool Configuration Summary

| Service | Pool Size (max) | Pool Min | Idle Timeout | Source |
|---------|----------------|----------|--------------|--------|
| farm-service | **50** | default (0) | 30s | `DATABASE_POOL_SIZE` env |
| sensor-service | **50** | **10** | 300s (5 min) | `DATABASE_POOL_SIZE` env |
| hr-service | **20** | default (0) | 30s | `DB_POOL_SIZE` env |
| hydroponics-service | **5** | default (0) | 30s | `DB_POOL_SIZE` env |
| ai-service | **5** | default (0) | 30s | `DB_POOL_SIZE` env |
| alert-engine | not specified | default | default | uses TypeORM defaults (10) |

**PostgreSQL max_connections:** 300 (from `docker-compose.droplet.yml`)

### Connection Budget at Scale

Total configured max pool across all services: 50 + 50 + 20 + 5 + 5 + 10 = **140 connections**

With 5 tenants and N concurrent users per tenant:

| Concurrent Users (total) | Connections Needed | Pool Headroom |
|--------------------------|-------------------|---------------|
| 10 | ~10-20 | Comfortable |
| 50 | ~30-50 | Comfortable |
| 100 | ~50-80 | OK (farm + sensor may saturate) |
| 200 | ~80-140 | At limit, queue backpressure starts |
| 300+ | >140 | **Connection timeout errors** |

**Key insight:** The pool sizes are **per-service, not per-tenant**. Because search_path is set per-checkout, all tenants share the same pool. This is optimal -- 5 tenants do not need 5x the connections.

### RISK: Double SET search_path

The middleware chain does **not** call SET search_path itself -- it only stores `schemaName` in AsyncLocalStorage. The pool patch handles the actual SET. This avoids double-SET overhead. However, if a request creates a dedicated QueryRunner (as cron jobs do), the cron code manually calls `SET search_path` AND the pool patch also fires. The pool patch's SET is overridden by the manual SET, so there is wasted work but no correctness issue. Impact: ~0.2ms wasted per cron QueryRunner checkout.

---

## 2. Schema Existence Cache Analysis

### Implementation Variants

Two distinct cache implementations exist across services:

**Variant A — Custom SchemaLRUCache class** (farm, hr, alert-engine):
- Max size: **1000 entries**
- TTL: **5 minutes** (uniform for positive and negative)
- LRU eviction via Map delete-and-reinsert pattern
- No request coalescing

**Variant B — Sensor-service SchemaLRUCache** (sensor):
- Max size: **1000 entries**
- Positive TTL: **5 minutes**
- Negative TTL: **30 seconds** (faster re-check for new tenants)
- LRU eviction

**Variant C — Plain Map + pendingChecks** (hydroponics, ai):
- Max size: **1000 entries**
- TTL: **5 minutes**
- **Request coalescing** via `pendingChecks` Map -- concurrent requests for the same schema reuse a single DB query
- Uses `pg_catalog.pg_namespace` instead of `information_schema.schemata`

### Cache Miss Behavior

On cache miss, a query is executed:

| Variant | Query | Typical Latency |
|---------|-------|----------------|
| A, B | `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1` | ~0.5-2ms |
| C | `SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1` | ~0.2-0.5ms |

`pg_catalog.pg_namespace` is a **system catalog table** with a unique index on `nspname`. It is significantly faster than `information_schema.schemata`, which is a **view** that joins multiple catalog tables with permission checks.

### Cache Hit Rate Projections

| Tenant Count | Cache Entries Needed | Max Size (1000) | Hit Rate After Warm-up |
|-------------|---------------------|-----------------|----------------------|
| 5 | 5 | 1000 | **~99.99%** (miss only on 5-min TTL expiry) |
| 100 | 100 | 1000 | **~99.9%** |
| 1000 | 1000 | 1000 | **~99%** (LRU eviction starts for least-active tenants) |
| 5000 | 5000 | 1000 | **~80%** (significant eviction churn) |

### Cache Misses Under Load

With 5 tenants and 5-minute TTL:
- Each service instance: 5 misses every 5 minutes = **1 miss per 60 seconds** = negligible
- Cold start: 5 misses in first 5 seconds, then fully cached

With 1000 tenants:
- 1000 misses every 5 minutes = **~3.3 misses/second** = still acceptable
- Thundering herd on cold start: 1000 concurrent misses. Only Variant C (hydroponics, ai) handles this correctly with request coalescing.

### Inconsistency Issues

1. **Negative cache TTL mismatch:** Farm, hr, alert-engine cache negative results (schema not found) for 5 minutes. Sensor caches them for 30 seconds. This means if a tenant is provisioned, farm/hr/alert-engine may reject requests for up to 5 minutes. This is the LOW-03 finding that sensor-service already fixed.

2. **information_schema vs pg_catalog:** Performance difference is 2-4x. All services should use `pg_catalog.pg_namespace`.

3. **No request coalescing in most services:** Farm, sensor, hr, alert-engine will fire duplicate DB queries if concurrent requests arrive for the same uncached schema. Only hydroponics and ai handle this.

---

## 3. Cron Job Tenant Iteration

### Identified Cron Jobs That Iterate All Tenants

| Service | Job | Interval | Iteration Method |
|---------|-----|----------|-----------------|
| farm | `detectOverdueTasks` | Every 30 min | `getTenantSchemas()` + sequential QueryRunner |
| farm | `generateDueTasks` (recurring) | Every 15 min | Sequential QueryRunner |
| farm | `processScheduleRules` | Every hour | Repository query (no schema iteration) |
| farm | `generateMaintenanceWorkOrders` | Daily 6AM | `getTenantSchemas()` + sequential QueryRunner |
| farm | `checkOverdueMaintenance` | Daily 7AM | `getTenantSchemas()` + sequential QueryRunner |
| farm | `checkOverdueWorkOrders` | Daily 8AM | Sequential QueryRunner |
| farm | `checkLowStock` | Daily 9AM | Sequential QueryRunner |
| farm | `weeklyMaintenanceSummary` | Weekly | Sequential QueryRunner |
| farm | `monthlyComplianceReport` | Monthly | Sequential QueryRunner |
| farm | `cleanupOldData` | Daily 2AM | Sequential QueryRunner |
| farm | `syncWeatherData` | Every 15 min | All tenant schemas |
| farm | `generateDailyPlans` (feeding) | Daily 6AM | Advisory lock + pagination |
| farm | `checkFeedTransitions` | Daily 7AM | Advisory lock |
| farm | `cleanupOldExecutions` | Monthly | Advisory lock |

### Per-Tenant Cost

Each tenant iteration involves:
1. `createQueryRunner()` -- allocates from pool (~0.1ms)
2. `SET search_path TO "tenant_xxx"` -- session GUC (~0.2ms)
3. Business logic queries (variable, 5-500ms)
4. `RESET search_path` -- session GUC (~0.2ms)
5. `queryRunner.release()` -- return to pool (~0.1ms)

Fixed overhead per tenant: **~0.6ms**. Business logic dominates.

### Overlap Risk Analysis

| Job | Interval | Projected Duration (N tenants) | Overlap Risk |
|-----|----------|-------------------------------|-------------|
| `detectOverdueTasks` | 30 min | N * 10ms = 50ms (5 tenants) | None |
| `generateDueTasks` | 15 min | N * 50ms = 250ms (5 tenants) | None |
| `syncWeatherData` | 15 min | N * 2s (HTTP call) = 10s (5 tenants) | **Low** at 5 tenants, **HIGH** at 100+ |
| `generateMaintenanceWorkOrders` | Daily | N * 100ms = 500ms (5 tenants) | None |

**At 100 tenants:**
- `detectOverdueTasks` (30 min): 100 * 10ms = 1s -- no risk
- `generateDueTasks` (15 min): 100 * 50ms = 5s -- no risk
- `syncWeatherData` (15 min): 100 * 2s = **200s (3.3 min)** -- approaches interval, **overlap risk**

**At 1000 tenants:**
- `syncWeatherData`: 1000 * 2s = **2000s (33 min)** -- **will overlap**, causing duplicate runs
- `detectOverdueTasks`: 1000 * 10ms = 10s -- acceptable
- `generateDueTasks`: 1000 * 50ms = 50s -- approaching risk

### Concurrency Guards

| Guard Type | Present In | Missing In |
|-----------|-----------|------------|
| `pg_try_advisory_lock` | feeding-cron.service (3 jobs) | cron-jobs.service (all 7 jobs), task.service, weather-cron |
| `isRunning` flag | observability-service | All farm-service cron jobs |
| None | -- | task.service.detectOverdueTasks, recurring-task.service, all cron-jobs.service jobs |

**CRITICAL:** The most frequent cron jobs (`detectOverdueTasks` at 30 min, `generateDueTasks` at 15 min, `syncWeatherData` at 15 min) have **no concurrency guards**. At scale, these will overlap and cause:
- Duplicate processing (work orders, overdue detection)
- Pool exhaustion (multiple QueryRunners per tenant per overlapping run)
- Event storms (duplicate NATS events)

---

## 4. Index Redundancy — tenantId in Schema-Isolated Tables

### Current Pattern

The `BaseEntity` class at `apps/farm-service/src/database/entities/base.entity.ts` defines:

```typescript
@Column('uuid', { name: 'tenant_id' })
@Index()
tenantId: string;
```

This creates a B-tree index on `tenant_id` in **every table** that extends `BaseEntity`. Additionally, many entities add composite indexes including tenantId:

```typescript
@Index(['tenantId', 'entityType', 'entityId'])
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'action'])
```

### Index Overhead Calculation

A B-tree index on a UUID column costs approximately:
- **Per row:** 40 bytes (16-byte UUID + 24-byte tuple header/pointer)
- **Per 1000 rows:** ~40 KB
- **Per table with 10K rows:** ~400 KB

With schema isolation, every tenant schema has its own copy of every table and index.

| Entity Count | Standalone tenantId Indexes | Avg Rows/Table | Disk per Tenant | 100 Tenants | 1000 Tenants |
|-------------|---------------------------|----------------|-----------------|-------------|--------------|
| Farm (66 tables) | ~66 | 1000 | ~2.6 MB | **260 MB** | **2.6 GB** |
| Sensor (34 tables) | ~34 | 10000 | ~13.6 MB | **1.36 GB** | **13.6 GB** |
| HR (24 tables) | ~24 | 500 | ~0.5 MB | **50 MB** | **500 MB** |

### Analysis

**Standalone `@Index()` on tenantId is WASTEFUL in schema-isolated tables.** Within a tenant schema, all rows belong to a single tenant. The index contains a single unique value repeated N times -- it is never selective and never used by the query planner.

**However, composite indexes like `@Index(['tenantId', 'createdAt'])` MAY still be useful** if:
- Application code filters by `WHERE tenantId = ? AND createdAt > ?`
- The query planner can use the index for the `createdAt` portion

In practice, since all rows in a schema have the same `tenantId`, the composite index degenerates to a single-column index on `createdAt`. A standalone `@Index(['createdAt'])` would be equivalent and smaller (no UUID prefix).

### Recommendation

**For schema-isolated tables:**
1. **DROP** standalone `@Index()` on `tenantId` -- zero selectivity, pure waste
2. **REPLACE** composite indexes `['tenantId', 'col']` with single `['col']` -- equivalent selectivity within a schema
3. **KEEP** the `tenantId` column itself as defense-in-depth (RLS policies, cross-schema queries for analytics)

**Estimated savings:**
- Per tenant: ~50% reduction in index disk usage (~1.3 MB for farm, ~6.8 MB for sensor)
- At 100 tenants: ~130 MB (farm) + 680 MB (sensor) = **~810 MB saved**
- At 1000 tenants: **~8.1 GB saved**

---

## 5. Table Count and Schema Scalability

### Current Table Counts Per Tenant Schema

| Service | Entities | Tables (incl. junction/TypeORM) |
|---------|----------|-------------------------------|
| farm-service | 66 | ~70-75 (including auto-generated junction tables) |
| sensor-service | 34 | ~35-38 |
| hr-service | 24 | ~25-27 |
| alert-engine | 5 | ~5-6 |
| ai-service | 3 | ~3 |
| hydroponics-service | 1 | ~1 |

**Total tables per tenant across all services:** ~139-150

Note: Each service creates its own schema copy per tenant. So tenant `abc` has `tenant_abc` in the farm database context (70 tables), `tenant_abc` in the sensor context (35 tables), etc. Since all services share the same PostgreSQL database, a single `tenant_abc` schema would contain all ~140 tables.

### information_schema Performance at Scale

The `information_schema.schemata` view queries `pg_catalog.pg_namespace`. PostgreSQL has a **B-tree index on `pg_namespace.nspname`**, making schema lookups O(log N) regardless of schema count.

| Tenant Count | Schema Count | `information_schema.schemata` Query Time | `pg_catalog.pg_namespace` Query Time |
|-------------|-------------|----------------------------------------|-------------------------------------|
| 5 | ~15 (5 tenant + system) | ~0.5ms | ~0.2ms |
| 100 | ~110 | ~0.6ms | ~0.2ms |
| 1000 | ~1010 | ~0.8ms | ~0.3ms |
| 10000 | ~10010 | ~1.5ms | ~0.4ms |

**The bottleneck is NOT schema lookup** -- it is the metadata catalog bloat.

### PostgreSQL Limits and Catalog Bloat

PostgreSQL has no hard limit on schema count. However, practical limits emerge from:

1. **pg_catalog bloat:** Each schema with 140 tables adds ~140 rows to `pg_class`, ~1000+ rows to `pg_attribute`, ~500+ rows to `pg_index`, etc.

| Tenant Count | pg_class rows | pg_attribute rows | pg_index rows | Estimated Catalog Size |
|-------------|--------------|-------------------|---------------|----------------------|
| 5 | ~1,400 | ~10,000 | ~3,500 | ~10 MB |
| 100 | ~15,400 | ~110,000 | ~38,500 | ~100 MB |
| 1000 | ~141,400 | ~1,010,000 | ~353,500 | **~1 GB** |
| 10000 | ~1,401,400 | ~10,010,000 | ~3,503,500 | **~10 GB** |

2. **DDL performance:** `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE` must scan catalog tables. At 1000+ tenants, schema creation (provisioning a new tenant) slows from ~100ms to ~500ms-2s.

3. **TypeORM synchronize:** With `DATABASE_SYNC=true`, TypeORM introspects ALL schemas on startup. At 1000 tenants, startup time increases from seconds to **minutes**.

4. **pg_dump/pg_restore:** Backup time scales linearly with schema count. At 1000 tenants with 140 tables each = 140,000 tables to dump.

5. **Connection startup:** Each new connection loads catalog cache. Larger catalogs = slower first query per connection.

### Hard Limits

| Limit | Value | Risk Level at 1000 Tenants |
|-------|-------|--------------------------|
| Max schemas | None (soft limit from catalog) | Low |
| Max tables (pg_class) | ~2 billion OIDs | None |
| Max columns (pg_attribute) | ~1600 per table | None |
| pg_catalog cache per connection | Proportional to catalog size | **Medium** |
| Shared buffer pressure | Each schema's indexes compete | **Medium** |
| WAL size during DDL | Schema creation generates WAL | Low |

---

## Summary of Recommendations

### Priority 1 — Must Fix (Data Integrity / Availability)

| # | Finding | Impact | Fix |
|---|---------|--------|-----|
| P1-1 | Cron jobs lack concurrency guards | Duplicate processing, event storms at scale | Add `pg_try_advisory_lock` or `isRunning` flag to all cron jobs in `cron-jobs.service.ts`, `task.service.ts`, `weather-cron.service.ts` |
| P1-2 | Negative cache TTL is 5 min in farm/hr/alert | New tenants rejected for up to 5 minutes | Adopt sensor-service pattern: 30s negative TTL across all services |

### Priority 2 — Should Fix (Performance)

| # | Finding | Impact | Fix |
|---|---------|--------|-----|
| P2-1 | `information_schema.schemata` used in 4/6 services | 2-4x slower than `pg_catalog.pg_namespace` | Switch farm, sensor, hr, alert-engine to `pg_catalog.pg_namespace` |
| P2-2 | No request coalescing in 4/6 services | Thundering herd on cold start/TTL expiry | Adopt hydroponics/ai `pendingChecks` pattern |
| P2-3 | Standalone `@Index()` on tenantId | ~810 MB wasted at 100 tenants | Remove from `BaseEntity`, replace composites with single-column |
| P2-4 | `syncWeatherData` runs every 15 min with no guard | Overlaps at 100+ tenants | Add advisory lock + configurable parallelism |

### Priority 3 — Nice to Have (Scale Preparation)

| # | Finding | Impact | Fix |
|---|---------|--------|-----|
| P3-1 | Hydroponics/AI pool size is 5 | Will bottleneck at 20+ concurrent users | Make configurable, raise default to 10-20 |
| P3-2 | Alert-engine has no explicit pool config | Uses pg default of 10 | Add explicit `max` with env var |
| P3-3 | Sequential tenant iteration in cron jobs | Linear scaling (O(N) tenants) | Add configurable parallelism (Promise.allSettled with concurrency limit) |
| P3-4 | No catalog size monitoring | Silent degradation at 1000+ tenants | Add pg_catalog row count to health checks |
| P3-5 | `DATABASE_SYNC=true` does not scale | Startup time degrades at 100+ tenants | Document that sync must be disabled; enforce via production guard |
| P3-6 | Total pool across services = 140 vs max_connections = 300 | Only ~2x headroom for replication, admin, monitoring | Review pool sizes; consider PgBouncer at 500+ total connections |

### Capacity Planning Matrix

| Metric | Current (5 Tenants) | 100 Tenants | 1000 Tenants | Action Threshold |
|--------|-------------------|-------------|--------------|-----------------|
| Pool connections needed | ~30 | ~80 | ~140 | >200: add PgBouncer |
| SET search_path overhead/req | ~0.6ms | ~0.6ms | ~0.6ms | Constant -- no action |
| Schema cache misses/sec | ~0.02 | ~3.3 | ~33 | >50: increase cache size |
| Cron job duration (weather) | ~10s | ~200s | ~2000s | >interval: add parallelism |
| Catalog size (pg_class) | ~10 MB | ~100 MB | ~1 GB | >500 MB: monitor closely |
| Index disk waste (tenantId) | ~6.5 MB | ~810 MB | ~8.1 GB | >1 GB: drop redundant indexes |
| Tenant provisioning time | ~100ms | ~200ms | ~500ms-2s | >5s: batch DDL |
