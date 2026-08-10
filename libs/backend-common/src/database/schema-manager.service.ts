// Refactor note: SchemaManagerService is ~1,400 lines and should be split into smaller focused services.
// Recommended decomposition:
//   - SchemaProvisioningService  (createTenantSchema, dropTenantSchema, schemaExists)
//   - SchemaSearchPathService    (setTenantSearchPath, setTenantSearchPathInTransaction, resetSearchPath)
//   - SchemaMigrationService     (migrateDataToTenantSchema, copyReferenceDataTable)
//   - SchemaTimescaleService     (createSensorMetricsHypertable, createContinuousAggregates, etc.)
//   - SchemaIntrospectionService (listTenantSchemas, getSchemaTableCount, validateModuleSchemas)
// Keep MODULE_SCHEMAS and ModuleSchema interface in a separate schemas.constants.ts file.

import * as crypto from 'crypto';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { MIGRATION_LEDGER_TABLE, tenantMigrationLedgerTable } from './migration-ledger';
import { SchemaLRUCache } from './schema-lru-cache';
import {
  getTenantSchemaName as deriveTenantSchemaName,
  isValidUUID,
  listTenantSchemas as listCanonicalTenantSchemas,
} from './tenant-schema.utils';

/**
 * Module schema definitions - tables for each module
 */
export interface ModuleSchema {
  moduleName: string;
  tables: string[];
  sourceSchema: string;
  /** Tables containing reference/lookup data to copy into new tenant schemas */
  referenceDataTables?: string[];
  /**
   * Tables that legitimately live in the source schema but are NOT
   * per-tenant copied. These are service-infrastructure tables:
   * TypeORM's `migrations` bookkeeping, the service's outbox table,
   * any runtime bootstrap tracking tables. They are excluded from
   * `tables` (which drives `CREATE TABLE LIKE`-based tenant
   * provisioning) because copying them per-tenant is nonsensical —
   * each service owns one shared outbox, one migrations ledger, etc.
   *
   * Used by `SourceSchemaBootstrapService.dropOrphanTables()` as part
   * of the legitimate-tables set when `strictOwnership` is enabled:
   * a table present in the source schema is an orphan only if it is
   * NOT in `tables`, NOT in `referenceDataTables`, and NOT in
   * `infrastructureTables`.
   */
  infrastructureTables?: string[];
  /**
   * When `true`, `SourceSchemaBootstrapService` enforces that the
   * source schema contains ONLY tables declared by this module entry
   * (`tables` ∪ `referenceDataTables` ∪ `infrastructureTables`).
   * Any other table found in the schema is an orphan and gets
   * `DROP TABLE … CASCADE`ed on every startup. This closes the
   * cross-module contamination failure mode observed on 2026-04-07/08
   * in farm-service: the farm source schema had accumulated four
   * tables owned by OTHER services (`audit_logs`, `user_consents`,
   * `gdpr_data_requests` from backend-common, `employees` from hr)
   * via a historical transitive-import path that's since been
   * removed. The tables persisted on disk after the import was
   * removed, polluting the farm RLS discovery query and crashing the
   * RLS migration with `operator does not exist: character varying = uuid`
   * because those foreign entities declared `tenantId` as varchar(255).
   *
   * Defaults to `false` (lenient — existing services' behaviour is
   * unchanged). Enabling it on a module is an ARCHITECTURAL DECISION:
   * it makes this list the single authoritative source of truth for
   * the module's schema surface, and requires whoever adds a new
   * entity to also add its table name to this list or the deploy
   * will DROP the newly-created table.
   */
  strictOwnership?: boolean;
}

export interface SyncTenantSchemaOptions {
  /**
   * Existing tenant repair is disabled by default. Runtime DDL drift repair
   * must be handled by authored migrations/fan-out, not best-effort
   * CREATE TABLE LIKE from application code.
   */
  allowExistingTenantRepair?: boolean;
  reason?: string;
}

const cleanupDropProofBrand: unique symbol = Symbol('CleanupDropProof');

export type CleanupDropProofPurpose =
  | 'provisioning_rollback'
  | 'tenant_deprovision'
  | 'tenant_erasure';

export interface CleanupDropProofBackupEvidence {
  id?: string;
  checksum: string;
  sizeBytes: number;
  isEncrypted: true;
  uri?: string;
  createdAt?: string | Date;
  retentionDays?: number;
  algorithm?: string;
  keyId?: string;
}

export interface CleanupDropProof {
  readonly [cleanupDropProofBrand]: true;
  readonly operationId: string;
  readonly tenantId: string;
  readonly purpose: CleanupDropProofPurpose;
  readonly actorId: string;
  readonly approverId?: string;
  readonly reason: string;
  readonly legalHoldCheckedAt?: string;
  readonly backup?: CleanupDropProofBackupEvidence;
  readonly preCounts?: Record<string, unknown>;
  readonly postCounts?: Record<string, unknown>;
  readonly createdAt: string;
}

export function createCleanupDropProof(input: {
  operationId: string;
  tenantId: string;
  purpose: CleanupDropProofPurpose;
  actorId: string;
  approverId?: string;
  reason: string;
  legalHoldCheckedAt?: string | Date;
  backup?: CleanupDropProofBackupEvidence;
  preCounts?: Record<string, unknown>;
  postCounts?: Record<string, unknown>;
  createdAt?: string | Date;
}): CleanupDropProof {
  const proof = Object.freeze({
    [cleanupDropProofBrand]: true as const,
    operationId: input.operationId,
    tenantId: input.tenantId,
    purpose: input.purpose,
    actorId: input.actorId,
    approverId: input.approverId,
    reason: input.reason,
    legalHoldCheckedAt: normalizeOptionalTimestamp(input.legalHoldCheckedAt),
    backup: input.backup,
    preCounts: input.preCounts,
    postCounts: input.postCounts,
    createdAt: normalizeTimestamp(input.createdAt ?? new Date()),
  }) as CleanupDropProof;

  return assertCleanupDropProof(proof, input.tenantId);
}

function normalizeTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeOptionalTimestamp(value: string | Date | undefined): string | undefined {
  return value === undefined ? undefined : normalizeTimestamp(value);
}

function assertCleanupDropProof(
  proof: CleanupDropProof | undefined,
  tenantId: string,
): CleanupDropProof {
  if (!proof || proof[cleanupDropProofBrand] !== true) {
    throw new BadRequestException(
      'CleanupDropProof is required before tenant schema removal can run',
    );
  }
  if (proof.tenantId !== tenantId) {
    throw new BadRequestException('CleanupDropProof tenant does not match target tenant');
  }
  if (!proof.operationId || !proof.actorId || !proof.reason || !proof.purpose) {
    throw new BadRequestException('CleanupDropProof is incomplete');
  }
  if (proof.purpose === 'tenant_deprovision' || proof.purpose === 'tenant_erasure') {
    if (!proof.legalHoldCheckedAt) {
      throw new BadRequestException('CleanupDropProof requires legal-hold evidence');
    }
  }
  if (proof.purpose === 'tenant_deprovision') {
    if (
      !proof.backup ||
      !proof.backup.checksum ||
      Number(proof.backup.sizeBytes) <= 0 ||
      proof.backup.isEncrypted !== true
    ) {
      throw new BadRequestException('CleanupDropProof requires encrypted backup evidence');
    }
  }

  return proof;
}

function toSchemaManagerError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Supported modules and their table definitions.
 *
 * MAINTENANCE CONTRACT:
 * - Every table registered in a NestJS entity (with @Entity decorator) for a module MUST be
 *   listed in the corresponding MODULE_SCHEMAS entry BEFORE the entity is deployed to production.
 * - When adding a new per-tenant table: add it to the `tables` array of the relevant module here.
 * - When adding a source-schema-only owned table: add it to `infrastructureTables` instead.
 * - When removing a table: remove it from both the entity definitions AND this list, then create
 *   a migration to drop the column/table from existing tenant schemas.
 * - Reference data tables (lookup / seed data) must also be listed in `referenceDataTables` so
 *   they are copied into every new tenant schema on provisioning.
 * - Call `SchemaManagerService.validateModuleSchemas()` in integration tests to detect drift
 *   between this list and the actual entity definitions.
 */
