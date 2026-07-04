import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddTankTemperatureSensorId1802300000000
 *
 * Adds `tanks.temperatureSensorId` — the sensor-service `sensors.id` linked to a
 * tank/pond/cage at creation. Tanks live in the `tanks` table (the equipment
 * list maps them into Equipment on read), so the durable sensor link belongs
 * here; WaterTemperatureService resolves a tank's sensor from `tanks` (or
 * `equipment` for non-tank containers). Soft cross-service reference (nullable,
 * no FK — the Sensor entity lives in sensor-service).
 *
 * current_schema-relative + idempotent + forward-only + blue-green safe.
 */
export class AddTankTemperatureSensorId1802300000000 implements MigrationInterface {
  name = 'AddTankTemperatureSensorId1802300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE "tanks"
        ADD COLUMN IF NOT EXISTS "temperatureSensorId" uuid
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tanks_temperatureSensorId"
        ON "tanks" ("temperatureSensorId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query('DROP INDEX IF EXISTS "IDX_tanks_temperatureSensorId"');
    await queryRunner.query(`
      ALTER TABLE "tanks" DROP COLUMN IF EXISTS "temperatureSensorId"
    `);
  }
}
