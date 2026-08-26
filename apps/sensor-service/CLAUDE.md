# sensor-service — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY the sensor-domain facts that CONTRADICT a correct reading of those rules.

Sensor ingestion, calibration, aggregation, MQTT/LoRaWAN, VFD, edge devices, SCADA runtime. Schema: `sensor` (tenant-scoped).

## The audit-table heuristic is wrong half the time here

`tests/invariants/entity-schema-declaration.spec.ts` classifies by FILENAME (`CROSS_TENANT_FILENAME_PATTERNS`), so a new `*-audit*.entity.ts` is auto-classified cross-tenant. In this service that is a coin flip:

- `apps/sensor-service/src/vfd/entities/vfd-command-audit-log.entity.ts` → `@Entity('vfd_command_audit_logs', { schema: 'sensor' })` — cross-tenant.
- `apps/sensor-service/src/vfd-programming/entities/vfd-parameter-audit-log.entity.ts` → `@Entity('vfd_parameter_audit_logs')` — **per-tenant, no `schema:`**. It only survives CI because it is listed in that spec's `TENANT_OWNED_FILENAME_OVERRIDES`. A third, `edge-device/entities/v2/audit-archive-v2.entity.ts`, is also per-tenant (and its table is `audit_archive_v1` — the `-v2` in the filename is the entity version, not the table).

Adding an audit-shaped entity: decide the classification from the DATA, then make the spec agree — add the override if it is per-tenant. Do not let the filename decide.

## Cross-tenant set

<!-- infra-tables:sensor -->`migrations`, `sensor_audit_logs`, `sensor_outbox`, `vfd_register_mappings`, `edge_device_directory`, `scada_alarms`, `scada_alarm_chronicle`, `scada_tag_history`, `vfd_command_audit_logs`, `telemetry_archive_events`, `telemetry_archive_presigns`, `telemetry_archive_cancellations`, `tenant_erasure_target_proofs`<!-- /infra-tables -->

Proven against `MODULE_SCHEMAS` by `tests/invariants/nested-steering-parity.spec.ts` — edit the registry, never this copy. Two entries there are non-obvious:

- `vfd_register_mappings` is GLOBAL vendor reference data pinned to `sensor` (SENSOR-MEDIUM-009), not tenant data.
- The SCADA trio (`scada_alarms`, `scada_alarm_chronicle`, `scada_tag_history`) is cross-tenant BECAUSE process-wide singletons write it; isolation comes from a forced `tenant_isolation_policy` instead of schema routing. Guarded by `tests/invariants/scada-storage-tenant-context.spec.ts`.
- `edge_device_directory` is a cross-tenant index; its `device_code` index is deliberately NOT unique.

## `sensor_readings` does not exist — do not "restore" it

SENSOR-HIGH-085 retired the table. A `SensorReading` is an as-of PROJECTION over `sensor_metrics`, computed in `apps/sensor-service/src/sensor/services/sensor-query.service.ts`. Code searching for the missing table is looking at a design decision, not a gap.

`sensor_metrics` itself is a PER-TENANT TimescaleDB hypertable with composite PK `(time, sensor_id, channel_id)` (`apps/sensor-service/src/database/entities/sensor-metric.entity.ts`). The writer derives the destination schema from the ROW's tenantId, not from search_path (`apps/sensor-service/src/ingestion/sensor-metric-writer.service.ts`) — so "a singleton writer implies a cross-tenant table" does not hold.

## Domain invariants

- Only `SensorRegistrationService` may create a `Sensor`. The `createSensor` / `updateSensor` GraphQL mutations were deleted on purpose and returning them fails `tests/invariants/sensor-single-write-path.spec.ts`.
- `edge_devices` (v1) and `devices` (v2) coexist by design during the model cutover, with a single writer per model and no dual-write. Guarded by `tests/invariants/edge-device-dual-model-guard.spec.ts`.

## Enforcement

Boot: `SchemaDriftValidator`. CI: `tests/invariants/sensor-single-write-path.spec.ts`, `scada-storage-tenant-context.spec.ts`, `edge-device-dual-model-guard.spec.ts`, `entity-schema-declaration.spec.ts`, `tenant-fanout-entity-parity.spec.ts`, `timescale-rls-columnstore-contract.spec.ts`; `e2e/tests/integration/schema-invariants.spec.ts`.
