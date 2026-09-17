import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'feeder_silo_mass_latest';

/**
 * CreateFeederSiloMassProjection1809200000000
 *
 * WHAT: the farm-side read model of the latest mass reported by each
 * sensor-service mass sensor — the load cells under a feeder's silo. One row per
 * (tenant, sensor); newest reading wins.
 *
 * WHY it is part of the feeder-calibration work rather than a sensor feature:
 * `feeder_capabilities.dispense_control = 'weight_based'` is only a real
 * capability if a mass measurement actually arrives. The database can force
 * `weight_sensor_id` to be present (`CK_fcap_weight_source_required`), but "not
 * null" cannot tell a genuine load cell apart from a mistyped uuid or a sensor
 * that was quoted and never installed. This table is the evidence that closes
 * that gap: a row exists only because a reading landed, `measured_at` says when,
 * and `FeederDoseDirectiveService` refuses to plan a weight-based dose when the
 * row is absent or stale. A farm claiming load cells it does not have is refused
 * at planning time instead of dispensing against a number that never comes.
 *
 * Same shape and discipline as `sensor_temperature_latest`
 * (CreateSensorTemperatureLatest1802200000000): latest-only, because the
 * question is "is the source alive and what does it say now" — a silo-mass time
 * series belongs to the service that already stores one.
 *
 * TENANT-SCOPED, so the DDL is SCHEMA-UNQUALIFIED.
 */
export class CreateFeederSiloMassProjection1809200000000 implements MigrationInterface {
  name = 'CreateFeederSiloMassProjection1809200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${TABLE}" (
        "tenantId" uuid NOT NULL,
        "sensorId" uuid NOT NULL,
        "massKg" numeric(12,3) NOT NULL,
        "measuredAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_feeder_silo_mass_latest" PRIMARY KEY ("tenantId", "sensorId"),
        -- A negative silo mass is a load cell drifting below its tare, i.e. a
        -- broken source. It must not be storable, because the projection's very
        -- existence is what tells the dose planner the source is healthy.
        CONSTRAINT "CK_fsml_mass_non_negative" CHECK ("massKg" >= 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fsml_tenant" ON "${TABLE}" ("tenantId")`,
    );
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT to_regclass(current_schema() || '.${TABLE}') IS NOT NULL AS ok`,
    )) as Array<{ ok: boolean }>;
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DESTRUCTIVE: down() of CreateFeederSiloMassProjection1809200000000 — drops the silo-mass read model introduced by this same migration; the data is a projection and rebuilds itself from the SensorReading stream; rollback reference is this file's up().
    await queryRunner.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  }
}
