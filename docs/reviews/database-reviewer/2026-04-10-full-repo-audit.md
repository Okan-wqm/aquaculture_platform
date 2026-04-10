# Database Review
**Date:** 2026-04-10  
**Scope:** full-repo schema/state audit across `database/migrations/**`, entity definitions, and DB scripts  
**Decision:** **BLOCK**

## Findings

**CRITICAL-001 - Authoritative migration tree is empty for core, alert, farm, and sensor**

The canonical migration files in the repo are zero-byte placeholders, so the stated source-of-truth for schema state does not actually contain schema DDL.

Affected files:
- [database/migrations/core/V001__initial_schema.sql](/var/aqua-saas/database/migrations/core/V001__initial_schema.sql)
- [database/migrations/core/V002__add_tenant_table.sql](/var/aqua-saas/database/migrations/core/V002__add_tenant_table.sql)
- [database/migrations/core/V003__add_user_table.sql](/var/aqua-saas/database/migrations/core/V003__add_user_table.sql)
- [database/migrations/core/V004__add_subscription_table.sql](/var/aqua-saas/database/migrations/core/V004__add_subscription_table.sql)
- [database/migrations/core/V005__add_audit_table.sql](/var/aqua-saas/database/migrations/core/V005__add_audit_table.sql)
- [database/migrations/modules/alert/V001__alert_initial_schema.sql](/var/aqua-saas/database/migrations/modules/alert/V001__alert_initial_schema.sql)
- [database/migrations/modules/alert/V002__add_escalation_tables.sql](/var/aqua-saas/database/migrations/modules/alert/V002__add_escalation_tables.sql)
- [database/migrations/modules/farm/V001__farm_initial_schema.sql](/var/aqua-saas/database/migrations/modules/farm/V001__farm_initial_schema.sql)
- [database/migrations/modules/farm/V002__add_production_tables.sql](/var/aqua-saas/database/migrations/modules/farm/V002__add_production_tables.sql)
- [database/migrations/modules/farm/V003__add_ras_tables.sql](/var/aqua-saas/database/migrations/modules/farm/V003__add_ras_tables.sql)
- [database/migrations/modules/farm/V004__add_feeding_tables.sql](/var/aqua-saas/database/migrations/modules/farm/V004__add_feeding_tables.sql)
- [database/migrations/modules/sensor/V001__sensor_initial_schema.sql](/var/aqua-saas/database/migrations/modules/sensor/V001__sensor_initial_schema.sql)
- [database/migrations/modules/sensor/V002__create_hypertables.sql](/var/aqua-saas/database/migrations/modules/sensor/V002__create_hypertables.sql)
- [database/migrations/modules/sensor/V003__create_continuous_aggregates.sql](/var/aqua-saas/database/migrations/modules/sensor/V003__create_continuous_aggregates.sql)
- [database/migrations/modules/sensor/V004__add_retention_policies.sql](/var/aqua-saas/database/migrations/modules/sensor/V004__add_retention_policies.sql)

This blocks reproducible bootstrap and makes the central migration tree unusable for schema review.

**HIGH-002 - Precision-sensitive sensor and VFD schema uses floating point for control and audit values**

The schema stores alarm thresholds, calibration values, and VFD setpoints as `float` / `double precision` across multiple entities. These are not harmless presentation values; they are live control, threshold, and audit fields.

Evidence:
- [apps/sensor-service/src/database/entities/sensor-data-channel.entity.ts](/var/aqua-saas/apps/sensor-service/src/database/entities/sensor-data-channel.entity.ts#L229-L243)
- [apps/sensor-service/src/database/entities/sensor.entity.ts](/var/aqua-saas/apps/sensor-service/src/database/entities/sensor.entity.ts#L311-L315)
- [apps/sensor-service/src/process/entities/unified-tag.entity.ts](/var/aqua-saas/apps/sensor-service/src/process/entities/unified-tag.entity.ts#L134-L160)
- [apps/sensor-service/src/vfd/entities/vfd-register-mapping.entity.ts](/var/aqua-saas/apps/sensor-service/src/vfd/entities/vfd-register-mapping.entity.ts#L75-L133)
- [apps/sensor-service/src/vfd-programming/entities/vfd-change-set-item.entity.ts](/var/aqua-saas/apps/sensor-service/src/vfd-programming/entities/vfd-change-set-item.entity.ts#L40-L50)
- [apps/sensor-service/src/vfd-programming/entities/vfd-parameter-audit-log.entity.ts](/var/aqua-saas/apps/sensor-service/src/vfd-programming/entities/vfd-parameter-audit-log.entity.ts#L43-L49)

Impact: silent rounding drift, non-deterministic threshold comparisons, and audit values that cannot be compared or replayed exactly. The sensor metric hypertable is intentionally documented as a throughput tradeoff and is not the problem here; these configuration/audit tables are.

**HIGH-003 - `message_receipts` partitioning makes the intended logical uniqueness unenforceable**

The receipt table is partitioned by `receiptCreatedAt`, but its unique key includes that partition column instead of the logical identity alone. The application code treats receipts as one row per `messageId` + `userId`.

Evidence:
- [apps/messaging-service/src/migrations/1711800000000-CreateMessagingTables.ts](/var/aqua-saas/apps/messaging-service/src/migrations/1711800000000-CreateMessagingTables.ts#L231-L247)
- [apps/messaging-service/src/message/commands/mark-read.handler.ts](/var/aqua-saas/apps/messaging-service/src/message/commands/mark-read.handler.ts#L63-L88)

Impact: duplicate logical receipts can survive across partitions/months, and `mark-read` cannot reliably enforce a single current receipt row. The current design also complicates GDPR export/delete semantics because the schema does not have a stable current-state identity.

## Cross-Domain Dependencies

- `CRITICAL-001` -> `data-expert` for migration restoration and canonical DDL authoring.
- `HIGH-002` -> `sensor-expert` and `data-expert` for precision-safe schema redesign.
- `HIGH-003` -> `messaging-expert` and `data-expert` for receipt-table redesign and partitioning strategy.

