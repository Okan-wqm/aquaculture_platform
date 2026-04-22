# Package 23: db-precision-partition-pk

## Metadata
Status: IMPLEMENTED
Implemented: 2026-04-09
Estimated Tokens: 8K
Priority: CRITICAL
Security-Sensitive: no
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [DB-CRITICAL-002, DB-CRITICAL-003]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Two database schema defects: (1) sensor_metrics uses `double precision` (float8) for compliance threshold values -- floating point comparison errors can cause false compliance violations or missed real violations (e.g., pH 6.9999999 vs 7.0 threshold); (2) compliance_audit_log primary key does not include the partition key, which is required for partitioned tables in PostgreSQL -- the table cannot be partitioned without including the partition key in the PK.

## Findings
- **DB-CRITICAL-002**: sensor_metrics double precision for compliance thresholds
  - File: `apps/sensor-service/src/database/entities/sensor-metric.entity.ts` (~7.9K chars)
  - Threshold comparison values stored as float8 instead of numeric/decimal
  - Root cause: initial schema used float for simplicity

- **DB-CRITICAL-003**: compliance_audit_log PK missing partition key
  - File: `apps/messaging-service/src/compliance/entities/compliance-audit-log.entity.ts` (~2.3K chars)
  - PK is (id) only; partition by created_at requires (id, created_at) composite PK

## Affected Files
- `/var/aqua-saas/apps/sensor-service/src/database/entities/sensor-metric.entity.ts` (~7.9K chars)
- `/var/aqua-saas/apps/messaging-service/src/compliance/entities/compliance-audit-log.entity.ts` (~2.3K chars)

## Dependencies
Soft dependency with Package 19 (compliance partition + legal hold). Both touch compliance-audit-log.entity.ts. If executed in same sprint, coordinate the migration. No hard blocking dependency -- either order works.

## Atomic Commit Plan
```
fix(database): use numeric for sensor thresholds and fix compliance audit PK for partitioning

1. sensor-metric.entity.ts: change threshold columns from float8 to
   numeric(10,4). Add migration to ALTER COLUMN TYPE. Use
   DecimalTransformer for read/write.
2. compliance-audit-log.entity.ts: change PK to composite (id, created_at)
   to support RANGE partitioning by created_at. Add migration.

Closes: docs/reviews/2026-04-09-critical-fixes#DB-CRITICAL-002
Closes: docs/reviews/2026-04-09-critical-fixes#DB-CRITICAL-003
Plan: docs/plans/2026-04-09-critical-fixes/packages/23-db-precision-partition-pk.md
```

## Test Plan
- Unit test: sensor metric threshold stored as numeric, not float
- Unit test: threshold comparison 6.9999999 vs 7.0 uses exact numeric comparison
- Unit test: compliance_audit_log PK includes created_at
- Migration test: existing float values converted to numeric without data loss
- Migration test: compliance_audit_log PK migration succeeds

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service/src/database" --coverage=false
```

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