// Tenant-erasure proof ledger (tenant_erasure_target_proofs) is source-schema
// infrastructure created per service by the Ensure*TenantErasureProofLedger
// migrations; declared here so strict-ownership bootstrap does not drop it.
const TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES = [
  TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE,
] as const;

export const MODULE_SCHEMAS: ModuleSchema[] = [
  {
    moduleName: 'sensor',
    sourceSchema: 'sensor', // Tables are in sensor schema, will be copied to tenant schema
    // SENSOR-MEDIUM-009: vfd_register_mappings is GLOBAL vendor reference data
    // (declares schema:'sensor'), a single cross-tenant table — NOT per-tenant
    // cloned — so it belongs in the source-schema-only infrastructure set.
    // SENSOR-MEDIUM-004: edge_device_directory is the cross-tenant O(1) index
    // (public identifier -> tenant_id); one table in `sensor`, never cloned.
    // DB-SENSOR-CRITICAL-001 / SENSOR-HIGH-004 / SENSOR-HIGH-053: the SCADA
    // runtime persistence tables (scada_alarms, scada_alarm_chronicle,
    // scada_tag_history) are written by process-wide singleton services with
    // no per-request search_path, so they cannot be per-tenant clones — they
    // live once in `sensor` and carry a mandatory tenant_id discriminator
    // (added by 1806000000000-ScadaTenantIsolation), exactly like
    // edge_device_directory. vfd_command_audit_logs is the append-only VFD
    // command audit ledger (cross-tenant, same class).
    infrastructureTables: [
      'migrations',
      'sensor_audit_logs',
      'sensor_outbox',
      'vfd_register_mappings',
      'edge_device_directory',
      'scada_alarms',
      'scada_alarm_chronicle',
      'scada_tag_history',
      'vfd_command_audit_logs',
      ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES,
    ],
    referenceDataTables: ['sensor_protocols', 'sensor_type_definitions', 'industry_templates'],
    tables: [
      // Core sensor entities
      'sensors',
      // SENSOR-HIGH-085: sensor_readings is retired — a reading is now an as-of
      // projection over each tenant's sensor_metrics hypertable, not a stored
      // per-tenant row. Removed from the fan-out list so new tenants get no such
      // table; existing tenants' orphan tables are dropped by F-085-DROP.
      //
      // sensor_metrics is a PER-TENANT TimescaleDB hypertable: a tenant's
      // telemetry lives in that tenant's schema. Delivered by migration
      // 1815000000000 (unqualified, so provisioning's migration replay creates
      // one per tenant); its rollups are ensured per tenant by
      // ContinuousAggregateService, and SensorMetricWriterService derives the
      // destination schema from each row's tenantId so the process-wide
      // ingestion singletons write to the right tenant without an ambient
      // search_path.
      'sensor_metrics',
      'sensor_data_channels',
      // SENSOR-HIGH-083: per-tenant calibration history (append-only). Written by
      // the calibration aggregate; its entity omits schema: so it must be cloned
      // into every tenant schema alongside sensor_data_channels.
      'calibration_events',
      'sensor_protocols',
      'processes',

      // VFD (Variable Frequency Drive) entities
      // vfd_register_mappings is intentionally NOT here — it is global
      // cross-tenant reference data pinned to `sensor` (see infrastructureTables
      // above, SENSOR-MEDIUM-009), not a per-tenant clone.
      'vfd_devices',
      // Which farm equipment each drive turns, and the units that follow from it.
      // Per-tenant like the drive itself — a binding is meaningless outside the
      // tenant whose equipment it names.
      'vfd_drive_bindings',
      'vfd_drive_binding_units',
      'vfd_readings',
      'vfd_parameter_definitions',
      'vfd_change_sets',
      'vfd_change_set_items',
      'vfd_automation_rules',
      'vfd_parameter_audit_logs',
      // DB-SENSOR-HIGH-003: vfd_command_audit_logs is a CROSS-TENANT audit ledger
      // (declares schema:'sensor', tenant_id-discriminated) — see
      // infrastructureTables above, NOT this per-tenant clone list.

      // Dashboard & Edge devices
      'dashboard_layouts',
      'edge_devices',
      'device_io_configs',

      // PLC control entities
      'plc_connections',
      'plc_alarms',
      'plc_telemetry',
      'feeding_parameters',

      // Automation (IEC 61131-3) entities
      'automation_programs',
      'program_steps',
      'program_transitions',
      'program_variables',
      'step_actions',

      // Dynamic sensor type system
      'sensor_type_definitions',
      'industry_templates',
      'channel_detection_log',

      // Edge Gateway - Self-Registration & Deployment
      'tenant_provisioning_keys',
      'device_events',
      'deployment_logs',

      // SCADA & Unified Tag entities
      'scada_packages',
      'scada_deploy_logs',
      'unified_tags',

      // LoRa & Device Groups
      'lora_devices',
      'device_groups',
      'device_group_members',

      // Edge Platform v2 (per ADR-025 — sensor-service per-tenant ownership;
      // supersedes ADR-022's standalone `edge` schema under admin-api).
      // 7 entities under apps/sensor-service/src/edge-device/entities/v2/.
      'devices',
      'policies',
      'licenses',
      'firmware_releases',
      'provisioning_records',
      'witnesses',
      'audit_archive_v1',

      // Signed deploy pipeline (Faz 3/5) — per-tenant tables (their entities
      // omit `schema:` per ADR-011): content-addressed artifact store +
      // guarded release-bundle ledger. Must be cloned into every tenant schema.
      'deploy_artifacts',
      'release_bundles',
    ],
  },
  {
    moduleName: 'farm',
    sourceSchema: 'farm', // Tables are in farm schema, will be copied to tenant schema
    // ── Phase 14: strict ownership ────────────────────────────────────
    // Farm was the first module to hit cross-module contamination in
    // its source schema (historical transitive imports of
    // backend-common's AuditLogEntity / UserConsent / GdprDataRequest
    // and hr's Employee entity had synchronized their tables into
    // `farm.*` on old deploys, and the tables persisted on disk after
    // those imports were removed). Enabling strictOwnership makes
    // SourceSchemaBootstrapService DROP any table in the farm schema
    // that isn't declared below as owned by the farm module, on every
    // startup. This is the architectural fix for the "orphan table"
    // failure mode — see source-schema-bootstrap.service.ts for the
    // enforcement logic and the 2026-04-08 incident notes behind it.
    strictOwnership: true,
    // Infrastructure tables that live in farm schema but are NOT
    // per-tenant copied. The `tables` array drives tenant provisioning
    // via CREATE TABLE LIKE INCLUDING ALL, and these must be excluded:
    //   - `migrations`        — TypeORM's migration metadata ledger.
    //   - `outbox_events`     — canonical transactional outbox queue.
    //                           `farm_outbox` remains migration/compatibility
    //                           infrastructure only; neither table is cloned.
    //   - `inbox_messages`, `event_dlq`
    //                         — event delivery infrastructure ledgers.
    //   - `tenant_erasure_audit`
    //                         — GDPR erasure idempotency ledger. It is a
    //                           farm-owned source-schema table keyed by
    //                           tenantId, not a per-tenant table to clone.
    // If the service ever adds another runtime-only infrastructure
    // table (bootstrap tracking, rate-limit counters, etc.), add it
    // here so the strict-ownership enforcement doesn't drop it.
    infrastructureTables: [
      'migrations',
      'farm_outbox',
      'outbox_events',
      'inbox_messages',
      'event_dlq',
      'tenant_erasure_audit',
      'farm_audit_logs',
      ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES,
    ],
    // Reference tables are excluded from the source-schema write guard (the
    // deploy-time reconciler assertSourceSchemaWriteGuards subtracts them from the
    // guarded set = tables − referenceDataTables − infrastructureTables) so that
    // seed services (FarmSeedService) can write global/template rows that
    // subsequently get copied into each tenant schema on provisioning via
    // SchemaManagerService.copyReferenceData(). `species` was added in
    // Phase 11.4 because FarmSeedService.seedGlobalCleanerFishSpecies()
    // writes cleaner-fish species with `tenantId = '00000000-0000-0000-0000-000000000000'`
    // (the global-template tenant) directly into `farm.species`, and
    // without this exemption the write-guard trigger raises
    // TENANT_ISOLATION_VIOLATION on the insert. Per-tenant species
    // additions still route through tenant schemas via search_path and
    // are unaffected by this exemption.
    referenceDataTables: [
      'equipment_types',
      'sub_equipment_types',
      'supplier_types',
      'chemical_types',
      'feed_types',
      'species',
    ],
    tables: [
      // Core entities
      'farms',
      'code_sequences',
      'sites',
      'departments',
      'ponds',
      'tanks',
      'tank_allocations',
      'tank_batches',
      'tank_operations',

      // Batch management — `batches` (legacy PondBatch) was removed in
      // commit b5bcec3c and dropped from existing databases by the
      // ConvergeTenantIdTypesAndDropPondBatch1775900000000 migration.
      // `batches_v2` is the current canonical batches table.
      'batches_v2',
      'batch_documents',
      // farm_documents was dropped (ORPHAN-HIGH-369, owner decision): a fully
      // built but unwired DMS surface — DropFarmDocuments1805300000000 removed
      // the physical table from farm + every tenant clone.
      'batch_feed_assignments',
      'batch_locations',
      'species',

      // Equipment hierarchy
      'systems',
      'sub_systems',
      'equipment_types',
      'equipment',
      'equipment_systems',
      'sub_equipment_types',
      'sub_equipment',
      'feeder_calibrations',
      // Yemleyicinin FİZİĞİ (atımlı/sürekli, silo kapasitesi, hız bandı,
      // ağırlık kaynağı) — makine başına TEK satır. Kalibrasyon satırları
      // buna FK ile çakılıdır (ReshapeFeederCalibrationForVfd1809100000000).
      'feeder_capabilities',
      // Ağırlık-tabanlı yemleyicinin yük hücresinin GERÇEKTEN raporladığının
      // kanıtı — sensor_temperature_latest emsali per-tenant projeksiyon.
      'feeder_silo_mass_latest',

      // Maintenance
      'maintenance_schedules',
      'work_orders',
      'spare_parts',

      // Feed management
      'feed_types',
      'feed_type_species',
      'feeds',
      'feed_inventory',
      'feed_sites',
      'feeding_protocols',
      'feeding_records',
      'feeding_tables',
      'feeding_programs',
      'feeding_program_tanks',
      'daily_feeding_executions',
      // Birleşik protokol SSoT (feeding-protocol SSoT Faz 3, FARM-HIGH-219)
      'feeding_protocols_v2',
      'feeding_protocol_assignments',
      'feeding_day_plans',
      'feeding_meals',
      'feeding_forecast_snapshots',
      // Ünite → yemleyici bağlaması ve payların toplamını 100'de tutan türetilmiş
      // çapa satırı (CreateFeederAssignments1808900000000). İkisi de per-tenant
      // DATA tablosudur — `feeder_assignment_unit_totals` bir infrastructure
      // ledger DEĞİLDİR: içeriği tenant'ın kendi atama satırlarından türer, bu
      // yüzden guarded set'te kalması ve tenant şemasına klonlanması doğrudur.
      'feeder_assignments',
      'feeder_assignment_unit_totals',

      // Chemical management
      'chemical_types',
      'chemicals',
      'chemical_sites',

      // Production tracking
      'growth_measurements',
      'mortality_records',
      'water_quality_measurements',
      'water_quality_parameter_configs',
      'water_quality_param_equipment',
      'sensor_temperature_latest',
      'sensor_temperature_daily',
      'health_events',
      'lice_counts',
      'treatment_applications',
      'welfare_assessments',
      'escape_incidents',
      'farm_incident_media',
      'slaughter_facilities',
      'harvest_plans',
      'harvest_records',

      // Suppliers
      'supplier_types',
      'suppliers',
      // Supplier ↔ Site junction + per-site contact people (Scope A
      // Phase 4.4.1). These were declared as @Entity() in the source
      // tree for some time but had no migration and were excluded
      // from this list under INFRA-CRITICAL-019. Migration
      // 1788100000000-WireSupplierSitesAndSiteContacts now creates
      // them per tenant; SupplierModule + SiteModule register them
      // in `forFeature(...)` (Phase 4.4.2 / 4.4.3 wiring).
      'supplier_sites',
      'site_contacts',

      // Storage & Stock Management
      'storage_locations',
      'consumables',
      'storage_inventory',
      'stock_movements',
      'purchase_orders',
      'purchase_order_items',
      'inventory_counts',
      'inventory_count_items',
      'storage_lot_mixes',
      'farm_stock_container_snapshots',
      'farm_stock_batch_snapshots',
      'farm_mobile_command_receipts',

      // Regulatory settings (Maskinporten credentials, company info)
      'regulatory_settings',
      'biomass_reports',
      // Persisted Mattilsynet report submissions (FARM-HIGH-125) — the
      // legal record of what was reported; per-tenant like biomass_reports.
      'regulatory_reports',
      // Scheduler-assembled report drafts awaiting review/approval (RPT-003).
      'regulatory_report_drafts',
      'sentinel_hub_settings',

      // Canonical weather/marine observations plus the frozen legacy settings
      // table retained for existing-tenant schema compatibility. No runtime
      // environmental reader or writer consumes weather_settings.
      'weather_observations',
      'marine_observations',
      'satellite_scene_observations',
      'satellite_scene_coverage_assessments',
      'site_environment_sync_state',
      'environment_metric_sync_outcomes',
      'weather_settings',

      // Task management & Automation
      'tasks',
      'auto_rules',
      'recurring_templates',

      // Workers
      'farm_workers',

      // Finance (farm OPEX/revenue ledger) — migration
      // 1802500000000-CreateFinanceTables. Declared here in the SAME
      // commit as the migration: farm has strictOwnership enabled, so
      // an undeclared table would be DROPPED by
      // SourceSchemaBootstrapService on the next startup.
      'finance_categories',
      'finance_expense_entries',
      'finance_settings',
    ],
  },
  {
    moduleName: 'hr',
    sourceSchema: 'hr', // Tables are in hr schema, will be copied to tenant schema
    // Infrastructure tables live in the source schema but are NOT per-tenant
    // copied — identical rationale to farm_outbox (see farm module entry).
    //   - `migrations` — TypeORM migration ledger. hr-service wires its
    //                    runner via createSchemaVersionGate('hr') in
    //                    app.module.ts and owns
    //                    apps/hr-service/src/database/migrations/ plus
    //                    data-source.ts; listed here so the ledger table is
    //                    never flagged as an orphan during fan-out.
    //   - `hr_outbox`  — Transactional outbox (HR-HIGH-015). One shared
    //                    queue with internal tenantId column for routing;
    //                    never replicated per-tenant. Created by the hr
    //                    baseline migration; the former
    //                    init-scripts/09-hr-outbox.sql bootstrap is gone.
    infrastructureTables: [
      'migrations',
      'hr_outbox',
      'payroll_audit',
      ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES,
    ],
    referenceDataTables: ['leave_types', 'certification_types', 'shifts'],
    tables: [
      // Core Employee & Payroll
      'employees',
      'payrolls',
      'departments_hr',

      // Leave Management
      'leave_types',
      'leave_balances',
      'leave_requests',

      // Attendance & Scheduling
      'shifts',
      'schedules',
      'schedule_entries',
      'scheduling_settings',
      'attendance_records',

      // Weekly Planning
      'weekly_plans',
      'weekly_plan_entries',

      // Holidays
      'holidays',

      // Training
      'training_courses',
      'training_enrollments',
      'training_sessions',

      // Certifications (Aquaculture-specific)
      'certification_types',
      'employee_certifications',

      // Performance Management
      'goals',
      'performance_reviews',
      'employee_kpis',

      // Aquaculture-specific
      'work_areas',
      'work_rotations',
      'safety_training_records',
      'hr_mobile_command_receipts',

      // HR Finance (labour-cost settings + manual HR expense ledger) —
      // migration 1801700000000-CreateHrFinanceTables. `hr_` prefix is
      // mandatory: farm and hr tables are cloned into the SAME
      // tenant_<uuid> schema namespace (precedent: departments_hr).
      'hr_finance_categories',
      'hr_finance_entries',
      'hr_payroll_cost_settings',
    ],
  },
  {
    moduleName: 'hydroponics',
    sourceSchema: 'hydroponics',
    // ── Strict ownership ──────────────────────────────────────────────
    // Wave 4-A.2 baseline migration introduces the first DDL in the
    // hydroponics source schema. Enabling strictOwnership from the
    // start keeps the schema clean: SourceSchemaBootstrapService DROPs
    // any table in `hydroponics.*` that is not declared in `tables`
    // below on every startup, preventing the "orphan table" failure
    // mode that hit `farm` historically (cross-module entity transitive
    // imports synchronizing rogue tables into the source schema).
    strictOwnership: true,
    // `hydroponics_outbox` is source-only delivery infrastructure and is
    // never copied into tenant schemas.
    infrastructureTables: [
      'migrations',
      'hydroponics_outbox',
      ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES,
    ],
    referenceDataTables: [],
    tables: ['hydroponics_config'],
  },
  {
    moduleName: 'alert',
    sourceSchema: 'alert',
    infrastructureTables: [
      'migrations',
      'alert_audit_log',
      'alert_outbox',
      ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES,
    ],
    referenceDataTables: [],
    tables: ['alert_rules', 'alert_incidents', 'escalation_policies', 'alert_history'],
  },
  {
    moduleName: 'ai',
    sourceSchema: 'ai',
    // ── Phase 14: strict ownership ────────────────────────────────────
    // Wave 4-A.2 of the 2026-05-07 bootstrap-restoration plan brought
    // ai-service under the strict-module-ownership umbrella alongside
    // farm. With `strictOwnership: true`, SourceSchemaBootstrapService
    // DROPs any table in the `ai` schema that is not declared as owned
    // by this module on every startup. This blocks the cross-module
    // contamination failure mode (e.g. a stray AuditLogEntity import
    // synchronising into `ai.audit_logs`) deterministically, identical
    // to the architectural fix applied to farm in Phase 14.
    strictOwnership: true,
    // Infrastructure tables live in the source `ai` schema but are NOT
    // per-tenant copied. The `tables` array drives tenant provisioning
    // via CREATE TABLE LIKE INCLUDING ALL; the entries below MUST be
    // excluded from that path:
    //   - `migrations`              — TypeORM migration ledger.
    //                                 AiMigrationRunnerService owns this.
    //   - `ai_outbox`               — Transactional outbox. Single shared
    //                                 queue with internal tenantId column;
    //                                 never replicated per-tenant. Excluded
    //                                 from RLS in app.module.ts:234.
    //   - `tool_execution_audit`    — CROSS-TENANT audit table (entity
    //                                 declares `schema: 'ai'`). The audit
    //                                 row stream spans tenants by design
    //                                 for operator analytics. Lives in
    //                                 `ai.tool_execution_audit` only — NOT
    //                                 cloned into tenant_<uuid> schemas.
    infrastructureTables: [
      'migrations',
      'ai_outbox',
      'tool_execution_audit',
      ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES,
    ],
    referenceDataTables: [],
    tables: [
      // Per-tenant template tables. Each is created as an unqualified
      // table in the `ai` source schema by
      // `1700000000000-CreateInitialSchema` and cloned into every
      // tenant_<uuid> schema by TenantSchemaSyncService.
      'agent_conversations',
      'tenant_agent_configs',
      // Durable per-invocation AI cost ledger (ORPHAN-MEDIUM-380 /
      // DB-PEOPLE-MEDIUM-002) — created current_schema-relative by
      // `1802100000000-CreateConversationTurns`; append-only at the
      // service layer (TurnLedgerService).
      'conversation_turns',
      // MOB-HIGH-001: held actuation proposals (human-in-the-loop confirm
      // flow) — migration 1803000000000-CreateAiProposedActions.
      'ai_proposed_actions',
    ],
  },
  {
    moduleName: 'messaging',
    sourceSchema: 'messaging',
    infrastructureTables: [
      'migrations',
      'messaging_outbox',
      'embeddings_metadata',
      'message_send_idempotency',
      ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES,
    ],
    referenceDataTables: [],
    tables: [
      // Core messaging tables (migration 1711800000000)
      'channels',
      'channel_members',
      'messages',
      'message_attachments',
      'message_receipt_ledger',
      'message_receipts',
      'message_reactions',
      'pinned_messages',
      // AI tables (migration 1711800000001)
      'message_analysis',
      'message_entity_references',
      'knowledge_entries',
      // Compliance tables (migration 1711800000003)
      'retention_policies',
      'legal_holds',
      'compliance_audit_log',
      'user_ai_consents',
    ],
  },
  {
    moduleName: 'billing',
    sourceSchema: 'billing',
    infrastructureTables: [
      'migrations',
      'billing_outbox',
      // A6 / DB-IDENT-MEDIUM-002: jsonb archive of the retired
      // tenant_usage_metrics rows (archive-before-drop, migration
      // 1801700000000) — same class as admin.retired_config_backups.
      'retired_usage_metrics_backup',
      ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES,
    ],
    referenceDataTables: [],
    tables: [
      'subscriptions',
      'subscription_module_items',
      'invoices',
      'payments',
      // tenant_usage_metrics retired 2026-07-13 (A6 / DB-IDENT-MEDIUM-002,
      // ORPHAN-MEDIUM-382): dead parallel usage model with no writer —
      // usage_aggregations/usage_hourly_data below are the usage SSoT.
      'scheduled_plan_changes',
      'usage_aggregations',
      'usage_hourly_data',
      // subscription_provisioning_retries retired 2026-07-13 (ORPHAN-MEDIUM-395):
      // backed the dead event-driven TenantSubscriptionRequestedHandler (never
      // registered, zero emitters). Dropped by migration 1801800000000; the live
      // provisioning path is the PROVISION_TENANT_SUBSCRIPTION command receipt.
      'command_receipts',
      // DB registry completeness (same class as DB-ADMIN-MEDIUM-002): billing
      // domain tables that had drifted out of the registry — `plans` (plan
      // catalog) + `stripe_webhook_events` (Stripe webhook idempotency ledger,
      // same class as command_receipts above).
      'plans',
      'stripe_webhook_events',
    ],
  },
  {
    moduleName: 'admin',
    sourceSchema: 'admin',
    infrastructureTables: [
      'migrations',
      'admin_outbox',
      'tenant_erasure_operations',
      'tenant_schemas',
      'schema_migrations',
      'schema_backups',
      'schema_restores',
      'cleanup_runs',
      'cleanup_run_steps',
      'cleanup_run_events',
      'cleanup_run_evidence',
      // DB-ADMIN-MEDIUM-002: schema-lifecycle backup ledger — same class as
      // schema_backups/schema_restores above (retired-tenant-schema backups).
      'retired_schema_backups',
      // ORPHAN-HIGH-364 follow-on: the TenantProvisioningWorkflow tables
      // (migrations 1800400/1800500/1801200) — legitimate raw-SQL/migration-
      // managed workflow state with no TypeORM entity. Registered so the drift
      // validator + orphan-drop presence checks recognize them.
      'tenant_provisioning_runs',
      'tenant_provisioning_steps',
      'tenant_onboarding_acks',
      // ORPHAN-HIGH-364 items 1-3: the jsonb archive that received the retired
      // legacy config stores' rows before 1801400000000 dropped them
      // (global_configs / system_settings / tenant_configurations). Raw-SQL
      // table (no entity) — registry entry keeps it visible + protected.
      'retired_config_backups',
      ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES,
    ],
    referenceDataTables: [],
    tables: [
      'tenant_activities',
      'tenant_notes',
      'tenant_billing_info',
      'impersonation_sessions',
      'impersonation_permissions',
      'debug_sessions',
      'captured_queries',
      'captured_api_calls',
      'cache_entries_snapshot',
      'feature_flag_overrides',
      'discount_redemptions',
      'custom_plans',
      'message_threads',
      'messages',
      'announcement_acknowledgments',
      'support_tickets',
      'ticket_comments',
      'onboarding_progress',
      'analytics_snapshots',
      'report_definitions',
      'report_executions',
      'background_jobs',
      'job_execution_logs',
      'performance_metrics',
      'performance_snapshots',
      'audit_logs',
      'error_occurrences',
      'error_groups',
      'error_alert_rules',
      'maintenance_modes',
      'feature_toggles',
      'email_templates',
      'ip_access_rules',
      'activity_logs',
      'security_events',
      'security_incidents',
      'data_requests',
      'compliance_reports',
      'login_attempts',
      'api_usage_logs',
      'user_sessions',
      // DB-ADMIN-MEDIUM-002: admin-schema data tables that were absent from this
      // registry, so the ADR-012 drift validator + orphan-drop presence checks
      // did not cover them (an unregistered real table is neither protected nor
      // reconciled). All are @Entity(..., { schema: 'admin' }).
      'discount_codes',
      'module_pricing',
      'plan_definitions',
      'plan_module_assignments',
      'threat_intelligence',
      'retention_policies',
      'database_metrics',
      'slow_query_logs',
      'ingest_backend_policy_state',
      'announcements',
      'job_queues',
      'system_versions',
    ],
  },
  {
    moduleName: 'auth',
    sourceSchema: 'auth',
    referenceDataTables: [],
    tables: ['tenant_roles', 'tenant_role_permissions', 'user_role_assignments'],
  },
  {
    // notification-service is global-schema (no per-tenant copies). These
    // tables live in the `notification` schema after Phase 6/7 moves them
    // out of `public`. Listed here so that when notification-service starts
    // wiring SourceSchemaBootstrap (P2 migration runner work), orphan-drop
    // and table-presence checks have a declarative truth source.
    moduleName: 'notification',
    sourceSchema: 'notification',
    infrastructureTables: [
      'migrations',
      'notification_outbox',
      ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES,
    ],
    referenceDataTables: [],
    tables: ['device_tokens', 'notification_logs', 'command_receipts'],
  },
  {
    // DB-INFRA-HIGH-003: config-service registered as a platform-level
    // (source-schema-tenant-column) tenant-erasure target. NOT tenant-cloned
    // (absent from TENANT_SCOPED_MODULES); per-tenant config rows are deleted
    // by tenantId on erasure. config_outbox + the erasure proof ledger are its
    // cross-tenant infrastructure tables.
    moduleName: 'config',
    sourceSchema: 'config',
    infrastructureTables: [
      'migrations',
      'config_outbox',
      ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES,
    ],
    referenceDataTables: [],
    tables: ['configurations', 'configuration_history'],
  },
  {
    // DB-INFRA-HIGH-003: event-store-service — platform-level erasure target.
    // The tenant-column projection tables are deleted by tenantId on erasure;
    // stored_events is intentionally NOT deleted (immutable append-only log —
    // excluded in the erasure registry; awaits crypto-shred). NOT tenant-cloned.
    moduleName: 'event_store',
    sourceSchema: 'event_store',
    infrastructureTables: [
      'migrations',
      'event_store_outbox',
      'tenant_payload_keys',
      ...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES,
    ],
    referenceDataTables: [],
    tables: [
      'stored_events',
      'event_streams',
      'snapshots',
      'projection_checkpoints',
      'projection_rebuilds',
    ],
  },
  {
    // ORPHAN-HIGH-365: the `compliance` schema existed in the live DB with NO
    // registry entry — its single table is litigation/GDPR-critical (legal-hold
    // precedence gates every destructive path), yet the drift validator and the
    // orphan-drop presence checks were blind to it. Owner: admin-api-service
    // (its migration 1787500000000-CreateComplianceLegalHolds created the
    // schema; the LegalHold entity lives there and admin-api's own
    // SchemaDriftValidator validates it at boot). Cross-tenant ledger — never
    // per-tenant cloned — so it is an infrastructure table.
    moduleName: 'compliance',
    sourceSchema: 'compliance',
    infrastructureTables: ['legal_holds'],
    referenceDataTables: [],
    tables: [],
  },
  {
    // ORPHAN-MEDIUM-362 follow-on: observability-service had schema-declaring
    // entities but NO registry entry. All four tables are migration/schema
    // observability infrastructure (written by the migration/backfill pipeline
    // and emergency-override tooling), single cross-tenant copies — never
    // per-tenant cloned. observability-service already registers
    // SchemaDriftModule.forRoot (app.module), so its boot validator now has a
    // matching registry surface.
    moduleName: 'observability',
    sourceSchema: 'observability',
    infrastructureTables: [
      'migrations',
      'emergency_overrides',
      'migration_backfill_progress',
      'migration_events',
      'schema_object_history',
    ],
    referenceDataTables: [],
    tables: [],
  },
  {
    // ORPHAN-HIGH-365: the `platform` schema holds db-migrate/bootstrap-owned
    // raw-SQL infrastructure (the bootstrap signal, the release ledger, the
    // tenant-schema-provisioner job queue). It has NO TypeORM entities and no
    // owning NestJS service by design — the entry exists so the registry is a
    // complete map of every non-tenant schema and a future strictOwnership or
    // orphan sweep can never mistake these for droppable orphans.
    moduleName: 'platform',
    sourceSchema: 'platform',
    infrastructureTables: ['bootstrap_signal', 'release_ledger', 'tenant_schema_jobs'],
    referenceDataTables: [],
    tables: [],
  },
];

