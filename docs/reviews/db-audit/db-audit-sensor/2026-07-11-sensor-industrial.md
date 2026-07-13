# db-audit-sensor — CATCHER — 2026-07-11

## Scope

Lane-D end-to-end DB audit of the Sensor & Industrial-Control partition:

- Backend `apps/sensor-service` (schema-per-tenant `sensor`), all 51 `@Entity` classes across ~52 files (sensors, readings/aggregation, calibration, device groups, edge devices v1/v2, VFD, VFD-programming, PLC/SCADA runtime, automation, registration, deploy pipeline, dashboards) + the raw-SQL SCADA runtime tables (`scada_alarms`, `scada_alarm_chronicle`, `scada_tag_history`).
- TimescaleDB hypertables (`sensor_readings`, `sensor_metrics`) + migration set under `apps/sensor-service/src/database/migrations/`.
- Cross-tenant infra tables vs `MODULE_SCHEMAS['sensor'].infrastructureTables`.
- The Rust ingestion sidecar `apps/sensor-ingestion` (EVENT write boundary, ADR-025).
- Frontend reachability via `web/modules/sensor-module/src/**`.

Method binding: `.claude/agents/_shared/db-audit-methodology.md`. Appendix A = provenance matrix (one `###` per table); Appendix B = incidental findings. Deep evidence only on non-`OK` rows.

## Executive summary

The most serious defect is a cross-tenant isolation gap in the SCADA runtime store: `scada_alarms`, `scada_alarm_chronicle` and `scada_tag_history` carry NO `tenant_id`, are created only in the shared `sensor` source schema (not cloned per tenant, absent from MODULE_SCHEMAS), and are read with unfiltered `SELECT * FROM scada_alarms`/`scada_alarm_chronicle`. In a multi-tenant sensor-service every tenant's SCADA runtime shares one physical alarm table with no tenant column and no read filter — a cross-tenant read leak (CRITICAL). `scada_tag_history` additionally has no migration that creates it (MISSING-TABLE). The reading write path has a live duality defect: the Rust-sidecar→NATS bridge populates only tenant/farm/pond on `sensor_metrics`, dropping the site/department/system/equipment/tank hierarchy the dashboards index and query by (HIGH). VFD runtime control commands (start/stop/setFrequency/emergencyStop) and SCADA operator tag-writes fire at the device with no durable command/audit record (HIGH, life-safety adjacent) — in contrast to the well-modelled `vfd_parameter_audit_logs` for the programming path. The Rust `PostgresSink` mis-stores `raw_value = value` and writes only 6 columns (HIGH, latent — `main.rs` is still a stub drain).

## Findings (by severity)

### CRITICAL

#### DB-SENSOR-CRITICAL-001 — SCADA alarm/chronicle/tag-history store has no tenant isolation

**Severity:** CRITICAL
**Layer:** 2 (tenant isolation) + 3 (ADR-011)
**State:** OPEN

