import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Task 1.5 (100-tenant readiness plan): event-identity watermarks for the
 * sensor-temperature read model.
 *
 * Both projection tables gain `lastEventId` (the SensorReading's
 * deterministic eventId, Task 1.4). The daily rollup's idempotency guard
 * becomes identity-based (`lastEventId IS DISTINCT FROM EXCLUDED`), which
 * fixes the silent drop of a second, distinct reading arriving in the same
 * millisecond under the old strict time comparison. Legacy rows keep NULL
 * (IS DISTINCT FROM treats NULL as distinct from any id — the first new
 * event after the migration counts, redeliveries of it do not).
 *
 * UNQUALIFIED table names on purpose: per-tenant tables replayed into every
 * tenant schema by the provisioner (ADR-033 discipline).
 */
export class AddSensorTemperatureEventId1808700000000 implements MigrationInterface {
  name = 'AddSensorTemperatureEventId1808700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sensor_temperature_latest" ADD COLUMN IF NOT EXISTS "lastEventId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "sensor_temperature_daily" ADD COLUMN IF NOT EXISTS "lastEventId" uuid`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sensor_temperature_daily" DROP COLUMN IF EXISTS "lastEventId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sensor_temperature_latest" DROP COLUMN IF EXISTS "lastEventId"`,
    );
  }
}