/**
 * Reference data tables to copy for each module.
 * Derived from MODULE_SCHEMAS.referenceDataTables to ensure a single source of truth.
 *
 * NOTE: Reference data is copied from the same sourceSchema defined in MODULE_SCHEMAS.
 */
/**
 * Default module names for tenant provisioning.
 *
 * This list is deliberately narrower than MODULE_SCHEMAS: MODULE_SCHEMAS is the
 * complete registry of schemas known to SchemaManagerService, including
 * platform-level schemas such as auth and notification. DEFAULT_TENANT_MODULES
 * is the schema-per-tenant fan-out set only.
 *
 * Usage:
 *   import { DEFAULT_TENANT_MODULES } from '@aquaculture/backend-common/database';
 *   await schemaManager.createTenantSchema(tenantId, DEFAULT_TENANT_MODULES);
 */
export const TENANT_SCOPED_MODULES: ReadonlySet<string> = new Set([
  'sensor',
  'farm',
  'hr',
  'hydroponics',
  'alert',
  'ai',
  'messaging',
]);

export const PLATFORM_LEVEL_MODULES: ReadonlySet<string> = new Set([
  'admin',
  'auth',
  'notification',
  'config',
  'event_store',
  // Registry-completeness sweep (ORPHAN-HIGH-365 / DB audit A-classification):
  // billing was in NEITHER classification set (flagged by the DB audit);
  // compliance/observability/platform gained MODULE_SCHEMAS entries and are
  // platform-level by nature (single cross-tenant schemas, no per-tenant fan-out).
  'billing',
  'compliance',
  'observability',
  'platform',
]);

