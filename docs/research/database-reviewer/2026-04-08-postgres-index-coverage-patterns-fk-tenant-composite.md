# Research: PostgreSQL Index Coverage — Foreign Keys, Tenant Composites, Partial & Covering Indexes

**Topic:** Enterprise index coverage rules for multi-tenant PostgreSQL schemas — mandatory FK indexing, tenant-prefix composite indexes, partial indexes, covering indexes with INCLUDE, and when to add vs remove an index.
**Date:** 2026-04-08
**Agent:** database-reviewer

## Sources
- [PostgreSQL: Documentation 15 — Indexes](https://www.postgresql.org/docs/15/indexes.html)
- [PostgreSQL: Documentation 15 — Multicolumn Indexes](https://www.postgresql.org/docs/15/indexes-multicolumn.html)
- [PostgreSQL: Documentation 15 — Partial Indexes](https://www.postgresql.org/docs/15/indexes-partial.html)
- [PostgreSQL: Documentation 15 — Index-Only Scans and Covering Indexes](https://www.postgresql.org/docs/15/indexes-index-only-scans.html)
- [PostgreSQL: Documentation 15 — CREATE INDEX](https://www.postgresql.org/docs/15/sql-createindex.html)
- [PostgreSQL Wiki: Unindexed Foreign Keys](https://wiki.postgresql.org/wiki/Unindexed_foreign_keys)
- [PostgreSQL Wiki: Index Maintenance](https://wiki.postgresql.org/wiki/Index_Maintenance)
- [Cybertec: Index Your Foreign Key (Foreign Key Indexing and Performance)](https://www.cybertec-postgresql.com/en/index-your-foreign-key/)
- [Cybertec: PostgreSQL Indexes and Foreign Keys](https://www.cybertec-postgresql.com/en/postgresql-indexes-and-foreign-keys/)
- [Percona: Should I Create an Index on Foreign Keys in PostgreSQL?](https://www.percona.com/blog/should-i-create-an-index-on-foreign-keys-in-postgresql/)
- [use-the-index-luke: Partial and Filtered Indexes](https://use-the-index-luke.com/sql/where-clause/partial-and-filtered-indexes)
- [use-the-index-luke: Concatenated Indexes](https://use-the-index-luke.com/sql/where-clause/the-equals-operator/concatenated-keys)

## Key Findings

1. **PostgreSQL does NOT auto-index foreign keys.** The referenced (parent) side's primary key is already indexed. The referencing (child) side — the column holding the FK — is NOT indexed automatically. This is the single most common missing-index bug in PostgreSQL schemas.
2. **Unindexed FK consequences are severe on the DELETE path.** When a row in the parent table is deleted or its primary key is updated, PostgreSQL must scan the referencing table to check for dependent rows. Without an index, this is a sequential scan. A single `DELETE` against a parent table with a million-row child table = multi-second lock on the child + cascade chains. Under concurrent load, this becomes a lock pile-up that manifests as "the DELETE is stuck" in production.
3. **Unindexed FK also hurts JOIN performance.** Any `SELECT ... JOIN child ON child.parent_id = parent.id WHERE ...` without an index on `child.parent_id` degenerates to a nested loop with a sequential scan per row.
4. **The leading column of a multicolumn B-tree index matters.** A B-tree `INDEX (a, b, c)` can efficiently serve queries filtering on `a`, on `a AND b`, on `a AND b AND c`, but NOT `b` alone or `c` alone. This rule governs how multi-tenant composite indexes must be designed.
5. **Tenant composite rule: `tenantId` should be the leading column** of multi-tenant index shapes in a shared-schema (pool) model, but NOT in a schema-per-tenant model. In schema-per-tenant (aqua-saas `tenant_{16hex}`), every query is already scoped by `search_path` to one schema; `tenantId` is a degenerate constant and indexing on it is pure overhead. Index on the domain key instead (e.g., `sensorId`, `batchId`).
6. **`sensor_metrics` (hypertable) is the exception** — it lives in a shared schema and must be indexed with `(time DESC, tenant_id, sensor_id)` or similar. Time-first because TimescaleDB chunks on time, then tenant/domain for in-chunk pruning.
7. **Partial indexes are a force multiplier for small hot subsets.** `CREATE INDEX ON orders(order_nr) WHERE billed = false` keeps the index tiny (only unbilled rows), which is dramatically faster than a full index when the queries only target the subset. Use for `is_active = true`, `is_deleted = false`, `status IN ('pending','in_progress')`, soft-delete filters, and any other high-selectivity predicate.
8. **Partial indexes enable uniqueness with soft deletes.** `CREATE UNIQUE INDEX ON users(email) WHERE deleted_at IS NULL` enforces email uniqueness across non-deleted rows while allowing the same email to be recycled after a user is soft-deleted. Without the partial predicate, soft-deleted rows block re-signup and force hard deletes.
9. **Covering indexes via `INCLUDE` enable index-only scans.** `CREATE INDEX ON orders(customer_id) INCLUDE (total, status)` stores `total` and `status` in the leaf pages without making them part of the search key. Queries that filter on `customer_id` and return only `customer_id, total, status` can be answered entirely from the index, skipping the heap — an index-only scan. This is a major win on wide tables.
10. **Covering index non-key columns** (the `INCLUDE` list) do NOT participate in uniqueness checks, do NOT have to be comparable types, and do NOT expand the sort order. They are pure payload.
11. **Index-only scan requires visibility map cooperation.** The visibility map must indicate the heap page is all-visible, otherwise PostgreSQL must visit the heap anyway. Vacuum maintains the visibility map — tables with heavy churn and infrequent autovacuum may see index-only scan fall back to regular index scan.
12. **Too many indexes is also a bug.** Every index slows INSERT / UPDATE / DELETE. Every index consumes space and cache. Every index adds autovacuum work. Single-column indexes that are strict subsets of a composite (`INDEX (a)` when `INDEX (a, b)` exists) are redundant and should be dropped.
13. **`pg_stat_user_indexes.idx_scan = 0`** over a month of production traffic is a strong drop-candidate signal. Indexes that are never used consume write overhead with zero read benefit.
14. **Partitioned tables require local indexes on each partition.** A `CREATE INDEX` on the parent partitioned table creates child indexes on every existing partition. New partitions created later must be attached with indexes to participate in index scans. Missing index on a newly-created monthly partition = silent performance cliff at month boundary.
15. **Composite PK on partitioned table MUST include the partition key.** PostgreSQL enforces: "the constraint's columns must include all of the partition key columns." This also applies to unique constraints. For `messages` partitioned by month on `created_at`, the PK must be `(id, created_at)` not just `(id)`.
16. **FK from partitioned table to partitioned table** is limited prior to PostgreSQL 12 and still has sharp edges around detach. Prefer application-level integrity checks or keep the partitioned → non-partitioned direction.

## Security Concerns
- Missing `tenant_id` composite index on hypertables like `sensor_metrics` = HIGH (enables cross-tenant fishing via timing attacks on slow unindexed queries).
- Unique index on email without a partial `WHERE deleted_at IS NULL` predicate on tables that also support soft delete = MEDIUM (user-recycling breaks, workarounds hard-delete PII prematurely).
- Covering index with sensitive `INCLUDE` columns (e.g., encrypted ciphertext) = LOW but worth noting — the ciphertext lives in more places.

## Performance Concerns
- Unindexed FK on a parent table used in cascade delete = CRITICAL for DELETE latency, HIGH for JOIN latency.
- Missing composite index on `sensor_metrics(time, tenant_id, sensor_id)` = HIGH — dashboard queries fall back to full chunk scans.
- Missing partial index on `is_active = true` or `status = 'pending'` for a workqueue table = HIGH when the subset is <5% of the table and the table is large.
- Redundant single-column index where a multi-column composite already exists = MEDIUM (write amplification, cache pollution).
- `pg_stat_user_indexes.idx_scan = 0` for a month = MEDIUM drop candidate (confirm it is not only used on a monthly / quarterly job before dropping).
- New monthly partition created without its sibling indexes = HIGH (silent performance degradation on the new partition).
- Covering index falling back to heap scan due to unvacuumed visibility map = MEDIUM (tune autovacuum aggressiveness on the table).

## Architectural Implications for database-reviewer

- Every migration that adds a `REFERENCES` clause MUST also add an index on the referencing column, unless that column is already the leading column of another index. The check is: grep every new FK, confirm a corresponding `CREATE INDEX`.
- Multi-tenant index design depends on the isolation model:
  - Schema-per-tenant (aqua-saas default): `tenant_id` index is degenerate — index on domain keys only.
  - Shared-schema tables (`sensor_metrics`, `messages` partitioned): `tenant_id` MUST be in the composite, typically after the time key.
- Covering indexes (`INCLUDE`) should be recommended when a frequent query returns 2-4 additional columns after filtering — the read win outweighs the write cost.
- Partial indexes should be recommended for soft-delete filters and hot-subset workqueues. The reviewer should also flag unique constraints that ignore soft delete (need `WHERE deleted_at IS NULL`).
- Index bloat patterns: single-column indexes shadowing composite indexes should be flagged for removal with a recommendation to `data-expert`.
- Partitioned table review: every monthly / quarterly partition creation migration must include index DDL (or attach). Missing = HIGH.

## Domain Rule Additions for database-reviewer

Add to `## Domain Rules → Index Coverage (Critical)`:

- Every foreign key REFERENCING column MUST have an index where it is the leading column (or be the first column of a covering composite). Missing FK index on any table >1K rows = HIGH; on any table >1M rows or parent of cascade delete = CRITICAL.
- In schema-per-tenant models (`tenant_{16hex}` isolation), DO NOT add `tenant_id`-leading composite indexes — they are degenerate constants under `search_path` scoping. Index on the domain key only.
- In shared-schema tables (hypertables like `sensor_metrics`, partitioned `messages`, `message_receipts`, `compliance_audit_log`), `tenant_id` MUST participate in the composite index. Missing `(time, tenant_id, ...)` on `sensor_metrics` = HIGH.
- Unique constraints on tables with soft delete MUST be partial: `UNIQUE (col) WHERE deleted_at IS NULL`. Full unique that collides with soft-deleted rows = MEDIUM (blocks re-signup) or HIGH (forces hard delete of PII).
- Hot-subset workqueues (status = 'pending', is_active = true) SHOULD use partial indexes. Full index on a skewed column = MEDIUM.
- Covering indexes with `INCLUDE (col1, col2)` SHOULD be recommended when the query pattern is filter-then-project without sorting / joining on the included columns. No `INCLUDE` = LOW but worth an optimization recommendation.
- Redundant single-column indexes shadowed by a multi-column composite = MEDIUM drop candidate.
- Partitioned table composite PK / unique constraint MUST include the partition key column. Missing partition key from PK = CRITICAL (PostgreSQL will refuse, but TypeORM entity drift may hide it until migration time).
- New monthly partition DDL MUST include sibling indexes (directly or via `CREATE INDEX ON parent`). Missing = HIGH (silent month-boundary performance cliff).
