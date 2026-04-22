# Package 13: sensor-metrics-time-bound

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 10K
Priority: CRITICAL
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [sensor-expert/CRITICAL-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/sensor-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
`getLastReadings()` queries the `sensor_metrics` hypertable by `channel_id` and `tenant_id` only, with no time-range predicate. This bypasses TimescaleDB chunk pruning and can devolve into a full scan across the entire retention window, causing one tenant to force expensive scans on shared infrastructure.

## Findings
`CRITICAL-001` (sensor-expert): `getLastReadings()` scans `sensor_metrics` without any time-range predicate. File: `apps/sensor-service/src/sensor/services/metric-query.service.ts:298-315`. The query orders by `time DESC` and applies `LIMIT` but has no `time >= ...` / `time < ...` predicate, bypassing chunk pruning.

## Affected Files
- /var/aqua-saas/apps/sensor-service/src/sensor/services/metric-query.service.ts

## Dependencies
None.

## Atomic Commit Plan
```
fix(sensor): add time-range predicate to getLastReadings() hypertable query

getLastReadings() queried sensor_metrics by channel_id and tenant_id
without any time-range predicate, bypassing TimescaleDB chunk pruning
and potentially scanning the full retention window. This adds a bounded
time window (e.g., last 24 hours) to the query predicate so chunk
pruning is effective, and falls back to a dedicated latest-value
materialized view for the most recent reading.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/13-sensor-metrics-time-bound.md
Closes: docs/reviews/sensor-expert/2026-04-10-full-repo-audit.md#CRITICAL-001
```

## Test Plan
- Unit test: query includes `time >= NOW() - interval` predicate.
- Unit test: verify EXPLAIN plan shows chunk exclusion.
- Performance test: compare query time with and without time predicate.
- Negative test: calling without time bounds fails or uses default bound.

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service/src/sensor" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

