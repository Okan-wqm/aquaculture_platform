import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * CreateInitialSchema1700000000000
 * ============================================================================
 *
 * Restores the farm-service migration baseline that was lost when several
 * earlier `CREATE TABLE` migrations were squashed out of source. On a
 * fresh-volume bootstrap, the remaining migration chain (1734336000000+)
 * assumes baseline tables that no longer have a creation step.
 *
 * Concrete failure on a fresh DB:
 * `1734500000000-AddBatchDocuments` ALTERs `batches_v2` to add the
 * `arrivalMethod` column — but `batches_v2` is never created anywhere in
 * the surviving migration set. Same applies to `farms`, `ponds`, `tanks`,
 * `batch_locations`, `batch_feed_assignments`, `tank_batches`,
 * `tank_allocations`.
 *
 * Wave 5 ordering bug (closed by this revision):
 *   The init script `03-farm-tables-and-seed.sql` historically created
 *   `sites`, `departments`, `systems`, `sub_systems`, `equipment_types`,
 *   `equipment`, `species` in `public` (then `1786000000000-MovePublicTablesToFarm`
 *   was supposed to relocate them — except that migration only moves
 *   weather/marine/feeder tables, never these). Meanwhile this baseline
 *   migration creates `farm.tanks` with an FK to `farm.departments` and
 *   `farm.batches_v2` with an FK to `farm.species` — both FK targets did
 *   not exist in the `farm` schema at migration time, breaking fresh-DB
 *   bootstrap with a foreign-key-target-missing error. The fix is to
 *   create the seven seed tables in `farm.*` directly here, ahead of the
 *   tables that depend on them.
 *
 * # Scope
 *
 *   1. Create 7 init-script-equivalent `farm.*` tables idempotently:
 *        sites, departments, systems, sub_systems, equipment_types,
 *        equipment, species.
 *   2. Create 8 baseline `farm.*` tables idempotently in topological FK
 *      order:
 *        farms, ponds, tanks, batches_v2, batch_locations,
 *        batch_feed_assignments, tank_batches, tank_allocations.
 *   3. Create the 20 enum types those tables depend on idempotently:
 *        farm_site_status, farm_system_type, farm_system_status,
 *        farm_sub_system_type, farm_sub_system_status,
 *        farm_equipment_category, farm_equipment_status,
 *        farm_department_type, farm_department_status,
 *        farm_water_type, farm_pond_status, farm_tank_type,
 *        farm_tank_material, farm_tank_status, farm_batch_status,
 *        farm_batch_input_type, farm_batch_type, farm_location_type,
 *        farm_transfer_reason, farm_allocation_type.
 *
 * # Idempotency
 *
 * Every DDL statement uses `IF NOT EXISTS` (tables, columns, indexes) and
 * `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL` blocks for enum
 * types and FK constraints. A second run is a no-op. This is required
 * because:
 *
 *   - The migration ledger only inserts the entry once, but a partial
 *     first-run failure (e.g. transient network) may leave some objects
 *     already created when the migration is retried.
 *   - The init script may already have established a subset of these
 *     objects on legacy environments.
 *
 * # Schema qualification
 *
 * Every object name is qualified with `farm.` rather than relying on
 * search_path. The MigrationRunnerService pins `search_path = farm,
 * public` before each migration but explicit qualification is the
 * defence-in-depth against any future search_path leak — and matches the
 * pattern used in `apps/auth-service/src/migrations/1700000000000-
 * CreateInitialSchema.ts`.
 *
 * # Topological order
 *
 *   farms (no FKs to farm.*)
 *     → ponds (FK farms)
 *   tanks (FK departments — created by init script)
 *   batches_v2 (FK species — created by init script)
 *     → batch_locations (FK batches_v2; tankId/pondId polymorphic, ON DELETE SET NULL)
 *     → batch_feed_assignments (FK batches_v2; no FK to feeds — feed table
 *       is created by a later migration not in scope here)
 *     → tank_batches (FK batches_v2; tankId not FK'd — tanks/equipment
 *       polymorphic per entity decorator)
 *     → tank_allocations (FK batches_v2)
 *
 * # Why no FK from tank_batches/tank_allocations.tankId → tanks.id
 *
 * The Tank entity decorator references `'Tank'` and `'Equipment'`
 * polymorphically (see tank-batch.entity.ts L100, tank-allocation.entity.ts
 * L103) and the `tankId` column is allowed to point at either `tanks.id`
 * or `equipment.id` rows depending on tenant configuration. Attempting a
 * single FK would fragment that polymorphism. Same logic applies to
 * `batch_locations.tankId`.
 *
 * # Why TIMESTAMPTZ for every date column
 *
 * The codebase standardises on TIMESTAMPTZ across the farm schema; the
 * later `ConvertAuditColumnsToTimestamptz1781900000000` migration converts
 * any plain `TIMESTAMP` survivors and uses `information_schema` to skip
 * tables/columns it cannot find — so creating the new tables with
 * `TIMESTAMPTZ` from birth is consistent with both the entity decorators
 * (`type: 'timestamptz'`) and the timestamptz-only invariant.
 *
 * # Why uuid for tenantId
 *
 * The later `ConvergeTenantIdTypesAndDropPondBatch1775900000000` migration
 * converges legacy varchar `tenantId` columns to uuid; creating fresh
 * tables with `uuid` from birth means that migration's per-table check
 * sees the column already-uuid and logs "Skipping" — exactly the safe
 * idempotent path it was designed for.
 *
 * Closes: docs/plans/bootstrap-restoration-and-factory-reset-2026-05-07.md
 */
