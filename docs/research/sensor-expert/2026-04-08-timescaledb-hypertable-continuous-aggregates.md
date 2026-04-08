# Research: TimescaleDB Hypertable + Continuous Aggregates (Production)

**Topic:** How to run TimescaleDB hypertables and continuous aggregates in a multi-tenant sensor telemetry workload.
**Date:** 2026-04-08
**Agent:** sensor-expert

## Sources
- [Tiger Data: About continuous aggregates](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/about-continuous-aggregates)
- [Tiger Data: Create a continuous aggregate](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/create-a-continuous-aggregate)
- [Real-Time Analytics for Time Series — Tiger Data](https://www.tigerdata.com/blog/real-time-analytics-for-time-series-continuous-aggregates)
- [Cloudflare: Scaling analytics with TimescaleDB](https://blog.cloudflare.com/timescaledb-art/)
- [TimescaleDB Guide — TechPrescient](https://www.techprescient.com/blogs/timescaledb/)

## Key Findings

1. **Partition pruning is mandatory.** Every query on a hypertable MUST include a time-range filter (`WHERE time >= X AND time < Y`) to enable chunk pruning. Missing time filter on `sensor_metrics` = CRITICAL performance violation — the query scans every chunk across the entire retention window.
2. **Continuous aggregates** are the correct pattern for dashboard queries. They materialize aggregated data in the background and are refreshed incrementally. Never run raw `SELECT … GROUP BY time_bucket()` on a production hypertable for dashboard loads.
3. **Chunk time interval** must be tuned to the workload. Default is 1 week. For high-cardinality sensor data, smaller intervals (1 day) improve query pruning but inflate catalog; larger intervals reduce catalog but slow point-lookup queries. Benchmark.
4. **Composite indexes** on `(time, tenantId, sensorId)` are the correct shape. TimescaleDB auto-creates the time index but NOT the tenant index — add it explicitly.
5. **Compression** enabled after 7+ days dramatically reduces storage (10-20x) but queries spanning the compression boundary must handle both compressed and uncompressed chunks. Aggregation functions are accelerated on compressed chunks; arbitrary WHERE filters may be slower.
6. **Real-time aggregation** combines pre-computed aggregate + raw unaggregated data to give up-to-the-second results. Enable when dashboards require freshness.
7. **Retention policies** must be configured explicitly. Unbounded retention on high-throughput sensor data exhausts disk within weeks.
8. **`timescaledb.invalidate_using = 'wal'`** (v2.22+) is the recommended invalidation mechanism for continuous aggregates — reduces overhead versus trigger-based invalidation.
9. **Parameterized queries mandatory.** String interpolation in raw SQL on `sensor_metrics` = CRITICAL security violation (SQL injection into a tenant-shared table).
10. **`synchronize: false`** for hypertables — TypeORM MUST NOT own hypertable schema. All schema changes via migrations only.

## Security Concerns
- Raw SQL with string interpolation on `sensor_metrics` = CRITICAL (injection).
- Missing tenant filter (relying on `search_path` alone on a hypertable in a shared schema) = CRITICAL.
- Missing retention policy causing disk exhaustion = HIGH (availability).
- Compressed chunks may retain PII if compression happened before an anonymization event — check anonymization workflow against compression policy.

## Performance Concerns
- Missing time-range filter = CRITICAL (full scan).
- Missing composite index on `(time, tenantId, sensorId)` = HIGH.
- Dashboard queries hitting raw hypertable instead of continuous aggregate = HIGH.
- Continuous aggregate refresh policy too aggressive = HIGH (background load); too lazy = dashboard staleness.
- Over-compression: compressing chunks that are still being written = CRITICAL (write failures).
- N+1 at ingestion (per-reading INSERT vs batch COPY) = HIGH.

## Architectural Implications for sensor-expert reviews
- Every query handler touching `sensor_metrics` MUST include a time-range filter; reviewed via AST walk or grep of raw SQL.
- Dashboard resolvers MUST query the continuous aggregate, not the raw table.
- Ingestion paths MUST batch INSERTs (parameterized, multi-row) — single-row INSERT per reading on the hot path = HIGH.
- Retention, compression, and continuous aggregate refresh policies must exist and have monitoring on lag.

## Domain Rule Additions for sensor-expert

Add to `## Domain Rules → TimescaleDB & Time-Series Data (Critical)`:
- Continuous aggregate refresh lag MUST be monitored. Stale continuous aggregate > 2x expected interval = MEDIUM; > 10x = HIGH (dashboards showing misleading data).
- `timescaledb.invalidate_using = 'wal'` (v2.22+) SHOULD be enabled for continuous aggregate performance. Trigger-based invalidation on high-throughput workloads = MEDIUM performance concern.
- Composite index `(time, tenantId, sensorId)` on `sensor_metrics` is mandatory in addition to the auto-created time index. Missing tenant index = HIGH.
- Retention policy MUST be configured on `sensor_metrics`; unbounded retention = HIGH (inevitable disk exhaustion).
- Compression policy MUST leave a buffer (typically 7+ days) after the write window closes. Compressing actively-written chunks = CRITICAL (write failures).
- Ingestion MUST use batched multi-row INSERT or COPY; per-reading single-row INSERT on the hot path = HIGH.
