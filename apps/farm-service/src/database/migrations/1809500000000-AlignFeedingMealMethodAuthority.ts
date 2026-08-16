import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  FEEDING_MIGRATION_AUTHORITY_V1,
  assertFeedingMigrationAuthorityV1,
} from './feeding-migration-authority.v1';

const MIGRATION_AUTHORITY_DIGEST =
  '0f23c8d97804e652410c049efe33ef8ad8138e00a06aa908256d74ad54a264f8';
const METHOD_VALUES = FEEDING_MIGRATION_AUTHORITY_V1.feedingMethods;
const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const METHOD_ENUM_SQL = METHOD_VALUES.map(sqlLiteral).join(', ');
const INVALID_POUR_METHOD_JSON_PATH = `$[*].feedingMethod ? (@.type() != "string" || (${METHOD_VALUES.map(
  (value) => `@ != ${JSON.stringify(value)}`,
).join(' && ')}))`;

/**
 * Projects the closed feeding-method vocabulary into the meal column and its
 * embedded pour ledger. Unknown history is never guessed or rewritten.
 */
export class AlignFeedingMealMethodAuthority1809500000000 implements MigrationInterface {
  name = 'AlignFeedingMealMethodAuthority1809500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    assertFeedingMigrationAuthorityV1(MIGRATION_AUTHORITY_DIGEST);
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);
    const presence: Array<{ meals: string | null }> = await queryRunner.query(
      `SELECT to_regclass('feeding_meals')::text AS meals`,
    );
    if (!presence[0]?.meals) return;

    const columns: Array<{ dataType: string; udtName: string }> = await queryRunner.query(`
      SELECT data_type AS "dataType", udt_name AS "udtName"
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'feeding_meals'
         AND column_name = 'feedingMethod'
    `);
    if (!columns[0]) {
      throw new Error('feeding_meals.feedingMethod is absent; method authority cannot compile');
    }

    const invalidColumns: Array<{ value: string; rows: string }> = await queryRunner.query(
      `SELECT "feedingMethod"::text AS value, COUNT(*)::text AS rows
         FROM "feeding_meals"
        WHERE "feedingMethod" IS NOT NULL
          AND NOT ("feedingMethod"::text = ANY($1::text[]))
        GROUP BY "feedingMethod"::text
        ORDER BY "feedingMethod"::text`,
      [METHOD_VALUES],
    );
    if (invalidColumns.length > 0) {
      throw new Error(
        `feeding_meals.feedingMethod contains values outside the signed vocabulary: ${invalidColumns
          .map(({ value, rows }) => `${value} (${rows} rows)`)
          .join(', ')}`,
      );
    }

    const invalidPourLedgers: Array<{ id: string }> = await queryRunner.query(
      `SELECT id::text AS id
         FROM "feeding_meals"
        WHERE jsonb_typeof(pours) IS DISTINCT FROM 'array'
           OR jsonb_path_exists(pours, $path$${INVALID_POUR_METHOD_JSON_PATH}$path$::jsonpath)
        ORDER BY id
        LIMIT 25`,
    );
    if (invalidPourLedgers.length > 0) {
      throw new Error(
        `feeding_meals.pours contains a non-canonical feeding method (first ids: ${invalidPourLedgers
          .map(({ id }) => id)
          .join(', ')})`,
      );
    }

    const enumRows: Array<{ labels: string[] }> = await queryRunner.query(`
      SELECT jsonb_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE n.nspname = current_schema()
         AND t.typname = 'feeding_meals_feedingmethod_enum'
       GROUP BY t.oid
    `);
    if (enumRows[0]) {
      if (
        enumRows[0].labels.length !== METHOD_VALUES.length ||
        enumRows[0].labels.some((value, index) => value !== METHOD_VALUES[index])
      ) {
        throw new Error(
          `feeding_meals_feedingmethod_enum differs from FEEDING_METHOD: [${enumRows[0].labels.join(', ')}]`,
        );
      }
    } else {
      await queryRunner.query(
        `CREATE TYPE "feeding_meals_feedingmethod_enum" AS ENUM (${METHOD_ENUM_SQL})`,
      );
    }

    if (columns[0].udtName !== 'feeding_meals_feedingmethod_enum') {
      await queryRunner.query(`
        ALTER TABLE "feeding_meals"
          ALTER COLUMN "feedingMethod" TYPE "feeding_meals_feedingmethod_enum"
          USING "feedingMethod"::text::"feeding_meals_feedingmethod_enum"
      `);
    }

    await queryRunner.query(`
      ALTER TABLE "feeding_meals"
        DROP CONSTRAINT IF EXISTS "CHK_feeding_meals_method_v1"
    `);
    await queryRunner.query(`
      ALTER TABLE "feeding_meals"
        ADD CONSTRAINT "CHK_feeding_meals_method_v1"
        CHECK (
          jsonb_typeof(pours) = 'array'
          AND NOT jsonb_path_exists(
            pours,
            $path$${INVALID_POUR_METHOD_JSON_PATH}$path$::jsonpath
          )
        )
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const presence: Array<{ meals: string | null }> = await queryRunner.query(
      `SELECT to_regclass('feeding_meals')::text AS meals`,
    );
    if (!presence[0]?.meals) return true;

    const rows: Array<{ columnAligned: boolean; constraintPresent: boolean; labels: string[] }> =
      await queryRunner.query(`
        SELECT
          COALESCE((
            SELECT c.udt_name = 'feeding_meals_feedingmethod_enum'
              FROM information_schema.columns c
             WHERE c.table_schema = current_schema()
               AND c.table_name = 'feeding_meals'
               AND c.column_name = 'feedingMethod'
          ), false) AS "columnAligned",
          EXISTS (
            SELECT 1
              FROM pg_constraint c
              JOIN pg_class r ON r.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = r.relnamespace
             WHERE n.nspname = current_schema()
               AND r.relname = 'feeding_meals'
               AND c.conname = 'CHK_feeding_meals_method_v1'
          ) AS "constraintPresent",
          COALESCE((
            SELECT jsonb_agg(e.enumlabel::text ORDER BY e.enumsortorder)
              FROM pg_type t
              JOIN pg_namespace n ON n.oid = t.typnamespace
              JOIN pg_enum e ON e.enumtypid = t.oid
             WHERE n.nspname = current_schema()
               AND t.typname = 'feeding_meals_feedingmethod_enum'
          ), '[]'::jsonb) AS labels
      `);
    const row = rows[0];
    return (
      row?.columnAligned === true &&
      row.constraintPresent === true &&
      row.labels.length === METHOD_VALUES.length &&
      row.labels.every((value, index) => value === METHOD_VALUES[index])
    );
  }

  public async down(): Promise<void> {
    // Forward-only: widening this closed vocabulary back to free text would
    // reintroduce an ungoverned durable mutation surface.
  }
}