export const DEFAULT_TENANT_MODULES: string[] = MODULE_SCHEMAS.filter((m) =>
  TENANT_SCOPED_MODULES.has(m.moduleName),
).map((m) => m.moduleName);

export const REFERENCE_DATA_TABLES: Record<string, string[]> = Object.fromEntries(
  MODULE_SCHEMAS.map((m) => [m.moduleName, m.referenceDataTables || []]),
);

/**
 * Single source of truth for a service's RLS `excludeTables` set.
 *
 * The tables RLS must NOT touch are exactly the service's cross-tenant
 * infrastructure tables (outbox, migrations ledger, source-schema audit
 * ledgers, tenant-erasure proof ledgers) — i.e. `infrastructureTables` from
 * `MODULE_SCHEMAS`. CLAUDE.md (ADR-011/012) mandates "do not hardcode a copy"
 * of that set; service `app.module.ts` callsites pass
 * `excludeTables: getRlsExcludeTablesForService('<service>')` instead of an
 * inline literal, so a new infra table (or a renamed audit ledger) flows to the
 * RLS exclusion automatically and can never drift (the prior farm copy carried
 * phantom `audit_logs`/`audit_log` and omitted the real `farm_audit_logs`).
 *
 * Fail-fast on an unknown module name — a typo'd serviceName must not silently
 * yield an empty exclusion set (which would apply tenant RLS to the outbox).
 *
 * NOTE: cross-tenant platform services whose RLS exclusion legitimately covers
 * DOMAIN tables (e.g. auth excludes `users`/`tenants`, which are not
 * "infrastructure") do NOT use this helper — see the rls-exclude-tables
 * invariant's documented exemptions.
 */
