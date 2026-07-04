import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateSensorTemperatureLatest1802200000000
 *
 * Farm-side read model of the latest water temperature per sensor, projected
 * from the sensor-service `SensorReading` NATS event (Phase 2b). Lets the
 * feeding-rate calc read temperature LOCALLY instead of reaching into the
 * `sensor` schema (which farm_service has no grant on in prod).
 *
 * current_schema-relative: db-migrate fans farm migrations out with search_path
 * pinned to `farm` and each `tenant_<uuid>`, so the unqualified table name is the
 * only correct target. Idempotent, forward-only.
 */
export class CreateSensorTemperatureLatest1802200000000 implements MigrationInterface {
  name = 'CreateSensorTemperatureLatest1802200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sensor_temperature_latest" (
        "tenantId" uuid NOT NULL,
        "sensorId" uuid NOT NULL,
        "temperatureC" numeric(6,2) NOT NULL,
        "measuredAt" timestamptz NOT NULL,
        CONSTRAINT "PK_sensor_temperature_latest" PRIMARY KEY ("tenantId", "sensorId")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query('DROP TABLE IF EXISTS "sensor_temperature_latest"');
  }
}
