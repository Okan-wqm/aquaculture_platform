# Research: PostgreSQL Migration Safety and Idempotent Patterns

**Topic:** Idempotent migrations, DO $$ blocks, lock timeouts, CREATE TABLE IF NOT EXISTS patterns, online/concurrent index creation, destructive DROP COLUMN/TABLE precautions with backup
**Date:** 2026-04-08
**Agent:** data-expert

## Sources

- [PostgreSQL 18 — CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html) (CONCURRENTLY semantics, INVALID index recovery)
- [PostgreSQL 18 — ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) (lock levels, NOT VALID constraints, non-volatile default fast-path)
- [PostgreSQL 18 — DO](https://www.postgresql.org/docs/current/sql-do.html) (anonymous code blocks)
- [PostgreSQL 18 — Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html) (statement_timeout, lock_timeout, idle_in_transaction_session_timeout, transaction_timeout)
- [PostgreSQL 18 — Schemas](https://www.postgresql.org/docs/current/ddl-schemas.html)
- [PostgreSQL Wiki — Idempotent Deployment](https://wiki.postgresql.org/wiki/Idempotent_Deployment)

## Key Findings

### The default ALTER TABLE is dangerous: ACCESS EXCLUSIVE

PostgreSQL documentation is explicit: *"An `ACCESS EXCLUSIVE` lock is acquired unless explicitly noted."* ACCESS EXCLUSIVE blocks **all** concurrent access including reads. For production migrations, this is unacceptable unless the operation is genuinely instantaneous.

The subset of operations that are instantaneous (effectively O(1) metadata changes):

- `ADD COLUMN ... DEFAULT <non-volatile>` (PG 11+). *"The default value is evaluated at the time of the statement and the result stored in the table's metadata."* Critical distinction: `DEFAULT now()` is **volatile** and rewrites the table. `DEFAULT CURRENT_DATE` is also volatile. `DEFAULT 'some_literal'` is non-volatile and fast.
- `ADD CONSTRAINT ... NOT VALID` (check / foreign key). *"With `NOT VALID`, the `ADD CONSTRAINT` command does not scan the table and can be committed immediately."*
- `DROP CONSTRAINT` (metadata only)
- `DROP COLUMN` (logical drop — metadata mark only; storage reclaimed by VACUUM FULL later)
- `RENAME COLUMN` / `RENAME CONSTRAINT`

Operations that **rewrite the table** (long ACCESS EXCLUSIVE hold):

- `ADD COLUMN ... DEFAULT <volatile>` (volatile default, generated column, identity column, or a domain type with constraints)
- `ALTER COLUMN ... TYPE` (with a few exceptions — `text ↔ varchar` without collation change is metadata-only)
- `ALTER COLUMN ... SET NOT NULL` (without `NOT VALID` path — full scan, still blocks writes)

### The safe online migration pattern

Combine four primitives:

```sql
BEGIN;
SET LOCAL lock_timeout = '2s';          -- give up fast if blocked
SET LOCAL statement_timeout = '30s';     -- bound total time
SET LOCAL search_path = '<schema>', public;
ALTER TABLE foo ADD COLUMN bar text DEFAULT 'unknown';  -- fast, metadata only
COMMIT;
```

Key points from PostgreSQL docs:

- `lock_timeout` *"Aborts any statement that waits longer than the specified amount of time while attempting to acquire a lock on a table, index, row, or other database object."* **Applies to lock waits only, not statement execution.**
- `statement_timeout` bounds total statement time (applies to execution, not just waiting).
- `SET LOCAL` scopes both to the current transaction — no bleed into other sessions on the same pooled connection.
- The `lock_timeout` value of 1-3s is the industry convention: it gives up before the lock wait queue starves other sessions, and is short enough that the migration retries quickly.

### CREATE INDEX CONCURRENTLY — correct but subtle

Quoting the docs: *"Concurrent index builds can still fail, though, even though they allow other commands to run while they proceed. If a problem arises, the index build is rolled back, but the 'invalid' index continues to exist as a real index in the table."*

Rules:

1. **Cannot run inside a transaction block.** `BEGIN; CREATE INDEX CONCURRENTLY ... COMMIT;` fails. This forces each concurrent index into its own migration file or its own statement.
2. **Failure leaves an `INVALID` index that must be dropped and rebuilt.** Recovery: `DROP INDEX <name>; CREATE INDEX CONCURRENTLY <name> ON ...;` or `REINDEX INDEX CONCURRENTLY <name>;`.
3. **Partitioned tables: CONCURRENTLY is not supported on the parent.** The workaround in the docs: build concurrent indexes on each partition, then `CREATE INDEX` non-concurrently on the parent (metadata-only once all partitions already have the index).
4. **Two table scans + multiple wait phases.** CONCURRENTLY is dramatically slower than a regular index build. On a large sensor_readings hypertable, an index build can take hours. Never include concurrent index creation inside a migration that also does other work.

### The idempotent DDL pattern

PostgreSQL supports `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and `DROP TABLE IF EXISTS` directly. These are the preferred idempotency primitives because they are atomic and race-free.

For operations without an `IF NOT EXISTS` variant (e.g., `ADD CONSTRAINT`, `CREATE POLICY`, `CREATE TRIGGER`), the correct pattern is a `DO $$ ... END $$` anonymous block that checks `pg_catalog` before issuing the DDL:

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'foo_uq' AND conrelid = 'public.foo'::regclass
  ) THEN
    ALTER TABLE public.foo ADD CONSTRAINT foo_uq UNIQUE (bar);
  END IF;
END $$;
```

Catch-and-ignore (`EXCEPTION WHEN duplicate_object THEN NULL;`) is acceptable but inferior because it swallows *all* duplicate-object errors — if the constraint exists with a different definition, the block silently no-ops instead of alerting. Prefer the explicit `IF NOT EXISTS` check.

**Anti-pattern: catching generic exceptions.** `EXCEPTION WHEN others THEN NULL;` swallows *everything*, including syntax errors, and must never appear in a migration.

### Destructive migrations require explicit precautions

`DROP COLUMN`, `DROP TABLE`, `DROP SCHEMA ... CASCADE`, `TRUNCATE`, `ALTER COLUMN ... TYPE` with narrowing, and any migration that writes a default value to existing rows are destructive. The platform's internal review rule must require:

1. **Documented backup step.** Before the migration runs, a `pg_dump` or logical dump of the affected tables is taken and its path is recorded. A review that approves a destructive migration without this is CRITICAL.
2. **Rollback path.** A compensating migration that can restore the state (from the backup or from application data) must be designed *before* the forward migration runs.
3. **Stage-gate.** Destructive migrations do not autorun — they require explicit ops approval via a separate deploy flag.
4. **`DROP COLUMN` does not reclaim space.** Until `VACUUM FULL` or `CLUSTER` rewrites the table, the dropped column's storage stays allocated. This is relevant for capacity planning on wide tables.

### Advisory locks as a migration gate

`pg_advisory_lock(key)` acquires a session-scoped lock that does not honor transaction semantics (survives ROLLBACK, requires explicit unlock). `pg_try_advisory_lock(key)` is non-blocking. Transaction-scoped variants (`pg_advisory_xact_lock`) release at COMMIT/ROLLBACK without explicit unlock.

For tenant-scoped migrations (run per tenant schema), the correct pattern is to hash the tenant UUID into a bigint key and use a transaction-scoped advisory lock:

```sql
SELECT pg_advisory_xact_lock(('x' || substr(md5(tenant_id::text), 1, 16))::bit(64)::bigint);
-- ... migration DDL ...
-- lock auto-releases at COMMIT
```

This prevents two migration runners from racing on the same tenant schema. The aqua-saas `SchemaManagerService` already uses advisory locks for provisioning; the same pattern should apply to migration runners.

### Timeout discipline

The safe pattern explicitly sets three timeouts at the top of every migration transaction:

```sql
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
```

- `lock_timeout` = **2s**: how long to wait for a lock before giving up
- `statement_timeout` = **30s**: total allowed statement time
- `idle_in_transaction_session_timeout` = **60s**: prevents a paused migration from holding locks indefinitely

For CREATE INDEX CONCURRENTLY, disable `statement_timeout` (`SET LOCAL statement_timeout = 0`) but leave `lock_timeout` in place.

### The `CREATE TABLE LIKE` pattern (aqua-saas specific)

`SchemaManagerService` uses `CREATE TABLE <tenant>.<table> LIKE <source>.<table>` to clone table shapes from the source schema into a new tenant schema. Important caveats from PostgreSQL docs:

- `LIKE` copies the column definitions and optionally (`INCLUDING ALL`) indexes, constraints, defaults, identity, and storage parameters. Without `INCLUDING ALL`, NONE of these are copied.
- `LIKE` does **not** copy foreign keys by default. `INCLUDING CONSTRAINTS` copies CHECK constraints but not FKs. The platform must explicitly recreate FKs in the tenant schema if isolation should preserve them.
- `LIKE` does **not** copy RLS policies or grants. These must be re-applied per-tenant.
- `LIKE` does **not** copy triggers (the `SourceSchemaWriteGuard` triggers the platform installs on source schemas). Triggers must be re-installed per tenant schema if intended to apply there.

## Security Concerns

- **Dynamic SQL with unvalidated schema names is SQL injection.** Any migration that interpolates schema names from `information_schema.schemata` into a SQL string must validate the name against `SCHEMA_NAME_REGEX` (`^[a-z0-9_]+$`) and enforce length ≤63. The aqua-saas `assertSafeSchemaName()` helper is exactly this.
- **`DO $$ EXCEPTION WHEN others THEN NULL` swallows security failures silently.** If a constraint creation fails because of a missing column (indicating prior migration drift), an overbroad exception handler hides the drift instead of alerting.
- **Long-running DDL transactions hold dependent row locks.** A migration that runs for 30 minutes with even a single `UPDATE` inside the transaction will hold row locks for 30 minutes. Split migrations into read phase + short DDL phase.
- **Advisory locks are per-session.** If a connection pool recycles the connection that holds a session-scoped advisory lock, the lock is released. Transaction-scoped locks (`pg_advisory_xact_lock`) avoid this class of bug.
- **`SET search_path` contamination.** A migration that runs `SET search_path = foo` on a pooled connection contaminates that connection for all subsequent checkouts until pool eviction. This is the exact class of bug that the aqua-saas 2026-04-07 incident exposed — every migration transaction must use `SET LOCAL search_path` (never session-level `SET`).

## Performance Concerns

- **Index build on large hypertables is expensive.** Sensor_readings (TimescaleDB hypertable) has millions of rows per tenant. A non-concurrent index build blocks writes for the entire duration. Always `CREATE INDEX CONCURRENTLY` on hypertables, and accept that failure means retry-from-scratch.
- **`ALTER COLUMN ... SET NOT NULL` scans the whole table.** For large tables, the pattern is: (1) `ADD CONSTRAINT CHECK (col IS NOT NULL) NOT VALID`, (2) `VALIDATE CONSTRAINT` (only SHARE UPDATE EXCLUSIVE lock), (3) `SET NOT NULL` (metadata only once the check exists, PG 12+).
- **`VACUUM FULL` blocks all access.** The reference data copy on new tenant provisioning must NOT be followed by VACUUM FULL inline. If reclamation is needed, schedule it out-of-band.
- **Excessive `DO $$` blocks are opaque to the query planner.** Each DO block is a fresh PL/pgSQL context. Avoid wrapping every statement in a DO block when plain DDL with `IF NOT EXISTS` suffices.

## Architectural Implications for data-expert reviews

1. **Migration files are the primary artifact under review.** data-expert is primary for migration/delta review. Every file in `database/migrations/modules/` and `database/migrations/core/` requires a hand audit of: (a) lock impact, (b) idempotency, (c) reversibility, (d) destructive-operation precautions.
2. **Idempotency checks.** The reviewer must confirm every DDL statement either uses `IF NOT EXISTS` or is wrapped in a `DO $$` block with an explicit `pg_catalog` existence check. Bare `CREATE TABLE foo (...)` without `IF NOT EXISTS` in a migration is a **HIGH** finding.
3. **Lock hygiene.** Every migration must open with `SET LOCAL lock_timeout`, `SET LOCAL statement_timeout`, and (for DDL transactions) `SET LOCAL idle_in_transaction_session_timeout`. Missing timeouts is a **MEDIUM** finding.
4. **`ADD COLUMN` safety audit.** Every `ADD COLUMN` with a `DEFAULT` must be audited: non-volatile default = OK, volatile default = **HIGH** (table rewrite).
5. **`ALTER COLUMN ... TYPE` must document the rewrite cost.** Unless the change is `text ↔ varchar` without collation change, this is a full table rewrite. The reviewer must flag this as **HIGH** and require the two-phase (`text` alias column + backfill + swap) pattern on any table >1M rows.
6. **`CREATE INDEX CONCURRENTLY` isolation.** Each concurrent index must live in its own migration file (it cannot be in a transaction). Mixing CONCURRENTLY with other DDL in one file is a **HIGH** finding.
7. **Destructive migrations require a documented backup plan.** `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN ... TYPE` narrowing — without a documented `pg_dump` step and rollback migration, these are **CRITICAL**.
8. **`DO $$ EXCEPTION WHEN others THEN NULL`** — **HIGH** finding. Use explicit `pg_catalog` existence checks or `EXCEPTION WHEN duplicate_object` (specific).
9. **Cross-tenant migration coverage.** A migration that should run per-tenant but lacks integration with `TenantSchemaSyncService` is a **CRITICAL** drift source — it creates a schema split where some tenants have the new shape and others don't.

## Domain Rule Additions for data-expert

- Bare `CREATE TABLE` / `CREATE INDEX` / `CREATE POLICY` without `IF NOT EXISTS` or a `pg_catalog` existence check = **HIGH**.
- Missing `SET LOCAL lock_timeout` and `SET LOCAL statement_timeout` at the top of a DDL transaction = **MEDIUM**.
- `ADD COLUMN` with a volatile `DEFAULT` (e.g., `now()`, `clock_timestamp()`, `gen_random_uuid()` on a large table) without documented rewrite-cost analysis = **HIGH**.
- `ALTER COLUMN ... TYPE` that requires a rewrite on a table with >1M rows, without a documented two-phase migration plan = **HIGH**.
- `CREATE INDEX CONCURRENTLY` co-located with other DDL in the same migration file = **HIGH**.
- `DROP COLUMN`, `DROP TABLE`, `DROP SCHEMA ... CASCADE`, `TRUNCATE`, or narrowing `ALTER COLUMN ... TYPE` without documented `pg_dump` backup step and rollback migration = **CRITICAL**.
- `DO $$ EXCEPTION WHEN others THEN NULL` (overbroad catch-all) = **HIGH**.
- `SET search_path = ...` (session-scoped) inside a migration instead of `SET LOCAL search_path = ...` = **CRITICAL** (pool contamination risk; see 2026-04-07 incident).
- Migration that modifies per-tenant schema tables but is not wired into `TenantSchemaSyncService` or `MigrationRunnerService` per-tenant loop = **CRITICAL** (drift source).
- Migration that uses `synchronize()` or `QueryRunner.synchronize()` at runtime outside the `SourceSchemaBootstrapService` bootstrap path = **CRITICAL** (bypasses migration ledger).
