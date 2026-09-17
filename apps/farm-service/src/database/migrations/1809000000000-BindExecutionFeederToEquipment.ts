import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'daily_feeding_executions';
const COLUMN = 'feederEquipmentId';
const CONSTRAINT = 'FK_dfe_feeder_equipment';

/**
 * BindExecutionFeederToEquipment1809000000000
 *
 * WHAT: makes `daily_feeding_executions."feederEquipmentId"` a real foreign key
 * onto `equipment(id)`.
 *
 * WHY: the repository held two incompatible answers to "what is a feeder".
 * `feeder_calibrations` keys calibration by `equipment_id` and the setup UI
 * mounts the calibration editor on an EquipmentType, so calibration describes an
 * Equipment row. But this column was documented as a "SubEquipment feeder ID"
 * and the write path resolved its display name out of `sub_equipment`. If
 * calibration writes to one notion of feeder and feeding records write to
 * another, the two describe different objects and no join between them is
 * meaningful.
 *
 * The Equipment reading wins: `EQUIPMENT_TYPES_SEED` ships real feeder machines
 * (`feeder-automatic` and siblings, with silo volume and feeding rate),
 * calibration is already keyed on them, and the sub-equipment tier shipped
 * completely empty — no seed ever wrote a `sub_equipment_types` row, so a
 * SubEquipment feeder could not exist on any tenant. This FK is what makes the
 * losing interpretation unwritable rather than merely discouraged: a
 * `sub_equipment` id in this column now fails at the database.
 *
 * The pre-step nulls values that do not resolve to an equipment row. That set is
 * empty in practice — no client has ever sent this field, so no row carries a
 * value at all — but the migration must be correct on a database where someone
 * had written one, and an unresolvable id is by definition not a feeder anyone
 * can look up.
 *
 * current_schema-relative: both tables are per-tenant, so the DDL is unqualified
 * and db-migrate applies it to `farm` plus every `tenant_<uuid>` schema. Guarded
 * on table presence and wrapped for duplicate-object replay.
 */
export class BindExecutionFeederToEquipment1809000000000 implements MigrationInterface {
  name = 'BindExecutionFeederToEquipment1809000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.${TABLE}') IS NULL
           OR to_regclass(current_schema() || '.equipment') IS NULL THEN
          RETURN;
        END IF;

        UPDATE "${TABLE}" e
           SET "${COLUMN}" = NULL
         WHERE e."${COLUMN}" IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "equipment" q WHERE q."id" = e."${COLUMN}");

        BEGIN
          ALTER TABLE "${TABLE}"
            ADD CONSTRAINT "${CONSTRAINT}"
            FOREIGN KEY ("${COLUMN}") REFERENCES "equipment" ("id");
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
      END $$;
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.${TABLE}') IS NULL
        OR to_regclass(current_schema() || '.equipment') IS NULL
        OR EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema()
            AND t.relname = '${TABLE}'
            AND c.conname = '${CONSTRAINT}'
            AND c.contype = 'f'
        ) AS ok
    `)) as Array<{ ok: boolean }>;

    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.${TABLE}') IS NOT NULL THEN
          ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}";
        END IF;
      END $$;
    `);
  }
}
