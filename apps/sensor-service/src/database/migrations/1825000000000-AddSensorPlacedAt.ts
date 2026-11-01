import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When a sensor was placed where it now stands (`sensors.placed_at`).
 *
 * # Why
 *
 * A sample describes the place its sensor stood when it was taken. After a
 * sensor moves from tank A to tank B (SENSOR-MEDIUM-206), the samples taken in
 * A must not be read as B's values — not by the water-chemistry channel
 * description, and not by the feeding-window oxygen gate, which would let a
 * feed run in B on A's oxygen. Every reader that pairs a sample with the
 * sensor's current place reads only samples taken at or after this instant.
 *
 * NULL for every existing row ("not moved since tracking began"); set when a
 * placed sensor is registered and on every move, by the one placement writer.
 *
 * # Tenant routing
 *
 * Per-tenant table: run once per schema with the search_path pinned (the
 * orchestrator), unqualified, guarded for schemas without the table.
 * Blue-green safe: nullable, no default. `down` drops the column.
 */
export class AddSensorPlacedAt1825000000000 implements MigrationInterface {
  name = 'AddSensorPlacedAt1825000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await hasSensorTable(queryRunner))) {
      return;
    }
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(
      `ALTER TABLE "sensors" ADD COLUMN IF NOT EXISTS "placed_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await hasSensorTable(queryRunner))) {
      return;
    }
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`ALTER TABLE "sensors" DROP COLUMN IF EXISTS "placed_at"`);
  }
}

async function hasSensorTable(queryRunner: QueryRunner): Promise<boolean> {
  const present: Array<{ ready: boolean }> = await queryRunner.query(
    `SELECT to_regclass('sensors') IS NOT NULL AS ready`,
  );
  return present[0]?.ready === true;
}
