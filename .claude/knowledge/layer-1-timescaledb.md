# Layer-1 TimescaleDB — Time-series storage patterns

**Audience:** sensor-expert, data-expert, database-reviewer, observability-expert, any agent reviewing high-volume time-series paths (sensor metrics, audit trails, event store, cost telemetry).
**Anchor:** `timescale/timescaledb:2.17.2-pg16` (Docker image pinned 2026-04-05 in `docker-compose.prod.yml:L-tag`, `docker-compose.infra.yml`, `docker-compose.yml`), as of 2026-04-17.

Depends on: `layer-1-typeorm.md` (TypeORM 0.3.27 migration runner, schema-per-tenant). Applies to: `apps/sensor-service/` (primary), `libs/backend-common/src/database/schema-manager.service.ts` (cross-tenant hypertable bootstrap).

## Hypertables

- **What they are** — a PostgreSQL table transparently partitioned into per-time-range *chunks* by TimescaleDB. Reads route to the matching chunks; writes append to the newest chunk.
- **Canonical creation** — `SELECT create_hypertable('<table>', '<time_column>', chunk_time_interval => INTERVAL '<window>', if_not_exists => TRUE)`. Always pair with `if_not_exists => TRUE` so migrations are idempotent under re-run (the migration runner does not tolerate duplicate-hypertable errors).
- **`chunk_time_interval` choice** — aim for ~25M rows / chunk at steady state; too-narrow produces chunk-count bloat (catalog pressure) and too-wide defeats chunk pruning. Sensor metrics uses 1-day default; high-cardinality tenants may override via `ALTER TABLE ... SET (chunk_time_interval = ...)`.
- **Dimensions** — `add_dimension('<table>', '<column>', number_partitions => N)` adds a second partitioning key (e.g., `tenant_id` hash-partition) for further parallelism. Our deployment does NOT space-partition — schema-per-tenant already isolates by schema, so adding a tenant-hash dimension would double the chunk count without winning parallelism.
- **Primary key rule** — a hypertable's PK must include the partitioning (time) column. Composite PK `(time, id)` is the idiomatic shape; a `UUID` surrogate alone breaks the partition invariant.

## Continuous aggregates

- **What they are** — TimescaleDB-native materialized views with incremental refresh. Cheaper than hand-rolled materialized views because only the changed chunks are recomputed.
- **Cascading tiers** — sensor-service ships a 3-tier cascade: `metrics_1min` reads `sensor_metrics`; `metrics_1hour` reads `metrics_1min`; `metrics_1day` reads `metrics_1hour`. Each tier halves+ the row count, keeping dashboard queries cheap at any window (last-hour → raw; last-day → 1min; last-month → 1hour; historical → 1day).
- **Pooled stddev formula** — cascading continuous aggregates CANNOT simply `AVG(stddev_value)` at the higher tier; that under-reports variance. The correct pooled formula is `SQRT( GREATEST( SUM(n_i * (σ_i² + μ_i²)) / SUM(n_i) - (SUM(n_i * μ_i) / SUM(n_i))², 0 ) )`. See `apps/sensor-service/src/database/migrations/1735900001000-CreateContinuousAggregates.ts:123`.
- **`materialized_only = false`** — set via `ALTER MATERIALIZED VIEW ... SET (timescaledb.materialized_only = false)`. Enables real-time query pass-through so the *open* (un-materialized) bucket is included in reads. Without this flag, the most recent bucket appears empty until the next refresh job runs — MEDIUM-007 dashboard-lag regression.
- **Refresh policy** — `SELECT add_continuous_aggregate_policy('<cagg>', start_offset => INTERVAL '3<unit>', end_offset => INTERVAL '1<unit>', schedule_interval => INTERVAL '1<unit>')`. `start_offset` MUST cover `duplicate_window`-style lateness plus write-delay; `end_offset` excludes the currently-open bucket so refresh is deterministic.

## Compression

- **`add_compression_policy('<table>', INTERVAL '<age>', if_not_exists => TRUE)`** — compresses chunks older than `<age>`. Sensor metrics compresses after 7 days (`1735900000000-CreateSensorMetrics.ts`).
- **Segmentby / orderby** — `ALTER TABLE <table> SET (timescaledb.compress, timescaledb.compress_segmentby = '<cols>', timescaledb.compress_orderby = '<col> DESC')`. `segmentby` = high-cardinality grouping (`sensor_id` typically); `orderby = time DESC` maximizes run-length encoding.
- **Compressed-chunk write semantics** — writes to compressed chunks trigger decompression under the hood (TimescaleDB 2.11+). Bulk backfill over old windows is still expensive; prefer explicit `decompress_chunk` → INSERT → `compress_chunk` for large historical imports.

