import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddEquipmentTemperatureSensorId1802100000000
 *
 * Adds `equipment.temperatureSensorId` — the sensor-service `sensors.id` linked
 * to a tank/pond/cage at creation, so the feeding-rate calc can resolve the
 * tank's live water temperature from that sensor (Phase 2b). Soft cross-service
 * reference (nullable, no FK — the Sensor entity lives in sensor-service).
 *
 * current_schema-relative: db-migrate fans farm migrations out with search_path
 * pinned to `farm` and each `tenant_<uuid>`, so unqualified `equipment` is the
 * only correct target. Idempotent, forward-only, blue-green safe (nullable).
 */
export class AddEquipmentTemperatureSensorId1802100000000 implements MigrationInterface {
  name = 'AddEquipmentTemperatureSensorId1802100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE "equipment"
        ADD COLUMN IF NOT EXISTS "temperatureSensorId" uuid
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_equipment_temperatureSensorId"
        ON "equipment" ("temperatureSensorId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query('DROP INDEX IF EXISTS "IDX_equipment_temperatureSensorId"');
    await queryRunner.query(`
      ALTER TABLE "equipment" DROP COLUMN IF EXISTS "temperatureSensorId"
    `);
  }
}