**Evidence**
- `apps/sensor-service/src/database/migrations/1800200000000-CreateScadaAlarmStorage.ts:8-45` — `CREATE TABLE ... sensor.scada_alarms` / `sensor.scada_alarm_chronicle` with NO `tenant_id` column, hardcoded to the `sensor` source schema only.
- `apps/sensor-service/src/scada-runtime/services/alarm-storage.service.ts:112-118` — existence check is pinned to `table_schema = 'sensor'` (never per-tenant); `:148` `INSERT INTO scada_alarms` (unqualified — search_path resolves to shared `sensor.scada_alarms`); `:210` `SELECT * FROM scada_alarms ORDER BY severity` with NO tenant filter; `:324` `FROM scada_alarm_chronicle` unfiltered.
- `apps/sensor-service/src/scada-runtime/services/daq-storage.service.ts:47,171` — `scada_tag_history` written with `(tag_id, timestamp, value, quality)` — no `tenant_id`.
- Neither table appears in `MODULE_SCHEMAS['sensor'].tables`/`infrastructureTables` (`libs/backend-common/src/database/schema-manager.service.ts:222-299`).
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:384-433` — the gateway is multi-tenant (per-socket `clientData` with userId/role/tenant), so multiple tenants share this store at runtime.

**Rule violated**
Tenant isolation (layer-2 patterns; defect-catalog "cross-tenant isolation leak"); ADR-011 per-tenant placement; `getScopedRepository`/RLS discipline. The store relies entirely on pooled-connection `search_path` correctness with no `tenant_id` defense-in-depth and no read filter.

**Proposed fix direction**
- Add `tenant_id` to all three tables, populate on every write from the authenticated SCADA session, and filter every read by tenant (Tier-1: make the shared table impossible to read cross-tenant).
- Register the tables in MODULE_SCHEMAS (per-tenant clone) OR make them true cross-tenant infra with `tenant_id` + RLS.
- Route writes/reads through a tenant-scoped repository, not the raw `@InjectDataSource()`.

**Affected surface (ripple set)**
- `apps/sensor-service/src/scada-runtime/services/alarm-storage.service.ts`, `daq-storage.service.ts`
- `apps/sensor-service/src/database/migrations/1800200000000-CreateScadaAlarmStorage.ts` (+ new migration for `scada_tag_history`)
- `libs/backend-common/src/database/schema-manager.service.ts` (MODULE_SCHEMAS)

**Expected closer**
sensor-expert WRITER + multi-tenant-saas-expert review.

### HIGH

#### DB-SENSOR-HIGH-001 — Rust-sidecar/NATS ingestion bridge drops the location hierarchy on `sensor_metrics`

**Severity:** HIGH
**Layer:** 2 (reading-path duality invariant)
**State:** OPEN

**Evidence**
- `apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts:257-269` — the `SensorMetricInput` built from `SensorMetricIngestedEvent` sets only `time, sensorId, channelId, tenantId, rawValue, value, qualityCode, sourceProtocol='rust-sidecar', sourceTimestamp, farmId, pondId`; OMITS `siteId, departmentId, systemId, equipmentId, tankId, qualityBits, batchId` — even though the `sensor` meta is already loaded at `:203`.
- `apps/sensor-service/src/ingestion/data-ingestion.service.ts:313-331` — the native MQTT path populates ALL of `siteId..tankId` + `qualityBits`.
- `apps/sensor-service/src/database/entities/sensor-metric.entity.ts:82-83` — `@Index(['tankId','time'])`, `@Index(['equipmentId','time'])`: these are read-side query keys → sidecar-ingested rows are invisible to tank/equipment-scoped dashboards.

**Rule violated**
Domain invariant "Reading-path duality"; layer-1-timescaledb column-coverage.

**Proposed fix direction**
- Thread `sensor.siteId/departmentId/systemId/equipmentId/tankId` (already in hand at `:203`) into the `SensorMetricInput`, matching the native path.
- Make it detectable: a parity test asserting both write paths cover the same column set.

**Affected surface (ripple set)**
- `apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts`, `data-ingestion.service.ts`, `libs/event-contracts` (`SensorMetricIngestedEvent`).

**Expected closer**
sensor-expert WRITER.

#### DB-SENSOR-HIGH-002 — Rust `PostgresSink` stores calibrated value into `raw_value` and writes only 6 columns

**Severity:** HIGH (latent — sink unwired; escalate on rollout)
**Layer:** 1 (correctness) + domain "calibration lineage"
**State:** OPEN

**Evidence**
- `apps/sensor-ingestion/src/persistence.rs:348-349` — `let value = r.value; let raw_value = r.value;` — `r.raw_value` (pre-conversion measurement, `payload.rs:110`) is discarded; calibrated value written into both.
- `apps/sensor-ingestion/src/persistence.rs:409-431` — COPY+upsert write only `(time, sensor_id, channel_id, value, raw_value, quality_code)`; no `tenant_id`/location/`quality_bits`/`source_*`.
- `apps/sensor-ingestion/src/main.rs:200-238` — `drain_mqtt_stream` is a stub (log-and-drop); `PostgresSink`/`NatsOutboxPublisher` are NOT wired. Latent until the pipeline lands.

**Rule violated**
Domain "Calibration lineage"; layer-2 wrong-field/copy-paste defect.

**Proposed fix direction**
- Bind `raw_value` to `r.raw_value`. If the direct-COPY sink is retained, write the full column set the NestJS path writes, or explicitly retire it (see MEDIUM-001).

**Affected surface (ripple set)**
- `apps/sensor-ingestion/src/persistence.rs`.

**Expected closer**
Rust sidecar owner / sensor-expert WRITER.

#### DB-SENSOR-HIGH-003 — VFD runtime control commands and SCADA tag-writes have no durable command/audit record

**Severity:** HIGH (life-safety adjacent)
**Layer:** 2 (domain "Command paths are not provenance-free")
**State:** OPEN

**Evidence**
- `apps/sensor-service/src/vfd/services/vfd-command.service.ts:64-159` — `executeCommand` (START/STOP/SET_FREQUENCY/SET_SPEED/FAULT_RESET/EMERGENCY_STOP/JOG) fires `adapter.writeControlWord`/`writeSpeedReference` and returns a `VfdCommandExecutionResult`; the only trace is `logger.log` (`:78`). No INSERT into any table.
- `apps/sensor-service/src/vfd/resolvers/vfd-command.resolver.ts:48-157` — the mutations that reach it.
- Contrast `apps/sensor-service/src/vfd-programming/entities/vfd-parameter-audit-log.entity.ts` — an immutable audit log EXISTS for the parameter-programming path but NOT for runtime control. `@Auditable()` on `VfdDevice` audits row CRUD, not command execution (commands do not mutate the `vfd_devices` row).
- `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:384-433` — operator `TAG_WRITE` calls `tagManager.writeTagValue(...)`; role-checked + `logger.debug` only, no durable command record.

**Rule violated**
Domain invariant "Command paths are not provenance-free" (durable auditable record for actuator writes).

**Proposed fix direction**
- Persist every VFD control command and SCADA operator tag-write to an immutable command-history table (who/when/device/command/value/result), mirroring `vfd_parameter_audit_logs`.

**Affected surface (ripple set)**
- `apps/sensor-service/src/vfd/services/vfd-command.service.ts`, `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts` + new command-history entity/migration.

**Expected closer**
sensor-expert WRITER.

#### DB-SENSOR-HIGH-004 — `scada_tag_history` has no migration (MISSING-TABLE); DAQ historian writes to a non-provisioned table

**Severity:** HIGH
**Layer:** 1 (schema) + layer-1-timescaledb MODULE_SCHEMAS contract
**State:** OPEN

**Evidence**
- `apps/sensor-service/src/scada-runtime/services/daq-storage.service.ts:46-47` — `const TABLE_NAME = 'scada_tag_history';` with comment "change to match your migration"; `:171` `INSERT INTO scada_tag_history ...`.
- No migration under `apps/sensor-service/src/database/migrations/` (including Baseline) creates `scada_tag_history` (grep: no matches). No runtime `CREATE TABLE` in `daq-storage.service.ts`. Not in MODULE_SCHEMAS.
- The service has no `onModuleInit`/ensure guard (unlike `AlarmStorageService`), so first write raises `relation "scada_tag_history" does not exist` unless created out-of-band.

**Rule violated**
methodology `MISSING-TABLE`; layer-1-timescaledb "table must be added to MODULE_SCHEMAS before the entity deploys, else provisioning misses it and the entity crashes on first insert".

**Proposed fix direction**
- Author the `scada_tag_history` hypertable migration (with `tenant_id` per CRITICAL-001), register in MODULE_SCHEMAS, and add an `ensureTablesExist`-style guard.

**Affected surface (ripple set)**
- `apps/sensor-service/src/scada-runtime/services/daq-storage.service.ts` + new migration + MODULE_SCHEMAS.

**Expected closer**
sensor-expert WRITER.

### MEDIUM

#### DB-SENSOR-MEDIUM-001 — Two divergent sidecar persistence designs (direct COPY vs NATS-outbox)
**Layer:** 2 (duplication). `apps/sensor-ingestion/src/persistence.rs` (`PostgresSink` direct COPY→stage→upsert into `sensor_metrics`) vs `apps/sensor-ingestion/src/events.rs` (`NatsOutboxPublisher` → NestJS `nats-ingestion-consumer.service.ts` persists). Both present, neither wired (`main.rs` stub). ADR-025/charter names the NATS path canonical. Fix: declare one design of record; delete/gate the other behind the documented `INGEST_BACKEND` flag with a parity test.

#### DB-SENSOR-MEDIUM-002 — `sensor_readings` federated `@key` entity over a default-off legacy table
**Layer:** 2 (write-only/contract drift). Written only when `LEGACY_SENSOR_READINGS_ENABLED==='true'` (default off; `data-ingestion.service.ts:339-347,538-552`, `@deprecated`) while `sensor-reading.entity.ts:70-72` keeps `@Directive('@key(fields:"id")')` + `SensorReadingResolver`. With the flag off (default), the federated `SensorReading` resolves against a table receiving no new rows. Fix: retire the `@key`+resolver or repoint at `sensor_metrics`; confirm no `Tank.sensorReadings` consumer first.

#### DB-SENSOR-MEDIUM-003 — Edge device v1 (`edge_devices`) vs v2 (`devices`) dual-model
**Layer:** 2 (DUPLICATE-STRUCTURE, disclosed WIP). `edge-device.entity.ts` (`edge_devices`, GraphQL-exposed, `@Auditable`, rich) coexists with `v2/device-v2.entity.ts` (`devices`, bytea trust bundles, RLS, no GraphQL). The v2 docblock declares a dual-write cutover window + Faz 3 consolidation. Both registered in `edge-device.module.ts forFeature`. Track to single-owner consolidation; ensure no divergent write paths in the interim.

#### DB-SENSOR-MEDIUM-004 — `scada_alarms`/`scada_alarm_chronicle`/`scada_tag_history` UNREGISTERED in MODULE_SCHEMAS
**Layer:** 3 (ADR-012 drift coverage). These raw-SQL tables are outside `MODULE_SCHEMAS['sensor']`, so the schema-drift validator and per-tenant provisioning do not cover them. (Folds into CRITICAL-001/HIGH-004 but is separately actionable for drift-validator coverage.)

#### DB-SENSOR-MEDIUM-005 — Channel-level calibration coefficients are not audited (calibration lineage gap)
**Layer:** 2 (domain "Calibration lineage"). The calibration actually applied at ingestion uses `SensorDataChannel.applyCalibration` (`data-ingestion.service.ts:297`) with `sensor_data_channels.calibration_multiplier/offset/calibration_polynomial`. `SensorDataChannel` carries NO `@Auditable()` (unlike `Sensor`), and there is no calibration-history table — so who/when/prior-value of an effective coefficient change is unrecoverable, and no reading is tied to the coefficient set in force at sample time. Regulatory risk for water-quality reporting. Fix: `@Auditable()` on `SensorDataChannel` or a dedicated `calibration_history` ledger, and record the coefficient version on each metric (or a versioned coefficient reference).

### LOW

#### DB-SENSOR-LOW-001 — Dead empty stub files in `apps/sensor-service/src/calibration/`
**Layer:** hygiene. `calibration/calibration.entity.ts`, `calibration/calibration.service.ts`, `calibration/drift-detection.service.ts` are empty (0 content), unreferenced, and name-collide with the real `sensor/services/calibration.service.ts` (wired in `sensor.module.ts`). Delete the dead dir to remove the duplicate-name confusion.

## Cross-domain dependencies flagged
- Finding DB-SENSOR-CRITICAL-001: recommend also invoking multi-tenant-saas-expert (tenant isolation) and database-reviewer (MODULE_SCHEMAS / RLS).
- Findings HIGH-001 / MEDIUM-002: recommend data-expert review of `SensorMetricIngestedEvent`/`SensorReadingEvent` contracts (`libs/event-contracts`).
- Finding HIGH-003: recommend edge-expert (Rust `sens-api-gateway` may already carry a device-side command log to reconcile against).

## Verdict
BLOCK — one CRITICAL cross-tenant isolation finding + four HIGH.

## References
- `.claude/agents/_shared/db-audit-methodology.md`; `.claude/knowledge/layer-1-timescaledb.md`, `layer-2-patterns.md`, `layer-2-defect-catalog.md`; ADR-011/012/025.
- Prior: `docs/reviews/2026-07-05-sensor-vfd-device-audit.md`, `docs/reviews/sensor-expert/`, `docs/reviews/orphan-findings.md`.

---

## Appendix A — Provenance matrix

Legend — writer: FE-FORM | EVENT | SYSTEM | EXTERNAL | MIGRATION | NONE · read: GRAPHQL | REST | BE-INTERNAL | NONE · fe: `<module/component>` | NONE · class: OK | DEAD | WRITE-ONLY | BE-ONLY | UI-WITHOUT-DB | DUPLICATE | SUSPECT | MISSING-TABLE

Schema placement verified: all per-tenant tables OMIT `schema:` (correct); the four cross-tenant infra tables (`sensor_outbox`, `sensor_audit_logs`, `edge_device_directory`, `vfd_register_mappings`) DECLARE `schema:'sensor'` and match `MODULE_SCHEMAS['sensor'].infrastructureTables` — no WRONG-SCHEMA-PLACEMENT among the `@Entity` set. The raw-SQL SCADA tables are the exception (CRITICAL-001).

### sensors (per-tenant, no `schema:`) — federated `@key(fields:"id")`
Write FE-FORM (CRUD handlers) + SYSTEM (`status`/`lastSeenAt`/`connection_status` from data-ingestion). Read GRAPHQL (SensorResolver) + BE-INTERNAL. FE: sensor-module. All columns OK. jsonb: `metadata/configuration/calibration_data/protocol_configuration/connection_status/alert_thresholds/display_settings` (see B1). `calibration_data` — SUSPECT for lineage (see MEDIUM-005).

### sensor_readings (per-tenant hypertable) — federated `@key` — see MEDIUM-002
All columns WRITE-ONLY* (written only under `LEGACY_SENSOR_READINGS_ENABLED=true`, default off; resolver stays live). Columns: id, sensor_id, tenant_id, timestamp, readings(jsonb), pond_id, farm_id, quality, source, created_at.

### sensor_metrics (per-tenant TimescaleDB hypertable) — type-only entity, table via migration `1800000000000-Baseline.ts:361`
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| time / sensor_id / channel_id / tenant_id | SYSTEM/EVENT | GRAPHQL/BE | sensor-module | OK |
| site_id / department_id / system_id / equipment_id / tank_id | SYSTEM only | GRAPHQL | sensor-module | SUSPECT (NULL on sidecar rows — HIGH-001) |
| pond_id / farm_id | SYSTEM/EVENT | GRAPHQL | sensor-module | OK |
| raw_value | SYSTEM/EVENT | GRAPHQL | sensor-module | OK (Rust sink bug HIGH-002) |
| value / quality_code | SYSTEM/EVENT | GRAPHQL | sensor-module | OK |
| quality_bits | SYSTEM only | BE-INTERNAL | — | SUSPECT (NULL on sidecar rows) |
| source_protocol / source_timestamp | SYSTEM/EVENT | GRAPHQL/BE | sensor-module | OK |
| ingestion_latency_ms / batch_id | SYSTEM only | BE-INTERNAL | — | BE-ONLY |

### sensor_data_channels (per-tenant)
Write FE-FORM (channel CRUD, discovery) + SYSTEM (`discoveredAt`/`sampleValue`/`lastCalibratedAt`). Read GRAPHQL + BE-INTERNAL (ingestion calibration). FE sensor-module. Columns OK; `calibration_multiplier/offset/calibration_polynomial/lastCalibratedAt/nextCalibrationDue` — the effective calibration coefficients, NOT audited (MEDIUM-005). Multiple `numeric`/`decimal` via `DecimalTransformer` (correct).

### sensor_protocols (reference data, per-tenant clone + referenceDataTables) — OK
Write SYSTEM/seed. Read GRAPHQL + BE-INTERNAL (protocol adapters). FE sensor-module (protocol select). Columns OK.

### sensor_type_definitions (reference/dynamic type system) — OK
Write FE-FORM (type admin) + SYSTEM/seed. Read GRAPHQL. FE sensor-module. OK.

### industry_templates (reference data) — OK
Write SYSTEM/seed. Read GRAPHQL. FE sensor-module (template picker). OK.

### channel_detection_log (per-tenant) — BE-ONLY
Write SYSTEM (auto-detection). Read BE-INTERNAL (detection audit). fe NONE. Legitimate derived/audit purpose → BE-ONLY.

### processes (SCADA canvas, per-tenant)
Write FE-FORM (process editor). Read GRAPHQL. FE sensor-module (SCADA process canvas). `nodes`/`edges` jsonb = graph topology (acceptable graph shape; roundtrip verified — `version` bumped on save; see B4). Columns OK.

### unified_tags (per-tenant) — OK (wired via process.module forFeature)
Write FE-FORM (tag editor) + SYSTEM (deploy binding). Read GRAPHQL. FE sensor-module (`unified-tag.queries.ts`). OK.

### scada_packages / scada_deploy_logs (per-tenant) — OK
Write SYSTEM (deploy orchestrator) + FE-FORM (deploy trigger). Read GRAPHQL. FE sensor-module (`scada-package.queries.ts`). scada_deploy_logs = BE/GRAPHQL deploy audit. OK.

### dashboard_layouts (per-tenant)
Write FE-FORM (dashboard editor). Read GRAPHQL. FE sensor-module (dashboards). `widgets`/`process_background`/`grid_config` jsonb = widget layout (acceptable; see B1). Columns OK.

### vfd_devices (per-tenant) — `@Auditable`
Write FE-FORM (registration wizard) + SYSTEM (`connectionStatus`). Read GRAPHQL. FE sensor-module (VFD). Columns OK (`model_series/pump_id/tags` backfilled per SENSOR-HIGH-026). Runtime control commands NOT audited here (HIGH-003).

### vfd_readings (per-tenant, polled telemetry) — OK
Write SYSTEM (VFD poller). Read GRAPHQL (`readVfdParameters`) + BE. FE sensor-module. OK.

### vfd_register_mappings (cross-tenant, `schema:'sensor'`) — reference data — OK
Write SYSTEM (seed/internal). Read GRAPHQL (`vfdRegisterMappings`). FE sensor-module. Correct cross-tenant placement (matches infrastructureTables).

### vfd_parameter_definitions / vfd_parameter_audit_logs / vfd_change_sets / vfd_change_set_items / vfd_automation_rules (per-tenant, vfd-programming)
Write FE-FORM (parameter editor) + SYSTEM (writer service). Read GRAPHQL. FE sensor-module (`vfd-programming.operations.ts`). `vfd_parameter_audit_logs` = immutable programming audit (append-only, correct). `vfd_change_set_items` child (tenant via parent). All OK.

### plc_connections / plc_alarms / plc_telemetry / feeding_parameters (per-tenant, plc-control) — `feeding_parameters` `@Auditable`
Write FE-FORM (PLC config, feeding params) + SYSTEM (poller/telemetry). Read GRAPHQL. FE sensor-module (`plc.operations.ts`). `feeding_parameters` has a durable status lifecycle (DRAFT→SENT→ACKNOWLEDGED→ACTIVE) — command path IS auditable here. plc_telemetry jsonb payloads. All OK.

### automation_programs / program_steps / program_transitions / program_variables / step_actions / deployment_logs (per-tenant, IEC 61131-3)
Write FE-FORM (automation editor). Read GRAPHQL. FE sensor-module (`automation.queries.ts`). Children (steps/transitions/variables/step_actions) tenant-scoped via parent program. `deployment_logs` = deploy audit. All OK.

### scada_alarms / scada_alarm_chronicle / scada_tag_history (raw-SQL, `sensor` schema, NO `tenant_id`) — see CRITICAL-001 / HIGH-004 / MEDIUM-004
| table | writer | read | fe | class |
|-------|--------|------|----|-------|
| scada_alarms | SYSTEM (alarm-engine) | BE-INTERNAL (ws push) | sensor-module (SCADA HMI) | SUSPECT — no tenant_id, shared schema, unfiltered SELECT * (CRITICAL-001) |
| scada_alarm_chronicle | SYSTEM (append-only) | BE-INTERNAL | sensor-module | SUSPECT — same isolation gap |
| scada_tag_history | SYSTEM (DAQ) | BE-INTERNAL | sensor-module (trends) | MISSING-TABLE (HIGH-004) + no tenant_id; `deviceId` arg dropped on insert (B5) |

### edge_devices (per-tenant, v1) — `@Auditable` — see MEDIUM-003
Write FE-FORM (registration) + SYSTEM (health/heartbeat/provisioning). Read GRAPHQL. FE sensor-module (`edge-device.queries.ts`). Secrets `provisioning_token`/`mqtt_password_hash` carry NO `@Field` (correct); hashed per `1803000000000-HashProvisioningSecretsAtRest`. Columns OK; DUPLICATE with `devices` (v2).

### devices / policies / licenses / firmware_releases / provisioning_records / witnesses / audit_archive_v1 (per-tenant, edge v2, ADR-025) — see MEDIUM-003
Write SYSTEM (v2 provisioning services) — registered in `edge-device.module forFeature`. Read BE-INTERNAL (no `@ObjectType` → not GraphQL-exposed). fe NONE (mid-cutover). Class: DUPLICATE-STRUCTURE (v2 supersedes v1; consolidation tracked). bytea trust bundles + RLS + FK→auth.tenants (installed NOT VALID). Schema placement correct (per-tenant, in MODULE_SCHEMAS).

### device_io_configs / device_events / lora_devices / device_groups / device_group_members (per-tenant, edge-device)
Write FE-FORM (IO config, groups) + SYSTEM (device events, LoRa join). Read GRAPHQL. FE sensor-module (`lora-device.queries.ts`, `device-tags.queries.ts`). `device_io_configs`/`device_group_members` children scoped via parent device/group. All OK.

### tenant_provisioning_keys (per-tenant) — OK
Write FE-FORM (key create) + SYSTEM (`used_count`). Read GRAPHQL (digest excluded). FE sensor-module. `key_token` SHA-256 at rest, no `@Field` (correct, SENSOR-MEDIUM-001 closed). OK.

### deploy_artifacts / release_bundles (per-tenant, signed deploy Faz 3/5) — OK
Write SYSTEM (content-addressed artifact store, guarded release ledger). Read GRAPHQL/BE. FE sensor-module (deploy UI). Registered in MODULE_SCHEMAS.tables. OK.

### Cross-tenant infra (declare `schema:'sensor'`) — placement OK
- `sensor_outbox` (`OutboxEntityBase`, `synchronize:false`) — SYSTEM write (outbox worker), BE-INTERNAL. OK.
- `sensor_audit_logs` — SYSTEM write (AuditSubscriber via `@Auditable`), BE-INTERNAL (no GraphQL). OK/BE-ONLY.
- `edge_device_directory` — SYSTEM write (cross-tenant O(1) index), BE-INTERNAL. OK.
- `vfd_register_mappings` — see above (reference data). OK.
- `tenant_erasure_target_proofs` — GDPR erasure ledger (infrastructureTables). SYSTEM/BE-ONLY. OK.

---

## Appendix B — Incidental findings

- **B1 (jsonb dumping-ground watch).** `sensors` carries 7 jsonb columns; `sensor_data_channels`, `vfd_devices`, `dashboard_layouts`, `processes` also lean on jsonb for structured config/topology. Graph/topology (`processes.nodes/edges`, `dashboard_layouts.widgets`) and vendor-config blobs are defensible; but `sensors.calibration_data`, `sensor.configuration`, `sensor.metadata`, `vfd_devices.customRegisterMappings` are type-system bypasses of otherwise-typed data (layer-1-typeorm jsonb rule). Consider promoting the load-bearing ones (calibration coefficients, register mappings) to typed columns/child tables.
- **B2 (float vs numeric compliance).** `sensor_metrics.raw_value/value` are `double precision` (documented tradeoff DB-CRITICAL-002, `sensor-metric.entity.ts:139-166`). Compliance threshold comparisons MUST cast `::numeric`. The continuous-aggregate compliance queries live in `init-sensor-schema.sql` (not verified this cycle) — confirm the casts exist.
- **B3 (continuous aggregates deferred).** `CreateContinuousAggregates`/`CreateReadingsAggregates` exist only under `migrations/.archive/`; Baseline `1800000000000-Baseline.ts:363-364` defers CAGGs (`OPEN-ADR-030-CAGG`). The `AggregatedMetric` GraphQL type + `metrics_1min/1hour/1day` reads (layer-1-timescaledb) may resolve against non-existent aggregates — verify the dashboard aggregate queries degrade to raw `sensor_metrics` and are not silently empty.
- **B4 (SCADA canvas roundtrip).** `processes.version` is bumped on save and carried into the deploy artifact — the editor roundtrip is intact for the diagram; the risk is entirely in the runtime store (CRITICAL-001), not the design store.
- **B5 (DAQ drops deviceId).** `daq-storage.service.ts:143` `addValues(deviceId, values)` never writes `deviceId` — the `INSERT INTO scada_tag_history` stores only `(tag_id, timestamp, value, quality)`. Combined with no `tenant_id`, tag history is keyed solely by `tag_id`; cross-device/cross-tenant provenance of a historian sample is unrecoverable.
- **B6 (emergency-stop authz — NOT a defect).** `emergencyStopVfd` (`vfd-command.resolver.ts:149-157`) intentionally omits `@Roles` so any authenticated user can e-stop; documented and correct for safety. Recorded for completeness. RolesGuard is globally registered (`app.module.ts:475`), so `@Roles` on the other VFD mutations is enforced.
- **B7 (fail-open ingestion swallow).** `nats-ingestion-consumer.service.ts:283-287` and `data-ingestion.service.ts:358-360,369-373` catch+log+swallow on enrichment/publish failure. Documented as poison-pill avoidance for the NATS path, but the data-ingestion `handleSensorData` outer catch (`:369`) silently drops a whole message's metrics on any error — verify this cannot mask a systematic ingestion outage (no metric/alert on drop rate beyond a per-minute log).
- **B8 (raw `@InjectDataSource` in tenant paths).** `BatchProcessorService`, `DataIngestionService`, `AlarmStorageService`, `DaqStorageService` all issue raw `dataSource.query('INSERT INTO ...')` with unqualified table names, relying on pooled-connection `search_path` for tenant routing rather than `getScopedRepository`. This is the same fragility class behind CRITICAL-001 and the documented "pooled-conn tenant-context roulette" risk — a systemic pattern worth a platform-level guard.
</content>
