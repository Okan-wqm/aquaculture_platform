import { MigrationInterface, QueryRunner } from 'typeorm';

const EQUIPMENT_CATEGORY_VALUES = [
  'tank',
  'pond',
  'cage',
  'pump',
  'aeration',
  'filtration',
  'heating_cooling',
  'feeding',
  'monitoring',
  'water_treatment',
  'harvesting',
  'transport',
  'electrical',
  'plumbing',
  'safety',
  'other',
] as const;

/**
 * AlignEquipmentTypesRuntimeContract1800300000000
 *
 * Repair the farm equipment type catalogue schema to match the runtime entity
 * and seed contract. The post-reset baseline created this reference table with
 * legacy snake_case columns, while FarmSeedService writes the camelCase entity
 * columns. This migration is tenant-relative: db-migrate pins search_path to
 * either `farm` or `tenant_<id>` before running it, so existing tenant clones
 * receive the same reference-table contract as the source schema.
 */
export class AlignEquipmentTypesRuntimeContract1800300000000
  implements MigrationInterface
{
  name = 'AlignEquipmentTypesRuntimeContract1800300000000';
  // ALTER TYPE ADD VALUE cannot be safely consumed later in the same
  // transaction on every supported PostgreSQL version. Every DDL step below
  // is idempotent and guarded, so statement-level commits are acceptable here.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regtype(current_schema() || '.equipment_category') IS NULL THEN
          CREATE TYPE equipment_category AS ENUM (
            'tank',
            'pond',
            'cage',
            'pump',
            'aeration',
            'filtration',
            'heating_cooling',
            'feeding',
            'monitoring',
            'water_treatment',
            'harvesting',
            'transport',
            'electrical',
            'plumbing',
            'safety',
            'other'
          );
        ELSE
          ALTER TYPE equipment_category ADD VALUE IF NOT EXISTS 'pond';
          ALTER TYPE equipment_category ADD VALUE IF NOT EXISTS 'cage';
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS equipment_types (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "name" varchar(100) NOT NULL,
        "code" varchar(50) NOT NULL,
        "description" text,
        "category" equipment_category NOT NULL DEFAULT 'other',
        "icon" varchar(50),
        "specificationSchema" jsonb NOT NULL DEFAULT '{"fields":[]}'::jsonb,
        "allowedSubEquipmentTypes" text[],
        "isActive" boolean NOT NULL DEFAULT true,
        "isSystem" boolean NOT NULL DEFAULT false,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      ALTER TABLE equipment_types
        ADD COLUMN IF NOT EXISTS "specificationSchema" jsonb,
        ADD COLUMN IF NOT EXISTS "allowedSubEquipmentTypes" text[],
        ADD COLUMN IF NOT EXISTS "isActive" boolean,
        ADD COLUMN IF NOT EXISTS "isSystem" boolean,
        ADD COLUMN IF NOT EXISTS "sortOrder" integer,
        ADD COLUMN IF NOT EXISTS "createdAt" timestamptz,
        ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'specification_schema'
        ) THEN
          EXECUTE 'UPDATE equipment_types
                      SET "specificationSchema" = COALESCE("specificationSchema", specification_schema)';
        END IF;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'allowed_sub_equipment_types'
        ) THEN
          EXECUTE 'UPDATE equipment_types
                      SET "allowedSubEquipmentTypes" = COALESCE("allowedSubEquipmentTypes", allowed_sub_equipment_types)';
        END IF;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'is_active'
        ) THEN
          EXECUTE 'UPDATE equipment_types
                      SET "isActive" = COALESCE("isActive", is_active)';
        END IF;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'is_system'
        ) THEN
          EXECUTE 'UPDATE equipment_types
                      SET "isSystem" = COALESCE("isSystem", is_system)';
        END IF;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'sort_order'
        ) THEN
          EXECUTE 'UPDATE equipment_types
                      SET "sortOrder" = COALESCE("sortOrder", sort_order)';
        END IF;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'created_at'
        ) THEN
          EXECUTE 'UPDATE equipment_types
                      SET "createdAt" = COALESCE("createdAt", created_at)';
        END IF;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'updated_at'
        ) THEN
          EXECUTE 'UPDATE equipment_types
                      SET "updatedAt" = COALESCE("updatedAt", updated_at)';
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      UPDATE equipment_types
         SET "specificationSchema" = COALESCE("specificationSchema", '{"fields":[]}'::jsonb),
             "isActive" = COALESCE("isActive", true),
             "isSystem" = COALESCE("isSystem", false),
             "sortOrder" = COALESCE("sortOrder", 0),
             "createdAt" = COALESCE("createdAt", NOW()),
             "updatedAt" = COALESCE("updatedAt", NOW())
    `);

    await queryRunner.query(`
      UPDATE equipment_types
         SET "category" = 'other'
       WHERE "category" IS NULL
          OR "category"::text NOT IN (${EQUIPMENT_CATEGORY_VALUES.map(
         (value) => `'${value}'`,
       ).join(', ')})
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'category'
        ) THEN
          ALTER TABLE equipment_types
            ALTER COLUMN "category" DROP DEFAULT;
          ALTER TABLE equipment_types
            ALTER COLUMN "category" TYPE equipment_category
              USING "category"::text::equipment_category,
            ALTER COLUMN "category" SET DEFAULT 'other',
            ALTER COLUMN "category" SET NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'specificationSchema'
        ) THEN
          ALTER TABLE equipment_types
            ALTER COLUMN "specificationSchema" SET DEFAULT '{"fields":[]}'::jsonb,
            ALTER COLUMN "specificationSchema" SET NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'isActive'
        ) THEN
          ALTER TABLE equipment_types
            ALTER COLUMN "isActive" SET DEFAULT true,
            ALTER COLUMN "isActive" SET NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'isSystem'
        ) THEN
          ALTER TABLE equipment_types
            ALTER COLUMN "isSystem" SET DEFAULT false,
            ALTER COLUMN "isSystem" SET NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'sortOrder'
        ) THEN
          ALTER TABLE equipment_types
            ALTER COLUMN "sortOrder" SET DEFAULT 0,
            ALTER COLUMN "sortOrder" SET NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'createdAt'
        ) THEN
          ALTER TABLE equipment_types
            ALTER COLUMN "createdAt" SET DEFAULT NOW(),
            ALTER COLUMN "createdAt" SET NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'equipment_types'
             AND column_name = 'updatedAt'
        ) THEN
          ALTER TABLE equipment_types
            ALTER COLUMN "updatedAt" SET DEFAULT NOW(),
            ALTER COLUMN "updatedAt" SET NOT NULL;
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_farm_equipment_types_code"
        ON equipment_types ("code")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_farm_equipment_types_category"
        ON equipment_types ("category")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_farm_equipment_types_isActive"
        ON equipment_types ("isActive")
    `);

    await queryRunner.query(`
      INSERT INTO equipment_types (
        "id",
        "name",
        "code",
        "description",
        "category",
        "icon",
        "specificationSchema",
        "allowedSubEquipmentTypes",
        "isActive",
        "isSystem",
        "sortOrder",
        "createdAt",
        "updatedAt"
      )
      SELECT
        src."id",
        src."name",
        src."code",
        src."description",
        src."category"::text::equipment_category,
        src."icon",
        src."specificationSchema",
        src."allowedSubEquipmentTypes",
        src."isActive",
        src."isSystem",
        src."sortOrder",
        src."createdAt",
        src."updatedAt"
        FROM farm.equipment_types src
       WHERE current_schema() <> 'farm'
         AND NOT EXISTS (SELECT 1 FROM equipment_types)
      ON CONFLICT ("code") DO NOTHING
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      WITH required_columns(column_name, data_type, is_nullable) AS (
        VALUES
          ('specificationSchema', 'jsonb', 'NO'),
          ('allowedSubEquipmentTypes', 'ARRAY', 'YES'),
          ('isActive', 'boolean', 'NO'),
          ('isSystem', 'boolean', 'NO'),
          ('sortOrder', 'integer', 'NO'),
          ('createdAt', 'timestamp with time zone', 'NO'),
          ('updatedAt', 'timestamp with time zone', 'NO')
      ),
      missing_columns AS (
        SELECT rc.column_name
          FROM required_columns rc
         WHERE NOT EXISTS (
           SELECT 1
             FROM information_schema.columns c
            WHERE c.table_schema = current_schema()
              AND c.table_name = 'equipment_types'
              AND c.column_name = rc.column_name
              AND c.data_type = rc.data_type
              AND c.is_nullable = rc.is_nullable
         )
      ),
      missing_enum_values AS (
        SELECT value
          FROM (VALUES
            ('tank'),
            ('pond'),
            ('cage'),
            ('pump'),
            ('aeration'),
            ('filtration'),
            ('heating_cooling'),
            ('feeding'),
            ('monitoring'),
            ('water_treatment'),
            ('harvesting'),
            ('transport'),
            ('electrical'),
            ('plumbing'),
            ('safety'),
            ('other')
          ) AS expected(value)
         WHERE NOT EXISTS (
           SELECT 1
             FROM pg_type t
             JOIN pg_namespace n ON n.oid = t.typnamespace
             JOIN pg_enum e ON e.enumtypid = t.oid
            WHERE n.nspname = current_schema()
              AND t.typname = 'equipment_category'
              AND e.enumlabel = expected.value
         )
      )
      SELECT (
        (SELECT COUNT(*) FROM missing_columns) +
        (SELECT COUNT(*) FROM missing_enum_values)
      )::text AS missing_count
    `)) as Array<{ missing_count: string }>;

    return rows[0]?.missing_count === '0';
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only production repair. Do not drop runtime contract columns.
  }
}
