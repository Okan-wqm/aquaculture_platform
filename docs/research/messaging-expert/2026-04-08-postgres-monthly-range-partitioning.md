# Research: PostgreSQL Monthly RANGE Partitioning for Messaging Tables

**Topic:** Monthly RANGE partition strategy, partition key discipline, PartitionManagerService proactive creation, composite PK/FK, TypeORM synchronize:false discipline
**Date:** 2026-04-08
**Agent:** messaging-expert

## Sources

- [PostgreSQL 15 — 5.12. Table Partitioning (postgresql.org)](https://www.postgresql.org/docs/15/ddl-partitioning.html)
- [PostgreSQL Insider — Partitioning Types (Fujitsu/postgresql.fastware.com)](https://www.postgresql.fastware.com/postgresql-insider-prt-ove)
- [pg_partman — PostgreSQL Partition Manager (pgpartman/pg_partman)](https://github.com/pgpartman/pg_partman)
- [Managing PostgreSQL partitions with pg_partman — Amazon RDS User Guide](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL_Partitions.html)
- [Partitioning with Native Postgres and pg_partman — Crunchy Data](https://www.crunchydata.com/blog/native-partitioning-with-postgres)
- [Automatic partition creation in PostgreSQL — Cybertec](https://www.cybertec-postgresql.com/en/automatic-partition-creation-in-postgresql/)

## Key Findings

### 1. Partition key discipline (`createdAt`, `receipt_created_at`)
- For monthly RANGE partitioning, the partition key MUST be a timestamp/date column whose value is immutable once set and monotonically correlated with insert time.
- Range bounds are **inclusive at the lower end, exclusive at the upper end**. Adjacent monthly partitions share a boundary date that belongs to the later partition.
- For `messages`: `PARTITION BY RANGE (created_at)`. For `message_receipts`: `PARTITION BY RANGE (receipt_created_at)`. For `compliance_audit_log`: `PARTITION BY RANGE (created_at)`.
- **Hard rule:** the partition-key column must NEVER be UPDATEd. A row whose `created_at` changes would need to migrate partitions, which PostgreSQL permits but at a heavy cost (row DELETE + INSERT across partitions, breaking FK references).

### 2. Composite primary keys and foreign keys
From PostgreSQL 15 docs verbatim: *"to create a unique or primary key constraint on a partitioned table, the partition keys must not include any expressions or function calls and the constraint's columns must include all of the partition key columns."*
- `messages` PK MUST be `(id, created_at)`, not `(id)` alone.
- `message_receipts` PK MUST include `receipt_created_at`.
- A FK from any other table that points to `messages(id)` MUST reference the full composite: `FOREIGN KEY (message_id, message_created_at) REFERENCES messages(id, created_at)`.
- This cascades into child tables: `message_attachments`, `message_reactions`, `pinned_messages`, `message_analysis` all need a `message_created_at` duplicate column plumbed through writes.
- **Rationale:** PostgreSQL cannot enforce a cross-partition unique constraint without a global index, and global indexes on partitioned tables are not supported. Every unique/PK constraint must be enforceable within a single partition.

### 3. Partition pruning requirements
- Every read query on `messages`, `message_receipts`, `compliance_audit_log` MUST include a filter on the partition key column in the WHERE clause (e.g., `WHERE created_at >= $1 AND created_at < $2`). Without such a filter, PostgreSQL scans every partition.
- **Pruning is constraint-driven, not index-driven.** Defining an index on `created_at` does NOT enable pruning; partition bounds do. The WHERE clause must use comparison operators (`>=`, `<`, `BETWEEN`) on the partition key directly — not on an expression like `DATE_TRUNC('month', created_at)`.
- `SET enable_partition_pruning = on` is the default but must not be disabled in `postgresql.conf`.
- Runtime (execution-phase) pruning happens for parameterized queries; check via `EXPLAIN ANALYZE` for `Subplans Removed` or `loops=0` on never-touched partitions.

### 4. PartitionManagerService — proactive creation
- The cost of not pre-creating: inserts into a date range with no matching partition either fail (without DEFAULT partition) or land in a catch-all (with DEFAULT) that becomes a performance liability.
- Production pattern: create current month + next 2-3 months proactively via a cron job running daily (or on app startup).
- Two-phase creation (from Postgres docs) reduces lock contention:
  1. `CREATE TABLE messages_2026m05 (LIKE messages INCLUDING DEFAULTS INCLUDING CONSTRAINTS);`
  2. `ALTER TABLE messages_2026m05 ADD CONSTRAINT y2026m05 CHECK (created_at >= '2026-05-01' AND created_at < '2026-06-01');`
  3. `ALTER TABLE messages ATTACH PARTITION messages_2026m05 FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');`
- `ATTACH PARTITION` requires only `SHARE UPDATE EXCLUSIVE` lock (vs. `ACCESS EXCLUSIVE` for `CREATE TABLE ... PARTITION OF`), so zero-downtime attach is possible.
- pg_partman is the canonical reference implementation; a custom `PartitionManagerService` should mirror its guarantees: idempotent creation, retention (DROP old partitions), metrics, and a notion of "premake count" (number of future partitions to keep ready).

### 5. TypeORM `synchronize: false` (mandatory)
- TypeORM's schema sync has no knowledge of partition clauses. If `synchronize: true` runs against a partitioned table, TypeORM will attempt to `DROP` or re-`CREATE` the table using its own DDL — destroying all partitions.
- **Rule:** every entity decorated at a partitioned table must be backed by a DataSource whose config has `synchronize: false`. Schema changes happen through explicit migrations that emit partition-aware DDL.
- Migrations on partitioned tables themselves need care: `ALTER TABLE messages ADD COLUMN foo ...` propagates to all partitions (inherited constraint rule), but CREATE INDEX on parent requires ATTACH on each child index (`CREATE INDEX CONCURRENTLY` is NOT supported on partitioned tables in older versions; use per-partition `CREATE INDEX CONCURRENTLY` then `ALTER INDEX ... ATTACH PARTITION`).

### 6. Inherited constraints
- CHECK and NOT NULL constraints defined on the parent partitioned table are **always** inherited by all partitions.
- Cannot drop NOT NULL on a partition if it exists on the parent.
- Column additions/drops must occur at the parent level; partitions inherit automatically.

### 7. Limitations to be aware of
- Exclusion constraints cannot span the entire partitioned table — they must be per-partition.
- `TRUNCATE ONLY messages` always errors on a partitioned parent.
- Partition columns must match the parent exactly; you cannot add columns to a single partition.
- BEFORE ROW INSERT triggers cannot change the destination partition of a tuple.

## Security Concerns

- **Missing partition key filter = full-tenant scan.** If a query forgets to include `created_at` in the WHERE clause, PostgreSQL scans every partition for every tenant — worst-case this is indistinguishable from a tenant-isolation breach at the query-cost level (and may reveal tenant data cross-partition via errors or timing).
- **Composite FK omission** can allow an orphan `message_attachments` row to point at a nonexistent `messages.id` in a different partition — data integrity hole that violates multi-tenant isolation guarantees.
- **Partition-drop as GDPR cleanup is unsafe without legal-hold check.** A nightly cron that DROPs a stale monthly partition must still check that no row in that partition is under active legal hold.
- **DEFAULT partition as silent bucket:** if the service accepts `created_at` values outside the pre-created range (e.g., clock skew, client-supplied timestamps), they land in DEFAULT. DEFAULT partition rows are not subject to the same pruning optimizations and can leak across time ranges. Reject client-supplied `created_at`; always use server time.

## Performance Concerns

- **Planning-time explosion:** too many partitions (e.g., daily partitions over 10 years = 3650 children) dramatically slow query planning. Monthly is a sensible middle ground for messaging data.
- **Partition pruning only at plan time OR execution time:** prepared statements and parameterized queries may not prune at plan time. Check `EXPLAIN (ANALYZE, BUFFERS)` on live traffic.
- **Index-build on large partitions** requires `CREATE INDEX` per-partition with `CONCURRENTLY` to avoid blocking. Parent-level CREATE INDEX (non-concurrent) takes an ACCESS EXCLUSIVE lock across the tree.
- **Vacuum per partition:** each partition is its own table with its own autovacuum stats. Autovacuum settings inherited from parent but can be tuned per-partition for hot months.
- **Partition elimination window during ATTACH:** ATTACH scans the attaching table to validate CHECK constraint unless CHECK was defined before ATTACH. Always define the CHECK up front.
- **Cross-partition joins** (a query spanning 12 months of messages) multiply index lookups by partition count. Queries over long ranges should use covering indexes per partition or be restructured.

## Architectural Implications for messaging-expert reviews

When reviewing messaging-service code and migrations, verify:

1. **TypeORM DataSource `synchronize: false`** for any service that touches `messages`, `message_receipts`, `compliance_audit_log`. `synchronize: true` -> CRITICAL.
2. **Entity `@PrimaryColumn` includes the partition key column.** Missing `created_at` in PK -> CRITICAL.
3. **Foreign keys from child tables use composite `(message_id, message_created_at)`.** Single-column FK -> CRITICAL.
4. **All repository queries on partitioned tables include a `createdAt` filter.** Missing -> HIGH (performance and cost). If the query has no time bound it must be explicitly justified.
5. **Raw SQL uses direct `>= AND <` on partition key**, not `DATE_TRUNC` or other expressions — expressions defeat pruning. HIGH.
6. **PartitionManagerService exists, runs on a schedule, creates at least N+2 months ahead, and has a metric for partition coverage.** Missing -> HIGH (will eventually cause inserts to fail).
7. **Retention sweeper DROPs old partitions (not DELETEs rows)** when a tenant's retention policy allows — DROP PARTITION is O(1), DELETE is O(n). Using DELETE where DROP is viable -> MEDIUM.
8. **Partition-drop MUST check legal hold state first** — bypassing legal hold is CRITICAL.
9. **Client-supplied `createdAt` rejected; server-assigned only.** Accepting client timestamp -> HIGH.
10. **Migrations use per-partition `CREATE INDEX CONCURRENTLY` + `ATTACH`** to avoid downtime. Parent-level blocking index -> HIGH.

## Domain Rule Additions for messaging-expert

- Primary keys on `messages`, `message_receipts`, `compliance_audit_log` MUST be composite including the partition key column (`created_at` / `receipt_created_at`).
- Foreign keys pointing INTO partitioned tables MUST reference the full composite PK. Child tables (`message_attachments`, `message_reactions`, `message_analysis`, `pinned_messages`) MUST carry a denormalized `message_created_at` column.
- All repository queries on partitioned tables MUST include an explicit WHERE bound on the partition key; bare `WHERE id = ?` lookups without time bound are forbidden.
- Partition-key WHERE clauses MUST use direct comparison operators (`>=`, `<`, `BETWEEN`) — never `DATE_TRUNC()` or other expressions that defeat pruning.
- `PartitionManagerService` MUST proactively create current month + next 3 months and expose a Prometheus gauge (`partition_coverage_months`) alerting if coverage < 2 months.
- Partition retention cleanup MUST DROP whole partitions (not DELETE rows) when compliant with retention policy AND AFTER legal-hold check.
- TypeORM `synchronize: false` is mandatory on every DataSource that touches a partitioned table; all DDL changes go through explicit migrations.
- Server MUST reject client-supplied `createdAt`; use `now()` at the DB level or `new Date()` at the service layer.
- DEFAULT partition MUST NOT be created for `messages` — missing coverage should fail loudly, not silently land in DEFAULT.
