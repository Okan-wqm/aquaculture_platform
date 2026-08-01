import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEnvironmentMetricSyncOutcomes1807200000000 implements MigrationInterface {
  name = 'AddEnvironmentMetricSyncOutcomes1807200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      ALTER TABLE "site_environment_sync_state"
        DROP CONSTRAINT IF EXISTS "CHK_site_environment_sync_status",
        DROP CONSTRAINT IF EXISTS "CHK_site_environment_sync_counts",
        DROP CONSTRAINT IF EXISTS "CHK_site_environment_sync_outcome",
        ADD COLUMN IF NOT EXISTS "expected_scope_count" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "successful_scope_count" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "failed_scope_count" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "no_data_scope_count" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "out_of_coverage_scope_count" integer NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_constraint
           WHERE conname = 'CHK_site_environment_sync_status'
             AND conrelid = 'site_environment_sync_state'::regclass
        ) THEN
          ALTER TABLE "site_environment_sync_state"
            ADD CONSTRAINT "CHK_site_environment_sync_status"
          CHECK (
            "status" IN (
              'PENDING', 'RUNNING', 'READY', 'PARTIAL_FAILURE', 'NO_DATA',
              'OUT_OF_COVERAGE', 'PROVIDER_UNAVAILABLE', 'CONFIGURATION_ERROR'
            )
          );
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_constraint
           WHERE conname = 'CHK_site_environment_sync_counts'
             AND conrelid = 'site_environment_sync_state'::regclass
        ) THEN
          ALTER TABLE "site_environment_sync_state"
            ADD CONSTRAINT "CHK_site_environment_sync_counts"
          CHECK (
            "consecutive_failures" >= 0
            AND "monitoring_location_revision" >= 1
            AND "expected_scope_count" >= 0
            AND "successful_scope_count" >= 0
            AND "failed_scope_count" >= 0
            AND "no_data_scope_count" >= 0
            AND "out_of_coverage_scope_count" >= 0
            AND "expected_scope_count" =
                "successful_scope_count" + "failed_scope_count"
            AND "no_data_scope_count" + "out_of_coverage_scope_count" <=
                "successful_scope_count"
          );
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_constraint
           WHERE conname = 'CHK_site_environment_sync_outcome'
             AND conrelid = 'site_environment_sync_state'::regclass
        ) THEN
          ALTER TABLE "site_environment_sync_state"
            ADD CONSTRAINT "CHK_site_environment_sync_outcome"
          CHECK (
            (
              "status" IN ('PENDING', 'RUNNING', 'READY', 'NO_DATA', 'OUT_OF_COVERAGE')
              AND "error_code" IS NULL
            )
            OR (
              "status" IN (
                'PARTIAL_FAILURE', 'PROVIDER_UNAVAILABLE', 'CONFIGURATION_ERROR'
              )
              AND "error_code" IS NOT NULL
            )
          );
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "environment_metric_sync_outcomes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "site_id" uuid NOT NULL,
        "provider" character varying(40) NOT NULL,
        "metric" character varying(50),
        "scope_kind" character varying(40) NOT NULL,
        "scope_key" character varying(240) NOT NULL,
        "valid_from" TIMESTAMP WITH TIME ZONE,
        "valid_to" TIMESTAMP WITH TIME ZONE,
        "outcome" character varying(40) NOT NULL,
        "error_code" character varying(100),
        "observation_count" integer NOT NULL,
        "monitoring_location_revision" integer NOT NULL,
        "completed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_environment_metric_sync_outcomes" PRIMARY KEY ("id"),
        CONSTRAINT "FK_environment_metric_sync_state"
          FOREIGN KEY (
            "tenant_id", "site_id", "provider", "monitoring_location_revision"
          )
          REFERENCES "site_environment_sync_state" (
            "tenant_id", "site_id", "provider", "monitoring_location_revision"
          ) ON DELETE CASCADE,
        CONSTRAINT "CHK_environment_metric_sync_provider"
          CHECK (
            "provider" IN (
              'MET_LOCATIONFORECAST', 'MET_FROST', 'CMEMS', 'CDSE_SENTINEL_2'
            )
          ),
        CONSTRAINT "CHK_environment_metric_sync_metric"
          CHECK (
            "metric" IS NULL OR "metric" IN (
              'AIR_TEMPERATURE', 'WIND_SPEED', 'WIND_DIRECTION', 'WIND_GUST',
              'PRECIPITATION', 'CLOUD_COVER', 'PRESSURE_MSL', 'RELATIVE_HUMIDITY',
              'WAVE_HEIGHT', 'WAVE_DIRECTION', 'WAVE_PERIOD', 'CURRENT_SPEED',
              'CURRENT_DIRECTION', 'SEA_TEMPERATURE', 'SALINITY',
              'DISSOLVED_OXYGEN', 'MODEL_CHLOROPHYLL'
            )
          ),
        CONSTRAINT "CHK_environment_metric_sync_scope_kind"
          CHECK (
            "scope_kind" IN (
              'PROVIDER_RUN', 'METRIC_SUMMARY', 'METRIC_HORIZON', 'METRIC_INTERVAL'
            )
          ),
        CONSTRAINT "CHK_environment_metric_sync_outcome"
          CHECK (
            (
              "outcome" IN ('AVAILABLE', 'NO_DATA', 'OUT_OF_COVERAGE')
              AND "error_code" IS NULL
            )
            OR (
              "outcome" IN ('PROVIDER_UNAVAILABLE', 'CONFIGURATION_ERROR')
              AND "error_code" IS NOT NULL
            )
          ),
        CONSTRAINT "CHK_environment_metric_sync_window"
          CHECK (
            ("valid_from" IS NULL AND "valid_to" IS NULL)
            OR (
              "valid_from" IS NOT NULL
              AND "valid_to" IS NOT NULL
              AND "valid_from" <= "valid_to"
            )
          ),
        CONSTRAINT "CHK_environment_metric_sync_counts"
          CHECK (
            "observation_count" >= 0
            AND "monitoring_location_revision" >= 1
          )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_environment_metric_sync_outcome_lookup"
        ON "environment_metric_sync_outcomes" (
          "tenant_id", "site_id", "monitoring_location_revision", "provider", "metric"
        )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_environment_metric_sync_outcome_scope"
        ON "environment_metric_sync_outcomes" (
          "tenant_id", "site_id", "monitoring_location_revision", "provider",
          "metric", "scope_kind", "scope_key", "valid_from", "valid_to"
        ) NULLS NOT DISTINCT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);
    await queryRunner.query(`
      DO $$
      DECLARE
        outcome_table regclass := pg_catalog.to_regclass('environment_metric_sync_outcomes');
        sync_state_table regclass := pg_catalog.to_regclass('site_environment_sync_state');
        coverage_column_count integer := 0;
        has_persisted_outcomes boolean := false;
        has_persisted_sync_state boolean := false;
      BEGIN
        IF outcome_table IS NOT NULL THEN
          EXECUTE
            'SELECT EXISTS (SELECT 1 FROM "environment_metric_sync_outcomes")'
            INTO has_persisted_outcomes;
        END IF;

        IF sync_state_table IS NOT NULL THEN
          SELECT pg_catalog.count(*)::integer
            INTO coverage_column_count
            FROM pg_catalog.pg_attribute
           WHERE attrelid = sync_state_table
             AND attname IN (
               'expected_scope_count',
               'successful_scope_count',
               'failed_scope_count',
               'no_data_scope_count',
               'out_of_coverage_scope_count'
             )
             AND attnum > 0
             AND NOT attisdropped;

          IF coverage_column_count = 5 THEN
            EXECUTE
              'SELECT EXISTS (
                 SELECT 1 FROM "site_environment_sync_state"
                  WHERE "status" = ''PARTIAL_FAILURE''
                     OR "expected_scope_count" <> 0
                     OR "successful_scope_count" <> 0
                     OR "failed_scope_count" <> 0
                     OR "no_data_scope_count" <> 0
                     OR "out_of_coverage_scope_count" <> 0
               )'
              INTO has_persisted_sync_state;
          ELSIF coverage_column_count = 0 THEN
            EXECUTE
              'SELECT EXISTS (
                 SELECT 1 FROM "site_environment_sync_state"
                  WHERE "status" = ''PARTIAL_FAILURE''
               )'
              INTO has_persisted_sync_state;
          ELSE
            RAISE EXCEPTION
              'Refusing rollback from an incomplete environmental sync counter schema';
          END IF;
        END IF;

        IF has_persisted_outcomes OR has_persisted_sync_state THEN
          RAISE EXCEPTION
            'Refusing to drop persisted environmental metric coverage outcomes';
        END IF;
      END $$
    `);
    await queryRunner.query(`
      -- DESTRUCTIVE: down()-only rollback before typed coverage is persisted;
      -- recovery reference: re-run AddEnvironmentMetricSyncOutcomes1807200000000.up().
      DROP TABLE IF EXISTS "environment_metric_sync_outcomes"
    `);
    await queryRunner.query(`
      ALTER TABLE "site_environment_sync_state"
        DROP CONSTRAINT IF EXISTS "CHK_site_environment_sync_status",
        DROP CONSTRAINT IF EXISTS "CHK_site_environment_sync_counts",
        DROP CONSTRAINT IF EXISTS "CHK_site_environment_sync_outcome",
        -- DESTRUCTIVE: down()-only removal of empty derived counters;
        -- recovery reference: re-run AddEnvironmentMetricSyncOutcomes1807200000000.up().
        DROP COLUMN IF EXISTS "expected_scope_count",
        DROP COLUMN IF EXISTS "successful_scope_count",
        DROP COLUMN IF EXISTS "failed_scope_count",
        DROP COLUMN IF EXISTS "no_data_scope_count",
        DROP COLUMN IF EXISTS "out_of_coverage_scope_count"
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_constraint
           WHERE conname = 'CHK_site_environment_sync_status'
             AND conrelid = 'site_environment_sync_state'::regclass
        ) THEN
          ALTER TABLE "site_environment_sync_state"
            ADD CONSTRAINT "CHK_site_environment_sync_status"
          CHECK (
            "status" IN (
              'PENDING', 'RUNNING', 'READY', 'NO_DATA', 'OUT_OF_COVERAGE',
              'PROVIDER_UNAVAILABLE', 'CONFIGURATION_ERROR'
            )
          );
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_constraint
           WHERE conname = 'CHK_site_environment_sync_counts'
             AND conrelid = 'site_environment_sync_state'::regclass
        ) THEN
          ALTER TABLE "site_environment_sync_state"
            ADD CONSTRAINT "CHK_site_environment_sync_counts"
          CHECK (
            "consecutive_failures" >= 0
            AND "monitoring_location_revision" >= 1
          );
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_constraint
           WHERE conname = 'CHK_site_environment_sync_outcome'
             AND conrelid = 'site_environment_sync_state'::regclass
        ) THEN
          ALTER TABLE "site_environment_sync_state"
            ADD CONSTRAINT "CHK_site_environment_sync_outcome"
          CHECK (
            (
              "status" IN ('PENDING', 'RUNNING', 'READY', 'NO_DATA', 'OUT_OF_COVERAGE')
              AND "error_code" IS NULL
            )
            OR (
              "status" IN ('PROVIDER_UNAVAILABLE', 'CONFIGURATION_ERROR')
              AND "error_code" IS NOT NULL
            )
          );
        END IF;
      END
      $$
    `);
  }
}