export function getRlsExcludeTablesForService(moduleName: string): string[] {
  const module = MODULE_SCHEMAS.find((m) => m.moduleName === moduleName);
  if (!module) {
    throw new Error(
      `getRlsExcludeTablesForService: unknown module '${moduleName}' — not declared in MODULE_SCHEMAS`,
    );
  }
  return module.infrastructureTables ?? [];
}

/**
 * Auth is the ONE service whose RLS exclusions include DOMAIN tables, not just
 * infrastructure: auth resolves a tenant by reading `users`/`tenants` pre-auth
 * (SUPER_ADMIN rows carry `tenantId=NULL`), so those tables cannot carry a
 * tenant-RLS policy. `getRlsExcludeTablesForService('auth')` only knows the
 * infrastructure tables, so auth's list is declared HERE as the single SSoT —
 * imported by BOTH the runtime `RlsModule.forPoolService` (auth app.module) AND
 * the db-migrate provisioner's SCHEMA_REGISTRY (schema-registry.ts) so the two
 * hand-maintained copies can never drift. Add a new auth cross-tenant/identity
 * table here and both sides pick it up.
 */
export const AUTH_RLS_EXCLUDE_TABLES: readonly string[] = ['auth_outbox', 'users', 'tenants'];

/**
 * Provisioning status to distinguish total failure from partial success
 */