export class CreateInitialSchema1700000000000 implements MigrationInterface {
  name = 'CreateInitialSchema1700000000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Creating baseline farm.* tables (15 core + 20 domain + 4 infra) and ~30 enum types',
    );

    // The farm schema itself is created by infrastructure/docker/init-scripts.
    // Defensive guard for direct CLI runs against a bare database — this is a
    // no-op when the schema already exists.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS farm`);

    await this.createEnumTypes(queryRunner);

    // Init-script-equivalent tables (formerly created by
    // 03-farm-tables-and-seed.sql in `public`). These come FIRST because
    // farm.tanks has an FK to farm.departments and farm.batches_v2 has an
    // FK to farm.species — the targets must exist before the dependents.
    await this.createSitesTable(queryRunner);
    await this.createDepartmentsTable(queryRunner);
    await this.createSystemsTable(queryRunner);
    await this.createSubSystemsTable(queryRunner);
    await this.createEquipmentTypesTable(queryRunner);
    await this.createEquipmentTable(queryRunner);
    await this.createSpeciesTable(queryRunner);

    // Baseline tables previously squashed out of source.
    await this.createFarmsTable(queryRunner);
    await this.createPondsTable(queryRunner);
    await this.createTanksTable(queryRunner);
    await this.createBatchesV2Table(queryRunner);
    await this.createBatchLocationsTable(queryRunner);
    await this.createBatchFeedAssignmentsTable(queryRunner);
    await this.createTankBatchesTable(queryRunner);
    await this.createTankAllocationsTable(queryRunner);

    // ------------------------------------------------------------------
    // W4-A.2 Dalga 2 — domain template tables previously squashed out of
    // source. Without these CREATE steps, every column-altering migration
    // in 1769100000000+ failed on a fresh-volume bootstrap with a
    // "relation does not exist" error. Order is topological by FK
    // dependency: feeds → feed_types → feed_type_species → feed_inventory,
    // chemicals → chemical_sites, etc.
    // ------------------------------------------------------------------
    await this.createFeedsGroup(queryRunner);
    await this.createFeedingGroup(queryRunner);
    await this.createChemicalsGroup(queryRunner);
    await this.createHealthGroup(queryRunner);
    await this.createHarvestGroup(queryRunner);
    await this.createTasksGroup(queryRunner);
    await this.createInfraGroup(queryRunner);

    // Species column additions — owned here so AddSpeciesTags becomes a
    // pure no-op on a fresh DB. See migration 1769100000000.
    await this.alterSpeciesAddColumns(queryRunner);

    this.logger.log('Baseline farm schema initialised.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse FK order — children first, then parents, then enum types.
    this.logger.warn(
      'Reverting baseline farm.* tables. ' +
        'This is destructive and is intended for ephemeral test environments only.',
    );

    const tablesInDropOrder = [
      // W4-A.2 Dalga 2 domain tables (children-first per FK direction)
      'farm_workers',
      'farm_audit_logs',
      'code_sequences',
      'recurring_templates',
      'auto_rules',
      'tasks',
      'harvest_records',
      'harvest_plans',
      'health_events',
      'growth_measurements',
      'mortality_records',
      'chemical_sites',
      'chemical_types',
      'chemicals',
      'daily_feeding_executions',
      'feeding_records',
      'feeding_tables',
      'feeding_program_tanks',
      'feeding_programs',
      'feeding_protocols',
      'feed_inventory',
      'feed_type_species',
      'feed_types',
      'feeds',
      // Baseline tables (children-first per FK direction)
      'tank_allocations',
      'tank_batches',
      'batch_feed_assignments',
      'batch_locations',
      'batches_v2',
      'tanks',
      'ponds',
      'farms',
      // Init-script-equivalent tables (children-first per FK direction)
      'equipment',
      'equipment_types',
      'sub_systems',
      'systems',
      'departments',
      'sites',
      'species',
    ];

    for (const table of tablesInDropOrder) {
      await queryRunner.query(`DROP TABLE IF EXISTS farm."${table}" CASCADE`);
    }

    // Drop enum types last — table drops above already removed dependent
    // columns, so these should be free.
    const enumTypes = [
      // Baseline enums
      'farm_water_type_enum',
      'farm_pond_status_enum',
      'farm_tank_type_enum',
      'farm_tank_material_enum',
      'farm_tank_status_enum',
      'farm_batch_status_enum',
      'farm_batch_input_type_enum',
      'farm_batch_type_enum',
      'farm_location_type_enum',
      'farm_transfer_reason_enum',
      'farm_allocation_type_enum',
      // Init-script-equivalent enums
      'farm_site_status_enum',
      'farm_system_type_enum',
      'farm_system_status_enum',
      'farm_sub_system_type_enum',
      'farm_sub_system_status_enum',
      'farm_equipment_category_enum',
      'farm_equipment_status_enum',
      'farm_department_type_enum',
      'farm_department_status_enum',
      // W4-A.2 Dalga 2 domain enums
      'farm_feed_type_enum',
      'farm_feed_floating_type_enum',
      'farm_feed_status_enum',
      'farm_feed_growth_stage_enum',
      'farm_feed_species_recommendation_enum',
      'farm_inventory_status_enum',
      'farm_feeding_program_status_enum',
      'farm_program_equipment_type_enum',
      'farm_feeding_table_status_enum',
      'farm_feeding_calculation_method_enum',
      'farm_feeding_method_enum',
      'farm_execution_status_enum',
      'farm_chemical_type_enum',
      'farm_chemical_status_enum',
      'farm_mortality_cause_enum',
      'farm_mortality_severity_enum',
      'farm_measurement_type_enum',
      'farm_measurement_method_enum',
      'farm_growth_performance_enum',
      'farm_health_event_type_enum',
      'farm_disease_category_enum',
      'farm_health_severity_enum',
      'farm_health_event_status_enum',
      'farm_treatment_method_enum',
      'farm_harvest_plan_status_enum',
      'farm_harvest_type_enum',
      'farm_harvest_method_enum',
      'farm_product_form_enum',
      'farm_harvest_record_status_enum',
      'farm_size_grade_enum',
      'farm_quality_grade_enum',
      'farm_task_category_enum',
      'farm_task_priority_enum',
      'farm_task_status_enum',
      'farm_auto_rule_trigger_enum',
      'farm_recurrence_frequency_enum',
      'farm_audit_action_enum',
    ];
    for (const enumType of enumTypes) {
      await queryRunner.query(
        `DROP TYPE IF EXISTS farm."${enumType}" CASCADE`,
      );
    }
  }

  /**
   * Create Postgres enum types used by farms / ponds / tanks / batches_v2 /
   * batch_locations / tank_allocations. Names are prefixed with `farm_`
   * so they are unambiguous in cross-schema introspection (the auth and
   * farm schemas would otherwise collide on generic names like
   * `water_type`).
   *
   * `DO $$ ... EXCEPTION WHEN duplicate_object` makes each block
   * idempotent without depending on `CREATE TYPE IF NOT EXISTS` (which
   * Postgres does not support).
   */
  private async createEnumTypes(queryRunner: QueryRunner): Promise<void> {
    const enums: ReadonlyArray<{ name: string; values: readonly string[] }> = [
      // 03-farm-tables-and-seed.sql: site_status (init script literal values)
      { name: 'farm_site_status_enum', values: ['active', 'maintenance', 'inactive', 'under_construction'] },
      // 03-farm-tables-and-seed.sql: system_type
      { name: 'farm_system_type_enum', values: ['ras', 'flow_through', 'pond', 'cage', 'raceway', 'hatchery', 'nursery', 'biofloc', 'aquaponics', 'other'] },
      // 03-farm-tables-and-seed.sql: system_status
      { name: 'farm_system_status_enum', values: ['active', 'maintenance', 'inactive', 'commissioning'] },
      // 03-farm-tables-and-seed.sql: sub_system_type
      { name: 'farm_sub_system_type_enum', values: ['grow_out', 'nursery', 'hatchery', 'broodstock', 'quarantine', 'treatment', 'filtration', 'aeration', 'heating_cooling', 'feeding', 'harvesting', 'storage', 'other'] },
      // 03-farm-tables-and-seed.sql: sub_system_status
      { name: 'farm_sub_system_status_enum', values: ['active', 'maintenance', 'inactive', 'cleaning', 'fallow'] },
      // 03-farm-tables-and-seed.sql: equipment_category
      { name: 'farm_equipment_category_enum', values: ['tank', 'pump', 'aeration', 'filtration', 'heating_cooling', 'feeding', 'monitoring', 'water_treatment', 'harvesting', 'transport', 'electrical', 'plumbing', 'safety', 'other'] },
      // 03-farm-tables-and-seed.sql: equipment_status
      { name: 'farm_equipment_status_enum', values: ['operational', 'maintenance', 'repair', 'out_of_service', 'decommissioned', 'standby', 'active', 'preparing', 'cleaning', 'harvesting', 'fallow', 'quarantine'] },
      // 03-farm-tables-and-seed.sql: department_type
      { name: 'farm_department_type_enum', values: ['production', 'grow_out', 'nursery', 'hatchery', 'broodstock', 'quarantine', 'processing', 'maintenance', 'administration', 'other'] },
      // 03-farm-tables-and-seed.sql: department_status
      { name: 'farm_department_status_enum', values: ['active', 'maintenance', 'inactive', 'under_construction'] },
      // pond.entity.ts: WaterType — also used by tank.entity.ts
      { name: 'farm_water_type_enum', values: ['freshwater', 'saltwater', 'brackish'] },
      // pond.entity.ts: PondStatus
      { name: 'farm_pond_status_enum', values: ['active', 'maintenance', 'inactive', 'preparing'] },
      // tank.entity.ts: TankType
      { name: 'farm_tank_type_enum', values: ['circular', 'rectangular', 'raceway', 'd_end', 'oval', 'square', 'other'] },
      // tank.entity.ts: TankMaterial
      { name: 'farm_tank_material_enum', values: ['fiberglass', 'concrete', 'hdpe', 'steel', 'stainless_steel', 'pvc', 'liner', 'other'] },
      // tank.entity.ts: TankStatus
      { name: 'farm_tank_status_enum', values: ['active', 'preparing', 'cleaning', 'maintenance', 'harvesting', 'fallow', 'quarantine', 'inactive'] },
      // batch.types.ts: BatchStatus (uppercase string values)
      { name: 'farm_batch_status_enum', values: ['QUARANTINE', 'ACTIVE', 'GROWING', 'PRE_HARVEST', 'HARVESTING', 'HARVESTED', 'TRANSFERRED', 'FAILED', 'CLOSED'] },
      // batch.types.ts: BatchInputType (uppercase)
      { name: 'farm_batch_input_type_enum', values: ['EGGS', 'LARVAE', 'POST_LARVAE', 'FRY', 'FINGERLINGS', 'JUVENILES', 'ADULTS', 'BROODSTOCK'] },
      // batch.types.ts: BatchType (lowercase)
      { name: 'farm_batch_type_enum', values: ['production', 'cleaner_fish'] },
      // batch-location.entity.ts: LocationType
      { name: 'farm_location_type_enum', values: ['tank', 'pond'] },
      // batch-location.entity.ts: TransferReason
      { name: 'farm_transfer_reason_enum', values: ['initial_stocking', 'split', 'merge', 'grading', 'growth_stage', 'water_quality', 'health_issue', 'maintenance', 'harvest_prep', 'other'] },
      // tank-allocation.entity.ts: AllocationType
      { name: 'farm_allocation_type_enum', values: ['initial_stocking', 'split', 'transfer_in', 'transfer_out', 'grading', 'harvest'] },

      // ----------------------------------------------------------------
      // W4-A.2 Dalga 2 — domain enums for feeds, feeding, chemicals,
      // health, harvest, tasks. Names are prefixed `farm_*_enum` to keep
      // cross-schema introspection unambiguous.
      // ----------------------------------------------------------------
      // feed.entity.ts: FeedType
      { name: 'farm_feed_type_enum', values: ['starter', 'grower', 'finisher', 'broodstock', 'medicated', 'larval', 'fry', 'other'] },
      // feed.entity.ts: FloatingType
      { name: 'farm_feed_floating_type_enum', values: ['floating', 'sinking', 'slow_sinking'] },
      // feed.entity.ts: FeedStatus
      { name: 'farm_feed_status_enum', values: ['available', 'low_stock', 'out_of_stock', 'expired', 'discontinued'] },
      // feed-type-species.entity.ts: FeedGrowthStage
      { name: 'farm_feed_growth_stage_enum', values: ['all', 'larvae', 'fry', 'fingerling', 'juvenile', 'grower', 'pre_adult', 'adult', 'broodstock'] },
      // feed-type-species.entity.ts: FeedSpeciesRecommendation
      { name: 'farm_feed_species_recommendation_enum', values: ['highly_recommended', 'recommended', 'suitable', 'conditional', 'not_recommended'] },
      // feed-inventory.entity.ts: InventoryStatus
      { name: 'farm_inventory_status_enum', values: ['available', 'low_stock', 'out_of_stock', 'expired', 'quarantine'] },
      // feeding-program.entity.ts: FeedingProgramStatus
      { name: 'farm_feeding_program_status_enum', values: ['draft', 'active', 'paused', 'completed', 'cancelled'] },
      // feeding-program-tank.entity.ts: ProgramEquipmentType
      { name: 'farm_program_equipment_type_enum', values: ['tank', 'pond', 'cage'] },
      // feeding-table.entity.ts: FeedingTableStatus
      { name: 'farm_feeding_table_status_enum', values: ['draft', 'active', 'superseded', 'archived'] },
      // feeding-table.entity.ts: CalculationMethod
      { name: 'farm_feeding_calculation_method_enum', values: ['fcr_based', 'body_weight_percent', 'fixed_amount', 'manual'] },
      // feeding-record.entity.ts: FeedingMethod (also used by daily-feeding-execution)
      { name: 'farm_feeding_method_enum', values: ['manual', 'automatic', 'demand', 'broadcast', 'spot'] },
      // daily-feeding-execution.entity.ts: ExecutionStatus
      { name: 'farm_execution_status_enum', values: ['planned', 'in_progress', 'completed', 'skipped', 'partial'] },
      // chemical.entity.ts: ChemicalType
      { name: 'farm_chemical_type_enum', values: ['disinfectant', 'treatment', 'water_conditioner', 'antibiotic', 'antiparasitic', 'probiotic', 'vitamin', 'mineral', 'anesthetic', 'ph_adjuster', 'algaecide', 'other'] },
      // chemical.entity.ts: ChemicalStatus
      { name: 'farm_chemical_status_enum', values: ['available', 'low_stock', 'out_of_stock', 'expired', 'discontinued'] },
      // mortality-record.entity.ts: MortalityCause
      { name: 'farm_mortality_cause_enum', values: ['disease', 'water_quality', 'stress', 'handling', 'predation', 'cannibalism', 'starvation', 'temperature', 'oxygen', 'ammonia', 'genetic', 'unknown', 'other'] },
      // mortality-record.entity.ts: MortalitySeverity
      { name: 'farm_mortality_severity_enum', values: ['normal', 'elevated', 'high', 'critical', 'mass'] },
      // growth-measurement.entity.ts: MeasurementType
      { name: 'farm_measurement_type_enum', values: ['routine', 'transfer', 'grading', 'harvest', 'health_check', 'spot_check'] },
      // growth-measurement.entity.ts: MeasurementMethod
      { name: 'farm_measurement_method_enum', values: ['manual_scale', 'automated_scale', 'image_analysis', 'sonar', 'estimated'] },
      // growth-measurement.entity.ts: GrowthPerformance
      { name: 'farm_growth_performance_enum', values: ['excellent', 'good', 'average', 'below_average', 'poor'] },
      // health-event.entity.ts: HealthEventType
      { name: 'farm_health_event_type_enum', values: ['disease_outbreak', 'symptom_observed', 'routine_inspection', 'treatment_start', 'treatment_end', 'vaccination', 'quarantine_start', 'quarantine_end', 'mortality_event', 'recovery', 'lab_result', 'vet_consultation'] },
      // health-event.entity.ts: DiseaseCategory
      { name: 'farm_disease_category_enum', values: ['bacterial', 'viral', 'parasitic', 'fungal', 'nutritional', 'environmental', 'genetic', 'unknown'] },
      // health-event.entity.ts: HealthSeverity
      { name: 'farm_health_severity_enum', values: ['minor', 'moderate', 'severe', 'critical'] },
      // health-event.entity.ts: HealthEventStatus
      { name: 'farm_health_event_status_enum', values: ['active', 'monitoring', 'resolved', 'chronic', 'cancelled'] },
      // health-event.entity.ts: TreatmentMethod
      { name: 'farm_treatment_method_enum', values: ['bath', 'in_feed', 'injection', 'immersion', 'topical', 'environmental', 'vaccination'] },
      // harvest-plan.entity.ts: HarvestPlanStatus
      { name: 'farm_harvest_plan_status_enum', values: ['draft', 'planned', 'approved', 'scheduled', 'in_progress', 'completed', 'cancelled', 'postponed'] },
      // harvest-plan.entity.ts: HarvestType
      { name: 'farm_harvest_type_enum', values: ['full', 'partial', 'selective', 'emergency', 'thinning'] },
      // harvest-plan.entity.ts: HarvestMethod
      { name: 'farm_harvest_method_enum', values: ['net', 'pump', 'drain', 'manual', 'crowder'] },
      // harvest-plan.entity.ts: ProductForm
      { name: 'farm_product_form_enum', values: ['live', 'fresh_whole', 'fresh_gutted', 'frozen_whole', 'frozen_gutted', 'fillet', 'processed'] },
      // harvest-record.entity.ts: HarvestRecordStatus
      { name: 'farm_harvest_record_status_enum', values: ['in_progress', 'completed', 'quality_check', 'dispatched', 'delivered', 'cancelled'] },
      // harvest-record.entity.ts: SizeGrade
      { name: 'farm_size_grade_enum', values: ['xs', 's', 'm', 'l', 'xl', 'xxl'] },
      // harvest-record.entity.ts: QualityGrade
      { name: 'farm_quality_grade_enum', values: ['premium', 'grade_a', 'grade_b', 'grade_c', 'reject'] },
      // task.entity.ts: TaskCategory
      { name: 'farm_task_category_enum', values: ['FEEDING', 'WATER_QUALITY', 'HEALTH_CHECK', 'EQUIPMENT_MAINTENANCE', 'STOCK_MANAGEMENT', 'CLEANING', 'REGULATORY', 'HARVEST', 'ENVIRONMENTAL', 'SAFETY', 'GENERAL'] },
      // task.entity.ts: TaskPriority
      { name: 'farm_task_priority_enum', values: ['URGENT', 'HIGH', 'MEDIUM', 'LOW'] },
      // task.entity.ts: TaskStatus
      { name: 'farm_task_status_enum', values: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'CANCELLED'] },
      // auto-rule.entity.ts: AutoRuleTrigger
      { name: 'farm_auto_rule_trigger_enum', values: ['STOCK_LOW', 'EXPIRY_NEAR', 'MAINTENANCE_DUE', 'SCHEDULE', 'LICENSE_EXPIRY', 'WATER_PARAM_ALERT'] },
      // recurring-template.entity.ts: RecurrenceFrequency
      { name: 'farm_recurrence_frequency_enum', values: ['HOURLY', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM'] },
      // audit-log.entity.ts: AuditAction
      { name: 'farm_audit_action_enum', values: ['CREATE', 'UPDATE', 'DELETE', 'SOFT_DELETE', 'RESTORE', 'CAPACITY_BLOCKED'] },
    ];

    for (const enumType of enums) {
      const literals = enumType.values.map((v) => `'${v}'`).join(', ');
      await queryRunner.query(`
        DO $$ BEGIN
          CREATE TYPE farm."${enumType.name}" AS ENUM (${literals});
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
    }
  }

  /**
   * farm.farms — farm/entities/farm.entity.ts
   *
   * Multi-tenant top-level container. CREATE TABLE + sibling indexes are
   * bundled in a single queryRunner.query call so migration-sql-lint R3
   * recognizes the just-created-table exemption.
   */
  private async createFarmsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.farms (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(255) NOT NULL,
        "location" jsonb NOT NULL,
        "tenantId" uuid NOT NULL,
        "address" varchar(255),
        "contactPerson" varchar(255),
        "contactPhone" varchar(255),
        "contactEmail" varchar(255),
        "description" text,
        "totalArea" decimal(10, 2),
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "version" integer NOT NULL DEFAULT 1,
        "createdBy" varchar(255),
        "updatedBy" varchar(255)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_farms_tenant_name"
        ON farm.farms ("tenantId", "name");
      CREATE INDEX IF NOT EXISTS "IDX_farms_tenant_isActive"
        ON farm.farms ("tenantId", "isActive");
      CREATE INDEX IF NOT EXISTS "IDX_farms_tenantId"
        ON farm.farms ("tenantId");
    `);
  }

  /**
   * farm.ponds — farm/entities/pond.entity.ts
   *
   * FK to farms (CASCADE). CREATE TABLE + sibling indexes bundled per
   * R3 lint chunk rule. FK ADD CONSTRAINT lives in a separate call —
   * that pattern is independent of R3 and remains untouched.
   */
  private async createPondsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.ponds (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(255) NOT NULL,
        "capacity" decimal(10, 2) NOT NULL,
        "depth" decimal(10, 2),
        "surfaceArea" decimal(10, 2),
        "waterType" farm.farm_water_type_enum NOT NULL DEFAULT 'freshwater',
        "status" farm.farm_pond_status_enum NOT NULL DEFAULT 'active',
        "farmId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" varchar(255)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ponds_farm_name"
        ON farm.ponds ("farmId", "name");
      CREATE INDEX IF NOT EXISTS "IDX_ponds_tenant_status"
        ON farm.ponds ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_ponds_farmId"
        ON farm.ponds ("farmId");
      CREATE INDEX IF NOT EXISTS "IDX_ponds_tenantId"
        ON farm.ponds ("tenantId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.ponds
          ADD CONSTRAINT "FK_ponds_farm"
          FOREIGN KEY ("farmId") REFERENCES farm.farms("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * farm.tanks — tank/entities/tank.entity.ts
   *
   * FK to departments (RESTRICT — entity decorator). systemId is nullable
   * uuid with no FK in the entity (referenced via systemId column only).
   * CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
   */
  private async createTanksTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.tanks (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "code" varchar(50) NOT NULL,
        "description" text,
        "departmentId" uuid NOT NULL,
        "systemId" uuid,
        "tankType" farm.farm_tank_type_enum NOT NULL DEFAULT 'circular',
        "material" farm.farm_tank_material_enum NOT NULL DEFAULT 'fiberglass',
        "waterType" farm.farm_water_type_enum NOT NULL DEFAULT 'saltwater',
        "diameter" decimal(10, 2),
        "length" decimal(10, 2),
        "width" decimal(10, 2),
        "depth" decimal(10, 2) NOT NULL,
        "waterDepth" decimal(10, 2),
        "freeboard" decimal(10, 2),
        "volume" decimal(15, 2) NOT NULL DEFAULT 0,
        "waterVolume" decimal(15, 2),
        "maxBiomass" decimal(15, 2) NOT NULL DEFAULT 0,
        "currentBiomass" decimal(15, 2) NOT NULL DEFAULT 0,
        "maxDensity" decimal(10, 2) NOT NULL DEFAULT 30,
        "currentCount" integer,
        "waterFlow" jsonb,
        "aeration" jsonb,
        "location" jsonb,
        "status" farm.farm_tank_status_enum NOT NULL DEFAULT 'preparing',
        "statusChangedAt" timestamptz,
        "statusReason" text,
        "isActive" boolean NOT NULL DEFAULT true,
        "notes" text,
        "installationDate" date,
        "lastMaintenanceDate" date,
        "nextMaintenanceDate" date,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tanks_tenant_code"
        ON farm.tanks ("tenantId", "code");
      CREATE INDEX IF NOT EXISTS "IDX_tanks_tenant_department"
        ON farm.tanks ("tenantId", "departmentId");
      CREATE INDEX IF NOT EXISTS "IDX_tanks_tenant_status"
        ON farm.tanks ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_tanks_tenant_tankType"
        ON farm.tanks ("tenantId", "tankType");
      CREATE INDEX IF NOT EXISTS "IDX_tanks_tenant_waterType"
        ON farm.tanks ("tenantId", "waterType");
      CREATE INDEX IF NOT EXISTS "IDX_tanks_tenant_isActive"
        ON farm.tanks ("tenantId", "isActive");
      CREATE INDEX IF NOT EXISTS "IDX_tanks_department_status"
        ON farm.tanks ("departmentId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_tanks_tenant_systemId"
        ON farm.tanks ("tenantId", "systemId");
      CREATE INDEX IF NOT EXISTS "IDX_tanks_tenantId"
        ON farm.tanks ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_tanks_isActive"
        ON farm.tanks ("isActive");
    `);

    // FK to departments (RESTRICT per Tank entity decorator). Not added
    // to systemId — the entity's systemId is column-only with no
    // ManyToOne, matching the polymorphic system/sub_system selection
    // pattern the entity layer enforces in the service tier.
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.tanks
          ADD CONSTRAINT "FK_tanks_department"
          FOREIGN KEY ("departmentId") REFERENCES farm.departments("id") ON DELETE RESTRICT;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * farm.batches_v2 — batch/entities/batch.entity.ts
   *
   * Note: `arrivalMethod` column is INTENTIONALLY OMITTED here — the
   * later `1734500000000-AddBatchDocuments` migration owns it (with a
   * differently-cased `arrival_method_enum`). Adding it twice would
   * conflict with that migration's `ADD COLUMN IF NOT EXISTS` check.
   *
   * FK to species (RESTRICT — entity decorator). speciesId references
   * the init-script-created `farm.species` table.
   *
   * supplierId column has no FK — the Supplier entity is created by
   * a later migration not in scope here.
   *
   * CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
   */
  private async createBatchesV2Table(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.batches_v2 (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "batchNumber" varchar(50) NOT NULL,
        "name" varchar(255),
        "description" text,
        "speciesId" uuid NOT NULL,
        "strain" varchar(100),
        "inputType" farm.farm_batch_input_type_enum NOT NULL DEFAULT 'FRY',
        "batchType" farm.farm_batch_type_enum NOT NULL DEFAULT 'production',
        "sourceType" varchar(50),
        "sourceLocation" text,
        "initialQuantity" integer NOT NULL,
        "currentQuantity" integer NOT NULL,
        "totalMortality" integer NOT NULL DEFAULT 0,
        "harvestedQuantity" integer,
        "cullCount" integer NOT NULL DEFAULT 0,
        "totalFeedConsumed" decimal(15, 2) NOT NULL DEFAULT 0,
        "totalFeedCost" decimal(15, 2) NOT NULL DEFAULT 0,
        "retentionRate" decimal(5, 2),
        "sgr" decimal(5, 4),
        "costPerKg" decimal(10, 2),
        "weight" jsonb NOT NULL,
        "fcr" jsonb NOT NULL,
        "feedingSummary" jsonb NOT NULL,
        "growthMetrics" jsonb NOT NULL,
        "mortalitySummary" jsonb NOT NULL,
        "stockedAt" date NOT NULL,
        "expectedHarvestDate" date,
        "actualHarvestDate" date,
        "supplierId" uuid,
        "supplierBatchNumber" varchar(100),
        "purchaseCost" decimal(15, 2),
        "currency" varchar(3),
        "status" farm.farm_batch_status_enum NOT NULL DEFAULT 'QUARANTINE',
        "statusChangedAt" timestamptz,
        "statusReason" text,
        "isActive" boolean NOT NULL DEFAULT true,
        "notes" text,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_batches_v2_tenant_batchNumber"
        ON farm.batches_v2 ("tenantId", "batchNumber");
      CREATE INDEX IF NOT EXISTS "IDX_batches_v2_tenant_species"
        ON farm.batches_v2 ("tenantId", "speciesId");
      CREATE INDEX IF NOT EXISTS "IDX_batches_v2_tenant_status"
        ON farm.batches_v2 ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_batches_v2_tenant_stockedAt"
        ON farm.batches_v2 ("tenantId", "stockedAt");
      CREATE INDEX IF NOT EXISTS "IDX_batches_v2_tenant_isActive"
        ON farm.batches_v2 ("tenantId", "isActive");
      CREATE INDEX IF NOT EXISTS "IDX_batches_v2_tenant_batchType"
        ON farm.batches_v2 ("tenantId", "batchType");
      CREATE INDEX IF NOT EXISTS "IDX_batches_v2_tenantId"
        ON farm.batches_v2 ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_batches_v2_isActive"
        ON farm.batches_v2 ("isActive");
    `);

    // FK to species (RESTRICT per Batch entity decorator).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.batches_v2
          ADD CONSTRAINT "FK_batches_v2_species"
          FOREIGN KEY ("speciesId") REFERENCES farm.species("id") ON DELETE RESTRICT;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * farm.batch_locations — batch/entities/batch-location.entity.ts
   *
   * Polymorphic tank/pond reference: `tankId` and `pondId` are both
   * nullable uuid columns. Per the entity decorator, only `tankId` has
   * a real ManyToOne (SET NULL). The pondId relation is documented as
   * "Pond entity ile ilişki ... varsa" with the @ManyToOne commented
   * out — column-only, no FK. Same rationale as tank-batches.
   *
   * CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
   */
  private async createBatchLocationsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.batch_locations (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "batchId" uuid NOT NULL,
        "locationType" farm.farm_location_type_enum NOT NULL,
        "tankId" uuid,
        "pondId" uuid,
        "quantity" integer NOT NULL,
        "biomass" decimal(15, 2) NOT NULL,
        "avgWeight" decimal(10, 2),
        "movedAt" timestamptz NOT NULL,
        "movedBy" uuid,
        "transferReason" farm.farm_transfer_reason_enum,
        "previousLocationId" uuid,
        "isCurrentLocation" boolean NOT NULL DEFAULT true,
        "exitedAt" timestamptz,
        "notes" text,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_batch_locations_tenant_batch_current"
        ON farm.batch_locations ("tenantId", "batchId", "isCurrentLocation");
      CREATE INDEX IF NOT EXISTS "IDX_batch_locations_tenant_tank_current"
        ON farm.batch_locations ("tenantId", "tankId", "isCurrentLocation");
      CREATE INDEX IF NOT EXISTS "IDX_batch_locations_tenant_pond_current"
        ON farm.batch_locations ("tenantId", "pondId", "isCurrentLocation");
      CREATE INDEX IF NOT EXISTS "IDX_batch_locations_batch_movedAt"
        ON farm.batch_locations ("batchId", "movedAt");
      CREATE INDEX IF NOT EXISTS "IDX_batch_locations_tenantId"
        ON farm.batch_locations ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_batch_locations_batchId"
        ON farm.batch_locations ("batchId");
      CREATE INDEX IF NOT EXISTS "IDX_batch_locations_isCurrentLocation"
        ON farm.batch_locations ("isCurrentLocation");
    `);

    // FK to batches_v2 (CASCADE per entity decorator).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.batch_locations
          ADD CONSTRAINT "FK_batch_locations_batch"
          FOREIGN KEY ("batchId") REFERENCES farm.batches_v2("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * farm.batch_feed_assignments — batch/entities/batch-feed-assignment.entity.ts
   *
   * No FK to a `feeds` table — the feed entity ships in a later
   * migration not in scope here. The column-level ManyToOne in the
   * entity is referenced via string ('Batch') on batchId only.
   *
   * CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
   */
  private async createBatchFeedAssignmentsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.batch_feed_assignments (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "batchId" uuid NOT NULL,
        "feedAssignments" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "isActive" boolean NOT NULL DEFAULT true,
        "notes" text,
        "isDeleted" boolean NOT NULL DEFAULT false,
        "deletedAt" timestamptz,
        "deletedBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_batch_feed_assignments_tenant_batch"
        ON farm.batch_feed_assignments ("tenantId", "batchId");
      CREATE INDEX IF NOT EXISTS "IDX_batch_feed_assignments_tenant_isActive"
        ON farm.batch_feed_assignments ("tenantId", "isActive");
      CREATE INDEX IF NOT EXISTS "IDX_batch_feed_assignments_tenantId"
        ON farm.batch_feed_assignments ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_batch_feed_assignments_batchId"
        ON farm.batch_feed_assignments ("batchId");
      CREATE INDEX IF NOT EXISTS "IDX_batch_feed_assignments_isDeleted"
        ON farm.batch_feed_assignments ("isDeleted");
    `);

    // FK to batches_v2. Entity declares { nullable: true } on the
    // batch ManyToOne — but the column is typed `uuid NOT NULL`, so the
    // FK is a hard constraint. CASCADE chosen to match other batch_*
    // child tables (batch_locations, tank_allocations).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.batch_feed_assignments
          ADD CONSTRAINT "FK_batch_feed_assignments_batch"
          FOREIGN KEY ("batchId") REFERENCES farm.batches_v2("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * farm.tank_batches — batch/entities/tank-batch.entity.ts
   *
   * Tank-batch snapshot table. The `tankId` ManyToOne resolves to
   * `'Tank'` per the entity decorator but the column also accepts
   * `equipment.id` rows on tenants where tanks are stored as equipment
   * (legacy migration 02-migrate-tanks-to-equipment.sql). FK to
   * batches_v2 only — the polymorphic tankId is FK-less by design.
   *
   * Unique index on (tenantId, tankId) — entity expresses
   * `@Index(['tenantId', 'tankId'], { unique: true })`.
   *
   * CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
   */
  private async createTankBatchesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.tank_batches (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "tankId" uuid NOT NULL,
        "tankName" varchar(255),
        "tankCode" varchar(50),
        "currentQuantity" integer,
        "currentBiomassKg" decimal(15, 2),
        "primaryBatchId" uuid,
        "primaryBatchNumber" varchar(50),
        "totalQuantity" integer NOT NULL DEFAULT 0,
        "avgWeightG" decimal(10, 2) NOT NULL DEFAULT 0,
        "totalBiomassKg" decimal(15, 2) NOT NULL DEFAULT 0,
        "densityKgM3" decimal(10, 2) NOT NULL DEFAULT 0,
        "isMixedBatch" boolean NOT NULL DEFAULT false,
        "batchDetails" jsonb,
        "cleanerFishQuantity" integer NOT NULL DEFAULT 0,
        "cleanerFishBiomassKg" decimal(10, 2) NOT NULL DEFAULT 0,
        "cleanerFishDetails" jsonb,
        "lastFeedingAt" timestamptz,
        "lastSamplingAt" timestamptz,
        "lastMortalityAt" timestamptz,
        "capacityUsedPercent" decimal(5, 2),
        "isOverCapacity" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tank_batches_tenant_tank"
        ON farm.tank_batches ("tenantId", "tankId");
      CREATE INDEX IF NOT EXISTS "IDX_tank_batches_tenant_primaryBatch"
        ON farm.tank_batches ("tenantId", "primaryBatchId");
      CREATE INDEX IF NOT EXISTS "IDX_tank_batches_tenantId"
        ON farm.tank_batches ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_tank_batches_tankId"
        ON farm.tank_batches ("tankId");
    `);

    // FK to batches_v2 (SET NULL per entity decorator on primaryBatch).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.tank_batches
          ADD CONSTRAINT "FK_tank_batches_primary_batch"
          FOREIGN KEY ("primaryBatchId") REFERENCES farm.batches_v2("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * farm.tank_allocations — batch/entities/tank-allocation.entity.ts
   *
   * Allocation history. The `tankId` and `sourceTankId` ManyToOne
   * relations target `'Tank'` polymorphically (entity also imports
   * Equipment as a type alias) — no DB-level FK on those columns.
   * Real FK is on batchId → batches_v2 (CASCADE per entity decorator).
   *
   * CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
   */
  private async createTankAllocationsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.tank_allocations (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "batchId" uuid NOT NULL,
        "batchNumber" varchar(50),
        "tankId" uuid NOT NULL,
        "tankName" varchar(255),
        "tankCode" varchar(50),
        "allocationType" farm.farm_allocation_type_enum NOT NULL DEFAULT 'initial_stocking',
        "allocationDate" date NOT NULL,
        "quantity" integer NOT NULL,
        "avgWeightG" decimal(10, 2) NOT NULL,
        "biomassKg" decimal(15, 2) NOT NULL,
        "sourceTankId" uuid,
        "sourceTankName" varchar(255),
        "densityKgM3" decimal(10, 2),
        "notes" text,
        "allocatedBy" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "isDeleted" boolean NOT NULL DEFAULT false,
        "deletedAt" timestamptz,
        "deletedBy" uuid
      );
      CREATE INDEX IF NOT EXISTS "IDX_tank_allocations_tenant_batch_date"
        ON farm.tank_allocations ("tenantId", "batchId", "allocationDate");
      CREATE INDEX IF NOT EXISTS "IDX_tank_allocations_tenant_tank_date"
        ON farm.tank_allocations ("tenantId", "tankId", "allocationDate");
      CREATE INDEX IF NOT EXISTS "IDX_tank_allocations_batch_tank"
        ON farm.tank_allocations ("batchId", "tankId");
      CREATE INDEX IF NOT EXISTS "IDX_tank_allocations_tenantId"
        ON farm.tank_allocations ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_tank_allocations_batchId"
        ON farm.tank_allocations ("batchId");
      CREATE INDEX IF NOT EXISTS "IDX_tank_allocations_tankId"
        ON farm.tank_allocations ("tankId");
    `);

    // FK to batches_v2 (CASCADE per entity decorator).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.tank_allocations
          ADD CONSTRAINT "FK_tank_allocations_batch"
          FOREIGN KEY ("batchId") REFERENCES farm.batches_v2("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  // ==========================================================================
  // INIT-SCRIPT-EQUIVALENT TABLES
  //
  // The seven table creators below mirror the column shapes that
  // `infrastructure/docker/init-scripts/03-farm-tables-and-seed.sql`
  // produced in `public` on legacy environments. We re-create them in
  // `farm.*` here so the FK targets `farm.departments` and `farm.species`
  // (referenced by `createTanksTable` / `createBatchesV2Table`) are
  // present at migration time on a fresh DB. Idempotency is on
  // `IF NOT EXISTS` for every DDL statement, matching the same hook
  // discipline as the baseline tables above (R3 sibling-index bundling,
  // R5 enum DO blocks, FK ADD CONSTRAINT in a separate DO $$ block).
  //
  // The `equipment` table includes the columns that legacy init script
  // `02-migrate-tanks-to-equipment.sql` used to bolt on (isTank, volume,
  // currentBiomass, currentCount, subSystemId, isDeleted, deletedAt,
  // deletedBy) — that init script was removed in commit e0d2f716 and the
  // baseline must own those columns directly.
  // ==========================================================================

  /**
   * farm.sites — init-script `sites` table.
   *
   * NOTE on entity drift: the Site entity (apps/farm-service/src/site/entities/site.entity.ts)
   * carries additional columns the init script never produced (type, city,
   * areaM2, waterCapacityM3, maxBiomassKg, establishedDate, facilities,
   * notes, metadata, isDeleted/deletedAt/deletedBy) and uses different
   * length constraints (name 150 vs 255, code 20 vs 50). This baseline
   * faithfully reproduces the init script columns; the entity-vs-baseline
   * drift is tracked separately and a follow-up migration is the right
   * place to align them — rewriting the baseline would obscure history.
   */
  private async createSitesTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.sites (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "code" varchar(50) NOT NULL,
        "description" text,
        "location" jsonb,
        "address" jsonb,
        "country" varchar(100),
        "region" varchar(100),
        "timezone" varchar(50) DEFAULT 'UTC',
        "status" farm.farm_site_status_enum DEFAULT 'active',
        "settings" jsonb,
        "totalArea" decimal(15, 2),
        "siteManager" varchar(100),
        "contactEmail" varchar(255),
        "contactPhone" varchar(50),
        "isActive" boolean DEFAULT true,
        "createdAt" timestamptz DEFAULT NOW(),
        "updatedAt" timestamptz DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer DEFAULT 1,
        CONSTRAINT "UQ_sites_tenant_code" UNIQUE ("tenantId", "code"),
        CONSTRAINT "UQ_sites_tenant_name" UNIQUE ("tenantId", "name")
      );
      CREATE INDEX IF NOT EXISTS "IDX_sites_tenantId"
        ON farm.sites ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_sites_tenant_status"
        ON farm.sites ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_sites_tenant_isActive"
        ON farm.sites ("tenantId", "isActive");
    `);
  }

  /**
   * farm.departments — init-script `departments` table.
   *
   * FK to sites (CASCADE per init script). The departments-tank FK is
   * added later by `createTanksTable` (RESTRICT per Tank entity).
   */
  private async createDepartmentsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.departments (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "code" varchar(50) NOT NULL,
        "description" text,
        "type" farm.farm_department_type_enum DEFAULT 'other',
        "status" farm.farm_department_status_enum DEFAULT 'active',
        "settings" jsonb,
        "managerId" uuid,
        "managerName" varchar(255),
        "equipmentCount" integer DEFAULT 0,
        "isActive" boolean DEFAULT true,
        "isDeleted" boolean DEFAULT false,
        "deletedAt" timestamptz,
        "deletedBy" uuid,
        "createdAt" timestamptz DEFAULT NOW(),
        "updatedAt" timestamptz DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer DEFAULT 1,
        CONSTRAINT "UQ_departments_tenant_site_code" UNIQUE ("tenantId", "siteId", "code"),
        CONSTRAINT "UQ_departments_tenant_site_name" UNIQUE ("tenantId", "siteId", "name")
      );
      CREATE INDEX IF NOT EXISTS "IDX_departments_tenantId"
        ON farm.departments ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_departments_siteId"
        ON farm.departments ("siteId");
      CREATE INDEX IF NOT EXISTS "IDX_departments_tenant_type"
        ON farm.departments ("tenantId", "type");
      CREATE INDEX IF NOT EXISTS "IDX_departments_tenant_status"
        ON farm.departments ("tenantId", "status");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.departments
          ADD CONSTRAINT "FK_departments_site"
          FOREIGN KEY ("siteId") REFERENCES farm.sites("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * farm.systems — init-script `systems` table.
   *
   * FK to sites (CASCADE per init script). `parent_system_id` is added
   * later by `1734336000000-AddSystemHierarchy`.
   */
  private async createSystemsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.systems (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "code" varchar(50) NOT NULL,
        "description" text,
        "type" farm.farm_system_type_enum DEFAULT 'other',
        "status" farm.farm_system_status_enum DEFAULT 'active',
        "specifications" jsonb,
        "managerId" uuid,
        "managerName" varchar(255),
        "subSystemCount" integer DEFAULT 0,
        "equipmentCount" integer DEFAULT 0,
        "isActive" boolean DEFAULT true,
        "isDeleted" boolean DEFAULT false,
        "deletedAt" timestamptz,
        "deletedBy" uuid,
        "createdAt" timestamptz DEFAULT NOW(),
        "updatedAt" timestamptz DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer DEFAULT 1,
        CONSTRAINT "UQ_systems_tenant_site_code" UNIQUE ("tenantId", "siteId", "code"),
        CONSTRAINT "UQ_systems_tenant_site_name" UNIQUE ("tenantId", "siteId", "name")
      );
      CREATE INDEX IF NOT EXISTS "IDX_systems_tenantId"
        ON farm.systems ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_systems_siteId"
        ON farm.systems ("siteId");
      CREATE INDEX IF NOT EXISTS "IDX_systems_tenant_type"
        ON farm.systems ("tenantId", "type");
      CREATE INDEX IF NOT EXISTS "IDX_systems_tenant_status"
        ON farm.systems ("tenantId", "status");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.systems
          ADD CONSTRAINT "FK_systems_site"
          FOREIGN KEY ("siteId") REFERENCES farm.sites("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * farm.sub_systems — init-script `sub_systems` table.
   *
   * FK to systems (CASCADE per init script).
   */
  private async createSubSystemsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.sub_systems (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "systemId" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "code" varchar(50) NOT NULL,
        "description" text,
        "type" farm.farm_sub_system_type_enum DEFAULT 'other',
        "status" farm.farm_sub_system_status_enum DEFAULT 'active',
        "specifications" jsonb,
        "supervisorId" uuid,
        "supervisorName" varchar(255),
        "equipmentCount" integer DEFAULT 0,
        "tankCount" integer DEFAULT 0,
        "isActive" boolean DEFAULT true,
        "isDeleted" boolean DEFAULT false,
        "deletedAt" timestamptz,
        "deletedBy" uuid,
        "createdAt" timestamptz DEFAULT NOW(),
        "updatedAt" timestamptz DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer DEFAULT 1,
        CONSTRAINT "UQ_sub_systems_tenant_system_code" UNIQUE ("tenantId", "systemId", "code"),
        CONSTRAINT "UQ_sub_systems_tenant_system_name" UNIQUE ("tenantId", "systemId", "name")
      );
      CREATE INDEX IF NOT EXISTS "IDX_sub_systems_tenantId"
        ON farm.sub_systems ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_sub_systems_systemId"
        ON farm.sub_systems ("systemId");
      CREATE INDEX IF NOT EXISTS "IDX_sub_systems_tenant_type"
        ON farm.sub_systems ("tenantId", "type");
      CREATE INDEX IF NOT EXISTS "IDX_sub_systems_tenant_status"
        ON farm.sub_systems ("tenantId", "status");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.sub_systems
          ADD CONSTRAINT "FK_sub_systems_system"
          FOREIGN KEY ("systemId") REFERENCES farm.systems("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * farm.equipment_types — init-script `equipment_types` table (global,
   * cross-tenant).
   *
   * No FK out. The init script also seeds 4 system equipment types
   * (TANK / PUMP / AERATOR / FILTER); seeding is owned by application
   * code (SeedService), NOT by this baseline migration.
   */
  private async createEquipmentTypesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.equipment_types (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(100) NOT NULL,
        "code" varchar(50) UNIQUE NOT NULL,
        "description" text,
        "category" farm.farm_equipment_category_enum DEFAULT 'other',
        "icon" varchar(50),
        "specificationSchema" jsonb NOT NULL,
        "allowedSubEquipmentTypes" text[],
        "isActive" boolean DEFAULT true,
        "isSystem" boolean DEFAULT false,
        "sortOrder" integer DEFAULT 0,
        "createdAt" timestamptz DEFAULT NOW(),
        "updatedAt" timestamptz DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_equipment_types_code"
        ON farm.equipment_types ("code");
      CREATE INDEX IF NOT EXISTS "IDX_equipment_types_category"
        ON farm.equipment_types ("category");
      CREATE INDEX IF NOT EXISTS "IDX_equipment_types_isActive"
        ON farm.equipment_types ("isActive");
    `);
  }

  /**
   * farm.equipment — init-script `equipment` table, plus the columns
   * that legacy init script `02-migrate-tanks-to-equipment.sql` added
   * (isTank, volume, currentBiomass, currentCount, subSystemId,
   * isDeleted, deletedAt, deletedBy). 02 was deleted in e0d2f716, so
   * this baseline owns the merged column set directly.
   *
   * FKs:
   *   - departmentId → farm.departments(id) ON DELETE CASCADE
   *   - subSystemId  → farm.sub_systems(id) ON DELETE CASCADE
   *   - equipmentTypeId → farm.equipment_types(id)
   */
  private async createEquipmentTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.equipment (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "departmentId" uuid,
        "subSystemId" uuid,
        "equipmentTypeId" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "code" varchar(50) NOT NULL,
        "description" text,
        "manufacturer" varchar(100),
        "model" varchar(100),
        "serialNumber" varchar(100),
        "purchaseDate" date,
        "installationDate" date,
        "warrantyEndDate" date,
        "purchasePrice" decimal(15, 2),
        "currency" varchar(3) DEFAULT 'TRY',
        "status" farm.farm_equipment_status_enum DEFAULT 'operational',
        "location" jsonb,
        "specifications" jsonb,
        "maintenanceSchedule" jsonb,
        "supplierId" uuid,
        "subEquipmentCount" integer DEFAULT 0,
        "operatingHours" decimal(10, 2),
        "notes" text,
        "isTank" boolean DEFAULT false,
        "volume" decimal(15, 2),
        "currentBiomass" decimal(15, 2),
        "currentCount" integer,
        "isActive" boolean DEFAULT true,
        "isDeleted" boolean DEFAULT false,
        "deletedAt" timestamptz,
        "deletedBy" uuid,
        "createdAt" timestamptz DEFAULT NOW(),
        "updatedAt" timestamptz DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer DEFAULT 1,
        CONSTRAINT "UQ_equipment_tenant_code" UNIQUE ("tenantId", "code")
      );
      CREATE INDEX IF NOT EXISTS "IDX_equipment_tenantId"
        ON farm.equipment ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_equipment_departmentId"
        ON farm.equipment ("departmentId");
      CREATE INDEX IF NOT EXISTS "IDX_equipment_subSystemId"
        ON farm.equipment ("subSystemId");
      CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant_departmentId"
        ON farm.equipment ("tenantId", "departmentId");
      CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant_subSystemId"
        ON farm.equipment ("tenantId", "subSystemId");
      CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant_status"
        ON farm.equipment ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant_equipmentTypeId"
        ON farm.equipment ("tenantId", "equipmentTypeId");
      CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant_isTank"
        ON farm.equipment ("tenantId", "isTank");
      CREATE INDEX IF NOT EXISTS "IDX_equipment_serialNumber"
        ON farm.equipment ("serialNumber");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.equipment
          ADD CONSTRAINT "FK_equipment_department"
          FOREIGN KEY ("departmentId") REFERENCES farm.departments("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.equipment
          ADD CONSTRAINT "FK_equipment_sub_system"
          FOREIGN KEY ("subSystemId") REFERENCES farm.sub_systems("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.equipment
          ADD CONSTRAINT "FK_equipment_equipment_type"
          FOREIGN KEY ("equipmentTypeId") REFERENCES farm.equipment_types("id");
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * farm.species — init-script `species` table.
   *
   * The Batch entity FK target (FK_batches_v2_species) lands later in
   * createBatchesV2Table, so species must be created first.
   */
  private async createSpeciesTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.species (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "scientificName" varchar(255),
        "code" varchar(50) NOT NULL,
        "category" varchar(50) DEFAULT 'finfish',
        "description" text,
        "optimalTemperature" jsonb,
        "optimalPh" jsonb,
        "optimalSalinity" jsonb,
        "optimalOxygen" jsonb,
        "growthCurve" jsonb,
        "isActive" boolean DEFAULT true,
        "createdAt" timestamptz DEFAULT NOW(),
        "updatedAt" timestamptz DEFAULT NOW(),
        CONSTRAINT "UQ_species_tenant_code" UNIQUE ("tenantId", "code")
      );
      CREATE INDEX IF NOT EXISTS "IDX_species_tenantId"
        ON farm.species ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_species_tenant_code"
        ON farm.species ("tenantId", "code");
    `);
  }

  // ==========================================================================
  // W4-A.2 DALGA 2 — DOMAIN TEMPLATE TABLES
  //
  // The 20 farm-domain tenant-template tables that lost their CREATE step
  // when older migrations were squashed out of source. Without these,
  // every column-altering migration in 1769100000000+ failed on a
  // fresh-volume bootstrap. The architectural fix is owning the CREATE in
  // the baseline so tenant-clone bootstrap reproduces every entity-shape
  // expected by the running services.
  //
  // Hook discipline:
  //   - R1 (down): every drop is `DROP TABLE IF EXISTS ... CASCADE` in
  //                children-first order in the down() ledger above.
  //   - R3 (up):   CREATE TABLE + sibling CREATE INDEX statements are
  //                bundled in a single queryRunner.query template literal.
  //   - R5:        DO $$ blocks for FK ADD CONSTRAINT use only
  //                `WHEN duplicate_object` — never `WHEN others`.
  //
  // Schema decoration: per ADR-011 update for tenant-scoped tables, these
  // entities OMIT `schema:` in @Entity() so search_path tenant routing
  // places them in `tenant_<uuid>` clones at runtime. The source schema
  // (`farm`) holds the templates, and `SourceSchemaBootstrapService`
  // copies them on tenant provisioning.
  // ==========================================================================

  /**
   * FEEDS GROUP — feeds, feed_types, feed_type_species, feed_inventory.
   *
   * Topological order:
   *   feed_types → feeds (no FK to feed_types in entity)
   *   feeds → feed_type_species (FK feeds + FK species CASCADE)
   *   feeds → feed_inventory (FK feeds RESTRICT, FK sites CASCADE)
   *
   * Notes on entity drift:
   *   - feed_inventory references `Site` and `Department` ManyToOne via
   *     string. The Site target lives in `farm.sites` (created above).
   *     Department FK is SET NULL.
   *   - The `min_fish_weight_g` and `max_fish_weight_g` columns use
   *     snake_case `name:` overrides on the entity decorator; the
   *     baseline reproduces those exact column names. Migration
   *     1770000000000 ADDs `min_fish_weight_g` IF NOT EXISTS — once we
   *     create it here, that migration becomes a no-op on fresh DB.
   */
  private async createFeedsGroup(queryRunner: QueryRunner): Promise<void> {
    // feed_types — global cross-tenant taxonomy. No tenantId.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feed_types (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(100) NOT NULL,
        "code" varchar(50) NOT NULL UNIQUE,
        "description" text,
        "icon" varchar(50),
        "isActive" boolean NOT NULL DEFAULT true,
        "isSystem" boolean NOT NULL DEFAULT false,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feed_types_code"
        ON farm.feed_types ("code");
      CREATE INDEX IF NOT EXISTS "IDX_feed_types_isActive"
        ON farm.feed_types ("isActive");
    `);

    // feeds — primary catalogue table.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feeds (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "code" varchar(50) NOT NULL,
        "description" text,
        "brand" varchar(255),
        "manufacturer" varchar(100),
        "supplierId" uuid,
        "type" farm.farm_feed_type_enum NOT NULL DEFAULT 'grower',
        "targetSpecies" varchar(100),
        "pelletSize" decimal(5, 2),
        "floatingType" farm.farm_feed_floating_type_enum NOT NULL DEFAULT 'floating',
        "nutritionalContent" jsonb,
        "feedingTable" jsonb,
        "status" farm.farm_feed_status_enum NOT NULL DEFAULT 'available',
        "quantity" decimal(15, 2) NOT NULL DEFAULT 0,
        "minStock" decimal(15, 2) NOT NULL DEFAULT 0,
        "unit" varchar(20) NOT NULL DEFAULT 'kg',
        "storageRequirements" text,
        "storage_temp_min" decimal(5, 1),
        "storage_temp_max" decimal(5, 1),
        "storage_humidity_min" decimal(5, 1),
        "storage_humidity_max" decimal(5, 1),
        "shelfLifeMonths" integer,
        "expiryDate" date,
        "pricePerKg" decimal(15, 2),
        "currency" varchar(3) NOT NULL DEFAULT 'TRY',
        "documents" jsonb,
        "notes" text,
        "pelletSizeLabel" varchar(50),
        "productStage" varchar(100),
        "composition" text,
        "unitSize" varchar(100),
        "unitPrice" decimal(15, 2),
        "environmentalImpact" jsonb,
        "feedingCurve" jsonb,
        "feedingMatrix2D" jsonb,
        "min_fish_weight_g" decimal(10, 2),
        "max_fish_weight_g" decimal(10, 2),
        "isActive" boolean NOT NULL DEFAULT true,
        "isDeleted" boolean NOT NULL DEFAULT false,
        "deletedAt" timestamptz,
        "deletedBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feeds_tenant_code"
        ON farm.feeds ("tenantId", "code");
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feeds_tenant_name"
        ON farm.feeds ("tenantId", "name");
      CREATE INDEX IF NOT EXISTS "IDX_feeds_tenant_type"
        ON farm.feeds ("tenantId", "type");
      CREATE INDEX IF NOT EXISTS "IDX_feeds_tenant_status"
        ON farm.feeds ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_feeds_tenant_targetSpecies"
        ON farm.feeds ("tenantId", "targetSpecies");
      CREATE INDEX IF NOT EXISTS "IDX_feeds_tenantId"
        ON farm.feeds ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_feeds_isDeleted"
        ON farm.feeds ("isDeleted");
    `);

    // feed_type_species — M2M junction (feeds × species, weight-range scoped).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feed_type_species (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "feedId" uuid NOT NULL,
        "speciesId" uuid NOT NULL,
        "growthStage" farm.farm_feed_growth_stage_enum NOT NULL DEFAULT 'all',
        "recommendedWeightMinG" decimal(10, 2),
        "recommendedWeightMaxG" decimal(10, 2),
        "feedingRatePercent" decimal(5, 2),
        "feedingFrequencyPerDay" integer,
        "feedingRateConfig" jsonb,
        "recommendation" farm.farm_feed_species_recommendation_enum NOT NULL DEFAULT 'recommended',
        "priority" integer,
        "expectedPerformance" jsonb,
        "isActive" boolean NOT NULL DEFAULT true,
        "notes" text,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer NOT NULL DEFAULT 1,
        "isDeleted" boolean NOT NULL DEFAULT false,
        "deletedAt" timestamptz,
        "deletedBy" uuid,
        CONSTRAINT "UQ_feed_type_species_tenant_feed_species_stage"
          UNIQUE ("tenantId", "feedId", "speciesId", "growthStage")
      );
      CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_tenant_feed"
        ON farm.feed_type_species ("tenantId", "feedId");
      CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_tenant_species"
        ON farm.feed_type_species ("tenantId", "speciesId");
      CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_tenant_growthStage"
        ON farm.feed_type_species ("tenantId", "growthStage");
      CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_tenant_recommendation"
        ON farm.feed_type_species ("tenantId", "recommendation");
      CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_tenant_isActive"
        ON farm.feed_type_species ("tenantId", "isActive");
      CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_tenantId"
        ON farm.feed_type_species ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_isActive"
        ON farm.feed_type_species ("isActive");
      CREATE INDEX IF NOT EXISTS "IDX_feed_type_species_isDeleted"
        ON farm.feed_type_species ("isDeleted");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feed_type_species
          ADD CONSTRAINT "FK_feed_type_species_feed"
          FOREIGN KEY ("feedId") REFERENCES farm.feeds("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feed_type_species
          ADD CONSTRAINT "FK_feed_type_species_species"
          FOREIGN KEY ("speciesId") REFERENCES farm.species("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // feed_inventory — site/department-scoped feed stock.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feed_inventory (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "feedId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "departmentId" uuid,
        "quantityKg" decimal(15, 2) NOT NULL DEFAULT 0,
        "minStockKg" decimal(15, 2) NOT NULL DEFAULT 0,
        "status" farm.farm_inventory_status_enum NOT NULL DEFAULT 'available',
        "lotNumber" varchar(100),
        "manufacturingDate" date,
        "expiryDate" date,
        "receivedDate" date,
        "unitPricePerKg" decimal(15, 2),
        "totalValue" decimal(15, 2),
        "currency" varchar(3),
        "storageLocation" varchar(100),
        "storageTemperature" decimal(5, 1),
        "notes" text,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid
      );
      CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_tenant_feed_site"
        ON farm.feed_inventory ("tenantId", "feedId", "siteId");
      CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_tenant_site_status"
        ON farm.feed_inventory ("tenantId", "siteId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_tenant_lot"
        ON farm.feed_inventory ("tenantId", "lotNumber");
      CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_feed_expiry"
        ON farm.feed_inventory ("feedId", "expiryDate");
      CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_tenantId"
        ON farm.feed_inventory ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_feedId"
        ON farm.feed_inventory ("feedId");
      CREATE INDEX IF NOT EXISTS "IDX_feed_inventory_siteId"
        ON farm.feed_inventory ("siteId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feed_inventory
          ADD CONSTRAINT "FK_feed_inventory_feed"
          FOREIGN KEY ("feedId") REFERENCES farm.feeds("id") ON DELETE RESTRICT;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feed_inventory
          ADD CONSTRAINT "FK_feed_inventory_site"
          FOREIGN KEY ("siteId") REFERENCES farm.sites("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feed_inventory
          ADD CONSTRAINT "FK_feed_inventory_department"
          FOREIGN KEY ("departmentId") REFERENCES farm.departments("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * FEEDING GROUP — feeding_protocols, feeding_programs,
   *                 feeding_program_tanks, feeding_tables, feeding_records,
   *                 daily_feeding_executions.
   *
   * Topological order:
   *   feeding_protocols (FK feeds nullable)
   *   feeding_programs (no FK out)
   *     → feeding_program_tanks (FK feeding_programs CASCADE, FK equipment CASCADE, FK feeds SET NULL)
   *   feeding_tables (FK batches_v2 CASCADE, FK feeds RESTRICT)
   *   feeding_records (FK batches_v2 CASCADE, FK feeds RESTRICT, FK tanks SET NULL — polymorphic so column-only)
   *   daily_feeding_executions (FK feeding_programs CASCADE, FK feeding_program_tanks CASCADE)
   *
   * Notes on column drift:
   *   - daily_feeding_executions has a snake_case companion column set
   *     added by 1775000000000-AddFeederFieldsToExecution
   *     (`feeder_equipment_id`, `feeder_name`, `feeding_method`). The
   *     entity uses the camelCase `feederEquipmentId` etc. names which
   *     are baked into this baseline. Reconciling that drift is tracked
   *     work outside W4-A.2 scope.
   */
  private async createFeedingGroup(queryRunner: QueryRunner): Promise<void> {
    // feeding_protocols — protocol templates for species/stage.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feeding_protocols (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text,
        "feedId" uuid,
        "species" varchar(100) NOT NULL,
        "stage" farm.farm_feed_type_enum NOT NULL DEFAULT 'grower',
        "temperatureRanges" jsonb,
        "growthStageProtocols" jsonb,
        "defaultSchedule" jsonb,
        "targetFcr" decimal(4, 2),
        "minDissolvedOxygen" decimal(5, 2),
        "optimalTemperature" jsonb,
        "specialConditions" jsonb,
        "notes" text,
        "isActive" boolean NOT NULL DEFAULT true,
        "isDefault" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feeding_protocols_tenant_name"
        ON farm.feeding_protocols ("tenantId", "name");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_protocols_tenant_species"
        ON farm.feeding_protocols ("tenantId", "species");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_protocols_tenant_stage"
        ON farm.feeding_protocols ("tenantId", "stage");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_protocols_tenant_feed"
        ON farm.feeding_protocols ("tenantId", "feedId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_protocols_tenantId"
        ON farm.feeding_protocols ("tenantId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feeding_protocols
          ADD CONSTRAINT "FK_feeding_protocols_feed"
          FOREIGN KEY ("feedId") REFERENCES farm.feeds("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // feeding_programs — assigned-program parent.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feeding_programs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "siteId" uuid,
        "name" varchar(200) NOT NULL,
        "code" varchar(50) NOT NULL,
        "description" text,
        "feedAssignments" jsonb NOT NULL,
        "fcrTable" jsonb,
        "status" farm.farm_feeding_program_status_enum NOT NULL DEFAULT 'draft',
        "startDate" date NOT NULL,
        "endDate" date,
        "pausedAt" timestamptz,
        "activatedAt" timestamptz,
        "completedAt" timestamptz,
        "settings" jsonb NOT NULL DEFAULT '{"autoTransition":true,"transitionBuffer":0.5,"notifyOnTransition":true,"fcrSource":"feed","defaultMealsPerDay":4}'::jsonb,
        "totalTanks" integer NOT NULL DEFAULT 0,
        "totalFeedTransitions" integer NOT NULL DEFAULT 0,
        "totalFeedConsumed" decimal(15, 2),
        "createdBy" uuid NOT NULL,
        "lastModifiedBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "deletedAt" timestamptz,
        "isDeleted" boolean NOT NULL DEFAULT false,
        "deletedBy" uuid,
        "version" integer NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feeding_programs_tenant_code"
        ON farm.feeding_programs ("tenantId", "code");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_tenant_status"
        ON farm.feeding_programs ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_tenant_site"
        ON farm.feeding_programs ("tenantId", "siteId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_tenant_isDeleted"
        ON farm.feeding_programs ("tenantId", "isDeleted");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_tenantId"
        ON farm.feeding_programs ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_siteId"
        ON farm.feeding_programs ("siteId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_status"
        ON farm.feeding_programs ("status");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_programs_isDeleted"
        ON farm.feeding_programs ("isDeleted");
    `);

    // feeding_program_tanks — program ↔ equipment join.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feeding_program_tanks (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "feedingProgramId" uuid NOT NULL,
        "equipmentId" uuid NOT NULL,
        "equipmentType" farm.farm_program_equipment_type_enum NOT NULL,
        "equipmentName" varchar(200) NOT NULL,
        "equipmentCode" varchar(50) NOT NULL,
        "currentFeedId" uuid,
        "currentFeedCode" varchar(50),
        "currentWeightRangeIndex" integer,
        "lastFeedTransitionAt" timestamptz,
        "totalFeedTransitions" integer NOT NULL DEFAULT 0,
        "temperatureSensorId" uuid,
        "temperatureSensorCode" varchar(100),
        "isActive" boolean NOT NULL DEFAULT true,
        "addedAt" timestamptz NOT NULL,
        "removedAt" timestamptz,
        "notes" text,
        "createdBy" uuid NOT NULL,
        "lastModifiedBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "CHK_feeding_program_tanks_transitions" CHECK ("totalFeedTransitions" >= 0)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feeding_program_tanks_program_equipment"
        ON farm.feeding_program_tanks ("feedingProgramId", "equipmentId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_tenant_program"
        ON farm.feeding_program_tanks ("tenantId", "feedingProgramId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_tenant_equipment"
        ON farm.feeding_program_tanks ("tenantId", "equipmentId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_tenant_isActive"
        ON farm.feeding_program_tanks ("tenantId", "isActive");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_tenant_addedAt"
        ON farm.feeding_program_tanks ("tenantId", "addedAt");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_tenant_program_active"
        ON farm.feeding_program_tanks ("tenantId", "feedingProgramId", "isActive");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_tenantId"
        ON farm.feeding_program_tanks ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_feedingProgramId"
        ON farm.feeding_program_tanks ("feedingProgramId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_equipmentId"
        ON farm.feeding_program_tanks ("equipmentId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_program_tanks_temperatureSensorId"
        ON farm.feeding_program_tanks ("temperatureSensorId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feeding_program_tanks
          ADD CONSTRAINT "FK_feeding_program_tanks_program"
          FOREIGN KEY ("feedingProgramId") REFERENCES farm.feeding_programs("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feeding_program_tanks
          ADD CONSTRAINT "FK_feeding_program_tanks_equipment"
          FOREIGN KEY ("equipmentId") REFERENCES farm.equipment("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feeding_program_tanks
          ADD CONSTRAINT "FK_feeding_program_tanks_currentFeed"
          FOREIGN KEY ("currentFeedId") REFERENCES farm.feeds("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // feeding_tables — batch-scoped FCR/feeding plan with versioning.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feeding_tables (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "batchId" uuid NOT NULL,
        "feedId" uuid NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        "previousVersionId" uuid,
        "recalculationReason" text,
        "parameters" jsonb NOT NULL,
        "schedule" jsonb NOT NULL,
        "summary" jsonb NOT NULL,
        "targetFCR" decimal(5, 3) NOT NULL,
        "actualFCR" decimal(5, 3),
        "startDate" date NOT NULL,
        "endDate" date NOT NULL,
        "status" farm.farm_feeding_table_status_enum NOT NULL DEFAULT 'draft',
        "isActive" boolean NOT NULL DEFAULT false,
        "notes" text,
        "calculatedAt" timestamptz NOT NULL,
        "calculatedBy" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "entityVersion" integer NOT NULL DEFAULT 1,
        CONSTRAINT "UQ_feeding_tables_tenant_batch_version"
          UNIQUE ("tenantId", "batchId", "version")
      );
      CREATE INDEX IF NOT EXISTS "IDX_feeding_tables_tenant_batch_status"
        ON farm.feeding_tables ("tenantId", "batchId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_tables_tenant_status"
        ON farm.feeding_tables ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_tables_batch_isActive"
        ON farm.feeding_tables ("batchId", "isActive");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_tables_tenantId"
        ON farm.feeding_tables ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_tables_batchId"
        ON farm.feeding_tables ("batchId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_tables_isActive"
        ON farm.feeding_tables ("isActive");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feeding_tables
          ADD CONSTRAINT "FK_feeding_tables_batch"
          FOREIGN KEY ("batchId") REFERENCES farm.batches_v2("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feeding_tables
          ADD CONSTRAINT "FK_feeding_tables_feed"
          FOREIGN KEY ("feedId") REFERENCES farm.feeds("id") ON DELETE RESTRICT;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // feeding_records — historical feeding event log.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.feeding_records (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "batchId" uuid NOT NULL,
        "tankId" uuid,
        "pondId" uuid,
        "batchLocationId" uuid,
        "feedingDate" date NOT NULL,
        "feedingTime" varchar(10) NOT NULL,
        "feedingSequence" integer NOT NULL DEFAULT 1,
        "totalMealsToday" integer NOT NULL DEFAULT 1,
        "feedId" uuid NOT NULL,
        "feedBatchNumber" varchar(100),
        "plannedAmount" decimal(10, 3) NOT NULL,
        "actualAmount" decimal(10, 3) NOT NULL,
        "variance" decimal(10, 3) NOT NULL DEFAULT 0,
        "variancePercent" decimal(5, 2) NOT NULL DEFAULT 0,
        "wasteAmount" decimal(10, 3),
        "environment" jsonb,
        "fishBehavior" jsonb,
        "feedingMethod" farm.farm_feeding_method_enum NOT NULL DEFAULT 'manual',
        "equipmentId" uuid,
        "feedingDurationMinutes" integer,
        "feedCost" decimal(15, 2),
        "currency" varchar(3),
        "fedBy" uuid NOT NULL,
        "verifiedBy" uuid,
        "verifiedAt" timestamptz,
        "notes" text,
        "skipReason" text,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_feeding_records_tenant_batch_date"
        ON farm.feeding_records ("tenantId", "batchId", "feedingDate");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_records_tenant_tank_date"
        ON farm.feeding_records ("tenantId", "tankId", "feedingDate");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_records_tenant_date"
        ON farm.feeding_records ("tenantId", "feedingDate");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_records_batch_date_seq"
        ON farm.feeding_records ("batchId", "feedingDate", "feedingSequence");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_records_tenantId"
        ON farm.feeding_records ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_records_batchId"
        ON farm.feeding_records ("batchId");
      CREATE INDEX IF NOT EXISTS "IDX_feeding_records_tankId"
        ON farm.feeding_records ("tankId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feeding_records
          ADD CONSTRAINT "FK_feeding_records_batch"
          FOREIGN KEY ("batchId") REFERENCES farm.batches_v2("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.feeding_records
          ADD CONSTRAINT "FK_feeding_records_feed"
          FOREIGN KEY ("feedId") REFERENCES farm.feeds("id") ON DELETE RESTRICT;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // daily_feeding_executions — per-day rollup with feed transition tracking.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.daily_feeding_executions (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "feedingProgramId" uuid NOT NULL,
        "feedingProgramTankId" uuid NOT NULL,
        "executionDate" date NOT NULL,
        "equipmentId" uuid NOT NULL,
        "equipmentType" farm.farm_program_equipment_type_enum NOT NULL,
        "equipmentName" varchar(200) NOT NULL,
        "equipmentCode" varchar(50) NOT NULL,
        "calculations" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "actualResults" jsonb,
        "status" farm.farm_execution_status_enum NOT NULL DEFAULT 'planned',
        "completedAt" timestamptz,
        "completedBy" uuid,
        "feederEquipmentId" uuid,
        "feederName" varchar(100),
        "feedingMethod" farm.farm_feeding_method_enum,
        "notes" varchar(2000),
        "skipReason" varchar(500),
        "createdBy" uuid NOT NULL,
        "lastModifiedBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_daily_feeding_executions_tank_date"
          UNIQUE ("feedingProgramTankId", "executionDate")
      );
      CREATE INDEX IF NOT EXISTS "IDX_daily_feeding_executions_tenant_date"
        ON farm.daily_feeding_executions ("tenantId", "executionDate");
      CREATE INDEX IF NOT EXISTS "IDX_daily_feeding_executions_tenant_program_date"
        ON farm.daily_feeding_executions ("tenantId", "feedingProgramId", "executionDate");
      CREATE INDEX IF NOT EXISTS "IDX_daily_feeding_executions_status_date"
        ON farm.daily_feeding_executions ("status", "executionDate");
      CREATE INDEX IF NOT EXISTS "IDX_daily_feeding_executions_tenantId"
        ON farm.daily_feeding_executions ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_daily_feeding_executions_feedingProgramId"
        ON farm.daily_feeding_executions ("feedingProgramId");
      CREATE INDEX IF NOT EXISTS "IDX_daily_feeding_executions_feedingProgramTankId"
        ON farm.daily_feeding_executions ("feedingProgramTankId");
      CREATE INDEX IF NOT EXISTS "IDX_daily_feeding_executions_executionDate"
        ON farm.daily_feeding_executions ("executionDate");
      CREATE INDEX IF NOT EXISTS "IDX_daily_feeding_executions_status"
        ON farm.daily_feeding_executions ("status");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.daily_feeding_executions
          ADD CONSTRAINT "FK_daily_feeding_executions_program"
          FOREIGN KEY ("feedingProgramId") REFERENCES farm.feeding_programs("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.daily_feeding_executions
          ADD CONSTRAINT "FK_daily_feeding_executions_program_tank"
          FOREIGN KEY ("feedingProgramTankId") REFERENCES farm.feeding_program_tanks("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * CHEMICALS GROUP — chemical_types, chemicals, chemical_sites.
   *
   * Topological order:
   *   chemical_types (cross-tenant taxonomy)
   *   chemicals (FK supplier nullable — supplier table created later by 1772000000000)
   *     → chemical_sites (FK chemicals CASCADE, FK sites CASCADE)
   */
  private async createChemicalsGroup(queryRunner: QueryRunner): Promise<void> {
    // chemical_types — cross-tenant taxonomy.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.chemical_types (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(100) NOT NULL,
        "code" varchar(50) NOT NULL UNIQUE,
        "description" text,
        "icon" varchar(50),
        "isActive" boolean NOT NULL DEFAULT true,
        "isSystem" boolean NOT NULL DEFAULT false,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_chemical_types_code"
        ON farm.chemical_types ("code");
      CREATE INDEX IF NOT EXISTS "IDX_chemical_types_isActive"
        ON farm.chemical_types ("isActive");
    `);

    // chemicals — primary catalogue.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.chemicals (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "code" varchar(50) NOT NULL,
        "description" text,
        "type" farm.farm_chemical_type_enum NOT NULL DEFAULT 'other',
        "brand" varchar(255),
        "activeIngredient" varchar(255),
        "concentration" varchar(100),
        "formulation" varchar(100),
        "supplierId" uuid,
        "status" farm.farm_chemical_status_enum NOT NULL DEFAULT 'available',
        "quantity" decimal(15, 4) NOT NULL DEFAULT 0,
        "minStock" decimal(15, 4) NOT NULL DEFAULT 0,
        "unit" varchar(20) NOT NULL DEFAULT 'liter',
        "requiresApproval" boolean NOT NULL DEFAULT false,
        "withdrawalPeriodDays" integer,
        "usageProtocol" jsonb,
        "safetyInfo" jsonb,
        "storageRequirements" text,
        "storage_temp_min" decimal(5, 1),
        "storage_temp_max" decimal(5, 1),
        "storage_humidity_min" decimal(5, 1),
        "storage_humidity_max" decimal(5, 1),
        "shelfLifeMonths" integer,
        "expiryDate" date,
        "usageAreas" text,
        "documents" jsonb,
        "unitPrice" decimal(15, 2),
        "currency" varchar(3) NOT NULL DEFAULT 'TRY',
        "notes" text,
        "isActive" boolean NOT NULL DEFAULT true,
        "isDeleted" boolean NOT NULL DEFAULT false,
        "deletedAt" timestamptz,
        "deletedBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_chemicals_tenant_code"
        ON farm.chemicals ("tenantId", "code");
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_chemicals_tenant_name"
        ON farm.chemicals ("tenantId", "name");
      CREATE INDEX IF NOT EXISTS "IDX_chemicals_tenant_type"
        ON farm.chemicals ("tenantId", "type");
      CREATE INDEX IF NOT EXISTS "IDX_chemicals_tenant_status"
        ON farm.chemicals ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_chemicals_tenant_isActive"
        ON farm.chemicals ("tenantId", "isActive");
      CREATE INDEX IF NOT EXISTS "IDX_chemicals_tenantId"
        ON farm.chemicals ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_chemicals_supplierId"
        ON farm.chemicals ("supplierId");
      CREATE INDEX IF NOT EXISTS "IDX_chemicals_isActive"
        ON farm.chemicals ("isActive");
      CREATE INDEX IF NOT EXISTS "IDX_chemicals_isDeleted"
        ON farm.chemicals ("isDeleted");
    `);

    // chemical_sites — N:M chemicals × sites (per-site approval).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.chemical_sites (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "chemicalId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "isApproved" boolean NOT NULL DEFAULT true,
        "approvedBy" uuid,
        "approvedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" uuid,
        CONSTRAINT "UQ_chemical_sites_chemical_site"
          UNIQUE ("chemicalId", "siteId")
      );
      CREATE INDEX IF NOT EXISTS "IDX_chemical_sites_tenant_chemical"
        ON farm.chemical_sites ("tenantId", "chemicalId");
      CREATE INDEX IF NOT EXISTS "IDX_chemical_sites_tenant_site"
        ON farm.chemical_sites ("tenantId", "siteId");
      CREATE INDEX IF NOT EXISTS "IDX_chemical_sites_tenantId"
        ON farm.chemical_sites ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_chemical_sites_chemicalId"
        ON farm.chemical_sites ("chemicalId");
      CREATE INDEX IF NOT EXISTS "IDX_chemical_sites_siteId"
        ON farm.chemical_sites ("siteId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.chemical_sites
          ADD CONSTRAINT "FK_chemical_sites_chemical"
          FOREIGN KEY ("chemicalId") REFERENCES farm.chemicals("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.chemical_sites
          ADD CONSTRAINT "FK_chemical_sites_site"
          FOREIGN KEY ("siteId") REFERENCES farm.sites("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * HEALTH GROUP — mortality_records, growth_measurements, health_events.
   *
   * Topological order:
   *   mortality_records (FK batches_v2 CASCADE; tankId polymorphic so column-only)
   *   growth_measurements (FK batches_v2 CASCADE; tankId/pondId column-only)
   *   health_events (FK batches_v2 CASCADE; tankId polymorphic)
   */
  private async createHealthGroup(queryRunner: QueryRunner): Promise<void> {
    // mortality_records — fish mortality events.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.mortality_records (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "batchId" uuid NOT NULL,
        "tankId" uuid,
        "pondId" uuid,
        "recordDate" date NOT NULL,
        "count" integer NOT NULL,
        "estimatedBiomassLoss" decimal(10, 2),
        "dailyMortalityRate" decimal(5, 2),
        "cause" farm.farm_mortality_cause_enum NOT NULL DEFAULT 'unknown',
        "causeDetail" varchar(255),
        "severity" farm.farm_mortality_severity_enum NOT NULL DEFAULT 'normal',
        "waterQualitySnapshot" jsonb,
        "symptoms" text,
        "behaviorObservations" text,
        "physicalCondition" text,
        "actionsTaken" text,
        "recommendations" text,
        "labSampleTaken" boolean DEFAULT false,
        "labResults" text,
        "documents" jsonb,
        "recordedBy" uuid NOT NULL,
        "verifiedBy" uuid,
        "verifiedAt" timestamptz,
        "notes" text,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_mortality_records_tenant_batch_date"
        ON farm.mortality_records ("tenantId", "batchId", "recordDate");
      CREATE INDEX IF NOT EXISTS "IDX_mortality_records_tenant_cause"
        ON farm.mortality_records ("tenantId", "cause");
      CREATE INDEX IF NOT EXISTS "IDX_mortality_records_tenant_severity"
        ON farm.mortality_records ("tenantId", "severity");
      CREATE INDEX IF NOT EXISTS "IDX_mortality_records_batch_date"
        ON farm.mortality_records ("batchId", "recordDate");
      CREATE INDEX IF NOT EXISTS "IDX_mortality_records_tank_date"
        ON farm.mortality_records ("tankId", "recordDate");
      CREATE INDEX IF NOT EXISTS "IDX_mortality_batch_created_desc"
        ON farm.mortality_records ("batchId", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_mortality_records_tenantId"
        ON farm.mortality_records ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_mortality_records_batchId"
        ON farm.mortality_records ("batchId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.mortality_records
          ADD CONSTRAINT "FK_mortality_records_batch"
          FOREIGN KEY ("batchId") REFERENCES farm.batches_v2("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // growth_measurements — biometric records (sample-based, with stats).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.growth_measurements (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "batchId" uuid NOT NULL,
        "tankId" uuid,
        "pondId" uuid,
        "measurementDate" date NOT NULL,
        "measurementType" farm.farm_measurement_type_enum NOT NULL DEFAULT 'routine',
        "measurementMethod" farm.farm_measurement_method_enum NOT NULL DEFAULT 'manual_scale',
        "sampleSize" integer NOT NULL,
        "populationSize" integer NOT NULL,
        "samplePercent" decimal(5, 2) NOT NULL,
        "individualMeasurements" jsonb NOT NULL,
        "statistics" jsonb NOT NULL,
        "averageWeight" decimal(10, 2) NOT NULL,
        "averageLength" decimal(6, 2),
        "weightCV" decimal(6, 2) NOT NULL,
        "conditionFactor" decimal(6, 3),
        "growthComparison" jsonb,
        "performance" farm.farm_growth_performance_enum,
        "fcrAnalysis" jsonb,
        "estimatedBiomass" decimal(12, 2) NOT NULL,
        "previousBiomass" decimal(12, 2),
        "biomassGain" decimal(10, 2),
        "suggestedActions" jsonb,
        "conditions" jsonb,
        "isVerified" boolean NOT NULL DEFAULT false,
        "verifiedBy" uuid,
        "verifiedAt" timestamptz,
        "measuredBy" uuid NOT NULL,
        "notes" text,
        "updateBatchWeight" boolean NOT NULL DEFAULT true,
        "isProcessed" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_tenant_batch_date"
        ON farm.growth_measurements ("tenantId", "batchId", "measurementDate");
      CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_tenant_date"
        ON farm.growth_measurements ("tenantId", "measurementDate");
      CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_batch_date"
        ON farm.growth_measurements ("batchId", "measurementDate");
      CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_batch_type"
        ON farm.growth_measurements ("batchId", "measurementType");
      CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_tenantId"
        ON farm.growth_measurements ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_batchId"
        ON farm.growth_measurements ("batchId");
      CREATE INDEX IF NOT EXISTS "IDX_growth_measurements_measurementDate"
        ON farm.growth_measurements ("measurementDate");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.growth_measurements
          ADD CONSTRAINT "FK_growth_measurements_batch"
          FOREIGN KEY ("batchId") REFERENCES farm.batches_v2("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // health_events — fish health incidents and treatment timeline.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.health_events (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "batchId" uuid NOT NULL,
        "tankId" uuid,
        "pondId" uuid,
        "title" varchar(200) NOT NULL,
        "description" text,
        "eventType" farm.farm_health_event_type_enum NOT NULL,
        "eventDate" date NOT NULL,
        "eventTime" varchar(10),
        "diseaseCategory" farm.farm_disease_category_enum,
        "diseaseName" varchar(200),
        "severity" farm.farm_health_severity_enum NOT NULL DEFAULT 'moderate',
        "symptoms" jsonb,
        "affectedPopulation" jsonb,
        "treatment" jsonb,
        "isUnderTreatment" boolean NOT NULL DEFAULT false,
        "treatmentEndDate" date,
        "withdrawalPeriodDays" integer,
        "earliestHarvestDate" date,
        "isQuarantined" boolean NOT NULL DEFAULT false,
        "quarantineStartDate" date,
        "quarantineEndDate" date,
        "quarantineTankId" uuid,
        "labResults" jsonb,
        "labConfirmed" boolean NOT NULL DEFAULT false,
        "vetConsultation" jsonb,
        "vetNotified" boolean NOT NULL DEFAULT false,
        "waterQualitySnapshot" jsonb,
        "relatedWaterQualityMeasurementId" uuid,
        "status" farm.farm_health_event_status_enum NOT NULL DEFAULT 'active',
        "resolvedDate" date,
        "resolutionNotes" text,
        "parentEventId" uuid,
        "alertIncidentId" uuid,
        "estimatedCost" decimal(15, 2),
        "currency" varchar(3),
        "reportedBy" uuid NOT NULL,
        "notes" text,
        "attachments" text,
        "followUpRequired" boolean NOT NULL DEFAULT false,
        "nextFollowUpDate" date,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_health_events_tenant_batch_date"
        ON farm.health_events ("tenantId", "batchId", "eventDate");
      CREATE INDEX IF NOT EXISTS "IDX_health_events_tenant_type_status"
        ON farm.health_events ("tenantId", "eventType", "status");
      CREATE INDEX IF NOT EXISTS "IDX_health_events_tenant_date"
        ON farm.health_events ("tenantId", "eventDate");
      CREATE INDEX IF NOT EXISTS "IDX_health_events_batch_status"
        ON farm.health_events ("batchId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_health_events_disease_tenant"
        ON farm.health_events ("diseaseCategory", "tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_health_events_tenantId"
        ON farm.health_events ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_health_events_batchId"
        ON farm.health_events ("batchId");
      CREATE INDEX IF NOT EXISTS "IDX_health_events_tankId"
        ON farm.health_events ("tankId");
      CREATE INDEX IF NOT EXISTS "IDX_health_events_eventType"
        ON farm.health_events ("eventType");
      CREATE INDEX IF NOT EXISTS "IDX_health_events_eventDate"
        ON farm.health_events ("eventDate");
      CREATE INDEX IF NOT EXISTS "IDX_health_events_status"
        ON farm.health_events ("status");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.health_events
          ADD CONSTRAINT "FK_health_events_batch"
          FOREIGN KEY ("batchId") REFERENCES farm.batches_v2("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * HARVEST GROUP — harvest_plans, harvest_records.
   *
   * Topological order:
   *   harvest_plans (FK batches_v2 CASCADE)
   *     → harvest_records (FK batches_v2 CASCADE, FK harvest_plans SET NULL)
   *
   * Both tables use polymorphic tankId (column-only, no FK) per entity decorator.
   */
  private async createHarvestGroup(queryRunner: QueryRunner): Promise<void> {
    // harvest_plans — planned harvest with estimates and logistics.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.harvest_plans (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "planCode" varchar(50) NOT NULL,
        "name" varchar(200) NOT NULL,
        "description" text,
        "batchId" uuid NOT NULL,
        "status" farm.farm_harvest_plan_status_enum NOT NULL DEFAULT 'draft',
        "harvestType" farm.farm_harvest_type_enum NOT NULL DEFAULT 'full',
        "plannedDate" date NOT NULL,
        "confirmedDate" date,
        "windowStartDate" date,
        "windowEndDate" date,
        "criteria" jsonb NOT NULL,
        "harvestMethod" farm.farm_harvest_method_enum,
        "productForm" farm.farm_product_form_enum NOT NULL DEFAULT 'fresh_whole',
        "estimates" jsonb NOT NULL,
        "financialProjection" jsonb,
        "logistics" jsonb,
        "customerOrder" jsonb,
        "qualityRequirements" jsonb,
        "actualQuantityHarvested" integer,
        "actualBiomassHarvested" decimal(12, 2),
        "actualAvgWeight" decimal(10, 2),
        "approvedBy" uuid,
        "approvedAt" timestamptz,
        "createdBy" uuid NOT NULL,
        "notes" text,
        "attachments" text,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_harvest_plans_tenant_planCode"
        ON farm.harvest_plans ("tenantId", "planCode");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_tenant_batch"
        ON farm.harvest_plans ("tenantId", "batchId");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_tenant_status"
        ON farm.harvest_plans ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_tenant_plannedDate"
        ON farm.harvest_plans ("tenantId", "plannedDate");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_batch_status"
        ON farm.harvest_plans ("batchId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_tenantId"
        ON farm.harvest_plans ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_planCode"
        ON farm.harvest_plans ("planCode");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_batchId"
        ON farm.harvest_plans ("batchId");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_status"
        ON farm.harvest_plans ("status");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_plans_plannedDate"
        ON farm.harvest_plans ("plannedDate");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.harvest_plans
          ADD CONSTRAINT "FK_harvest_plans_batch"
          FOREIGN KEY ("batchId") REFERENCES farm.batches_v2("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // harvest_records — actual harvest event with QA and lot data.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.harvest_records (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "recordCode" varchar(50) NOT NULL,
        "lotNumber" varchar(50) NOT NULL,
        "batchId" uuid NOT NULL,
        "harvestPlanId" uuid,
        "tankId" uuid,
        "pondId" uuid,
        "status" farm.farm_harvest_record_status_enum NOT NULL DEFAULT 'in_progress',
        "harvestDate" date NOT NULL,
        "operation" jsonb NOT NULL,
        "method" farm.farm_harvest_method_enum NOT NULL DEFAULT 'net',
        "quantityHarvested" integer NOT NULL,
        "totalBiomass" decimal(12, 2) NOT NULL,
        "averageWeight" decimal(10, 2) NOT NULL,
        "minWeight" decimal(10, 2),
        "maxWeight" decimal(10, 2),
        "sizeDistribution" jsonb,
        "productForm" farm.farm_product_form_enum NOT NULL DEFAULT 'fresh_whole',
        "qualityGrade" farm.farm_quality_grade_enum NOT NULL DEFAULT 'grade_a',
        "qualityControl" jsonb,
        "qualityApproved" boolean NOT NULL DEFAULT false,
        "lotInfo" jsonb NOT NULL,
        "yieldCalculation" jsonb,
        "shipment" jsonb,
        "customerDeliveries" jsonb,
        "totalRevenue" decimal(15, 2),
        "harvestCost" decimal(15, 2),
        "currency" varchar(3),
        "mortalityDuringHarvest" integer,
        "rejectedQuantity" decimal(10, 2),
        "rejectionReason" text,
        "supervisorId" uuid NOT NULL,
        "approvedBy" uuid,
        "approvedAt" timestamptz,
        "notes" text,
        "attachments" text,
        "updatedBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_harvest_records_tenant_recordCode"
        ON farm.harvest_records ("tenantId", "recordCode");
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_harvest_records_tenant_lotNumber"
        ON farm.harvest_records ("tenantId", "lotNumber");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_records_tenant_batch_date"
        ON farm.harvest_records ("tenantId", "batchId", "harvestDate");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_records_tenant_date"
        ON farm.harvest_records ("tenantId", "harvestDate");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_records_tenant_status"
        ON farm.harvest_records ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_records_batch_date"
        ON farm.harvest_records ("batchId", "harvestDate");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_records_tenantId"
        ON farm.harvest_records ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_records_recordCode"
        ON farm.harvest_records ("recordCode");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_records_lotNumber"
        ON farm.harvest_records ("lotNumber");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_records_batchId"
        ON farm.harvest_records ("batchId");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_records_status"
        ON farm.harvest_records ("status");
      CREATE INDEX IF NOT EXISTS "IDX_harvest_records_harvestDate"
        ON farm.harvest_records ("harvestDate");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.harvest_records
          ADD CONSTRAINT "FK_harvest_records_batch"
          FOREIGN KEY ("batchId") REFERENCES farm.batches_v2("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.harvest_records
          ADD CONSTRAINT "FK_harvest_records_plan"
          FOREIGN KEY ("harvestPlanId") REFERENCES farm.harvest_plans("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * TASKS GROUP — tasks, auto_rules, recurring_templates.
   *
   * No FK constraints out — task assignments and recurring template
   * generation are looser couplings managed at the service layer
   * (assignedTo, createdBy, etc. are cross-service user UUIDs).
   *
   * The `timezone` column on recurring_templates is included here so that
   * 1787300000000-AddRecurringTemplateTimezone becomes pure no-op on a
   * fresh DB (its ADD COLUMN IF NOT EXISTS check passes through).
   */
  private async createTasksGroup(queryRunner: QueryRunner): Promise<void> {
    // tasks — operational task with checklist + notes JSONB.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.tasks (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "title" varchar(255) NOT NULL,
        "description" text,
        "category" farm.farm_task_category_enum NOT NULL,
        "priority" farm.farm_task_priority_enum NOT NULL,
        "status" farm.farm_task_status_enum NOT NULL DEFAULT 'PENDING',
        "assignedTo" uuid NOT NULL,
        "assignedToName" varchar(255) NOT NULL,
        "createdBy" uuid NOT NULL,
        "dueDate" date NOT NULL,
        "dueTime" time,
        "siteId" uuid,
        "location" varchar,
        "estimatedMinutes" integer,
        "checklistItems" jsonb DEFAULT '[]'::jsonb,
        "notes" jsonb DEFAULT '[]'::jsonb,
        "tags" jsonb DEFAULT '[]'::jsonb,
        "isRecurring" boolean NOT NULL DEFAULT false,
        "recurringTemplateId" uuid,
        "isAutoGenerated" boolean NOT NULL DEFAULT false,
        "completedAt" timestamptz,
        "completedBy" uuid,
        "deletedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_tasks_tenant_assignedTo_status"
        ON farm.tasks ("tenantId", "assignedTo", "status");
      CREATE INDEX IF NOT EXISTS "IDX_tasks_tenant_dueDate"
        ON farm.tasks ("tenantId", "dueDate");
      CREATE INDEX IF NOT EXISTS "IDX_tasks_tenant_status_priority"
        ON farm.tasks ("tenantId", "status", "priority");
      CREATE INDEX IF NOT EXISTS "IDX_tasks_status_dueDate"
        ON farm.tasks ("status", "dueDate");
    `);

    // auto_rules — trigger-driven task generation rules.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.auto_rules (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text,
        "trigger" farm.farm_auto_rule_trigger_enum NOT NULL,
        "triggerCondition" text NOT NULL,
        "taskTitle" varchar(255) NOT NULL,
        "taskDescription" text,
        "taskCategory" farm.farm_task_category_enum NOT NULL,
        "taskPriority" farm.farm_task_priority_enum NOT NULL,
        "assignTo" uuid,
        "isActive" boolean NOT NULL DEFAULT true,
        "lastTriggered" timestamptz,
        "triggerCount" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "deletedAt" timestamptz
      );
      CREATE INDEX IF NOT EXISTS "IDX_auto_rules_tenant_isActive"
        ON farm.auto_rules ("tenantId", "isActive");
    `);

    // recurring_templates — periodic task templates.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.recurring_templates (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "title" varchar(255) NOT NULL,
        "description" text,
        "category" farm.farm_task_category_enum NOT NULL,
        "priority" farm.farm_task_priority_enum NOT NULL,
        "frequency" farm.farm_recurrence_frequency_enum NOT NULL,
        "frequencyDetail" varchar,
        "timezone" varchar(64),
        "assignedTo" uuid NOT NULL,
        "assignedToName" varchar(255) NOT NULL,
        "location" varchar,
        "estimatedMinutes" integer,
        "checklistItems" jsonb DEFAULT '[]'::jsonb,
        "isActive" boolean NOT NULL DEFAULT true,
        "lastGenerated" timestamptz,
        "nextGeneration" timestamptz,
        "tags" jsonb DEFAULT '[]'::jsonb,
        "deletedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_recurring_templates_tenant_isActive"
        ON farm.recurring_templates ("tenantId", "isActive");
      CREATE INDEX IF NOT EXISTS "IDX_recurring_templates_isActive_next"
        ON farm.recurring_templates ("isActive", "nextGeneration");
    `);
  }

  /**
   * INFRA GROUP — code_sequences, farm_audit_logs, farm_workers.
   *
   * code_sequences:
   *   Cross-tenant sequence generator. The CodeSequence entity decorates
   *   `@Entity('code_sequences')` (no schema:) — the source-template is
   *   here in `farm.code_sequences`, and per-tenant clones are created by
   *   1786900000000-AlignCodeSequencesSchema's ensureTenantTableExists()
   *   helper using LIKE INCLUDING ALL. Idempotent IF NOT EXISTS so that
   *   later migration's farm-side CREATE is a no-op.
   *
   * farm_audit_logs:
   *   Cross-tenant audit log. The entity carries `@Entity('farm_audit_logs')`
   *   (no schema:) — but this is the canonical farm-schema source-of-truth
   *   that the immutability triggers in 1788300000000 attach to.
   *   `legalHold` column added here so that immutability migration's
   *   `ADD COLUMN IF NOT EXISTS` is a no-op on fresh DB.
   *
   * farm_workers:
   *   Per-tenant farm worker roster, distinct from HR service's
   *   `employees` table. Email-encryption transformer is application-layer
   *   only — column type is plain text/varchar at the DB level.
   */
  private async createInfraGroup(queryRunner: QueryRunner): Promise<void> {
    // code_sequences — cross-tenant sequence generator template.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.code_sequences (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "entityType" varchar(50) NOT NULL,
        "prefix" varchar(10) NOT NULL,
        "year" integer NOT NULL,
        "lastSequence" integer NOT NULL DEFAULT 0,
        "lastGeneratedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_code_sequences_tenant_entityType_year"
          UNIQUE ("tenantId", "entityType", "year")
      );
      CREATE INDEX IF NOT EXISTS "IDX_code_sequences_tenant_entityType"
        ON farm.code_sequences ("tenantId", "entityType");
      CREATE INDEX IF NOT EXISTS "IDX_code_sequences_tenantId"
        ON farm.code_sequences ("tenantId");
    `);

    // farm_audit_logs — cross-tenant audit log (immutability triggers
    // installed by 1788300000001-AddFarmAuditLogsImmutability).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.farm_audit_logs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "entityType" varchar(100) NOT NULL,
        "entityId" uuid NOT NULL,
        "action" farm.farm_audit_action_enum NOT NULL,
        "userId" uuid,
        "userName" varchar(255),
        "changes" jsonb,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "entityVersion" integer,
        "summary" text,
        "legalHold" boolean NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS "IDX_farm_audit_tenant_entity"
        ON farm.farm_audit_logs ("tenantId", "entityType", "entityId");
      CREATE INDEX IF NOT EXISTS "IDX_farm_audit_tenant_created"
        ON farm.farm_audit_logs ("tenantId", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_farm_audit_created"
        ON farm.farm_audit_logs ("createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_farm_audit_tenant_action"
        ON farm.farm_audit_logs ("tenantId", "action");
      CREATE INDEX IF NOT EXISTS "IDX_farm_audit_tenant_user"
        ON farm.farm_audit_logs ("tenantId", "userId");
      CREATE INDEX IF NOT EXISTS "IDX_farm_audit_tenant"
        ON farm.farm_audit_logs ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_farm_audit_entity_type"
        ON farm.farm_audit_logs ("entityType");
      CREATE INDEX IF NOT EXISTS "IDX_farm_audit_created_col"
        ON farm.farm_audit_logs ("createdAt");
    `);

    // farm_workers — per-tenant farm worker roster (encrypted nationalId
    // at application layer; DB column is plain text).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.farm_workers (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "employeeNumber" varchar NOT NULL UNIQUE,
        "firstName" varchar NOT NULL,
        "lastName" varchar NOT NULL,
        "email" varchar NOT NULL,
        "contactInfo" jsonb NOT NULL,
        "address" jsonb NOT NULL,
        "dateOfBirth" date NOT NULL,
        "nationalId" text NOT NULL,
        "status" varchar NOT NULL DEFAULT 'active',
        "employmentType" varchar NOT NULL,
        "department" varchar NOT NULL,
        "position" varchar NOT NULL,
        "hireDate" date NOT NULL,
        "baseSalary" decimal(12, 2) NOT NULL,
        "currency" varchar NOT NULL DEFAULT 'USD',
        "isDeleted" boolean NOT NULL DEFAULT false,
        "isFarmWorker" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" varchar,
        "version" integer NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_farm_workers_tenant_email"
        ON farm.farm_workers ("tenantId", "email");
      CREATE INDEX IF NOT EXISTS "IDX_farm_workers_tenant_department"
        ON farm.farm_workers ("tenantId", "department");
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_farm_workers_employeeNumber"
        ON farm.farm_workers ("employeeNumber");
    `);
  }

  /**
   * Species column additions (tenant template).
   *
   * The W4-A.1 baseline created `farm.species` with the original
   * init-script column set. The 1769100000000-AddSpeciesTags migration
   * later added `tags` JSONB and assumed `isCleanerFish` + `commonName`
   * columns existed (the migration's data-fix UPDATE references both).
   * Owning all three columns here means:
   *
   *   - On a fresh DB, AddSpeciesTags becomes a pure no-op (its column
   *     existence guards skip the ADD).
   *   - On an existing DB that already has these columns, the
   *     `ADD COLUMN IF NOT EXISTS` here is also a no-op — idempotent.
   *
   * Architectural rationale: the W4-A.2 plan's principle is "CREATE in
   * baseline, ALTER becomes belt-and-braces". This makes the data-fix UPDATE
   * in 1769100000000 self-consistent on every fresh-bootstrap path.
   */
  private async alterSpeciesAddColumns(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.species
        ADD COLUMN IF NOT EXISTS "isCleanerFish" boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS "commonName" varchar(255),
        ADD COLUMN IF NOT EXISTS "tags" jsonb DEFAULT '[]'::jsonb
    `);

    // GIN index for tags (created by AddSpeciesTags too — IF NOT EXISTS
    // makes both paths idempotent).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_species_tags"
      ON farm.species USING GIN ("tags")
    `);
  }
}
