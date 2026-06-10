import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
  withDdlSafety,
} from '@aquaculture/backend-common/database';

/**
 * AlignFarmReferenceDataContracts1789300000000
 * ============================================================================
 *
 * Forward-only repair for the farm reference-data surface used by bootstrap
 * seeds and tenant provisioning. The legacy baseline left `species` close to
 * the old init-script shape while the entity/seed contract had moved on to
 * camelCase species fields and Postgres arrays for equipment subtype codes.
 */
export class AlignFarmReferenceDataContracts1789300000000 implements MigrationInterface {
  name = 'AlignFarmReferenceDataContracts1789300000000';

  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'farm');

    await withDdlSafety(
      queryRunner,
      { schema: 'farm', advisoryLockKeySuffix: this.name },
      async () => {
        this.logger.log(
          'Aligning farm source schema contracts for species, departments, equipment, and equipment_types.',
        );

        await this.ensureSpeciesEnums(queryRunner);
        await this.ensureDepartmentEnums(queryRunner);
        await this.ensureEquipmentEnums(queryRunner);
        await this.alignSpecies(queryRunner);
        await this.alignDepartments(queryRunner);
        await this.alignEquipment(queryRunner);
        await this.alignEquipmentTypes(queryRunner);

        this.logger.log('Farm source schema contracts aligned.');
      },
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Down migration intentionally left as no-op: reference-data contract alignment is forward-only.',
    );
  }

  private async runGuardedColumnAlter(
    queryRunner: QueryRunner,
    sql: string,
  ): Promise<void> {
    const statement = sql.trim().replace(/;+$/, '');
    await queryRunner.query(`
      DO $$
      BEGIN
        ${statement};
      END $$;
    `);
  }

  private async ensureSpeciesEnums(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm."species_category_enum" AS ENUM (
          'fish', 'shrimp', 'prawn', 'crab', 'lobster', 'mollusk', 'seaweed', 'other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm."species_waterType_enum" AS ENUM (
          'freshwater', 'saltwater', 'brackish'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm."species_status_enum" AS ENUM (
          'active', 'inactive', 'experimental', 'discontinued'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  private async ensureDepartmentEnums(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.departments_type_enum AS ENUM (
          'production',
          'maintenance',
          'quality_control',
          'feed',
          'administration',
          'hatchery',
          'nursery',
          'grow_out',
          'broodstock',
          'quarantine',
          'processing',
          'laboratory',
          'other'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.departments_status_enum AS ENUM (
          'active', 'inactive'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  private async ensureEquipmentEnums(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.equipment_status_enum AS ENUM (
          'operational',
          'maintenance',
          'repair',
          'out_of_service',
          'decommissioned',
          'standby',
          'active',
          'preparing',
          'cleaning',
          'harvesting',
          'fallow',
          'quarantine'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  private async alignSpecies(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.species
        ADD COLUMN IF NOT EXISTS "scientificName" varchar(100),
        ADD COLUMN IF NOT EXISTS "commonName" varchar(100),
        ADD COLUMN IF NOT EXISTS "localName" varchar(100),
        ADD COLUMN IF NOT EXISTS "category" varchar(50) DEFAULT 'fish',
        ADD COLUMN IF NOT EXISTS "waterType" varchar(50) DEFAULT 'saltwater',
        ADD COLUMN IF NOT EXISTS "family" varchar(100),
        ADD COLUMN IF NOT EXISTS "genus" varchar(100),
        ADD COLUMN IF NOT EXISTS "optimalConditions" jsonb,
        ADD COLUMN IF NOT EXISTS "growthParameters" jsonb,
        ADD COLUMN IF NOT EXISTS "harvestDaysPerInputType" jsonb,
        ADD COLUMN IF NOT EXISTS "growthStages" jsonb,
        ADD COLUMN IF NOT EXISTS "marketInfo" jsonb,
        ADD COLUMN IF NOT EXISTS "breedingInfo" jsonb,
        ADD COLUMN IF NOT EXISTS "status" varchar(50) DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS "cleanerFishType" varchar(50),
        ADD COLUMN IF NOT EXISTS "notes" text,
        ADD COLUMN IF NOT EXISTS "imageUrl" varchar(500),
        ADD COLUMN IF NOT EXISTS "supplierId" uuid,
        ADD COLUMN IF NOT EXISTS "documents" jsonb,
        ADD COLUMN IF NOT EXISTS "tags" jsonb DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS "isActive" boolean DEFAULT true,
        ADD COLUMN IF NOT EXISTS "isCleanerFish" boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS "createdAt" timestamptz DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS "createdBy" uuid,
        ADD COLUMN IF NOT EXISTS "updatedBy" uuid,
        ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "isDeleted" boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz,
        ADD COLUMN IF NOT EXISTS "deletedBy" uuid
    `);

    await queryRunner.query(`
      UPDATE farm.species
         SET "commonName" = LEFT(
               COALESCE(
                 NULLIF("commonName", ''),
                 NULLIF("name", ''),
                 NULLIF("scientificName", ''),
                 "code"
               ),
               100
             )
       WHERE "commonName" IS NULL OR "commonName" = ''
    `);

    await queryRunner.query(`
      UPDATE farm.species
         SET "scientificName" = LEFT(
               COALESCE(
                 NULLIF("scientificName", ''),
                 NULLIF("commonName", ''),
                 NULLIF("name", ''),
                 "code"
               ),
               100
             )
       WHERE "scientificName" IS NULL OR "scientificName" = ''
    `);

    await queryRunner.query(`
      UPDATE farm.species
         SET "optimalConditions" = jsonb_strip_nulls(
               jsonb_build_object(
                 'temperature', "optimalTemperature",
                 'ph', "optimalPh",
                 'salinity', "optimalSalinity",
                 'dissolvedOxygen', "optimalOxygen"
               )
             )
       WHERE "optimalConditions" IS NULL
         AND (
           "optimalTemperature" IS NOT NULL OR
           "optimalPh" IS NOT NULL OR
           "optimalSalinity" IS NOT NULL OR
           "optimalOxygen" IS NOT NULL
         )
    `);

    await queryRunner.query(`
      UPDATE farm.species
         SET "growthParameters" = "growthCurve"
       WHERE "growthParameters" IS NULL
         AND "growthCurve" IS NOT NULL
    `);

    await this.runGuardedColumnAlter(queryRunner, `
      ALTER TABLE farm.species
        ALTER COLUMN "scientificName" TYPE varchar(100) USING LEFT("scientificName"::text, 100),
        ALTER COLUMN "commonName" TYPE varchar(100) USING LEFT("commonName"::text, 100)
    `);

    await queryRunner.query(`
      ALTER TABLE farm.species
        ALTER COLUMN "category" DROP DEFAULT,
        ALTER COLUMN "waterType" DROP DEFAULT,
        ALTER COLUMN "status" DROP DEFAULT
    `);

    await this.runGuardedColumnAlter(queryRunner, `
      ALTER TABLE farm.species
        ALTER COLUMN "category" TYPE farm."species_category_enum"
        USING (
          CASE LOWER(COALESCE("category"::text, 'fish'))
            WHEN 'finfish' THEN 'fish'
            WHEN 'fish' THEN 'fish'
            WHEN 'shrimp' THEN 'shrimp'
            WHEN 'prawn' THEN 'prawn'
            WHEN 'crab' THEN 'crab'
            WHEN 'lobster' THEN 'lobster'
            WHEN 'mollusk' THEN 'mollusk'
            WHEN 'seaweed' THEN 'seaweed'
            ELSE 'other'
          END
        )::farm."species_category_enum",
        ALTER COLUMN "category" SET DEFAULT 'fish'
    `);

    await this.runGuardedColumnAlter(queryRunner, `
      ALTER TABLE farm.species
        ALTER COLUMN "waterType" TYPE farm."species_waterType_enum"
        USING (
          CASE LOWER(COALESCE("waterType"::text, 'saltwater'))
            WHEN 'freshwater' THEN 'freshwater'
            WHEN 'saltwater' THEN 'saltwater'
            WHEN 'brackish' THEN 'brackish'
            ELSE 'saltwater'
          END
        )::farm."species_waterType_enum",
        ALTER COLUMN "waterType" SET DEFAULT 'saltwater'
    `);

    await this.runGuardedColumnAlter(queryRunner, `
      ALTER TABLE farm.species
        ALTER COLUMN "status" TYPE farm."species_status_enum"
        USING (
          CASE LOWER(COALESCE("status"::text, 'active'))
            WHEN 'active' THEN 'active'
            WHEN 'inactive' THEN 'inactive'
            WHEN 'experimental' THEN 'experimental'
            WHEN 'discontinued' THEN 'discontinued'
            ELSE 'active'
          END
        )::farm."species_status_enum",
        ALTER COLUMN "status" SET DEFAULT 'active'
    `);

    await queryRunner.query(`
      UPDATE farm.species
         SET "isActive" = COALESCE("isActive", true),
             "isCleanerFish" = COALESCE("isCleanerFish", false),
             "isDeleted" = COALESCE("isDeleted", false),
             "version" = COALESCE("version", 1),
             "createdAt" = COALESCE("createdAt", NOW()),
             "updatedAt" = COALESCE("updatedAt", "createdAt", NOW()),
             "category" = COALESCE("category", 'fish'::farm."species_category_enum"),
             "waterType" = COALESCE("waterType", 'saltwater'::farm."species_waterType_enum"),
             "status" = COALESCE("status", 'active'::farm."species_status_enum"),
             "tags" = COALESCE("tags", '[]'::jsonb)
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM farm.species
          WHERE "scientificName" IS NULL
             OR "commonName" IS NULL
             OR "category" IS NULL
             OR "waterType" IS NULL
             OR "status" IS NULL
             OR "isActive" IS NULL
             OR "isCleanerFish" IS NULL
             OR "createdAt" IS NULL
             OR "updatedAt" IS NULL
             OR "version" IS NULL
             OR "isDeleted" IS NULL
        ) THEN
          RAISE EXCEPTION 'farm.species reference-data alignment left residual required-column nulls';
        END IF;
      END $$;
    `);

    await this.runGuardedColumnAlter(queryRunner, `
      ALTER TABLE farm.species
        ALTER COLUMN "scientificName" SET NOT NULL,
        ALTER COLUMN "commonName" SET NOT NULL,
        ALTER COLUMN "category" SET NOT NULL,
        ALTER COLUMN "waterType" SET NOT NULL,
        ALTER COLUMN "status" SET NOT NULL,
        ALTER COLUMN "isActive" SET DEFAULT true,
        ALTER COLUMN "isActive" SET NOT NULL,
        ALTER COLUMN "isCleanerFish" SET DEFAULT false,
        ALTER COLUMN "isCleanerFish" SET NOT NULL,
        ALTER COLUMN "createdAt" SET DEFAULT NOW(),
        ALTER COLUMN "createdAt" SET NOT NULL,
        ALTER COLUMN "updatedAt" SET DEFAULT NOW(),
        ALTER COLUMN "updatedAt" SET NOT NULL,
        ALTER COLUMN "version" SET DEFAULT 1,
        ALTER COLUMN "version" SET NOT NULL,
        ALTER COLUMN "isDeleted" SET DEFAULT false,
        ALTER COLUMN "isDeleted" SET NOT NULL
    `);

    await this.deduplicateSpeciesScientificNames(queryRunner);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_species_tenant_scientificName"
        ON farm.species ("tenantId", "scientificName")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_species_tenant_category"
        ON farm.species ("tenantId", "category")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_species_tenant_waterType"
        ON farm.species ("tenantId", "waterType")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_species_tenant_status"
        ON farm.species ("tenantId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_species_tenant_isActive"
        ON farm.species ("tenantId", "isActive")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_species_isCleanerFish"
        ON farm.species ("isCleanerFish")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_species_supplierId"
        ON farm.species ("supplierId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_species_isDeleted"
        ON farm.species ("isDeleted")
    `);

    await queryRunner.query(`
      ALTER TABLE farm.species
        DROP COLUMN IF EXISTS "name",
        DROP COLUMN IF EXISTS "optimalTemperature",
        DROP COLUMN IF EXISTS "optimalPh",
        DROP COLUMN IF EXISTS "optimalSalinity",
        DROP COLUMN IF EXISTS "optimalOxygen",
        DROP COLUMN IF EXISTS "growthCurve"
    `);
  }

  private async alignDepartments(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.departments
        ADD COLUMN IF NOT EXISTS "capacity" double precision,
        ADD COLUMN IF NOT EXISTS "notes" text,
        ADD COLUMN IF NOT EXISTS "managerUserId" uuid,
        ADD COLUMN IF NOT EXISTS "managerName" varchar(255),
        ADD COLUMN IF NOT EXISTS "isDeleted" boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz,
        ADD COLUMN IF NOT EXISTS "deletedBy" uuid
    `);

    await queryRunner.query(`
      ALTER TABLE farm.departments
        ALTER COLUMN "type" DROP DEFAULT,
        ALTER COLUMN "status" DROP DEFAULT
    `);

    await this.runGuardedColumnAlter(queryRunner, `
      ALTER TABLE farm.departments
        ALTER COLUMN "type" TYPE farm.departments_type_enum
        USING (
          CASE LOWER(COALESCE("type"::text, 'production'))
            WHEN 'production' THEN 'production'
            WHEN 'maintenance' THEN 'maintenance'
            WHEN 'quality_control' THEN 'quality_control'
            WHEN 'quality-control' THEN 'quality_control'
            WHEN 'feed' THEN 'feed'
            WHEN 'administration' THEN 'administration'
            WHEN 'hatchery' THEN 'hatchery'
            WHEN 'nursery' THEN 'nursery'
            WHEN 'grow_out' THEN 'grow_out'
            WHEN 'grow-out' THEN 'grow_out'
            WHEN 'broodstock' THEN 'broodstock'
            WHEN 'quarantine' THEN 'quarantine'
            WHEN 'processing' THEN 'processing'
            WHEN 'laboratory' THEN 'laboratory'
            ELSE 'other'
          END
        )::farm.departments_type_enum,
        ALTER COLUMN "type" SET DEFAULT 'production'
    `);

    await this.runGuardedColumnAlter(queryRunner, `
      ALTER TABLE farm.departments
        ALTER COLUMN "status" TYPE farm.departments_status_enum
        USING (
          CASE LOWER(COALESCE("status"::text, 'active'))
            WHEN 'active' THEN 'active'
            WHEN 'inactive' THEN 'inactive'
            ELSE 'active'
          END
        )::farm.departments_status_enum,
        ALTER COLUMN "status" SET DEFAULT 'active'
    `);

    await queryRunner.query(`
      UPDATE farm.departments
         SET "type" = COALESCE("type", 'production'::farm.departments_type_enum),
             "status" = COALESCE("status", 'active'::farm.departments_status_enum),
             "isActive" = COALESCE("isActive", true),
             "isDeleted" = COALESCE("isDeleted", false),
             "createdAt" = COALESCE("createdAt", NOW()),
             "updatedAt" = COALESCE("updatedAt", "createdAt", NOW()),
             "version" = COALESCE("version", 1)
    `);

    await this.runGuardedColumnAlter(queryRunner, `
      ALTER TABLE farm.departments
        ALTER COLUMN "type" SET NOT NULL,
        ALTER COLUMN "status" SET NOT NULL,
        ALTER COLUMN "isActive" SET DEFAULT true,
        ALTER COLUMN "isActive" SET NOT NULL,
        ALTER COLUMN "isDeleted" SET DEFAULT false,
        ALTER COLUMN "isDeleted" SET NOT NULL,
        ALTER COLUMN "createdAt" SET DEFAULT NOW(),
        ALTER COLUMN "createdAt" SET NOT NULL,
        ALTER COLUMN "updatedAt" SET DEFAULT NOW(),
        ALTER COLUMN "updatedAt" SET NOT NULL,
        ALTER COLUMN "version" SET DEFAULT 1,
        ALTER COLUMN "version" SET NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_departments_isDeleted"
        ON farm.departments ("isDeleted")
    `);
  }

  private async alignEquipment(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.equipment
        ADD COLUMN IF NOT EXISTS "parentEquipmentId" uuid,
        ADD COLUMN IF NOT EXISTS "isVisibleInSensor" boolean DEFAULT false
    `);

    await queryRunner.query(`
      ALTER TABLE farm.equipment
        ALTER COLUMN "status" DROP DEFAULT
    `);

    await this.runGuardedColumnAlter(queryRunner, `
      ALTER TABLE farm.equipment
        ALTER COLUMN "status" TYPE farm.equipment_status_enum
        USING (
          CASE LOWER(COALESCE("status"::text, 'operational'))
            WHEN 'operational' THEN 'operational'
            WHEN 'maintenance' THEN 'maintenance'
            WHEN 'repair' THEN 'repair'
            WHEN 'out_of_service' THEN 'out_of_service'
            WHEN 'out-of-service' THEN 'out_of_service'
            WHEN 'decommissioned' THEN 'decommissioned'
            WHEN 'standby' THEN 'standby'
            WHEN 'active' THEN 'active'
            WHEN 'preparing' THEN 'preparing'
            WHEN 'cleaning' THEN 'cleaning'
            WHEN 'harvesting' THEN 'harvesting'
            WHEN 'fallow' THEN 'fallow'
            WHEN 'quarantine' THEN 'quarantine'
            ELSE 'operational'
          END
        )::farm.equipment_status_enum,
        ALTER COLUMN "status" SET DEFAULT 'operational'
    `);

    await queryRunner.query(`
      UPDATE farm.equipment
         SET "currency" = COALESCE(NULLIF("currency", ''), 'TRY'),
             "status" = COALESCE("status", 'operational'::farm.equipment_status_enum),
             "subEquipmentCount" = COALESCE("subEquipmentCount", 0),
             "isTank" = COALESCE("isTank", false),
             "isVisibleInSensor" = COALESCE("isVisibleInSensor", false),
             "isActive" = COALESCE("isActive", true),
             "isDeleted" = COALESCE("isDeleted", false),
             "createdAt" = COALESCE("createdAt", NOW()),
             "updatedAt" = COALESCE("updatedAt", "createdAt", NOW()),
             "version" = COALESCE("version", 1)
    `);

    await this.runGuardedColumnAlter(queryRunner, `
      ALTER TABLE farm.equipment
        ALTER COLUMN "currency" SET DEFAULT 'TRY',
        ALTER COLUMN "currency" SET NOT NULL,
        ALTER COLUMN "status" SET NOT NULL,
        ALTER COLUMN "subEquipmentCount" SET DEFAULT 0,
        ALTER COLUMN "subEquipmentCount" SET NOT NULL,
        ALTER COLUMN "isTank" SET DEFAULT false,
        ALTER COLUMN "isTank" SET NOT NULL,
        ALTER COLUMN "isVisibleInSensor" SET DEFAULT false,
        ALTER COLUMN "isVisibleInSensor" SET NOT NULL,
        ALTER COLUMN "isActive" SET DEFAULT true,
        ALTER COLUMN "isActive" SET NOT NULL,
        ALTER COLUMN "isDeleted" SET DEFAULT false,
        ALTER COLUMN "isDeleted" SET NOT NULL,
        ALTER COLUMN "createdAt" SET DEFAULT NOW(),
        ALTER COLUMN "createdAt" SET NOT NULL,
        ALTER COLUMN "updatedAt" SET DEFAULT NOW(),
        ALTER COLUMN "updatedAt" SET NOT NULL,
        ALTER COLUMN "version" SET DEFAULT 1,
        ALTER COLUMN "version" SET NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_equipment_parentEquipmentId"
        ON farm.equipment ("parentEquipmentId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_equipment_tenant_isVisibleInSensor"
        ON farm.equipment ("tenantId", "isVisibleInSensor")
    `);
  }

  private async alignEquipmentTypes(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE farm.farm_equipment_category_enum ADD VALUE IF NOT EXISTS 'pond'
    `);
    await queryRunner.query(`
      ALTER TYPE farm.farm_equipment_category_enum ADD VALUE IF NOT EXISTS 'cage'
    `);

    await this.ensureEquipmentTypeArrayColumn(queryRunner);

    await queryRunner.query(`
      UPDATE farm.equipment_types
         SET "category" = COALESCE("category", 'other'::farm.farm_equipment_category_enum),
             "isActive" = COALESCE("isActive", true),
             "isSystem" = COALESCE("isSystem", false),
             "sortOrder" = COALESCE("sortOrder", 0),
             "createdAt" = COALESCE("createdAt", NOW()),
             "updatedAt" = COALESCE("updatedAt", "createdAt", NOW())
    `);

    await this.runGuardedColumnAlter(queryRunner, `
      ALTER TABLE farm.equipment_types
        ALTER COLUMN "category" SET DEFAULT 'other',
        ALTER COLUMN "category" SET NOT NULL,
        ALTER COLUMN "isActive" SET DEFAULT true,
        ALTER COLUMN "isActive" SET NOT NULL,
        ALTER COLUMN "isSystem" SET DEFAULT false,
        ALTER COLUMN "isSystem" SET NOT NULL,
        ALTER COLUMN "sortOrder" SET DEFAULT 0,
        ALTER COLUMN "sortOrder" SET NOT NULL,
        ALTER COLUMN "createdAt" SET DEFAULT NOW(),
        ALTER COLUMN "createdAt" SET NOT NULL,
        ALTER COLUMN "updatedAt" SET DEFAULT NOW(),
        ALTER COLUMN "updatedAt" SET NOT NULL
    `);
  }

  private async deduplicateSpeciesScientificNames(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH ranked AS (
        SELECT
          "id",
          "scientificName",
          ROW_NUMBER() OVER (
            PARTITION BY "tenantId", "scientificName"
            ORDER BY COALESCE("isDeleted", false), "updatedAt" DESC NULLS LAST, "id"
          ) AS rn
        FROM farm.species
        WHERE "scientificName" IS NOT NULL
      )
      UPDATE farm.species s
         SET "scientificName" =
               LEFT(r."scientificName", 80) || ' #' || r.rn::text || '-' ||
               SUBSTRING(r."id"::text, 1, 8),
             "updatedAt" = NOW()
        FROM ranked r
       WHERE s."id" = r."id"
         AND r.rn > 1
    `);
  }

  private async ensureEquipmentTypeArrayColumn(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.equipment_types
        ADD COLUMN IF NOT EXISTS "allowedSubEquipmentTypes" text[]
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        observed_data_type text;
        observed_udt_name text;
      BEGIN
        SELECT data_type, udt_name
          INTO observed_data_type, observed_udt_name
          FROM information_schema.columns
         WHERE table_schema = 'farm'
           AND table_name = 'equipment_types'
           AND column_name = 'allowedSubEquipmentTypes';

        IF observed_data_type IS DISTINCT FROM 'ARRAY'
           OR observed_udt_name IS DISTINCT FROM '_text' THEN
          ALTER TABLE farm.equipment_types
            ALTER COLUMN "allowedSubEquipmentTypes" DROP DEFAULT;

          ALTER TABLE farm.equipment_types
            ALTER COLUMN "allowedSubEquipmentTypes" TYPE text[]
            USING (
              CASE
                WHEN "allowedSubEquipmentTypes" IS NULL THEN NULL::text[]
                WHEN btrim("allowedSubEquipmentTypes"::text) = '' THEN ARRAY[]::text[]
                WHEN btrim("allowedSubEquipmentTypes"::text) IN ('[]', '{}') THEN ARRAY[]::text[]
                ELSE regexp_split_to_array(
                  trim(both '[]{}' from btrim(replace("allowedSubEquipmentTypes"::text, '"', ''))),
                  '[[:space:]]*,[[:space:]]*'
                )::text[]
              END
            );
        END IF;
      END $$;
    `);
  }
}
