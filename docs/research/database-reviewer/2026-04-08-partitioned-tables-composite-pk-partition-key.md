# Research: PostgreSQL Partitioned Tables — Composite PK/FK, Partition Key Rules, TypeORM Limitations

**Topic:** Production partitioning for multi-tenant PostgreSQL — RANGE (time) and LIST (tenant) semantics, composite PK/FK rules that must include the partition key, `synchronize: false` requirement, and TypeORM's limitations on declarative partitioning.
**Date:** 2026-04-08
**Agent:** database-reviewer

## Sources
- [PostgreSQL: Documentation 15 — Table Partitioning](https://www.postgresql.org/docs/15/ddl-partitioning.html)
- [PostgreSQL: Documentation 15 — ALTER TABLE (ATTACH / DETACH PARTITION)](https://www.postgresql.org/docs/15/sql-altertable.html)
- [PostgreSQL Wiki: Table Partitioning](https://wiki.postgresql.org/wiki/Table_partitioning)
- [Crunchy Data: Partitioning with Native Postgres and pg_partman](https://www.crunchydata.com/blog/native-partitioning-with-postgres)
- [Crunchy Data: Postgres Partitioning with a Default Partition](https://www.crunchydata.com/blog/postgres-partitioning-with-a-default-partition)
- [Cybertec: PostgreSQL Table Partitioning](https://www.cybertec-postgresql.com/en/postgresql-v11-partitioning/)
- [Tiger Data: TimescaleDB Hypertables (reference for time-based partitioning parallels)](https://www.tigerdata.com/docs/use-timescale/latest/hypertables)
- [AWS: PostgreSQL partitioning best practices on RDS / Aurora](https://aws.amazon.com/blogs/database/designing-high-performance-time-series-data-tables-on-amazon-rds-for-postgresql/)

## Key Findings

1. **Declarative partitioning is the modern choice.** PostgreSQL 10 introduced declarative partitioning; PostgreSQL 11 added unique constraints and FK support with partition-key inclusion; PostgreSQL 12+ has tuple-routing improvements and FK-referencing partitioned tables (not just FK FROM partitioned). Inheritance-based partitioning (`INHERITS`) is legacy — avoid.
2. **Three partition strategies:**
   - **RANGE** — partition by a continuous key's ranges. Most common for time-based (`created_at`, `occurred_at`) or numeric-range data.
   - **LIST** — partition by explicit value sets. Useful for region codes, tenant IDs in sharded models, status enums.
   - **HASH** — partition by a hash of the key. Even distribution; loses pruning by range/list; rarely the right choice for multi-tenant SaaS.
3. **Partition key inclusion rule (hard constraint):** "To create a unique or primary key constraint on a partitioned table, the partition keys must not include any expressions or function calls and the constraint's columns must include all of the partition key columns."
   - For `messages` partitioned by `created_at` monthly, the PK must be `(id, created_at)`, not `(id)`.
   - This is the single most common schema mistake when migrating a non-partitioned table to partitioned.
4. **Unique constraint inclusion rule:** same rule as PK — any unique constraint must include all partition key columns. A `UNIQUE (email)` on a partitioned user table with `PARTITION BY LIST(tenant_id)` is not legal; must be `UNIQUE (tenant_id, email)`.
5. **Exclusion constraints** must also include partition keys, AND must compare the partition key columns for equality (not `&&` or other operators). Additional non-partition columns can use any operator.
6. **Foreign key behavior (PostgreSQL 12+):**
   - FROM a partitioned table → non-partitioned table: supported natively.
   - FROM a partitioned table → partitioned table: supported in PostgreSQL 12+, with restrictions (the referenced columns must be the partition key of the target, or a unique constraint including it).
   - TO a partitioned table: ATTACH / DETACH can have subtle effects on FK validation windows.
7. **Indexes on partitioned tables** are "partitioned indexes" — creating an index on the parent cascades to existing partitions. Partitions attached AFTER the index was created do NOT automatically receive the index; you must either recreate the index or ATTACH the partition's index to the parent. This is the silent performance cliff on month-boundary partition creation.
8. **Default partition** catches rows that do not fit any explicit partition. Without a default, misrouted inserts fail with an error — this is usually what you want in production (surface the missing partition immediately). A default partition silently absorbs data and makes future ATTACH slow (default partition must be scanned to ensure no overlap).
9. **Attach and detach semantics:**
   - `ATTACH PARTITION ... FOR VALUES FROM (...) TO (...)` acquires a stronger lock and scans the partition to verify constraint compliance unless a `CHECK` constraint already proves it.
   - `DETACH PARTITION CONCURRENTLY` (PostgreSQL 14+) avoids long locks, but has multi-step semantics — finalize is required.
10. **`pg_partman`** is the de facto extension for automatic partition management: premake future partitions, retention drops old partitions, background workers maintain the schedule. Without pg_partman, a cron / scheduled job must create next month's partition before the 1st — missing this = inserts fail at 00:00:00 month boundary = CRITICAL outage.
11. **Partition key choice drives pruning.** Every query that can be pruned to a subset of partitions MUST include a WHERE clause on the partition key. A query `SELECT * FROM messages WHERE sender_id = $1` without `created_at >= X AND created_at < Y` scans every partition — sequential scan across a year of data.
12. **RANGE partition bounds** are inclusive-start, exclusive-end: `FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')` covers January but NOT February 1. This is consistent with half-open intervals but trips up reviewers expecting inclusive end.
13. **TypeORM and partitioned tables: incomplete support.**
    - TypeORM's migration generator DOES NOT emit `PARTITION BY` clauses.
    - TypeORM's schema synchronizer DOES NOT understand partitioned tables — it will try to "fix" them by dropping partitions.
    - Entity decorators have no first-class partition metadata.
    - Composite PK including partition key (`@PrimaryColumn` on `id` AND `createdAt`) must be manually enforced; entity drift vs migration is easy to miss.
    - **`synchronize: false` is mandatory** on any entity mapped to a partitioned table. Leaving `synchronize: true` = CRITICAL (auto-sync will destroy partitions).
14. **Raw SQL in migrations is the only safe path** for creating partitioned tables, ATTACH / DETACH, and pg_partman setup. TypeORM's QueryRunner.createTable cannot model partitioning.
15. **Cross-partition DML:**
    - `INSERT` routes to the correct partition automatically.
    - `UPDATE` that moves a row across partitions (`UPDATE ... SET created_at = ...`) is legal in PostgreSQL 11+ and executes as DELETE + INSERT. This breaks TRIGGER semantics that assume UPDATE fires once.
    - `DELETE FROM parent` deletes across all partitions unless pruned by WHERE.
16. **Row-level statistics are per-partition.** The planner uses per-partition stats for pruning; autovacuum must run on each partition. A stale partition's statistics can cause bad plan choices even if the rest of the table is fine.

## Multi-Tenant Partitioning Patterns

17. **LIST partition by tenant_id** is an option for shared-table multi-tenancy at scale (thousands of tenants per DB). Each tenant gets its own partition; DROP PARTITION wipes a tenant in one DDL. The aqua-saas `tenant_{16hex}` schema model is the schema-per-tenant alternative — neither is strictly better, but mixing the two is schema debt.
18. **RANGE partition by time** is the right choice for append-only audit / event / message / sensor telemetry tables. aqua-saas uses this for: `messages` (monthly), `message_receipts` (monthly), `compliance_audit_log` (monthly), `sensor_metrics` (TimescaleDB hypertable = transparent time-range chunks).
19. **RANGE subpartitioned by LIST** (e.g., monthly top-level, tenant_id second-level) produces fine-grained pruning but explodes partition count — 12 months × 1000 tenants = 12,000 leaf partitions = catalog bloat. Not recommended beyond 100s of tenants.
20. **TimescaleDB hypertables** are logically declarative RANGE partitions by time, managed automatically. The chunk_time_interval defines the effective partition granularity. Same composite-PK-must-include-time rule applies.

## Security Concerns
- Missing composite PK (no partition key in the PK) on a partitioned table = CRITICAL — PostgreSQL refuses at create time, but an entity mismatch in TypeORM can mask this until migration runtime.
- `synchronize: true` on a partitioned table entity = CRITICAL (TypeORM auto-sync can drop partitions).
- Default partition silently absorbing misrouted rows that should have raised an error = HIGH (masks a missing partition bug that will eventually explode on ATTACH).
- Missing future-partition creation job = CRITICAL (INSERT failures at month boundary = outage).
- Cross-partition UPDATE breaking trigger semantics = MEDIUM (audit triggers may fire twice or miss an event).
- Missing tenant_id in WHERE on LIST-by-tenant shared table = CRITICAL (cross-tenant scan, planner may visit foreign-tenant partitions).

## Performance Concerns
- Query on partitioned table without partition-key predicate = HIGH (no pruning, full scan across all partitions).
- Stale statistics on a partition = MEDIUM (bad plan choices — autovacuum must run).
- Attach with overlapping default partition causing full table scan = HIGH during attach.
- Too many leaf partitions (>1000) = HIGH — catalog bloat, planner overhead, slow DDL.
- Missing index on newly-attached partition (because parent index was created before the partition existed) = HIGH — silent performance cliff.
- Cross-partition UPDATE causing DELETE + INSERT duplication in write path = MEDIUM (higher WAL volume, more bloat).

## Architectural Implications for database-reviewer

- Every partitioned table MUST have its composite PK including all partition key columns. Any `@PrimaryGeneratedColumn('uuid') id` on a partitioned entity without also `@PrimaryColumn() createdAt` = CRITICAL.
- Every entity mapped to a partitioned table MUST have `synchronize: false`. Missing = CRITICAL.
- Every partitioned table MUST have a scheduled future-partition creation job (pg_partman, Temporal, or cron). Missing = CRITICAL for monthly-partitioned tables.
- Every partitioned table query must be reviewed for partition-key predicate presence. Missing predicate on a month-scoped table = HIGH.
- RANGE bounds are half-open; reviewers should spot-check that month boundaries are correctly `FROM '2026-01-01' TO '2026-02-01'` (not `TO '2026-01-31'`).
- Default partition should be avoided for new partitioned tables — missing-partition bugs should fail loudly, not silently accumulate.
- Cross-partition UPDATE paths should be reviewed for trigger double-fire and duplicate audit events.
- TypeORM entity changes on partitioned tables must be reviewed against migration raw SQL — entity drift is silent here.

## Domain Rule Additions for database-reviewer

Add to `## Domain Rules → Partitioned Tables & Hypertables (Critical)`:

- Composite PK on partitioned tables MUST include all partition key columns. Missing partition key in PK = CRITICAL (PostgreSQL refuses).
- Unique constraints on partitioned tables MUST include all partition key columns. Naive `UNIQUE (email)` on LIST-by-tenant table = CRITICAL.
- `synchronize: false` MUST be set on every entity mapped to a partitioned table. `synchronize: true` = CRITICAL (schema corruption).
- Every RANGE-by-time partitioned table MUST have a scheduled future-partition creation job (pg_partman, Temporal, cron). Missing = CRITICAL (month-boundary outage).
- Queries on partitioned tables MUST include a partition-key predicate to enable pruning. Missing = HIGH (full scan across all partitions).
- Default partition on new partitioned tables SHOULD be avoided — prefer fail-loud on missing partition.
- RANGE bounds are half-open: `FROM 'YYYY-MM-01' TO '(YYYY-MM+1)-01'`. Off-by-one inclusive bound = HIGH.
- Cross-partition UPDATE (partition-key mutation) = MEDIUM — review trigger fire semantics.
- Leaf partition count > 1000 = HIGH — catalog bloat, plan overhead. Reconsider partition scheme.
- Entity composite PK drift vs migration DDL on partitioned tables = HIGH (silent until migration fails in production).
- TimescaleDB hypertables follow the same rule set: composite PK must include time, queries must include time-range, `synchronize: false` always.
