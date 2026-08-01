import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

const COVERAGE_ASSESSMENT_TABLE = 'satellite_scene_coverage_assessments';

/**
 * Separates immutable Sentinel scene facts from versioned AOI coverage
 * assessments. A scene can therefore retain its legacy UNKNOWN assessment
 * while newer algorithms append independently auditable results.
 */
export class AddSatelliteCoverageProvenance1808000000000 implements MigrationInterface {
  name = 'AddSatelliteCoverageProvenance1808000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "satellite_scene_coverage_assessments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "site_id" uuid NOT NULL,
        "scene_id" character varying(512) NOT NULL,
        "monitoring_location_revision" integer NOT NULL,
        "coverage_status" character varying(32) NOT NULL,
        "coverage_method" character varying(100) NOT NULL,
        "coverage_percent" numeric(5,2),
        "coverage_sample_count" integer,
        "quality_status" character varying(32) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_satellite_scene_coverage_assessments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_satellite_coverage_tenant_site"
          FOREIGN KEY ("tenant_id", "site_id")
          REFERENCES "sites"("tenantId", "id") ON DELETE CASCADE,
        CONSTRAINT "FK_satellite_coverage_scene_identity"
          FOREIGN KEY (
            "tenant_id", "site_id", "scene_id", "monitoring_location_revision"
          )
          REFERENCES "satellite_scene_observations"(
            "tenant_id", "site_id", "scene_id", "monitoring_location_revision"
          ) ON DELETE CASCADE,
        CONSTRAINT "uq_satellite_coverage_scene_method"
          UNIQUE (
            "tenant_id", "site_id", "scene_id", "monitoring_location_revision",
            "coverage_method"
          ),
        CONSTRAINT "CHK_satellite_coverage_location_revision"
          CHECK ("monitoring_location_revision" >= 1),
        CONSTRAINT "CHK_satellite_coverage_assessment"
          CHECK (
            (
              "coverage_status" = 'UNKNOWN'
              AND "coverage_method" = 'LEGACY_UNKNOWN'
              AND "coverage_sample_count" IS NULL
              AND "quality_status" IN (
                'VALID', 'PROVISIONAL', 'NO_DATA', 'CLOUD_OBSCURED',
                'OUT_OF_COVERAGE'
              )
              AND (
                "coverage_percent" IS NULL
                OR "coverage_percent" BETWEEN 0 AND 100
              )
            )
            OR (
              "coverage_status" = 'FULL'
              AND "coverage_method" <> 'LEGACY_UNKNOWN'
              AND length("coverage_method") > 0
              AND "coverage_percent" = 100
              AND "coverage_sample_count" = 0
              AND "quality_status" IN (
                'VALID', 'PROVISIONAL', 'CLOUD_OBSCURED'
              )
            )
            OR (
              "coverage_status" = 'OUT_OF_COVERAGE'
              AND "coverage_method" <> 'LEGACY_UNKNOWN'
              AND length("coverage_method") > 0
              AND "coverage_percent" = 0
              AND "coverage_sample_count" = 0
              AND "quality_status" = 'OUT_OF_COVERAGE'
            )
            OR (
              "coverage_status" = 'PARTIAL'
              AND "coverage_method" <> 'LEGACY_UNKNOWN'
              AND length("coverage_method") > 0
              AND "quality_status" IN (
                'VALID', 'PROVISIONAL', 'CLOUD_OBSCURED'
              )
              AND (
                (
                  "coverage_sample_count" = 0
                  AND "coverage_percent" IS NULL
                )
                OR (
                  "coverage_sample_count" > 0
                  AND (
                    "coverage_percent" IS NULL
                    OR "coverage_percent" > 0 AND "coverage_percent" < 100
                  )
                )
              )
            )
          )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_satellite_coverage_site_created"
        ON "satellite_scene_coverage_assessments" (
          "tenant_id", "site_id", "created_at"
      )
    `);
    await applyTenantRlsToSchema(queryRunner, {
      includeTables: [COVERAGE_ASSESSMENT_TABLE],
      tenantIdColumns: ['tenant_id'],
    });
    // The fan-out runner performs the full registry-derived ownership and ACL
    // alignment after each migration. This same-transaction grant closes the
    // rolling window in which an already-running old replica can fire the raw
    // scene trigger before that post-migration alignment runs.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farm_service') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE
            ON TABLE "satellite_scene_coverage_assessments"
            TO "farm_service";
        END IF;
      END
      $$
    `);

    // Keep old farm-service replicas safe during a rolling release. Their raw
    // scene INSERT contract remains valid and the database records the only
    // provenance statement it can truthfully make: LEGACY_UNKNOWN.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "insert_legacy_satellite_scene_coverage_assessment"()
      RETURNS trigger AS $$
      DECLARE
        has_versioned_assessment boolean;
      BEGIN
        EXECUTE pg_catalog.format(
          'SELECT EXISTS (
             SELECT 1
             FROM %I.satellite_scene_coverage_assessments AS assessment
             WHERE assessment.tenant_id = $1
               AND assessment.site_id = $2
               AND assessment.scene_id = $3
               AND assessment.monitoring_location_revision = $4
               AND assessment.coverage_method <> ''LEGACY_UNKNOWN''
           )',
          TG_TABLE_SCHEMA
        )
        INTO has_versioned_assessment
        USING NEW."tenant_id", NEW."site_id", NEW."scene_id",
              NEW."monitoring_location_revision";

        IF NOT has_versioned_assessment THEN
          EXECUTE pg_catalog.format(
            'INSERT INTO %I.satellite_scene_coverage_assessments (
               tenant_id, site_id, scene_id, monitoring_location_revision,
               coverage_status, coverage_method, coverage_percent,
               coverage_sample_count, quality_status, created_at
             ) VALUES ($1, $2, $3, $4, ''UNKNOWN'', ''LEGACY_UNKNOWN'',
                       $5, NULL, $6, $7)
             ON CONFLICT (
               tenant_id, site_id, scene_id, monitoring_location_revision,
               coverage_method
             ) DO NOTHING',
            TG_TABLE_SCHEMA
          )
          USING NEW."tenant_id", NEW."site_id", NEW."scene_id",
                NEW."monitoring_location_revision", NEW."coverage_percent",
                NEW."quality_status", NEW."created_at";
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_satellite_scene_legacy_coverage"
        ON "satellite_scene_observations";
      CREATE CONSTRAINT TRIGGER "trg_satellite_scene_legacy_coverage"
        AFTER INSERT ON "satellite_scene_observations"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION "insert_legacy_satellite_scene_coverage_assessment"()
    `);

    await queryRunner.query(`
      INSERT INTO "satellite_scene_coverage_assessments" (
        "tenant_id", "site_id", "scene_id", "monitoring_location_revision",
        "coverage_status", "coverage_method", "coverage_percent",
        "coverage_sample_count", "quality_status", "created_at"
      )
      SELECT
        scene."tenant_id", scene."site_id", scene."scene_id",
        scene."monitoring_location_revision", 'UNKNOWN', 'LEGACY_UNKNOWN',
        scene."coverage_percent", NULL, scene."quality_status", scene."created_at"
      FROM "satellite_scene_observations" AS scene
      WHERE NOT EXISTS (
        SELECT 1
        FROM "satellite_scene_coverage_assessments" AS assessment
        WHERE assessment."tenant_id" = scene."tenant_id"
          AND assessment."site_id" = scene."site_id"
          AND assessment."scene_id" = scene."scene_id"
          AND assessment."monitoring_location_revision" =
              scene."monitoring_location_revision"
          AND assessment."coverage_method" <> 'LEGACY_UNKNOWN'
      )
      ON CONFLICT (
        "tenant_id", "site_id", "scene_id", "monitoring_location_revision",
        "coverage_method"
      ) DO NOTHING
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_satellite_coverage_assessment_append_only"
        ON "satellite_scene_coverage_assessments";
      CREATE TRIGGER "trg_satellite_coverage_assessment_append_only"
        BEFORE UPDATE ON "satellite_scene_coverage_assessments"
        FOR EACH ROW
        EXECUTE FUNCTION "reject_canonical_environment_observation_update"()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);
    await queryRunner.query(`
      LOCK TABLE "satellite_scene_observations"
        IN ACCESS EXCLUSIVE MODE
    `);
    await queryRunner.query(`
      LOCK TABLE "satellite_scene_coverage_assessments"
        IN ACCESS EXCLUSIVE MODE
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "satellite_scene_coverage_assessments"
          WHERE "coverage_method" <> 'LEGACY_UNKNOWN'
             OR "coverage_status" <> 'UNKNOWN'
             OR "coverage_sample_count" IS NOT NULL
        ) THEN
          RAISE EXCEPTION
            'Refusing to drop persisted versioned satellite coverage assessments';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_satellite_scene_legacy_coverage"
        ON "satellite_scene_observations"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS "insert_legacy_satellite_scene_coverage_assessment"()
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "satellite_scene_coverage_assessments"
    `);
  }
}