export enum ProvisioningStatus {
  /** All tables created successfully */
  COMPLETE = 'COMPLETE',
  /** Schema exists but some tables failed to create */
  PARTIAL = 'PARTIAL',
  /** Schema creation failed entirely (schema was dropped/cleaned up) */
  FAILED = 'FAILED',
}

/**
 * Schema creation result
 */
export interface SchemaCreationResult {
  success: boolean;
  /** Detailed provisioning status distinguishing partial from total failure */
  status: ProvisioningStatus;
  schemaName: string;
  tablesCreated: string[];
  referenceDataCopied: { table: string; rows: number }[];
  errors: string[];
  duration: number;
  alreadyExists?: boolean;
  /**
   * True when at least one table was created successfully AND at least one error
   * was also recorded. Provides a quick boolean signal for consumers that need to
   * distinguish "some succeeded, some failed" from a clean success or a total
   * failure without inspecting `status === ProvisioningStatus.PARTIAL` directly.
   */
  partialSuccess?: boolean;
}

/**
 * SEC-M13: Validate tenant schema name format to prevent SQL injection.
 * Only allows the pattern 'public' or 'tenant_{16 hex chars}' which is the
 * standard tenant schema naming convention used across the platform.
 * This is a defense-in-depth measure — schema names are also validated at the guard level.
 *
 * @param schema - The schema name to validate
 * @returns The validated schema name (unchanged)
 * @throws Error if the schema name does not match the expected format
 */
export function validateTenantSchemaName(schema: string): string {
  if (schema === 'public') return schema;
  const TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/;
  if (!TENANT_SCHEMA_REGEX.test(schema)) {
    throw new Error(`SEC-M13: Invalid schema name format: ${schema}`);
  }
  return schema;
}

/**
 * SECURITY: Validate SQL identifier (schema/table name) to prevent injection
 * Only allows alphanumeric characters and underscores
 * @throws BadRequestException if identifier contains invalid characters
 */
function validateSqlIdentifier(identifier: string, type: 'schema' | 'table'): string {
  const identifierRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  if (!identifierRegex.test(identifier) || identifier.length > 63) {
    throw new BadRequestException(
      `SECURITY: Invalid ${type} identifier: ${identifier}. Only alphanumeric and underscore allowed.`,
    );
  }
  return identifier;
}

/**
 * Schema Manager Service
 * Manages tenant-specific PostgreSQL schemas for complete data isolation
 *
 * Features:
 * - Advisory locks for race condition prevention
 * - LRU caching for schema existence checks
 * - SQL injection prevention via UUID validation AND identifier validation
 * - Reference data copying for lookup tables
 * - Atomic schema creation with cleanup on failure
 */
@Injectable()
export class SchemaManagerService {
  private readonly logger = new Logger(SchemaManagerService.name);

  /** LRU cache for schema existence checks (max 1000 entries, positive TTL=5 min, negative TTL=30 s) */
  private readonly schemaCache = new SchemaLRUCache(1000, 5 * 60 * 1000, 30_000);

  constructor(private readonly dataSource: DataSource) {}

