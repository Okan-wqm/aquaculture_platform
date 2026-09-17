import { MigrationInterface, QueryRunner } from 'typeorm';
import { ExpandContract } from '@aquaculture/backend-common/database';

/**
 * DropVfdDeviceFreeTextUnitColumns1817100000000 — CONTRACT phase.
 *
 * WHAT: removes `vfd_devices.tank_id` and `vfd_devices.pump_id`.
 *
 * WHY they cannot stay. Both were bare uuids an operator typed into a wizard,
 * with no foreign key, no validation, no resolver and — in `pump_id`'s case — no
 * read path at all. Nothing on either side of the service boundary ever checked
 * that they named a real row, let alone the right one. On an actuator that is not
 * a data-quality issue: a drive pointed at the wrong container overfeeds one tank
 * and starves another, and no surface in the platform would have said so.
 *
 * They are not replaced by better-validated columns, because a validated column
 * still stores an answer to a question this service is not entitled to answer.
 * `vfd_drive_bindings` names the equipment the drive turns and holds what the
 * OWNER of that equipment says it is; the unit, where a unit is meaningful at all,
 * is derived from there. Leaving these columns in place would leave a second,
 * unchecked answer that a future reader could pick up — so the wrong value stops
 * being merely discouraged and becomes unstorable.
 *
 * The expand phase (CreateVfdDriveBindings1817000000000) has already carried every
 * `pump_id` into a PENDING binding, so no linkage is lost — it is downgraded from
 * "believed" to "must be confirmed before it can move a shaft", which is what it
 * should always have been. `tank_id` is deliberately NOT carried across: a unit is
 * not something a drive is wired to, and re-asserting it would re-create the guess
 * this change exists to delete.
 *
 * Schema-unqualified DDL: `vfd_devices` is per-tenant, so every schema pass drops
 * the columns in its own schema.
 */
@ExpandContract({ phase: 'contract', dependsOn: 'CreateVfdDriveBindings1817000000000' })
export class DropVfdDeviceFreeTextUnitColumns1817100000000 implements MigrationInterface {
  name = 'DropVfdDeviceFreeTextUnitColumns1817100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    // DESTRUCTIVE: drops vfd_devices.tank_id and vfd_devices.pump_id; rollback
    // reference is this file's down(), which restores both columns (values are not
    // restorable — pump_id survives as a vfd_drive_bindings row).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.vfd_devices') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "vfd_devices" DROP COLUMN IF EXISTS "tank_id";
        ALTER TABLE "vfd_devices" DROP COLUMN IF EXISTS "pump_id";
      END $$;
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.vfd_devices') IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'vfd_devices'
             AND column_name IN ('tank_id', 'pump_id')
        ) AS ok
    `)) as Array<{ ok: boolean }>;

    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.vfd_devices') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "vfd_devices" ADD COLUMN IF NOT EXISTS "tank_id" uuid;
        ALTER TABLE "vfd_devices" ADD COLUMN IF NOT EXISTS "pump_id" uuid;
      END $$;
    `);
  }
}
