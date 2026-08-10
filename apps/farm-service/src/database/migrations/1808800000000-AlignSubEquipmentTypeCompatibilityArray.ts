import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'sub_equipment_types';
const COLUMN = 'compatibleEquipmentTypes';

/**
 * AlignSubEquipmentTypeCompatibilityArray1808800000000
 *
 * WHAT: converts `sub_equipment_types."compatibleEquipmentTypes"` from the
 * comma-joined `text` that TypeORM's `simple-array` produces into a real
 * `text[]`.
 *
 * WHY: the column holds a LIST of EquipmentType codes, but serialising it into
 * one string forced every reader to match it as text.
 * `GetSubEquipmentTypesHandler` did precisely that — `LIKE '%<code>%'` — so a
 * code that is a substring of another matched wrongly: asking for the sub-types
 * of 'valve' also returned everything compatible with 'inlet-valve',
 * 'outlet-valve' and 'backwash-valve'. With a genuine array the containment
 * operator `@>` compares whole elements and the substring answer stops being
 * expressible. The other half of the same relation,
 * `equipment_types."allowedSubEquipmentTypes"`, has always been `text[]`; this
 * makes the two halves the same shape.
 *
 * Data safety: this table has never had a row in any environment — nothing
 * imported SUB_EQUIPMENT_TYPES_SEED and no SQL seed existed, so the whole
 * sub-equipment tier shipped empty. The conversion is nevertheless written to
 * preserve data (`string_to_array(..., ',')`) so it is correct on any hand-
 * populated database too.
 *
 * current_schema-relative: `sub_equipment_types` is a per-tenant reference table
 * (MODULE_SCHEMAS.referenceDataTables), so the DDL is UNqualified and db-migrate
 * applies it to `farm` plus every `tenant_<uuid>` schema. Guarded on both table
 * presence and current column type, so replay and partially-migrated schemas are
 * no-ops.
 */
export class AlignSubEquipmentTypeCompatibilityArray1808800000000 implements MigrationInterface {
  name = 'AlignSubEquipmentTypeCompatibilityArray1808800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = '${TABLE}'
             AND column_name = '${COLUMN}'
             AND data_type <> 'ARRAY'
        ) THEN
          ALTER TABLE "${TABLE}"
            ALTER COLUMN "${COLUMN}" TYPE text[]
            USING CASE
              WHEN "${COLUMN}" IS NULL OR btrim("${COLUMN}") = '' THEN ARRAY[]::text[]
              ELSE string_to_array("${COLUMN}", ',')
            END;
        END IF;
      END $$;
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    // Where the table exists in the active schema, the column must be an array.
    const rows = (await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.${TABLE}') IS NULL
        OR EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = '${TABLE}'
             AND column_name = '${COLUMN}'
             AND data_type = 'ARRAY'
        ) AS ok
    `)) as Array<{ ok: boolean }>;

    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = '${TABLE}'
             AND column_name = '${COLUMN}'
             AND data_type = 'ARRAY'
        ) THEN
          ALTER TABLE "${TABLE}"
            ALTER COLUMN "${COLUMN}" TYPE text
            USING array_to_string("${COLUMN}", ',');
        END IF;
      END $$;
    `);
  }
}
