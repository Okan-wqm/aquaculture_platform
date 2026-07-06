import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateSensorTemperatureDaily1803500000000
 *
 * Per-sensor per-day temperature rollup (RPT-005), fed incrementally by the
 * same SensorReading projection that maintains sensor_temperature_latest. The
 * `latest` table answers "what is the temperature now" (feed-rate); this table
 * answers "what was the representative temperature over reporting period P"
 * (the lakselus report's weekly sjøtemperatur, tied to the REPORT week rather
 * than to wall-clock now).
 *
 * Idempotent accumulation: `sumC`/`sampleCount` accrue, `minC`/`maxC` extend,
 * and `lastMeasuredAt` is a watermark so at-least-once redelivery / out-of-order
 * events cannot double-count (the upsert only advances on a strictly newer
 * reading — mirrors the newest-wins guard on sensor_temperature_latest).
 *
 * current_schema-relative, idempotent, forward-only.
 */
export class CreateSensorTemperatureDaily1803500000000 implements MigrationInterface {
  name = 'CreateSensorTemperatureDaily1803500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sensor_temperature_daily" (
        "tenantId" uuid NOT NULL,
        "sensorId" uuid NOT NULL,
        "day" date NOT NULL,
        "sumC" numeric(14,2) NOT NULL,
        "minC" numeric(6,2) NOT NULL,
        "maxC" numeric(6,2) NOT NULL,
        "sampleCount" integer NOT NULL,
        "lastMeasuredAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sensor_temperature_daily" PRIMARY KEY ("tenantId", "sensorId", "day")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sensor_temperature_daily_tenant_day"
        ON "sensor_temperature_daily" ("tenantId", "day")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query('DROP TABLE IF EXISTS "sensor_temperature_daily"');
  }
}
