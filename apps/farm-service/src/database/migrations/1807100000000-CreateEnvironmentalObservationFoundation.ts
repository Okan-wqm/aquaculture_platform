import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateEnvironmentalObservationFoundation1807100000000 implements MigrationInterface {
  name = 'CreateEnvironmentalObservationFoundation1807100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      ALTER TABLE "weather_observations"
        ADD COLUMN IF NOT EXISTS "provider" character varying(40),
        ADD COLUMN IF NOT EXISTS "product_id" character varying(160),
        ADD COLUMN IF NOT EXISTS "dataset_id" character varying(200),
        ADD COLUMN IF NOT EXISTS "source_run_key" character varying(200),
        ADD COLUMN IF NOT EXISTS "issued_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "semantic_class" character varying(40),
        ADD COLUMN IF NOT EXISTS "quality_status" character varying(40),
        ADD COLUMN IF NOT EXISTS "station_id" character varying(100),
        ADD COLUMN IF NOT EXISTS "station_distance_km" numeric(10,3),
        ADD COLUMN IF NOT EXISTS "horizontal_resolution_m" numeric(12,3),
        ADD COLUMN IF NOT EXISTS "monitoring_location_revision" integer NOT NULL DEFAULT 1
    `);
    await queryRunner.query(`
      ALTER TABLE "marine_observations"
        ADD COLUMN IF NOT EXISTS "provider" character varying(40),
        ADD COLUMN IF NOT EXISTS "product_id" character varying(160),
        ADD COLUMN IF NOT EXISTS "dataset_id" character varying(200),
        ADD COLUMN IF NOT EXISTS "variable_set_id" character varying(100),
        ADD COLUMN IF NOT EXISTS "source_run_key" character varying(200),
        ADD COLUMN IF NOT EXISTS "issued_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "semantic_class" character varying(40),
        ADD COLUMN IF NOT EXISTS "quality_status" character varying(40),
        ADD COLUMN IF NOT EXISTS "salinity" numeric(8,4),
        ADD COLUMN IF NOT EXISTS "dissolved_oxygen" numeric(12,5),
        ADD COLUMN IF NOT EXISTS "model_chlorophyll" numeric(12,6),
        ADD COLUMN IF NOT EXISTS "requested_depth_m" numeric(10,3),
        ADD COLUMN IF NOT EXISTS "model_depth_m" numeric(10,3),
        ADD COLUMN IF NOT EXISTS "horizontal_resolution_m" numeric(12,3),
        ADD COLUMN IF NOT EXISTS "grid_cell_distance_m" numeric(12,3),
        ADD COLUMN IF NOT EXISTS "coverage_percent" numeric(5,2),
        ADD COLUMN IF NOT EXISTS "monitoring_location_revision" integer NOT NULL DEFAULT 1
    `);
    await queryRunner.query(`
      ALTER TABLE "weather_observations"
        DROP CONSTRAINT IF EXISTS "uq_weather_obs"
    `);
    await queryRunner.query(`
      ALTER TABLE "marine_observations"
        DROP CONSTRAINT IF EXISTS "uq_marine_obs"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_sites_tenant_identity"
        ON "sites" ("tenantId", "id")
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "weather_observations"
          ADD CONSTRAINT "FK_weather_observation_tenant_site"
          FOREIGN KEY ("tenant_id", "site_id")
          REFERENCES "sites"("tenantId", "id")
          ON DELETE CASCADE
          NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "marine_observations"
          ADD CONSTRAINT "FK_marine_observation_tenant_site"
          FOREIGN KEY ("tenant_id", "site_id")
          REFERENCES "sites"("tenantId", "id")
          ON DELETE CASCADE
          NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    // Existing weather/marine rows predate the composite tenant/site FK. The
    // low-lock ADD ... NOT VALID path protects new writes immediately; the
    // catalog assertion prevents a same-named but structurally different
    // historical constraint from being silently accepted, and VALIDATE makes
    // legacy ownership proof a mandatory, fail-closed deployment condition.
    await queryRunner.query(`
      DO $$
      DECLARE
        site_table regclass := 'sites'::regclass;
        site_key smallint[];
        observation_table regclass;
        observation_key smallint[];
        constraint_row record;
        constraint_name text;
        table_name text;
      BEGIN
        SELECT ARRAY[
          (SELECT attnum::smallint FROM pg_attribute
            WHERE attrelid = site_table AND attname = 'tenantId' AND NOT attisdropped),
          (SELECT attnum::smallint FROM pg_attribute
            WHERE attrelid = site_table AND attname = 'id' AND NOT attisdropped)
        ] INTO site_key;

        FOR table_name, constraint_name IN
          SELECT * FROM (VALUES
            ('weather_observations', 'FK_weather_observation_tenant_site'),
            ('marine_observations', 'FK_marine_observation_tenant_site')
          ) AS expected(table_name, constraint_name)
        LOOP
          observation_table := table_name::regclass;
          SELECT ARRAY[
            (SELECT attnum::smallint FROM pg_attribute
              WHERE attrelid = observation_table
                AND attname = 'tenant_id' AND NOT attisdropped),
            (SELECT attnum::smallint FROM pg_attribute
              WHERE attrelid = observation_table
                AND attname = 'site_id' AND NOT attisdropped)
          ] INTO observation_key;

          SELECT c.conrelid, c.confrelid, c.conkey, c.confkey, c.confdeltype
            INTO constraint_row
            FROM pg_constraint c
           WHERE c.conrelid = observation_table
             AND c.conname = constraint_name
             AND c.contype = 'f';

          IF NOT FOUND THEN
            RAISE EXCEPTION 'Required environmental tenant/site FK % is absent',
              constraint_name;
          END IF;
          IF constraint_row.conrelid <> observation_table
             OR constraint_row.confrelid <> site_table
             OR constraint_row.conkey <> observation_key
             OR constraint_row.confkey <> site_key
             OR constraint_row.confdeltype <> 'c' THEN
            RAISE EXCEPTION
              'Environmental tenant/site FK % has an unexpected definition',
              constraint_name;
          END IF;
        END LOOP;
      END
      $$
    `);
    await queryRunner.query(`
      ALTER TABLE "weather_observations"
        VALIDATE CONSTRAINT "FK_weather_observation_tenant_site"
    `);
    await queryRunner.query(`
      ALTER TABLE "marine_observations"
        VALIDATE CONSTRAINT "FK_marine_observation_tenant_site"
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "weather_observations"
          ADD CONSTRAINT "CHK_weather_observation_provenance_bundle"
          CHECK (
            (
              "provider" IS NULL
              AND "product_id" IS NULL
              AND "dataset_id" IS NULL
              AND "source_run_key" IS NULL
              AND "issued_at" IS NULL
              AND "semantic_class" IS NULL
              AND "quality_status" IS NULL
              AND "station_id" IS NULL
              AND "station_distance_km" IS NULL
              AND "horizontal_resolution_m" IS NULL
            )
            OR (
              "provider" IN ('MET_LOCATIONFORECAST', 'MET_FROST')
              AND "product_id" IS NOT NULL
              AND "dataset_id" IS NOT NULL
              AND "source_run_key" IS NOT NULL
              AND (
                (
                  "provider" = 'MET_LOCATIONFORECAST'
                  AND "issued_at" IS NOT NULL
                  AND "semantic_class" = 'FORECAST'
                  AND "station_id" IS NULL
                  AND "station_distance_km" IS NULL
                )
                OR
                (
                  "provider" = 'MET_FROST'
                  AND "issued_at" IS NULL
                  AND "semantic_class" = 'OBSERVATION'
                  AND "station_id" IS NOT NULL
                  AND "station_distance_km" IS NOT NULL
                )
              )
              AND "quality_status" IN ('VALID', 'PROVISIONAL')
            )
          );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "weather_observations"
          ADD CONSTRAINT "CHK_weather_observation_dimensions"
          CHECK (
            "monitoring_location_revision" >= 1
            AND ("station_distance_km" IS NULL OR "station_distance_km" >= 0)
            AND ("horizontal_resolution_m" IS NULL OR "horizontal_resolution_m" > 0)
          );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "weather_observations"
          ADD CONSTRAINT "CHK_weather_observation_canonical_values"
          CHECK (
            "provider" IS NULL
            OR (
              num_nonnulls(
                "temperature", "wind_speed", "wind_direction", "wind_gusts",
                "precipitation", "cloud_cover", "pressure_msl",
                "relative_humidity"
              ) > 0
              AND ("temperature" IS NULL OR "temperature" BETWEEN -9999.99 AND 9999.99)
              AND ("wind_speed" IS NULL OR "wind_speed" BETWEEN 0 AND 9999.99)
              AND ("wind_direction" IS NULL OR "wind_direction" BETWEEN 0 AND 360)
              AND ("wind_gusts" IS NULL OR "wind_gusts" BETWEEN 0 AND 9999.99)
              AND ("precipitation" IS NULL OR "precipitation" BETWEEN 0 AND 9999.99)
              AND ("cloud_cover" IS NULL OR "cloud_cover" BETWEEN 0 AND 100)
              AND ("pressure_msl" IS NULL OR "pressure_msl" BETWEEN 0 AND 99999.99)
              AND ("relative_humidity" IS NULL OR "relative_humidity" BETWEEN 0 AND 100)
            )
          );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "marine_observations"
          ADD CONSTRAINT "CHK_marine_observation_provenance_bundle"
          CHECK (
            (
              "provider" IS NULL
              AND "product_id" IS NULL
              AND "dataset_id" IS NULL
              AND "variable_set_id" IS NULL
              AND "source_run_key" IS NULL
              AND "issued_at" IS NULL
              AND "semantic_class" IS NULL
              AND "quality_status" IS NULL
              AND "salinity" IS NULL
              AND "dissolved_oxygen" IS NULL
              AND "model_chlorophyll" IS NULL
              AND "requested_depth_m" IS NULL
              AND "model_depth_m" IS NULL
              AND "horizontal_resolution_m" IS NULL
              AND "grid_cell_distance_m" IS NULL
              AND "coverage_percent" IS NULL
            )
            OR (
              "provider" = 'CMEMS'
              AND "product_id" IS NOT NULL
              AND "dataset_id" IS NOT NULL
              AND "variable_set_id" IS NOT NULL
              AND "source_run_key" IS NOT NULL
              AND "semantic_class" IN ('ANALYSIS', 'FORECAST')
              AND "quality_status" = 'PROVISIONAL'
              AND "horizontal_resolution_m" IS NOT NULL
            )
          );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "marine_observations"
          ADD CONSTRAINT "CHK_marine_observation_dimensions"
          CHECK (
            "monitoring_location_revision" >= 1
            AND ("requested_depth_m" IS NULL OR "requested_depth_m" >= 0)
            AND ("model_depth_m" IS NULL OR "model_depth_m" >= 0)
            AND ("horizontal_resolution_m" IS NULL OR "horizontal_resolution_m" > 0)
            AND ("grid_cell_distance_m" IS NULL OR "grid_cell_distance_m" >= 0)
            AND ("coverage_percent" IS NULL OR "coverage_percent" BETWEEN 0 AND 100)
          );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "marine_observations"
          ADD CONSTRAINT "CHK_marine_observation_canonical_values"
          CHECK (
            "provider" IS NULL
            OR (
              num_nonnulls(
                "wave_height", "wave_direction", "wave_period",
                "ocean_current_velocity", "ocean_current_direction",
                "sea_surface_temperature", "salinity", "dissolved_oxygen",
                "model_chlorophyll"
              ) > 0
              AND ("wave_height" IS NULL OR "wave_height" BETWEEN 0 AND 999.99)
              AND ("wave_direction" IS NULL OR "wave_direction" BETWEEN 0 AND 360)
              AND ("wave_period" IS NULL OR "wave_period" BETWEEN 0 AND 999.99)
              AND (
                "ocean_current_velocity" IS NULL
                OR "ocean_current_velocity" BETWEEN 0 AND 99.999
              )
              AND (
                "ocean_current_direction" IS NULL
                OR "ocean_current_direction" BETWEEN 0 AND 360
              )
              AND (
                "sea_surface_temperature" IS NULL
                OR "sea_surface_temperature" BETWEEN -999.99 AND 999.99
              )
              AND ("salinity" IS NULL OR "salinity" BETWEEN 0 AND 9999.9999)
              AND (
                "dissolved_oxygen" IS NULL
                OR "dissolved_oxygen" BETWEEN 0 AND 9999999.99999
              )
              AND (
                "model_chlorophyll" IS NULL
                OR "model_chlorophyll" BETWEEN 0 AND 999999.999999
              )
              AND (
                "requested_depth_m" IS NULL
                OR "requested_depth_m" BETWEEN 0 AND 9999999.999
              )
              AND (
                "model_depth_m" IS NULL
                OR "model_depth_m" BETWEEN 0 AND 9999999.999
              )
              AND "horizontal_resolution_m" BETWEEN 0.001 AND 999999999.999
              AND (
                "grid_cell_distance_m" IS NULL
                OR "grid_cell_distance_m" BETWEEN 0 AND 999999999.999
              )
            )
          );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_weather_obs_legacy"
        ON "weather_observations"
        ("tenant_id", "site_id", "observed_at", "data_type")
        WHERE "provider" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_weather_obs_canonical_run"
        ON "weather_observations"
        ("tenant_id", "site_id", "provider", "dataset_id", "source_run_key", "observed_at")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_weather_obs_provider_revision"
        ON "weather_observations"
        (
          "tenant_id", "site_id", "provider", "dataset_id",
          "source_run_key", "observed_at", "data_type", "monitoring_location_revision"
        )
        WHERE "provider" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_weather_obs_retention"
        ON "weather_observations" ("observed_at")
        WHERE "provider" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_weather_obs_latest_metric"
        ON "weather_observations" (
          "tenant_id", "site_id", "monitoring_location_revision",
          "observed_at", "provider", "issued_at", "fetched_at"
        )
        WHERE "provider" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_marine_obs_legacy"
        ON "marine_observations"
        ("tenant_id", "site_id", "observed_at", "data_type")
        WHERE "provider" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_marine_obs_canonical_run"
        ON "marine_observations"
        (
          "tenant_id", "site_id", "provider", "dataset_id",
          "source_run_key", "observed_at", "model_depth_m"
        )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_marine_obs_provider_revision"
        ON "marine_observations"
        (
          "tenant_id", "site_id", "provider", "dataset_id", "source_run_key",
          "observed_at", "data_type", COALESCE("model_depth_m", -1),
          "monitoring_location_revision"
        )
        WHERE "provider" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_marine_obs_retention"
        ON "marine_observations" ("observed_at")
        WHERE "provider" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_marine_obs_latest_metric"
        ON "marine_observations" (
          "tenant_id", "site_id", "monitoring_location_revision",
          "observed_at", "provider", "issued_at", "fetched_at",
          "model_depth_m"
        )
        WHERE "provider" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "reject_canonical_environment_observation_update"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD."provider" IS NOT NULL THEN
          RAISE EXCEPTION 'canonical environmental observations are append-only';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_weather_observation_append_only" ON "weather_observations";
      CREATE TRIGGER "trg_weather_observation_append_only"
        BEFORE UPDATE ON "weather_observations"
        FOR EACH ROW
        EXECUTE FUNCTION "reject_canonical_environment_observation_update"()
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_marine_observation_append_only" ON "marine_observations";
      CREATE TRIGGER "trg_marine_observation_append_only"
        BEFORE UPDATE ON "marine_observations"
        FOR EACH ROW
        EXECUTE FUNCTION "reject_canonical_environment_observation_update"()
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "satellite_scene_observations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "site_id" uuid NOT NULL,
        "scene_id" character varying(512) NOT NULL,
        "collection" character varying(100) NOT NULL,
        "provider" character varying(40) NOT NULL DEFAULT 'CDSE_SENTINEL_2',
        "product_id" character varying(512) NOT NULL,
        "dataset_id" character varying(200) NOT NULL,
        "acquired_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "cloud_cover_percent" numeric(5,2),
        "coverage_percent" numeric(5,2),
        "quality_status" character varying(32) NOT NULL,
        "monitoring_location_revision" integer NOT NULL,
        "fetched_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_satellite_scene_observations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_satellite_scene_tenant_site"
          FOREIGN KEY ("tenant_id", "site_id")
          REFERENCES "sites"("tenantId", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_satellite_scene_provider"
          CHECK ("provider" = 'CDSE_SENTINEL_2'),
        CONSTRAINT "CHK_satellite_scene_percentages"
          CHECK (
            ("cloud_cover_percent" IS NULL OR "cloud_cover_percent" BETWEEN 0 AND 100)
            AND ("coverage_percent" IS NULL OR "coverage_percent" BETWEEN 0 AND 100)
          ),
        CONSTRAINT "CHK_satellite_scene_quality"
          CHECK (
            "quality_status" IN (
              'VALID', 'PROVISIONAL', 'NO_DATA', 'CLOUD_OBSCURED',
              'OUT_OF_COVERAGE'
            )
          ),
        CONSTRAINT "CHK_satellite_scene_location_revision"
          CHECK ("monitoring_location_revision" >= 1),
        CONSTRAINT "uq_satellite_scene_site_revision"
          UNIQUE ("tenant_id", "site_id", "scene_id", "monitoring_location_revision")
      )
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_satellite_scene_append_only"
        ON "satellite_scene_observations";
      CREATE TRIGGER "trg_satellite_scene_append_only"
        BEFORE UPDATE ON "satellite_scene_observations"
        FOR EACH ROW
        EXECUTE FUNCTION "reject_canonical_environment_observation_update"()
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_satellite_scene_site_acquired"
        ON "satellite_scene_observations" ("tenant_id", "site_id", "acquired_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_satellite_scene_retention"
        ON "satellite_scene_observations" ("acquired_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "site_environment_sync_state" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "site_id" uuid NOT NULL,
        "provider" character varying(40) NOT NULL,
        "status" character varying(40) NOT NULL,
        "cursor" character varying(2048),
        "last_attempt_at" TIMESTAMP WITH TIME ZONE,
        "last_success_at" TIMESTAMP WITH TIME ZONE,
        "next_run_at" TIMESTAMP WITH TIME ZONE,
        "error_code" character varying(100),
        "consecutive_failures" integer NOT NULL DEFAULT 0,
        "lease_token" uuid,
        "lease_expires_at" TIMESTAMP WITH TIME ZONE,
        "monitoring_location_revision" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_site_environment_sync_state" PRIMARY KEY ("id"),
        CONSTRAINT "FK_site_environment_sync_tenant_site"
          FOREIGN KEY ("tenant_id", "site_id")
          REFERENCES "sites"("tenantId", "id") ON DELETE CASCADE,
        CONSTRAINT "CHK_site_environment_sync_provider"
          CHECK (
            "provider" IN (
              'MET_LOCATIONFORECAST', 'MET_FROST', 'CMEMS', 'CDSE_SENTINEL_2'
            )
          ),
        CONSTRAINT "CHK_site_environment_sync_status"
          CHECK (
            "status" IN (
              'PENDING', 'RUNNING', 'READY', 'NO_DATA', 'OUT_OF_COVERAGE',
              'PROVIDER_UNAVAILABLE', 'CONFIGURATION_ERROR'
            )
          ),
        CONSTRAINT "CHK_site_environment_sync_counts"
          CHECK (
            "consecutive_failures" >= 0
            AND "monitoring_location_revision" >= 1
          ),
        CONSTRAINT "CHK_site_environment_sync_outcome"
          CHECK (
            (
              "status" IN (
                'PENDING', 'RUNNING', 'READY', 'NO_DATA', 'OUT_OF_COVERAGE'
              )
              AND "error_code" IS NULL
            )
            OR (
              "status" IN ('PROVIDER_UNAVAILABLE', 'CONFIGURATION_ERROR')
              AND "error_code" IS NOT NULL
            )
          ),
        CONSTRAINT "CHK_site_environment_sync_lease"
          CHECK (
            (
              "status" = 'RUNNING'
              AND "lease_token" IS NOT NULL
              AND "lease_expires_at" IS NOT NULL
              AND "last_attempt_at" IS NOT NULL
              AND "lease_expires_at" > "last_attempt_at"
            )
            OR
            (
              "status" <> 'RUNNING'
              AND "lease_token" IS NULL
              AND "lease_expires_at" IS NULL
            )
          ),
        CONSTRAINT "uq_site_environment_sync_provider_revision"
          UNIQUE (
            "tenant_id", "site_id", "provider", "monitoring_location_revision"
          )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_site_environment_sync_due"
        ON "site_environment_sync_state" ("status", "next_run_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_site_environment_sync_lease"
        ON "site_environment_sync_state" ("lease_expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "weather_observations" WHERE "provider" IS NOT NULL)
           OR EXISTS (SELECT 1 FROM "marine_observations" WHERE "provider" IS NOT NULL)
           OR EXISTS (SELECT 1 FROM "satellite_scene_observations")
           OR EXISTS (SELECT 1 FROM "site_environment_sync_state") THEN
          RAISE EXCEPTION
            'cannot roll back environmental observation foundation after canonical monitoring data exists';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "site_environment_sync_state"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "satellite_scene_observations"`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_marine_observation_append_only" ON "marine_observations"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_weather_observation_append_only" ON "weather_observations"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "reject_canonical_environment_observation_update"()`,
    );

    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_marine_obs_provider_revision";
      DROP INDEX IF EXISTS "uq_marine_obs_legacy";
      DROP INDEX IF EXISTS "idx_marine_obs_retention";
      DROP INDEX IF EXISTS "idx_marine_obs_canonical_run";
      DROP INDEX IF EXISTS "idx_marine_obs_latest_metric";
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "marine_observations"
          GROUP BY "tenant_id", "site_id", "observed_at", "data_type"
          HAVING COUNT(*) > 1
        ) THEN
          RAISE EXCEPTION
            'cannot restore uq_marine_obs: canonical provider revisions overlap';
        END IF;
        ALTER TABLE "marine_observations"
          ADD CONSTRAINT "uq_marine_obs"
          UNIQUE ("tenant_id", "site_id", "observed_at", "data_type");
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      ALTER TABLE "marine_observations"
        DROP CONSTRAINT IF EXISTS "FK_marine_observation_tenant_site",
        DROP CONSTRAINT IF EXISTS "CHK_marine_observation_canonical_values",
        DROP CONSTRAINT IF EXISTS "CHK_marine_observation_dimensions",
        DROP CONSTRAINT IF EXISTS "CHK_marine_observation_provenance_bundle",
        DROP COLUMN IF EXISTS "monitoring_location_revision",
        DROP COLUMN IF EXISTS "coverage_percent",
        DROP COLUMN IF EXISTS "grid_cell_distance_m",
        DROP COLUMN IF EXISTS "horizontal_resolution_m",
        DROP COLUMN IF EXISTS "model_depth_m",
        DROP COLUMN IF EXISTS "requested_depth_m",
        DROP COLUMN IF EXISTS "model_chlorophyll",
        DROP COLUMN IF EXISTS "dissolved_oxygen",
        DROP COLUMN IF EXISTS "salinity",
        DROP COLUMN IF EXISTS "quality_status",
        DROP COLUMN IF EXISTS "semantic_class",
        DROP COLUMN IF EXISTS "issued_at",
        DROP COLUMN IF EXISTS "source_run_key",
        DROP COLUMN IF EXISTS "variable_set_id",
        DROP COLUMN IF EXISTS "dataset_id",
        DROP COLUMN IF EXISTS "product_id",
        DROP COLUMN IF EXISTS "provider"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_weather_obs_provider_revision";
      DROP INDEX IF EXISTS "uq_weather_obs_legacy";
      DROP INDEX IF EXISTS "idx_weather_obs_retention";
      DROP INDEX IF EXISTS "idx_weather_obs_canonical_run";
      DROP INDEX IF EXISTS "idx_weather_obs_latest_metric";
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "weather_observations"
          GROUP BY "tenant_id", "site_id", "observed_at", "data_type"
          HAVING COUNT(*) > 1
        ) THEN
          RAISE EXCEPTION
            'cannot restore uq_weather_obs: canonical provider revisions overlap';
        END IF;
        ALTER TABLE "weather_observations"
          ADD CONSTRAINT "uq_weather_obs"
          UNIQUE ("tenant_id", "site_id", "observed_at", "data_type");
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      ALTER TABLE "weather_observations"
        DROP CONSTRAINT IF EXISTS "FK_weather_observation_tenant_site",
        DROP CONSTRAINT IF EXISTS "CHK_weather_observation_canonical_values",
        DROP CONSTRAINT IF EXISTS "CHK_weather_observation_dimensions",
        DROP CONSTRAINT IF EXISTS "CHK_weather_observation_provenance_bundle",
        DROP COLUMN IF EXISTS "monitoring_location_revision",
        DROP COLUMN IF EXISTS "horizontal_resolution_m",
        DROP COLUMN IF EXISTS "station_distance_km",
        DROP COLUMN IF EXISTS "station_id",
        DROP COLUMN IF EXISTS "quality_status",
        DROP COLUMN IF EXISTS "semantic_class",
        DROP COLUMN IF EXISTS "issued_at",
        DROP COLUMN IF EXISTS "source_run_key",
        DROP COLUMN IF EXISTS "dataset_id",
        DROP COLUMN IF EXISTS "product_id",
        DROP COLUMN IF EXISTS "provider"
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_sites_tenant_identity"`);
  }
}
