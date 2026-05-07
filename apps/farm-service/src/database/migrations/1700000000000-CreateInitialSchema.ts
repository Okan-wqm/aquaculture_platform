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
      'Creating baseline farm.* tables (15) and enum types (20)',
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

    this.logger.log('Baseline farm schema initialised.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse FK order — children first, then parents, then enum types.
    this.logger.warn(
      'Reverting baseline farm.* tables. ' +
        'This is destructive and is intended for ephemeral test environments only.',
    );

    const tablesInDropOrder = [
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
}
