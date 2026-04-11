# Package 18: sensor-precision-decimal

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 1

## Closing-Findings
Closing-Findings: [database-reviewer/HIGH-002]

## Source-Reviews
- /var/aqua-saas/docs/reviews/database-reviewer/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Sensor alarm thresholds, calibration values, VFD setpoints, change-set items, and parameter audit logs use `float` / `double precision` column types. These are not presentation values -- they are live control, threshold, and audit fields where silent rounding drift causes non-deterministic threshold comparisons and non-replayable audit trails.

## Findings
`HIGH-002` (database-reviewer): Precision-sensitive sensor and VFD schema uses floating point for control and audit values. Files: `apps/sensor-service/src/database/entities/sensor-data-channel.entity.ts:229-243`, `apps/sensor-service/src/database/entities/sensor.entity.ts:311-315`, `apps/sensor-service/src/process/entities/unified-tag.entity.ts:134-160`, `apps/sensor-service/src/vfd/entities/vfd-register-mapping.entity.ts:75-133`, `apps/sensor-service/src/vfd-programming/entities/vfd-change-set-item.entity.ts:40-50`, `apps/sensor-service/src/vfd-programming/entities/vfd-parameter-audit-log.entity.ts:43-49`.

## Affected Files
- /var/aqua-saas/apps/sensor-service/src/database/entities/sensor-data-channel.entity.ts
- /var/aqua-saas/apps/sensor-service/src/database/entities/sensor.entity.ts
- /var/aqua-saas/apps/sensor-service/src/process/entities/unified-tag.entity.ts
- /var/aqua-saas/apps/sensor-service/src/vfd/entities/vfd-register-mapping.entity.ts
- /var/aqua-saas/apps/sensor-service/src/vfd-programming/entities/vfd-change-set-item.entity.ts
- /var/aqua-saas/apps/sensor-service/src/vfd-programming/entities/vfd-parameter-audit-log.entity.ts

## Dependencies
None.

## Atomic Commit Plan
```
fix(sensor): migrate threshold and audit columns from float to numeric

Sensor alarm thresholds, calibration values, VFD setpoints, and
parameter audit logs used float/double precision, causing silent
rounding drift in control-path comparisons and non-replayable audit
trails. This migrates all configuration/audit columns to
numeric(precision, scale) with explicit precision appropriate to each
field's domain semantics, and adds a data migration for existing values.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/18-sensor-precision-decimal.md
Closes: docs/reviews/database-reviewer/2026-04-10-full-repo-audit.md#HIGH-002
```

## Test Plan
- Unit test: entity column types are `numeric` not `float`/`double precision`.
- Migration test: existing float values are losslessly converted to numeric.
- Unit test: threshold comparison produces deterministic results.
- Regression test: VFD setpoint read/write round-trips without precision loss.

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service/src" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

