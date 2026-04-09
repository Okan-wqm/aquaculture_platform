# Package 05: sensor-sql-interpolation

## Metadata
Status: PENDING
Estimated Tokens: 15K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [S2-HIGH-005]
Source-Reviews:
  - docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md
  - docs/reviews/farm-expert/2026-04-05-s2-high-findings-audit.md

## Context
TimeBucketService in sensor-service and FeedingScheduler in farm-service both use SQL string interpolation for dynamic values (bucket intervals, schema names). These are SQL injection vectors where user-controllable or config-controllable values are interpolated into raw queries.

## Findings

**S2-HIGH-005** (sensor-expert + farm-expert, HIGH)
File: apps/sensor-service/src/analytics/services/time-bucket.service.ts
File: apps/farm-service/src/feeding/services/feeding-cron.service.ts (line 731)
TimeBucketService interpolates bucket interval strings directly into SQL. FeedingScheduler constructs schema names via string manipulation of tenantId and interpolates into SET search_path. Both bypass parameterized query patterns used elsewhere in the codebase.

## Affected Files
- apps/sensor-service/src/analytics/services/time-bucket.service.ts
- apps/farm-service/src/feeding/services/feeding-cron.service.ts

## Dependencies
None. Each service fix is independent.

## Atomic Commit Plan
```
security(sensor,farm): parameterize SQL interpolation in TimeBucketService and FeedingScheduler

TimeBucketService interpolates bucket interval strings into raw SQL, creating
injection vectors. FeedingScheduler constructs schema names by string manipulation
of tenantId values from database queries and interpolates into SET search_path.

Replace interval interpolation with parameterized queries using PostgreSQL
interval type. Replace schema name construction with listTenantSchemas() from
backend-common (validated schema enumeration).

Plan: docs/plans/2026-04-09-high-fixes/packages/05-sensor-sql-interpolation.md
Closes: docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md#S2-HIGH-005
Closes: docs/reviews/farm-expert/2026-04-05-s2-high-findings-audit.md#HIGH-005
```

## Test Plan
- Unit test: TimeBucketService rejects malicious interval strings
- Unit test: FeedingScheduler uses listTenantSchemas() not string manipulation
- Verify parameterized queries pass with valid intervals
- Verify cleanup job operates correctly across tenant schemas

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx tsc --noEmit -p apps/farm-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service/src/analytics|apps/farm-service/src/feeding" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