## Retention

- **`add_retention_policy('<table>', INTERVAL '<age>', if_not_exists => TRUE)`** — drops chunks older than `<age>`. Sensor metrics retains raw for 90 days; `metrics_1min` for 1 year; `metrics_1hour` for 5 years; `metrics_1day` kept forever (no policy).
- **Retention + compliance** — GDPR 17 tenant deletion cascades through tenant schemas; hypertables in the `<tenant>` schema are dropped with the schema, no per-row cascade needed. For shared hypertables (audit_logs if ever moved to TimescaleDB), retention policies MUST NOT be the deletion mechanism — GDPR requires deterministic, auditable DELETE paths. Retention is bulk-aging only.

## Chunk pruning + query patterns

- **`WHERE time > now() - INTERVAL '<x>'`** — the planner prunes to the matching chunks. Always express time predicates as literal intervals, not computed columns. `WHERE date_trunc('hour', time) = ...` defeats pruning.
- **`SET timescaledb.enable_chunk_append = on` + `enable_parallel_chunk_append = on`** — default on for PG16 + TimescaleDB 2.17. If query plans show sequential chunk scans instead of parallel, check `max_parallel_workers` and chunk count (too-few chunks → not worth parallelism).
- **`current_readings` view pattern** — `SELECT DISTINCT ON (sensor_id, channel_id) ... ORDER BY sensor_id, channel_id, time DESC`. Returns the single latest row per sensor. Non-hypertable view wrapping a hypertable; cheap under index `(sensor_id, channel_id, time DESC)` but NOT a materialized view — the latest row may be on the currently-open chunk, so we must compute at query time.

## Schema-per-tenant interaction

- Hypertables are created PER-tenant-schema via `SchemaManagerService` (`libs/backend-common/src/database/schema-manager.service.ts`). Each tenant schema owns its own `sensor_metrics` hypertable, its own continuous aggregates, its own retention.
- **MODULE_SCHEMAS maintenance contract** — when a service gains a new hypertable, the table name MUST be added to the relevant `MODULE_SCHEMAS[].tables` entry before the entity deploys. Omission = the next tenant provisioning misses the table; the entity crashes on first insert.
- Continuous-aggregate migrations guard with `checkTimescaleDB(queryRunner)` — the `timescaledb` extension is optional in dev/CI (tests run on pure PG sometimes). Absence is a warn-and-skip, never a hard fail.

## Gotchas

- **`integer_now_func`** — required when the partition column is `BIGINT` instead of `TIMESTAMPTZ`. Our schema uses `TIMESTAMPTZ` universally; no `integer_now_func` is registered anywhere.
- **`drop_chunks()` vs retention policy** — manual `drop_chunks('<table>', older_than => INTERVAL '<x>')` bypasses the policy machinery; do NOT mix manual drops with retention-managed tables in the same window — the policy's telemetry (`timescaledb_information.jobs`) drifts.
- **Foreign keys TO a hypertable** — prohibited by TimescaleDB. Events referencing sensor metrics must denormalize or use a non-FK `sensor_id` column with application-enforced integrity.
- **Migrations cannot run inside a TimescaleDB-instrumented transaction if they issue `create_hypertable` + DDL in the same txn**; TimescaleDB ≥ 2.9 has fewer restrictions but the migration runner splits these into separate `queryRunner.query` calls to stay safe.

## References

- `apps/sensor-service/src/database/migrations/1735900000000-CreateSensorMetrics.ts` — canonical hypertable + retention + compression example
- `apps/sensor-service/src/database/migrations/1735900001000-CreateContinuousAggregates.ts` — 3-tier cascade + pooled-stddev + `materialized_only=false`
- `apps/sensor-service/src/database/migrations/1736200000000-CreateReadingsAggregates.ts` — readings 15min/1hour/1day alternate cascade
- `apps/sensor-service/src/timescale/retention-policy.service.ts` — runtime retention management
- `libs/backend-common/src/database/schema-manager.service.ts` — per-tenant hypertable provisioning
- ADR-011 (schema ownership), ADR-012 (schema drift prevention)
