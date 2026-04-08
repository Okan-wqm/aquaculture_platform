# Research: Search Path, Advisory Locks, and Tenant Provisioning

**Topic:** pg_advisory_lock for tenant schema creation races, CREATE SCHEMA → copy-tables-from-source → seed-reference-data pattern, LRU schema cache
**Date:** 2026-04-08
**Agent:** data-expert

## Sources

- [PostgreSQL 18 — Schemas](https://www.postgresql.org/docs/current/ddl-schemas.html) (CREATE SCHEMA, search_path, secure patterns)
- [PostgreSQL 18 — Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) (advisory locks: session vs transaction scope)
- [PostgreSQL 18 — Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html) (search_path GUC semantics)
- [PostgreSQL 18 — CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html) (LIKE clause: INCLUDING ALL, CONSTRAINTS, INDEXES, DEFAULTS, IDENTITY)
- Platform source: `libs/backend-common/src/database/schema-manager.service.ts`, `libs/backend-common/src/database/tenant-connection-bootstrap.service.ts`, `libs/backend-common/src/database/schema-lru-cache.ts`

## Key Findings

### The PostgreSQL `search_path` contract and how pooled connections break it

PostgreSQL docs: *"`search_path` — This variable specifies the order in which schemas are searched when an object (table, data type, function, etc.) is referenced by a simple name with no schema specified."* The critical property is that `search_path` is a **session variable**. Anything that executes `SET search_path = x` on a connection contaminates that connection until either (a) the connection is physically closed, (b) the pool runs its `afterCreate` / `beforeAcquire` hook, or (c) another `SET` overrides it.

Pool-level contamination is the root cause of the 2026-04-07 aqua-saas incident documented in `tenant-connection-bootstrap.service.ts`. The pool was created with `options: '-c search_path=farm,public'`, which PostgreSQL applies at physical connection startup — but once any query issued `SET search_path = public`, subsequent checkouts inherited the contaminated value.

### The fix: re-assert `search_path` on every checkout, in every context

The architecturally correct pattern is the one now in place: the pool's `connect()` method is monkey-patched so that **every** checkout (tenant request, migration, bootstrap, seed, cron) explicitly issues a `SET search_path` before the caller receives the connection. This converts an implicit "startup option sticks" contract into an explicit "every checkout is a reset" contract at the cost of one `SET` round-trip (~0.1ms on a local socket).

Three branches exist:

1. **Tenant request context.** `schemaName` from AsyncLocalStorage matches `TENANT_SCHEMA_REGEX` → `SET search_path TO "<tenant>", "<source>", public`. Tenant tables resolve first, falling back to source schema for shared reference data.
2. **Non-request context** (bootstrap, migration, seed, cron). No request context → `SET search_path TO "<source>", public`.
3. **Rejection.** Schema name does not match `TENANT_SCHEMA_REGEX` → the request is rejected before any SQL runs. This is the SQL-injection defense.

The contract is that **no code path may assume the pool delivered a clean `search_path` via startup options alone**. That assumption broke the platform once and must never be reintroduced.

### `SET LOCAL` vs `SET`

- `SET search_path = foo` — session-scoped, persists until end of session (or override). **Contaminates pooled connections.**
- `SET LOCAL search_path = foo` — transaction-scoped, released at COMMIT/ROLLBACK. **Safe inside a BEGIN/COMMIT.**

Any code path that issues a bare `SET search_path` on a pooled connection is a **CRITICAL** finding. Either use `SET LOCAL` inside a transaction, or rely on the bootstrap patch to re-assert on next checkout.

### Advisory locks for tenant provisioning races

PostgreSQL's advisory lock system provides application-defined locks that coordinate provisioning across multiple workers:

- **`pg_advisory_lock(key)`**: session-scoped, must be explicitly released with `pg_advisory_unlock(key)`, survives ROLLBACK. Used by `SchemaManagerService.createTenantSchema()`.
- **`pg_advisory_xact_lock(key)`**: transaction-scoped, released at COMMIT/ROLLBACK. Simpler and safer for bounded operations.
- **`pg_try_advisory_lock(key)`**: non-blocking variant; returns false if the lock cannot be acquired immediately. Use for "another worker is already provisioning this tenant" fast paths.

The aqua-saas pattern: hash the tenant UUID to a bigint key (typically `hashtext(tenantId)` or `('x' || substr(md5(tenantId::text), 1, 16))::bit(64)::bigint`) and take the lock before `CREATE SCHEMA`. Two workers racing to provision the same tenant will serialize on the lock, not on the `CREATE SCHEMA` statement itself (which would race and one would fail with `duplicate_schema`).

**Key failure mode**: session-scoped advisory locks **survive across connection returns to the pool**. If `pg_advisory_lock(key)` runs on a connection that is then returned to the pool without `pg_advisory_unlock(key)`, the lock is held by the next checkout of that connection — effectively leaked until the physical connection is evicted. The `SchemaManagerService.createTenantSchema()` implementation uses a `try/finally` block to guarantee release. Review rule: any code path that takes a session-scoped advisory lock without a matching `finally` unlock is a **CRITICAL** finding.

### The CREATE SCHEMA → copy tables → seed reference data pattern

The aqua-saas `SchemaManagerService` provisioning sequence (from `schema-manager.service.ts`):

1. **Validate tenant UUID** (`UUID_V4_REGEX`).
2. **Derive schema name** (`getTenantSchemaName(tenantId)` = `tenant_{first16HexChars}`).
3. **Acquire advisory lock** on the hashed tenant key.
4. **Check if schema exists** (LRU cache first, then `information_schema.schemata`).
5. **`CREATE SCHEMA IF NOT EXISTS "<schemaName>"`.**
6. **Copy table shapes** from source schemas using `CREATE TABLE <tenant>.<table> (LIKE <source>.<table> INCLUDING ALL)`.
7. **Copy reference data** (`INSERT INTO <tenant>.<refTable> SELECT * FROM <source>.<refTable>`) for each `referenceDataTables` entry.
8. **Create TimescaleDB hypertables** for time-series tables (`sensor_readings`, etc.).
9. **Apply RLS policies** (optional, defense in depth).
10. **Invalidate LRU cache**, populate with `exists=true`.
11. **Release advisory lock** in `finally`.

This sequence is structurally correct. Gaps the reviewer should flag:

- **`LIKE` without `INCLUDING ALL` drops constraints, defaults, indexes.** The reviewer must confirm the `CREATE TABLE LIKE` clause includes `INCLUDING ALL` (or explicitly lists `INCLUDING CONSTRAINTS INCLUDING INDEXES INCLUDING DEFAULTS INCLUDING IDENTITY INCLUDING STATISTICS INCLUDING STORAGE INCLUDING COMMENTS INCLUDING GENERATED`).
- **`LIKE` does not copy foreign keys.** If the source schema has `FK batches.cage_id → cages.id`, the tenant schema will not have that FK. Cross-table integrity is lost silently. The reviewer must confirm that either (a) FKs are re-created per tenant in a second pass, or (b) the schema design explicitly avoids FKs in tenant schemas (using application-level referential integrity).
- **`LIKE` does not copy triggers.** The `SourceSchemaWriteGuard` triggers are source-schema-only (intentional), but any domain trigger (e.g., `BEFORE INSERT` on a table) must be re-applied per tenant.
- **Reference data copy is an INSERT ... SELECT, not a COPY.** For large reference tables this is slower and holds locks longer. For `sensor_type_definitions` (~100 rows) this is fine; for a reference table with 100k rows it becomes a provisioning bottleneck.

### LRU cache for schema existence

`SchemaLRUCache` has two TTLs:

- **Positive TTL** (schema exists): 5 minutes default. Schemas are rarely deleted, so the cache is long-lived.
- **Negative TTL** (schema does not exist): 30 seconds default. Newly provisioned tenants are detected quickly.

The design includes **request coalescing**: if N concurrent requests hit the same uncached schema, only one fires the `SELECT FROM information_schema.schemata` check; the others await the same Promise. This prevents a thundering-herd on cold-cache bursts.

Gaps to review:

- **Cache invalidation on `deleteTenantSchema()`.** The delete path must call `schemaCache.invalidate(schemaName)`, otherwise the cache will report the schema exists for up to 5 minutes after deletion. This is implemented; the reviewer confirms the invalidate is present on every schema-delete code path.
- **Cache invalidation on DROP SCHEMA from an external source.** If ops manually drops a schema, the cache will lie for 5 minutes. There is no hook for external drops, but the reviewer should flag any ops runbook that does a raw DROP SCHEMA as needing a cache-clear step.
- **Cache size (`maxSize = 1000`).** For a tenant count > 1000, the LRU eviction starts churning and the hit rate drops. The reviewer must check the deployed tenant count against the cache size.

### Schema name validation: the SQL injection boundary

`SCHEMA_NAME_REGEX = /^[a-z0-9_]+$/` and `TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/`. Any SQL statement that interpolates a schema name (not parameterizable in PostgreSQL — identifiers cannot be `$1` bound) MUST validate first. The platform has `validateSqlIdentifier()`, `assertSafeSchemaName()`, and `validateTenantSchemaName()`.

Review rule: every `query()` call with a template literal that interpolates a schema or table name must have a validation call on the variable preceding it. A query like:

```typescript
await this.dataSource.query(`SELECT * FROM "${schemaName}"."${tableName}"`);
```

is a **CRITICAL** SQL injection risk unless both identifiers are validated against a safe regex.

### The `tenant_{16hex}` format and why 16 hex chars

Tenant UUIDs are 32 hex chars. PostgreSQL identifiers are limited to 63 bytes. The `tenant_` prefix is 7 bytes, leaving 56 for the hash. Taking the first 16 hex chars of the UUID is:

- **Unique enough** for practical tenant counts (2^64 = 1.8e19 possibilities; collision probability at 1M tenants ≈ 2.7e-8, birthday bound).
- **Short enough** to leave room for table names within the 63-byte limit. `tenant_<16hex>.some_table_with_long_name` is 30+ bytes, well under 63.
- **Predictable** — the same UUID always hashes to the same schema name (pure function `getTenantSchemaName()`).

A collision would be catastrophic (two tenants pointing at the same schema). The mitigation is: `CREATE SCHEMA IF NOT EXISTS` followed by a per-tenant marker table (e.g., `tenant_metadata` with the full UUID) checked on every provisioning request. This is not currently implemented; a collision would be silently accepted.

## Security Concerns

- **SQL injection via schema names.** Mitigated by `TENANT_SCHEMA_REGEX` and `assertSafeSchemaName()`. Any code path that interpolates a schema name without validation is **CRITICAL**. The reviewer must scan for `query(\`...${schemaName}...\`)` patterns in every PR.
- **Pool contamination via `SET search_path`.** Covered by the bootstrap patch, but any regression to bare `SET search_path` or to session-scoped `SET` statements inside request handlers is **CRITICAL**.
- **Advisory lock leak.** Session-scoped advisory lock without a `finally` unlock leaks into the next connection checkout. **CRITICAL**.
- **Schema name collision.** Two tenant UUIDs with the same first 16 hex chars would point to the same schema. Current code does not detect this. Review should add a tenant-metadata marker check.
- **`public` schema on the search_path.** The bootstrap patch leaves `public` on every search_path. PostgreSQL docs warn: *"Adding a schema to `search_path` effectively trusts all users having `CREATE` privilege on that schema."* The platform should `REVOKE CREATE ON SCHEMA public FROM PUBLIC` at deployment time and confirm the DB migration runner / RLS bootstrap does this.
- **Reference data copy leaks cross-tenant.** If a reference data table accidentally contains a `tenant_id` column (which it should not), the `INSERT ... SELECT *` will copy rows with that tenant_id into a different tenant's schema. The reviewer confirms that `referenceDataTables` are genuinely tenant-free.

## Performance Concerns

- **Provisioning latency is dominated by `CREATE TABLE LIKE` statements.** For the farm module (67+ tables), each provisioning run issues 67+ `CREATE TABLE` statements serially. This is ~2-5 seconds per tenant. Bulk provisioning (100 tenants) takes minutes.
- **Reference data INSERT SELECT scales linearly with reference row count.** For `sensor_type_definitions` (~100 rows) this is instant. For a larger reference table this becomes a bottleneck. Use `COPY` instead of `INSERT ... SELECT` for reference tables >10k rows.
- **Advisory lock contention.** If multiple workers try to provision the same tenant (e.g., retry storm), they serialize on the advisory lock. This is correct behavior, but each waiting worker holds an open connection. Set `lock_timeout` on advisory lock acquisitions so a stuck worker doesn't starve the pool.
- **LRU cache size vs tenant count.** At `maxSize = 1000` and > 1000 active tenants, cache hit rate degrades. Review the live tenant count and bump `maxSize` if needed.
- **Monkey-patching `pool.connect` adds a per-checkout round-trip.** The bootstrap patch adds ~0.1ms per checkout. At 1000 QPS this is 100ms/sec of overhead — negligible but non-zero. Worth monitoring.

## Architectural Implications for data-expert reviews

1. **Every schema-name interpolation requires a validation call.** Grep for `"${.*schema.*}"` or `"${.*Schema.*}"` in the PR diff and confirm the variable is validated. A **CRITICAL** finding if missing.
2. **Every session-scoped advisory lock needs a `finally` unlock.** Review looks for `pg_advisory_lock` calls and confirms a matching `pg_advisory_unlock` in a `finally` block on every exit path.
3. **`CREATE TABLE LIKE` must include `INCLUDING ALL`.** Missing `INCLUDING ALL` drops constraints, defaults, indexes silently. **HIGH** finding.
4. **Any `SET search_path = ...` outside the bootstrap patch is **CRITICAL**.** The bootstrap patch is the single authoritative mechanism. All other code paths must rely on it.
5. **LRU cache invalidation on schema delete.** Every `DROP SCHEMA` must be followed by `invalidateSchemaCache()`. Missing is **HIGH**.
6. **`REVOKE CREATE ON SCHEMA public FROM PUBLIC`.** The deployment migration must ensure this is set. Missing is **MEDIUM** (defense in depth).
7. **Schema-name collision check.** The `createTenantSchema()` path should verify the full UUID on re-use via a tenant-metadata marker table. Missing is **MEDIUM** until the platform scales past ~100k tenants.

## Domain Rule Additions for data-expert

- Session-scoped `pg_advisory_lock()` call without a matching `pg_advisory_unlock()` in a `finally` block on every exit path = **CRITICAL** (lock leak contaminates next checkout).
- `CREATE TABLE ... LIKE` without `INCLUDING ALL` (or explicit listing of `CONSTRAINTS INDEXES DEFAULTS IDENTITY STORAGE GENERATED`) on a tenant provisioning path = **HIGH**.
- Any `SET search_path = ...` (session-scoped) outside `TenantConnectionBootstrap.patchConnectionPool()` = **CRITICAL**.
- `query(\`... ${schemaName} ...\`)` pattern where `schemaName` has not been validated by `validateTenantSchemaName()` / `assertSafeSchemaName()` / `SCHEMA_NAME_REGEX` = **CRITICAL** (SQL injection).
- `DROP SCHEMA` code path missing `schemaCache.invalidate(schemaName)` = **HIGH**.
- Reference data table entry in `MODULE_SCHEMAS[module].referenceDataTables` that has a `tenant_id` column = **CRITICAL** (cross-tenant leak on provisioning).
- `SchemaLRUCache` `maxSize` less than the live tenant count = **MEDIUM** (cache churn degrades hit rate).
- `createTenantSchema()` path that does not take an advisory lock before `CREATE SCHEMA` = **HIGH** (race on concurrent provisioning).
- Raw `CREATE SCHEMA` statement without `IF NOT EXISTS` in a provisioning path = **MEDIUM** (retry-idempotency break).
- Missing `REVOKE CREATE ON SCHEMA public FROM PUBLIC` in deployment migration = **MEDIUM** (defense in depth for search_path trust).