  private static isQueryRow(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private static countFromRow(row: Record<string, unknown> | undefined): number {
    const value = row?.['count'];
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private async queryRows(
    sql: string,
    parameters?: unknown[],
  ): Promise<Array<Record<string, unknown>>> {
    const rows: unknown = await this.dataSource.query(sql, parameters);
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows.filter((row) => SchemaManagerService.isQueryRow(row));
  }

  private async queryExists(sql: string, parameters?: unknown[]): Promise<boolean> {
    return (await this.queryRows(sql, parameters)).length > 0;
  }

  private async queryCount(sql: string, parameters?: unknown[]): Promise<number> {
    return SchemaManagerService.countFromRow((await this.queryRows(sql, parameters))[0]);
  }
  /**
   * Generate tenant schema name from tenant ID
   * Format: tenant_{first16chars_of_uuid} (uses 16 chars to avoid collisions)
   *
   * Note: Using 16 hex characters provides 2^64 possible combinations,
   * making collisions practically impossible (birthday problem threshold ~4 billion tenants)
   *
   * @throws BadRequestException if tenant ID is not a valid UUID
   */
  getTenantSchemaName(tenantId: string): string {
    if (!isValidUUID(tenantId)) {
      throw new BadRequestException(`Invalid tenant ID format: ${tenantId}`);
    }

    return deriveTenantSchemaName(tenantId);
  }

  /**
   * Validate that schema name is safe for SQL queries
   * Additional safety layer beyond UUID validation
   */
  private isValidSchemaName(schemaName: string): boolean {
    // Match tenant_ prefix + 16 hex characters
    return /^tenant_[a-f0-9]{16}$/.test(schemaName);
  }

  /**
   * Create a new tenant schema with all module tables
   *
   * Runtime services do not perform tenant DDL. Existing schemas are validated
   * for completeness; new provisioning is queued through aqua-db-migrate.
   */
  async createTenantSchema(
    tenantId: string,
    modules: string[] = DEFAULT_TENANT_MODULES,
  ): Promise<SchemaCreationResult> {
    const startTime = Date.now();
    const schemaName = this.getTenantSchemaName(tenantId);
    const tablesCreated: string[] = [];
    const referenceDataCopied: { table: string; rows: number }[] = [];
    const errors: string[] = [];

    // Validate schema name as additional safety
    if (!this.isValidSchemaName(schemaName)) {
      return {
        success: false,
        status: ProvisioningStatus.FAILED,
        schemaName,
        tablesCreated: [],
        referenceDataCopied: [],
        errors: [`Invalid schema name generated: ${schemaName}`],
        duration: Date.now() - startTime,
      };
    }

    if (modules.length === 0) {
      return {
        success: false,
        status: ProvisioningStatus.FAILED,
        schemaName,
        tablesCreated: [],
        referenceDataCopied: [],
        errors: ['No tenant modules requested for schema provisioning'],
        duration: Date.now() - startTime,
      };
    }

    const unknownModules = modules.filter(
      (moduleName) => !MODULE_SCHEMAS.some((m) => m.moduleName === moduleName),
    );
    if (unknownModules.length > 0) {
      return {
        success: false,
        status: ProvisioningStatus.FAILED,
        schemaName,
        tablesCreated: [],
        referenceDataCopied: [],
        errors: [`Unknown tenant module(s): ${unknownModules.join(', ')}`],
        duration: Date.now() - startTime,
      };
    }

    try {
      // Check if schema already exists (idempotent operation)
      const exists = await this.schemaExistsNoCache(schemaName);
      if (exists) {
        this.logger.log(`Schema ${schemaName} already exists, verifying completeness`);
        const completenessErrors = await this.validateTenantSchemaComplete(schemaName, modules);
        if (completenessErrors.length > 0) {
          this.schemaCache.invalidate(schemaName);
          return {
            success: false,
            status: ProvisioningStatus.PARTIAL,
            schemaName,
            tablesCreated: [],
            referenceDataCopied: [],
            errors: completenessErrors,
            duration: Date.now() - startTime,
            alreadyExists: true,
            partialSuccess: true,
          };
        }

        this.schemaCache.set(schemaName, true);
        return {
          success: true,
          status: ProvisioningStatus.COMPLETE,
          schemaName,
          tablesCreated: [],
          referenceDataCopied: [],
          errors: [],
          duration: Date.now() - startTime,
          alreadyExists: true,
        };
      }

      const authorityError =
        `Tenant schema provisioning for ${schemaName} is owned by aqua-db-migrate; ` +
        `runtime services must write a provisioning request ledger entry instead.`;
      this.logger.warn(authorityError);
      return {
        success: false,
        status: ProvisioningStatus.FAILED,
        schemaName,
        tablesCreated: [],
        referenceDataCopied: [],
        errors: [authorityError],
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const schemaError = toSchemaManagerError(error);
      const errorMsg = `Failed to create tenant schema: ${schemaError.message}`;
      this.logger.error(errorMsg, schemaError.stack);
      errors.push(errorMsg);

      // CLEANUP: Drop partial schema on failure
      this.logger.warn(`Cleaning up partial schema ${schemaName} after failure`);
      try {
        this.dropTenantSchema(
          schemaName,
          tenantId,
          this.createProvisioningRollbackDropProof(
            tenantId,
            'partial tenant schema provisioning failed',
          ),
        );
        this.logger.log(`Cleaned up partial schema ${schemaName}`);
      } catch (cleanupError) {
        this.logger.error(`Cleanup failed for ${schemaName}: ${(cleanupError as Error).message}`);
      }

      return {
        success: false,
        status: ProvisioningStatus.FAILED,
        schemaName,
        tablesCreated,
        referenceDataCopied,
        errors,
        duration: Date.now() - startTime,
      };
    }
  }

  private async validateTenantSchemaComplete(
    schemaName: string,
    modules: string[],
  ): Promise<string[]> {
    const errors: string[] = [];
    const safeSchema = validateSqlIdentifier(schemaName, 'schema');
    const seenSourceSchemas = new Set<string>();

    for (const moduleName of modules) {
      const moduleSchema = MODULE_SCHEMAS.find((m) => m.moduleName === moduleName);
      if (!moduleSchema) {
        errors.push(`Unknown module ${moduleName}; cannot validate tenant schema completeness`);
        continue;
      }

      for (const tableName of moduleSchema.tables) {
        const sourceExists = await this.tableExists(moduleSchema.sourceSchema, tableName);
        if (!sourceExists) {
          errors.push(`Source schema ${moduleSchema.sourceSchema} missing table ${tableName}`);
          continue;
        }

        const targetExists = await this.tableExists(safeSchema, tableName);
        if (!targetExists) {
          errors.push(`Tenant schema ${safeSchema} missing table ${tableName}`);
        }
      }

      if (seenSourceSchemas.has(moduleSchema.sourceSchema)) continue;
      seenSourceSchemas.add(moduleSchema.sourceSchema);
      const safeSource = validateSqlIdentifier(moduleSchema.sourceSchema, 'schema');
      const sourceHasLedger = await this.tableExists(safeSource, MIGRATION_LEDGER_TABLE);
      if (!sourceHasLedger) continue;

      const sourceRows: Array<{ count: string }> = await this.dataSource.query(
        `SELECT COUNT(*)::text AS count
           FROM "${safeSource}"."${MIGRATION_LEDGER_TABLE}"`,
      );
      if (parseInt(sourceRows[0]?.count ?? '0', 10) === 0) continue;

      const tenantLedger = tenantMigrationLedgerTable(safeSource);
      const tenantHasLedger = await this.tableExists(safeSchema, tenantLedger);
      if (!tenantHasLedger) {
        errors.push(`Tenant schema ${safeSchema} missing ledger ${tenantLedger}`);
        continue;
      }

      const tenantRows: Array<{ count: string }> = await this.dataSource.query(
        `SELECT COUNT(*)::text AS count FROM "${safeSchema}"."${tenantLedger}"`,
      );
      if (parseInt(tenantRows[0]?.count ?? '0', 10) === 0) {
        errors.push(`Tenant schema ${safeSchema} has empty ledger ${tenantLedger}`);
      }
    }

    return errors;
  }

  /**
   * Delete a tenant schema and all its data.
   *
   * Runtime services do not perform tenant DDL; deletion is queued through
   * aqua-db-migrate with CleanupDropProof evidence.
   */
  deleteTenantSchema(
    tenantId: string,
    proof: CleanupDropProof,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const dropProof = assertCleanupDropProof(proof, tenantId);
      const schemaName = this.getTenantSchemaName(tenantId);

      this.logger.log(
        `Deleting tenant schema ${schemaName} with cleanup proof ${dropProof.operationId} (${dropProof.purpose})`,
      );
      const authorityError =
        `Tenant schema deletion for ${schemaName} is owned by aqua-db-migrate; ` +
        `runtime services must write a deletion request ledger entry instead.`;
      this.logger.warn(authorityError);
      return Promise.resolve({ success: false, error: authorityError });
    } catch (error) {
      if (error instanceof BadRequestException) {
        return Promise.reject(error);
      }

      const errorMsg = `Failed to delete tenant schema: ${toSchemaManagerError(error).message}`;
      this.logger.error(errorMsg);
      return Promise.resolve({ success: false, error: errorMsg });
    }
  }

  private createProvisioningRollbackDropProof(tenantId: string, reason: string): CleanupDropProof {
    return createCleanupDropProof({
      operationId: crypto.randomUUID(),
      tenantId,
      purpose: 'provisioning_rollback',
      actorId: 'schema-manager',
      reason,
    });
  }

  private dropTenantSchema(schemaName: string, tenantId: string, proof: CleanupDropProof): void {
    assertCleanupDropProof(proof, tenantId);
    validateSqlIdentifier(schemaName, 'schema');
    throw new Error(
      `Tenant schema deletion for ${schemaName} is owned by aqua-db-migrate; ` +
        `runtime services must write a cleanup request ledger entry instead.`,
    );
  }

  /**
   * Check if a schema exists (with LRU caching)
   * Use this for frequent checks to reduce database load
   */
  async schemaExists(schemaName: string): Promise<boolean> {
    // Check cache first
    const cached = this.schemaCache.get(schemaName);
    if (cached !== undefined) {
      return cached;
    }

    // Query database
    const exists = await this.schemaExistsNoCache(schemaName);
    this.schemaCache.set(schemaName, exists);
    return exists;
  }

  /**
   * Check if a schema exists (bypasses cache)
   * Use this when you need guaranteed fresh result
   */
  async schemaExistsNoCache(schemaName: string): Promise<boolean> {
    return this.queryExists(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [
      schemaName,
    ]);
  }

  /**
   * Check if tenant schema exists (convenience method)
   */
  async tenantSchemaExists(tenantId: string): Promise<boolean> {
    const schemaName = this.getTenantSchemaName(tenantId);
    return this.schemaExists(schemaName);
  }

  /**
   * Invalidate schema cache entry
   * Call this after schema deletion
   */
  invalidateSchemaCache(schemaName: string): void {
    this.schemaCache.invalidate(schemaName);
  }

  /**
   * Clear entire schema cache
   * Use sparingly, typically only for testing
   */
  clearSchemaCache(): void {
    this.schemaCache.clear();
  }

  /**
   * Check if a table exists in a schema
   */
  async tableExists(schemaName: string, tableName: string): Promise<boolean> {
    return this.queryExists(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2`,
      [schemaName, tableName],
    );
  }

  /**
   * Migrate existing data from shared schema to tenant schema
   *
   * SECURITY: All schema and table names are validated before use in SQL
   * to prevent SQL injection attacks.
   */
  async migrateDataToTenantSchema(
    tenantId: string,
    sourceSchema: string,
    tableName: string,
  ): Promise<{ rowsMigrated: number; error?: string }> {
    const schemaName = this.getTenantSchemaName(tenantId);

    // SECURITY: Validate all identifiers before using in SQL queries
    const safeSchemaName = validateSqlIdentifier(schemaName, 'schema');
    const safeSourceSchema = validateSqlIdentifier(sourceSchema, 'schema');
    const safeTableName = validateSqlIdentifier(tableName, 'table');

    try {
      this.logger.log(
        `Migrating data from ${safeSourceSchema}.${safeTableName} to ${safeSchemaName}.${safeTableName}`,
      );

      // Count rows before migration
      const beforeCount = await this.queryCount(
        `SELECT COUNT(*) as count FROM "${safeSchemaName}"."${safeTableName}"`,
      );

      // Insert data with tenant filter
      // Note: tenant column name varies by table (tenant_id for sensor/new tables, tenantId for legacy farm/hr)
      // Try tenant_id first (snake_case), fall back to "tenantId" (camelCase)
      try {
        await this.dataSource.query(
          `
          INSERT INTO "${safeSchemaName}"."${safeTableName}"
          SELECT * FROM "${safeSourceSchema}"."${safeTableName}"
          WHERE tenant_id = $1
          ON CONFLICT DO NOTHING
        `,
          [tenantId],
        );
      } catch (insertError) {
        const err = insertError as Error & { code?: string };
        const message = err.message ?? '';
        if (err.code !== '42703' && !message.includes('column "tenant_id" does not exist')) {
          throw insertError;
        }
        await this.dataSource.query(
          `
          INSERT INTO "${safeSchemaName}"."${safeTableName}"
          SELECT * FROM "${safeSourceSchema}"."${safeTableName}"
          WHERE "tenantId" = $1
          ON CONFLICT DO NOTHING
        `,
          [tenantId],
        );
      }

      // Count rows after migration to get actual migrated count
      const afterCount = await this.queryCount(
        `SELECT COUNT(*) as count FROM "${safeSchemaName}"."${safeTableName}"`,
      );
      const rowsMigrated = afterCount - beforeCount;

      this.logger.log(`Migrated ${rowsMigrated} rows to ${safeSchemaName}.${safeTableName}`);

      return { rowsMigrated };
    } catch (error) {
      const errorMsg = `Migration failed: ${(error as Error).message}`;
      this.logger.error(errorMsg);
      return { rowsMigrated: 0, error: errorMsg };
    }
  }

  /**
   * Get all tenant schemas
   */
  async listTenantSchemas(): Promise<string[]> {
    return listCanonicalTenantSchemas(this.dataSource);
  }

  /**
   * Get table count for a schema
   */
  async getSchemaTableCount(schemaName: string): Promise<number> {
    return this.queryCount(
      `SELECT COUNT(*) as count
       FROM information_schema.tables
       WHERE table_schema = $1`,
      [schemaName],
    );
  }

  /**
   * Validate that MODULE_SCHEMAS is consistent with the actual source schemas in the database.
   *
   * Intended for use in integration tests to detect drift between the MODULE_SCHEMAS
   * constant and the actual entity/migration definitions. Checks that every table listed
   * in MODULE_SCHEMAS exists in the corresponding source schema.
   *
   * @returns An object describing which registered tables were found and which were missing.
   *
   * @example
   * // In an integration test:
   * const result = await schemaManager.validateModuleSchemas();
   * expect(result.missing).toHaveLength(0);
   */
  async validateModuleSchemas(): Promise<{
    valid: boolean;
    missing: Array<{ module: string; table: string; sourceSchema: string }>;
    found: Array<{ module: string; table: string; sourceSchema: string }>;
  }> {
    const missing: Array<{ module: string; table: string; sourceSchema: string }> = [];
    const found: Array<{ module: string; table: string; sourceSchema: string }> = [];

    for (const moduleSchema of MODULE_SCHEMAS) {
      for (const tableName of moduleSchema.tables) {
        const exists = await this.tableExists(moduleSchema.sourceSchema, tableName);
        const entry = {
          module: moduleSchema.moduleName,
          table: tableName,
          sourceSchema: moduleSchema.sourceSchema,
        };
        if (exists) {
          found.push(entry);
        } else {
          missing.push(entry);
          this.logger.warn(
            `MODULE_SCHEMAS validation: table "${moduleSchema.sourceSchema}"."${tableName}" ` +
              `registered for module "${moduleSchema.moduleName}" does not exist in the database.`,
          );
        }
      }
    }

    return {
      valid: missing.length === 0,
      missing,
      found,
    };
  }

  /**
   * Set search_path within a transaction (connection-safe)
   * Use this for reliable tenant isolation in connection pools
   *
   * SECURITY: Uses SET LOCAL which is transaction-scoped and safe.
   * Schema name is validated to prevent SQL injection.
   *
   * @example
   * await dataSource.transaction(async (manager) => {
   *   await schemaManager.setTenantSearchPathInTransaction(manager, tenantId);
   *   // All queries in this transaction will use tenant schema
   *   await manager.query('SELECT * FROM sensors');
   * });
   */
  async setTenantSearchPathInTransaction(
    manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    tenantId: string,
  ): Promise<void> {
    const schemaName = this.getTenantSchemaName(tenantId);

    // SECURITY: Double-check schema name format to prevent SQL injection
    if (!this.isValidSchemaName(schemaName)) {
      throw new BadRequestException(`SECURITY: Invalid schema name format: ${schemaName}`);
    }

    // SECURITY: Use parameterized query with pg_catalog.set_config for safe schema setting
    // The 'true' parameter makes it LOCAL (transaction-scoped)
    await manager.query(`SELECT pg_catalog.set_config('search_path', $1 || ', public', true)`, [
      schemaName,
    ]);
  }

  /**
   * Sync existing tenant schema — add any missing tables from MODULE_SCHEMAS.
   *
   * Unlike createTenantSchema (which starts from scratch), this method:
   * 1. Iterates MODULE_SCHEMAS for requested modules
   * 2. Checks each table with tableExists()
   * 3. Creates only the missing ones via CREATE TABLE ... LIKE ... INCLUDING ALL
   * 4. Copies missing reference data
   *
   * Safe to call repeatedly (idempotent).
   */
  async syncTenantSchema(
    tenantId: string,
    modules: string[] = DEFAULT_TENANT_MODULES,
    options: SyncTenantSchemaOptions = {},
  ): Promise<{ created: string[]; skipped: string[]; errors: string[] }> {
    const schemaName = this.getTenantSchemaName(tenantId);
    const created: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    // Check schema exists
    const exists = await this.schemaExistsNoCache(schemaName);
    if (!exists) {
      errors.push(`Schema ${schemaName} does not exist`);
      return { created, skipped, errors };
    }

    const msg =
      `Runtime tenant schema repair is disabled for existing tenant schema ${schemaName}. ` +
      `Requested modules=${modules.join(', ')} reason=${options.reason ?? 'unspecified'}. ` +
      'Tenant schema creation and repair are owned by the db-migrate tenant provisioner.';
    this.logger.error(msg);
    errors.push(msg);
    return { created, skipped, errors };
  }
}
