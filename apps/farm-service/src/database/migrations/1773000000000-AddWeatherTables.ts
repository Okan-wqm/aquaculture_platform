import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * Migration: Add Weather & Marine Observation Tables
 *
 * Creates 3 new tables:
 * - weather_observations: Hourly weather data from Open-Meteo
 * - marine_observations: Hourly marine data from Open-Meteo Marine API
 * - weather_settings: Per-tenant sync configuration
 *
 * Two-phase approach:
 * 1. Create tables in farm schema (source for new tenants)
 * 2. Copy tables to all existing tenant schemas
 */
export class AddWeatherTables1773000000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('AddWeatherTables1773000000000');
  name = 'AddWeatherTables1773000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await queryRunner.query(`SELECT current_schema()`);
    this.logger.log('Running AddWeatherTables migration in schema:', schema);

    // =========================================================================
    // 1. weather_observations
    // =========================================================================
    const hasWeatherObs = await this.tableExists(queryRunner, 'weather_observations');
    if (!hasWeatherObs) {
      await queryRunner.query(`
        CREATE TABLE "weather_observations" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL,
          "site_id" UUID NOT NULL,
          "observed_at" TIMESTAMPTZ NOT NULL,
          "data_type" VARCHAR(20) NOT NULL DEFAULT 'forecast',
          "temperature" DECIMAL(6,2),
          "wind_speed" DECIMAL(6,2),
          "wind_direction" DECIMAL(5,1),
          "wind_gusts" DECIMAL(6,2),
          "precipitation" DECIMAL(6,2),
          "cloud_cover" DECIMAL(5,1),
          "pressure_msl" DECIMAL(7,2),
          "relative_humidity" DECIMAL(5,1),
          "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT "uq_weather_obs" UNIQUE ("tenant_id", "site_id", "observed_at", "data_type")
        )
      `);
      await queryRunner.query(`CREATE INDEX "idx_weather_obs_tenant" ON "weather_observations" ("tenant_id")`);
      await queryRunner.query(`CREATE INDEX "idx_weather_obs_site_time" ON "weather_observations" ("tenant_id", "site_id", "observed_at")`);
      this.logger.log('Created weather_observations table');
    } else {
      this.logger.log('weather_observations table already exists, skipping');
    }

    // =========================================================================
    // 2. marine_observations
    // =========================================================================
    const hasMarineObs = await this.tableExists(queryRunner, 'marine_observations');
    if (!hasMarineObs) {
      await queryRunner.query(`
        CREATE TABLE "marine_observations" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL,
          "site_id" UUID NOT NULL,
          "observed_at" TIMESTAMPTZ NOT NULL,
          "data_type" VARCHAR(20) NOT NULL DEFAULT 'forecast',
          "wave_height" DECIMAL(5,2),
          "wave_direction" DECIMAL(5,1),
          "wave_period" DECIMAL(5,2),
          "swell_wave_height" DECIMAL(5,2),
          "swell_wave_direction" DECIMAL(5,1),
          "swell_wave_period" DECIMAL(5,2),
          "ocean_current_velocity" DECIMAL(5,3),
          "ocean_current_direction" DECIMAL(5,1),
          "sea_surface_temperature" DECIMAL(5,2),
          "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT "uq_marine_obs" UNIQUE ("tenant_id", "site_id", "observed_at", "data_type")
        )
      `);
      await queryRunner.query(`CREATE INDEX "idx_marine_obs_tenant" ON "marine_observations" ("tenant_id")`);
      await queryRunner.query(`CREATE INDEX "idx_marine_obs_site_time" ON "marine_observations" ("tenant_id", "site_id", "observed_at")`);
      this.logger.log('Created marine_observations table');
    } else {
      this.logger.log('marine_observations table already exists, skipping');
    }

    // =========================================================================
    // 3. weather_settings
    // =========================================================================
    const hasWeatherSettings = await this.tableExists(queryRunner, 'weather_settings');
    if (!hasWeatherSettings) {
      await queryRunner.query(`
        CREATE TABLE "weather_settings" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL UNIQUE,
          "sync_interval_minutes" INT NOT NULL DEFAULT 60,
          "forecast_days" INT NOT NULL DEFAULT 7,
          "enabled" BOOLEAN NOT NULL DEFAULT true,
          "last_synced_at" TIMESTAMPTZ,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      this.logger.log('Created weather_settings table');
    } else {
      this.logger.log('weather_settings table already exists, skipping');
    }

    // =========================================================================
    // 4. Copy to existing tenant schemas
    // =========================================================================
    try {
      const tenantSchemas = await queryRunner.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
      `);

      for (const { schema_name } of tenantSchemas) {
        try {
          await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "${schema_name}"."weather_observations"
            (LIKE "weather_observations" INCLUDING ALL)
          `);
          await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "${schema_name}"."marine_observations"
            (LIKE "marine_observations" INCLUDING ALL)
          `);
          await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "${schema_name}"."weather_settings"
            (LIKE "weather_settings" INCLUDING ALL)
          `);
          this.logger.log(`Created weather tables in ${schema_name}`);
        } catch (err) {
          this.logger.warn(`Warning: Could not create tables in ${schema_name}:`, err);
        }
      }
    } catch (err) {
      this.logger.warn('Warning: Could not propagate to tenant schemas:', err);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop from tenant schemas first
    try {
      const tenantSchemas = await queryRunner.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
      `);
      for (const { schema_name } of tenantSchemas) {
        await queryRunner.query(`DROP TABLE IF EXISTS "${schema_name}"."weather_settings" CASCADE`);
        await queryRunner.query(`DROP TABLE IF EXISTS "${schema_name}"."marine_observations" CASCADE`);
        await queryRunner.query(`DROP TABLE IF EXISTS "${schema_name}"."weather_observations" CASCADE`);
      }
    } catch (err) {
      this.logger.warn('Warning: Could not drop from tenant schemas:', err);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS "weather_settings" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marine_observations" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "weather_observations" CASCADE`);
  }

  private async tableExists(queryRunner: QueryRunner, tableName: string): Promise<boolean> {
    const result = await queryRunner.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = $1 AND table_schema = current_schema()
      )`,
      [tableName],
    );
    return result[0]?.exists === true;
  }
}
