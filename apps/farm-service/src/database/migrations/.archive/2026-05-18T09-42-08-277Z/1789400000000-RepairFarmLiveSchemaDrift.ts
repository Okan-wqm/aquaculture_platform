import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
  withDdlSafety,
} from '@aquaculture/backend-common/database';

/**
 * RepairFarmLiveSchemaDrift1789400000000
 * ============================================================================
 *
 * Forward-only production repair for farm-service drift observed after the
 * one-shot db-migrate runner started enforcing schema health before service
 * boot. Earlier farm migrations were already marked as applied on the live
 * droplet, but the physical schema still lagged the entity surface.
 *
 * This migration codifies the missing contract instead of weakening
 * SchemaDriftValidator or health gates:
 *   - recreates the tenant erasure audit table if an older environment skipped
 *     the original 178850 DDL while still recording the migration row;
 *   - aligns systems/sub_systems with the camelCase entity columns, enum
 *     values, defaults, nullability and relational indexes;
 *   - tightens the remaining NOT NULL/default drift surfaced by farm bootstrap;
 *   - adds the missing inventory/stock traceability columns and indexes.
 */
export class RepairFarmLiveSchemaDrift1789400000000
  implements MigrationInterface
{
  name = 'RepairFarmLiveSchemaDrift1789400000000';

  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'farm');

    await withDdlSafety(
      queryRunner,
      { schema: 'farm', advisoryLockKeySuffix: this.name },
      async () => {
        this.logger.log('Repairing farm live schema drift contract.');

        await this.ensureTenantErasureAudit(queryRunner);
        await this.ensureSystemEnumTypes(queryRunner);
        await this.alignSystems(queryRunner);
        await this.alignSubSystems(queryRunner);
        await this.alignMortalityRecords(queryRunner);
        await this.alignRegulatorySettings(queryRunner);
        await this.alignStorageLocations(queryRunner);
        await this.alignStorageInventory(queryRunner);
        await this.alignStockMovements(queryRunner);
        await this.alignTasks(queryRunner);

        this.logger.log('Farm live schema drift contract repaired.');
      },
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Down migration intentionally left as no-op: farm live schema drift repair is forward-only.',
    );
  }

  private async ensureTenantErasureAudit(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.tenant_erasure_audit (
        "tenantId"             uuid PRIMARY KEY,
        "confirmedAt"          timestamptz NOT NULL,
        "requestedBy"          varchar(255) NOT NULL,
        "totalDeleted"         integer NOT NULL,
        "auditRowsAnonymised"  integer NOT NULL,
        "tableCount"           integer NOT NULL,
        "deletedRowsByTable"   jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.tenant_erasure_audit_prevent_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'tenant_erasure_audit rows are immutable; tenantId=%, op=%',
          OLD."tenantId", TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_tenant_erasure_audit_prevent_update
        ON farm.tenant_erasure_audit
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_tenant_erasure_audit_prevent_update
        BEFORE UPDATE OR DELETE ON farm.tenant_erasure_audit
        FOR EACH ROW
        EXECUTE FUNCTION farm.tenant_erasure_audit_prevent_mutation()
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farm_service') THEN
          ALTER TABLE farm.tenant_erasure_audit OWNER TO farm_service;
          ALTER FUNCTION farm.tenant_erasure_audit_prevent_mutation() OWNER TO farm_service;
          GRANT ALL PRIVILEGES ON TABLE farm.tenant_erasure_audit TO farm_service;
        END IF;
      END $$
    `);
  }

  private async ensureSystemEnumTypes(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.systems_type_enum AS ENUM (
          'ras',
          'flow_through',
          'pond',
          'cage',
          'raceway',
          'hatchery',
          'nursery',
          'biofloc',
          'aquaponics',
          'other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.systems_status_enum AS ENUM (
          'operational',
          'maintenance',
          'offline',
          'construction'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.sub_systems_type_enum AS ENUM (
          'aeration',
          'filtration',
          'biological',
          'heating',
          'cooling',
          'uv',
          'ozone',
          'oxygen',
          'pumping',
          'feeding',
          'monitoring',
          'other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.sub_systems_status_enum AS ENUM (
          'operational',
          'maintenance',
          'inactive'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farm_service') THEN
          ALTER TYPE farm.systems_type_enum OWNER TO farm_service;
          ALTER TYPE farm.systems_status_enum OWNER TO farm_service;
          ALTER TYPE farm.sub_systems_type_enum OWNER TO farm_service;
          ALTER TYPE farm.sub_systems_status_enum OWNER TO farm_service;
        END IF;
      END $$
    `);
  }

  private async alignSystems(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.systems
        ADD COLUMN IF NOT EXISTS "departmentId" uuid,
        ADD COLUMN IF NOT EXISTS "parentSystemId" uuid,
        ADD COLUMN IF NOT EXISTS "type" farm.systems_type_enum DEFAULT 'other',
        ADD COLUMN IF NOT EXISTS "totalVolumeM3" numeric(12, 2),
        ADD COLUMN IF NOT EXISTS "maxBiomassKg" numeric(12, 2),
        ADD COLUMN IF NOT EXISTS "tankCount" integer,
        ADD COLUMN IF NOT EXISTS "status" farm.systems_status_enum DEFAULT 'operational',
        ADD COLUMN IF NOT EXISTS "isActive" boolean DEFAULT true,
        ADD COLUMN IF NOT EXISTS "createdAt" timestamptz DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "isDeleted" boolean DEFAULT false
    `);

    await this.copyColumnIfBothExist(
      queryRunner,
      'systems',
      'parent_system_id',
      'parentSystemId',
    );

    await queryRunner.query(`
      DO $$
      DECLARE
        observed_udt_name text;
      BEGIN
        SELECT udt_name
          INTO observed_udt_name
          FROM information_schema.columns
         WHERE table_schema = 'farm'
           AND table_name = 'systems'
           AND column_name = 'type';

        IF observed_udt_name IS NOT NULL
           AND observed_udt_name IS DISTINCT FROM 'systems_type_enum' THEN
          ALTER TABLE farm.systems ALTER COLUMN "type" DROP DEFAULT;
          ALTER TABLE farm.systems
            ALTER COLUMN "type" TYPE farm.systems_type_enum
            USING (
              CASE lower(COALESCE("type"::text, 'other'))
                WHEN 'ras' THEN 'ras'
                WHEN 'flow_through' THEN 'flow_through'
                WHEN 'pond' THEN 'pond'
                WHEN 'cage' THEN 'cage'
                WHEN 'raceway' THEN 'raceway'
                WHEN 'hatchery' THEN 'hatchery'
                WHEN 'nursery' THEN 'nursery'
                WHEN 'biofloc' THEN 'biofloc'
                WHEN 'aquaponics' THEN 'aquaponics'
                ELSE 'other'
              END
            )::farm.systems_type_enum;
        END IF;
      END $$
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        observed_udt_name text;
      BEGIN
        SELECT udt_name
          INTO observed_udt_name
          FROM information_schema.columns
         WHERE table_schema = 'farm'
           AND table_name = 'systems'
           AND column_name = 'status';

        IF observed_udt_name IS NOT NULL
           AND observed_udt_name IS DISTINCT FROM 'systems_status_enum' THEN
          ALTER TABLE farm.systems ALTER COLUMN "status" DROP DEFAULT;
          ALTER TABLE farm.systems
            ALTER COLUMN "status" TYPE farm.systems_status_enum
            USING (
              CASE lower(COALESCE("status"::text, 'operational'))
                WHEN 'operational' THEN 'operational'
                WHEN 'active' THEN 'operational'
                WHEN 'maintenance' THEN 'maintenance'
                WHEN 'offline' THEN 'offline'
                WHEN 'inactive' THEN 'offline'
                WHEN 'construction' THEN 'construction'
                WHEN 'commissioning' THEN 'construction'
                ELSE 'operational'
              END
            )::farm.systems_status_enum;
        END IF;
      END $$
    `);

    await queryRunner.query(`
      ALTER TABLE farm.systems
        ALTER COLUMN "type" SET DEFAULT 'other',
        ALTER COLUMN "status" SET DEFAULT 'operational',
        ALTER COLUMN "isActive" SET DEFAULT true,
        ALTER COLUMN "createdAt" SET DEFAULT NOW(),
        ALTER COLUMN "updatedAt" SET DEFAULT NOW(),
        ALTER COLUMN "version" SET DEFAULT 1,
        ALTER COLUMN "isDeleted" SET DEFAULT false
    `);

    await this.backfillAndSetNotNull(queryRunner, 'systems', 'type', `'other'`);
    await this.backfillAndSetNotNull(
      queryRunner,
      'systems',
      'status',
      `'operational'`,
    );
    await this.backfillAndSetNotNull(queryRunner, 'systems', 'isActive', 'true');
    await this.backfillAndSetNotNull(queryRunner, 'systems', 'createdAt', 'NOW()');
    await this.backfillAndSetNotNull(
      queryRunner,
      'systems',
      'updatedAt',
      'COALESCE("createdAt", NOW())',
    );
    await this.backfillAndSetNotNull(queryRunner, 'systems', 'version', '1');
    await this.backfillAndSetNotNull(queryRunner, 'systems', 'isDeleted', 'false');

    await queryRunner.query(`
      UPDATE farm.systems s
         SET "departmentId" = NULL
       WHERE s."departmentId" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM farm.departments d WHERE d.id = s."departmentId"
         )
    `);

    await queryRunner.query(`
      UPDATE farm.systems s
         SET "parentSystemId" = NULL
       WHERE s."parentSystemId" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM farm.systems parent WHERE parent.id = s."parentSystemId"
         )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_systems_departmentId"
        ON farm.systems ("departmentId")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_systems_parentSystemId"
        ON farm.systems ("parentSystemId")
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.systems
          ADD CONSTRAINT "FK_systems_department"
          FOREIGN KEY ("departmentId") REFERENCES farm.departments("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.systems
          ADD CONSTRAINT "FK_systems_parentSystem"
          FOREIGN KEY ("parentSystemId") REFERENCES farm.systems("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  private async alignSubSystems(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.sub_systems
        ADD COLUMN IF NOT EXISTS "departmentId" uuid,
        ADD COLUMN IF NOT EXISTS "type" farm.sub_systems_type_enum DEFAULT 'other',
        ADD COLUMN IF NOT EXISTS "status" farm.sub_systems_status_enum DEFAULT 'operational',
        ADD COLUMN IF NOT EXISTS "isActive" boolean DEFAULT true,
        ADD COLUMN IF NOT EXISTS "createdAt" timestamptz DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "isDeleted" boolean DEFAULT false
    `);

    await queryRunner.query(`
      UPDATE farm.sub_systems ss
         SET "departmentId" = s."departmentId"
        FROM farm.systems s
       WHERE ss."systemId" = s.id
         AND ss."departmentId" IS NULL
         AND s."departmentId" IS NOT NULL
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        observed_udt_name text;
      BEGIN
        SELECT udt_name
          INTO observed_udt_name
          FROM information_schema.columns
         WHERE table_schema = 'farm'
           AND table_name = 'sub_systems'
           AND column_name = 'type';

        IF observed_udt_name IS NOT NULL
           AND observed_udt_name IS DISTINCT FROM 'sub_systems_type_enum' THEN
          ALTER TABLE farm.sub_systems ALTER COLUMN "type" DROP DEFAULT;
          ALTER TABLE farm.sub_systems
            ALTER COLUMN "type" TYPE farm.sub_systems_type_enum
            USING (
              CASE lower(COALESCE("type"::text, 'other'))
                WHEN 'aeration' THEN 'aeration'
                WHEN 'filtration' THEN 'filtration'
                WHEN 'biological' THEN 'biological'
                WHEN 'heating' THEN 'heating'
                WHEN 'heating_cooling' THEN 'heating'
                WHEN 'cooling' THEN 'cooling'
                WHEN 'uv' THEN 'uv'
                WHEN 'ozone' THEN 'ozone'
                WHEN 'oxygen' THEN 'oxygen'
                WHEN 'pumping' THEN 'pumping'
                WHEN 'feeding' THEN 'feeding'
                WHEN 'monitoring' THEN 'monitoring'
                ELSE 'other'
              END
            )::farm.sub_systems_type_enum;
        END IF;
      END $$
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        observed_udt_name text;
      BEGIN
        SELECT udt_name
          INTO observed_udt_name
          FROM information_schema.columns
         WHERE table_schema = 'farm'
           AND table_name = 'sub_systems'
           AND column_name = 'status';

        IF observed_udt_name IS NOT NULL
           AND observed_udt_name IS DISTINCT FROM 'sub_systems_status_enum' THEN
          ALTER TABLE farm.sub_systems ALTER COLUMN "status" DROP DEFAULT;
          ALTER TABLE farm.sub_systems
            ALTER COLUMN "status" TYPE farm.sub_systems_status_enum
            USING (
              CASE lower(COALESCE("status"::text, 'operational'))
                WHEN 'operational' THEN 'operational'
                WHEN 'active' THEN 'operational'
                WHEN 'maintenance' THEN 'maintenance'
                WHEN 'cleaning' THEN 'maintenance'
                WHEN 'inactive' THEN 'inactive'
                WHEN 'fallow' THEN 'inactive'
                ELSE 'operational'
              END
            )::farm.sub_systems_status_enum;
        END IF;
      END $$
    `);

    await queryRunner.query(`
      ALTER TABLE farm.sub_systems
        ALTER COLUMN "type" SET DEFAULT 'other',
        ALTER COLUMN "status" SET DEFAULT 'operational',
        ALTER COLUMN "isActive" SET DEFAULT true,
        ALTER COLUMN "createdAt" SET DEFAULT NOW(),
        ALTER COLUMN "updatedAt" SET DEFAULT NOW(),
        ALTER COLUMN "version" SET DEFAULT 1,
        ALTER COLUMN "isDeleted" SET DEFAULT false
    `);

    await this.backfillAndSetNotNull(
      queryRunner,
      'sub_systems',
      'type',
      `'other'`,
    );
    await this.backfillAndSetNotNull(
      queryRunner,
      'sub_systems',
      'status',
      `'operational'`,
    );
    await this.backfillAndSetNotNull(
      queryRunner,
      'sub_systems',
      'isActive',
      'true',
    );
    await this.backfillAndSetNotNull(
      queryRunner,
      'sub_systems',
      'createdAt',
      'NOW()',
    );
    await this.backfillAndSetNotNull(
      queryRunner,
      'sub_systems',
      'updatedAt',
      'COALESCE("createdAt", NOW())',
    );
    await this.backfillAndSetNotNull(queryRunner, 'sub_systems', 'version', '1');
    await this.backfillAndSetNotNull(
      queryRunner,
      'sub_systems',
      'isDeleted',
      'false',
    );

    await queryRunner.query(`
      UPDATE farm.sub_systems ss
         SET "departmentId" = NULL
       WHERE ss."departmentId" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM farm.departments d WHERE d.id = ss."departmentId"
         )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sub_systems_departmentId"
        ON farm.sub_systems ("departmentId")
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE farm.sub_systems
          ADD CONSTRAINT "FK_sub_systems_department"
          FOREIGN KEY ("departmentId") REFERENCES farm.departments("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  private async alignMortalityRecords(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.mortality_records
        ADD COLUMN IF NOT EXISTS "labSampleTaken" boolean DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE farm.mortality_records
        ALTER COLUMN "labSampleTaken" SET DEFAULT false
    `);
    await this.backfillAndSetNotNull(
      queryRunner,
      'mortality_records',
      'labSampleTaken',
      'false',
    );
  }

  private async alignRegulatorySettings(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.regulatory_settings
        ADD COLUMN IF NOT EXISTS "maskinporten_environment" varchar(20) DEFAULT 'TEST',
        ADD COLUMN IF NOT EXISTS "site_locality_mappings" jsonb DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS "created_at" timestamptz DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS "updated_at" timestamptz DEFAULT NOW()
    `);
    await queryRunner.query(`
      ALTER TABLE farm.regulatory_settings
        ALTER COLUMN "maskinporten_environment" SET DEFAULT 'TEST',
        ALTER COLUMN "site_locality_mappings" SET DEFAULT '{}'::jsonb,
        ALTER COLUMN "created_at" SET DEFAULT NOW(),
        ALTER COLUMN "updated_at" SET DEFAULT NOW()
    `);
    await this.backfillAndSetNotNull(
      queryRunner,
      'regulatory_settings',
      'maskinporten_environment',
      `'TEST'`,
    );
    await this.backfillAndSetNotNull(
      queryRunner,
      'regulatory_settings',
      'site_locality_mappings',
      `'{}'::jsonb`,
    );
    await this.backfillAndSetNotNull(
      queryRunner,
      'regulatory_settings',
      'created_at',
      'NOW()',
    );
    await this.backfillAndSetNotNull(
      queryRunner,
      'regulatory_settings',
      'updated_at',
      'COALESCE("created_at", NOW())',
    );
  }

  private async alignStorageLocations(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.storage_locations
        ADD COLUMN IF NOT EXISTS "capacity_unit" varchar(20) DEFAULT 'm3',
        ADD COLUMN IF NOT EXISTS "used_capacity" numeric(15, 2) DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE farm.storage_locations
        ALTER COLUMN "capacity_unit" SET DEFAULT 'm3',
        ALTER COLUMN "used_capacity" SET DEFAULT 0
    `);
    await this.backfillAndSetNotNull(
      queryRunner,
      'storage_locations',
      'capacity_unit',
      `'m3'`,
    );
    await this.backfillAndSetNotNull(
      queryRunner,
      'storage_locations',
      'used_capacity',
      '0',
    );
  }

  private async alignStorageInventory(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.storage_inventory
        ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1
    `);
    await queryRunner.query(`
      ALTER TABLE farm.storage_inventory
        ALTER COLUMN "version" SET DEFAULT 1
    `);
    await this.backfillAndSetNotNull(
      queryRunner,
      'storage_inventory',
      'version',
      '1',
    );
  }

  private async alignStockMovements(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.stock_movements
        ADD COLUMN IF NOT EXISTS "lot_number" varchar(100),
        ADD COLUMN IF NOT EXISTS "expiry_date" date,
        ADD COLUMN IF NOT EXISTS "idempotency_key" varchar(64),
        ADD COLUMN IF NOT EXISTS "performed_by_name" varchar(255)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stock_movements_tenant_lot_number"
        ON farm.stock_movements ("tenant_id", "lot_number")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_stock_movements_idempotency_key"
        ON farm.stock_movements ("idempotency_key")
        WHERE "idempotency_key" IS NOT NULL
    `);
  }

  private async alignTasks(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.tasks
        ADD COLUMN IF NOT EXISTS "checklistItems" jsonb DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS "notes" jsonb DEFAULT '[]'::jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE farm.tasks
        ALTER COLUMN "checklistItems" SET DEFAULT '[]'::jsonb,
        ALTER COLUMN "notes" SET DEFAULT '[]'::jsonb
    `);
    await this.backfillAndSetNotNull(
      queryRunner,
      'tasks',
      'checklistItems',
      `'[]'::jsonb`,
    );
    await this.backfillAndSetNotNull(queryRunner, 'tasks', 'notes', `'[]'::jsonb`);
  }

  private async copyColumnIfBothExist(
    queryRunner: QueryRunner,
    tableName: string,
    sourceColumn: string,
    targetColumn: string,
  ): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'farm'
             AND table_name = '${tableName}'
             AND column_name = '${sourceColumn}'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'farm'
             AND table_name = '${tableName}'
             AND column_name = '${targetColumn}'
        ) THEN
          UPDATE farm.${tableName}
             SET "${targetColumn}" = "${sourceColumn}"
           WHERE "${targetColumn}" IS NULL
             AND "${sourceColumn}" IS NOT NULL;
        END IF;
      END $$
    `);
  }

  private async backfillAndSetNotNull(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
    backfillExpression: string,
  ): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'farm'
             AND table_name = '${tableName}'
             AND column_name = '${columnName}'
             AND is_nullable = 'YES'
        ) THEN
          UPDATE farm.${tableName}
             SET "${columnName}" = ${backfillExpression}
           WHERE "${columnName}" IS NULL;
          ALTER TABLE farm.${tableName}
            ALTER COLUMN "${columnName}" SET NOT NULL;
        END IF;
      END $$
    `);
  }
}
