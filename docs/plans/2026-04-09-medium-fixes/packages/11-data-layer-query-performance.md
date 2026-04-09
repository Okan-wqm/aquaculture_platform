# Package 11: data-layer-query-performance

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [DATA-MEDIUM-013, DATA-MEDIUM-015, DATA-MEDIUM-017, DATA-MEDIUM-018, DATA-MEDIUM-021, DATA-MEDIUM-022, DATA-MEDIUM-023, DATA-MEDIUM-024]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/data-expert/2026-04-05-s2-high-findings.md

## Context
Eight data-layer findings cover query performance, missing indexes, unoptimized aggregation queries, and pagination issues. They span multiple services but share the common theme of database query optimization. Grouped because they are independent point fixes that do not affect each other's rollback path.

## Findings

**DATA-MEDIUM-013 — Missing composite index on event_store(tenant_id, aggregate_id, version)**
Event store queries filter by tenant_id + aggregate_id + version but only a single-column index on aggregate_id exists. Add composite index.

**DATA-MEDIUM-015 — Continuous aggregate refresh policy too aggressive**
TimescaleDB continuous aggregates refresh every 5 minutes for hourly aggregates. The refresh window scans the entire materialization range. Use `refresh_continuous_aggregate` with a bounded `start` window (e.g., last 2 hours).

**DATA-MEDIUM-017 — Cursor-based pagination uses OFFSET instead of keyset**
List endpoints use `OFFSET/LIMIT` pagination. At high page numbers, OFFSET scans and discards rows. Switch to keyset (cursor) pagination using the last-seen `id` or `createdAt`.

**DATA-MEDIUM-018 — Sensor reading aggregation scans raw hypertable**
Hourly sensor aggregation queries scan the raw `sensor_reading` hypertable instead of the pre-computed continuous aggregate view. Use the continuous aggregate for queries with >= 1 hour granularity.

**DATA-MEDIUM-021 — Missing index on notification(tenant_id, user_id, read_at)**
The notification list query filters by tenant_id, user_id, and `read_at IS NULL` for unread notifications. No composite index exists. Adds full table scan for notification badge counts.

**DATA-MEDIUM-022 — Audit log query lacks time-range partition pruning**
Audit log queries do not include a time range filter. Without a `WHERE created_at >= ...` clause, the query planner cannot prune partitions, scanning the entire audit history.

**DATA-MEDIUM-023 — Batch history query uses ORDER BY without matching index**
Batch history (mortality records, transfers, status changes) queries use `ORDER BY created_at DESC` but the index is on `(batch_id)` only. Add `(batch_id, created_at DESC)` composite index.

**DATA-MEDIUM-024 — Messaging thread list query N+1 for last message**
Thread list resolver fetches the last message per thread in a loop (N+1). Use a lateral join or DataLoader to batch the last-message lookup.

## Affected Files
- apps/event-store-service/src/ (indexes, query optimization)
- apps/sensor-service/src/ (continuous aggregate usage)
- apps/notification-service/src/ (notification queries, indexes)
- apps/admin-api-service/src/ (audit log queries)
- apps/farm-service/src/batch/ (batch history queries, indexes)
- apps/messaging-service/src/ (thread list resolver)
- database/migrations/ (new index migrations)

## Dependencies
None. Index additions and query optimizations are independent.

## Atomic Commit Plan
```
fix(data): add composite indexes, use continuous aggregates, keyset pagination, lateral join for thread list

Eight query performance fixes:
- Add composite index on event_store(tenant_id, aggregate_id, version)
- Bound continuous aggregate refresh window to last 2 hours
- Switch list endpoints from OFFSET to keyset pagination
- Use continuous aggregate view for hourly sensor queries
- Add composite index on notification(tenant_id, user_id, read_at)
- Add time-range filter to audit log queries for partition pruning
- Add (batch_id, created_at DESC) composite index for batch history
- Replace N+1 thread.lastMessage with lateral join or DataLoader

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-013
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-015
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-017
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-018
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-021
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-022
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-023
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-024
Plan: docs/plans/2026-04-09-medium-fixes/packages/11-data-layer-query-performance.md
```

## Test Plan
- EXPLAIN ANALYZE: event_store query uses composite index (Index Scan, not Seq Scan)
- EXPLAIN ANALYZE: notification unread query uses composite index
- EXPLAIN ANALYZE: batch history query uses (batch_id, created_at DESC) index
- Unit test: list endpoint returns cursor token, next page uses keyset
- Unit test: sensor hourly query hits continuous aggregate (mock/spy on view name)
- Unit test: audit log query includes created_at range filter
- Unit test: thread list uses single query for last messages (not N queries)

## Verification Command
`npx tsc --noEmit && npx jest --testPathPattern="(event-store|sensor-service|notification|messaging)" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
