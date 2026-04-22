import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddDomainRetentionFunctions
 * ============================================================================
 *
 * Phase 4.1 of the "Farm modülü kalan kör noktalar" plan. Closes the
 * Girdi 14b / 15-B18 retention gap for operational domain tables.
 *
 * Before this migration only `audit_logs` had a retention function;
 * everything else grew unbounded. In practice that meant:
 *
 *   - `feeding_records`        ≥ 3 rows per tank per day × 365 days × 50 tanks
 *                              = ~55k rows/year per tenant; 20 tenants × 5 years
 *                              = 5.5M rows per farm-service DB with no cap.
 *   - `water_quality_measurements`: each sensor emits one per minute
 *     when wired in — millions of rows in a year. GIN indexes on the
 *     JSONB `parameterValues` column multiply the storage footprint.
 *
 * # Functions created
 *
 * Every function follows the same shape as `cleanup_old_audit_logs`:
 * accepts `p_retention_days int`, deletes rows whose authoritative
 * timestamp column is older than `NOW() - retention_days`, returns
 * the deleted row count via `GET DIAGNOSTICS v_deleted_count = ROW_COUNT`.
 *
 * | Table                        | Timestamp column  | Default retention |
 * | ---------------------------- | ----------------- | ----------------- |
 * | feeding_records              | "feedingDate"     | 800 days (~2.2y)  |
 * | growth_measurements          | "measurementDate" | 1825 days (5y)    |
 * | water_quality_measurements   | "measuredAt"      | 1095 days (3y)    |
 * | tank_operations              | "operationDate"   | 2555 days (7y)    |
 * | harvest_records              | "harvestDate"     | 3650 days (10y)   |
 *
 * Mortality is recorded as a `tank_operations` row with operationType
 * = MORTALITY, so it shares the 7-year retention of tank_operations.
 * No separate `mortality_records` table exists.
 *
 * # Column identifiers
 *
 * TypeORM preserves property names unmodified unless `name:` is
 * passed to `@Column`. Every timestamp column above is quoted
 * camelCase in PostgreSQL ("feedingDate", "measurementDate", …) —
 * unquoted `WHERE feedingdate < …` would error. The SQL below
 * quotes them explicitly.
 *
 * # Reference-guard (follow-up)
 *
 * The plan (phase 4.1.1) calls for skipping rows referenced in the
 * last 30 days (e.g. a harvest_record still cited by a
 * BiomassReport). Implementing that needs a join against every
 * downstream consumer per table and lands in phase 4.1.1 — the
 * conservative retention windows above (2–10 years) already leave
 * a wide margin. When phase 4.1.1 lands it extends each function
 * with a `NOT EXISTS (SELECT 1 FROM … WHERE … )` predicate without
 * changing the calling cron code.
 */
export class AddDomainRetentionFunctions1787000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION cleanup_old_feeding_records(p_retention_days int DEFAULT 800)
      RETURNS int AS $$
      DECLARE
        v_deleted_count int;
      BEGIN
        DELETE FROM feeding_records
        WHERE "feedingDate" < (NOW() - (p_retention_days || ' days')::interval)::date;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % feeding_records rows older than % days', v_deleted_count, p_retention_days;
        RETURN v_deleted_count;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION cleanup_old_growth_measurements(p_retention_days int DEFAULT 1825)
      RETURNS int AS $$
      DECLARE
        v_deleted_count int;
      BEGIN
        DELETE FROM growth_measurements
        WHERE "measurementDate" < (NOW() - (p_retention_days || ' days')::interval);
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % growth_measurements rows older than % days', v_deleted_count, p_retention_days;
        RETURN v_deleted_count;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION cleanup_old_water_quality_measurements(p_retention_days int DEFAULT 1095)
      RETURNS int AS $$
      DECLARE
        v_deleted_count int;
      BEGIN
        DELETE FROM water_quality_measurements
        WHERE "measuredAt" < (NOW() - (p_retention_days || ' days')::interval);
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % water_quality_measurements rows older than % days', v_deleted_count, p_retention_days;
        RETURN v_deleted_count;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION cleanup_old_tank_operations(p_retention_days int DEFAULT 2555)
      RETURNS int AS $$
      DECLARE
        v_deleted_count int;
      BEGIN
        DELETE FROM tank_operations
        WHERE "operationDate" < (NOW() - (p_retention_days || ' days')::interval)::date;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % tank_operations rows older than % days', v_deleted_count, p_retention_days;
        RETURN v_deleted_count;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION cleanup_old_harvest_records(p_retention_days int DEFAULT 3650)
      RETURNS int AS $$
      DECLARE
        v_deleted_count int;
      BEGIN
        DELETE FROM harvest_records
        WHERE "harvestDate" < (NOW() - (p_retention_days || ' days')::interval)::date;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % harvest_records rows older than % days', v_deleted_count, p_retention_days;
        RETURN v_deleted_count;
      END;
      $$ LANGUAGE plpgsql;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS cleanup_old_feeding_records(int)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS cleanup_old_growth_measurements(int)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS cleanup_old_water_quality_measurements(int)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS cleanup_old_tank_operations(int)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS cleanup_old_harvest_records(int)`,
    );
  }
}
