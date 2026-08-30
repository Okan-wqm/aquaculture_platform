import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSiteMonitoringContract1806900000000 implements MigrationInterface {
  name = 'AddSiteMonitoringContract1806900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE "sites"
        ADD COLUMN IF NOT EXISTS "monitoringRadiusM" integer NOT NULL DEFAULT 2000,
        ADD COLUMN IF NOT EXISTS "monitoringArea" jsonb,
        ADD COLUMN IF NOT EXISTS "monitoringLocationRevision" integer NOT NULL DEFAULT 1
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sites"
          ADD CONSTRAINT "CHK_sites_monitoring_radius"
          CHECK ("monitoringRadiusM" BETWEEN 100 AND 20000);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sites"
          ADD CONSTRAINT "CHK_sites_monitoring_location_revision"
          CHECK ("monitoringLocationRevision" >= 1);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sites"
          ADD CONSTRAINT "CHK_sites_monitoring_area_geometry_kind"
          CHECK (
            "monitoringArea" IS NULL
            OR (
              jsonb_typeof("monitoringArea") = 'object'
              AND "monitoringArea"->>'type' IN ('Polygon', 'MultiPolygon')
              AND jsonb_typeof("monitoringArea"->'coordinates') = 'array'
            )
          );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Existing SEA_CAGE rows may predate coordinate capture. NOT VALID avoids
    // inventing coordinates during migration while still rejecting every new
    // or changed row that violates the contract.
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sites"
          ADD CONSTRAINT "CHK_sites_sea_cage_location"
          CHECK (
            "type"::text <> 'sea_cage'
            OR CASE
              WHEN jsonb_typeof("location") = 'object'
                AND jsonb_typeof("location"->'latitude') = 'number'
                AND jsonb_typeof("location"->'longitude') = 'number'
              THEN ("location"->>'latitude')::double precision BETWEEN -90 AND 90
                AND ("location"->>'longitude')::double precision BETWEEN -180 AND 180
              ELSE FALSE
            END
          ) NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "enforce_site_monitoring_location_revision"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        monitoring_changed boolean;
      BEGIN
        monitoring_changed :=
          NEW."type" IS DISTINCT FROM OLD."type"
          OR NEW."location" IS DISTINCT FROM OLD."location"
          OR NEW."monitoringRadiusM" IS DISTINCT FROM OLD."monitoringRadiusM"
          OR NEW."monitoringArea" IS DISTINCT FROM OLD."monitoringArea";

        IF monitoring_changed THEN
          IF NEW."monitoringLocationRevision" <> OLD."monitoringLocationRevision" + 1 THEN
            RAISE EXCEPTION
              'monitoringLocationRevision must advance exactly once when the monitoring location changes';
          END IF;
        ELSIF NEW."monitoringLocationRevision" <> OLD."monitoringLocationRevision" THEN
          RAISE EXCEPTION
            'monitoringLocationRevision cannot change without a monitoring location change';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_enforce_site_monitoring_location_revision" ON "sites"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_enforce_site_monitoring_location_revision"
      BEFORE UPDATE ON "sites"
      FOR EACH ROW
      EXECUTE FUNCTION "enforce_site_monitoring_location_revision"()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "sites"
          WHERE "monitoringLocationRevision" <> 1
             OR "monitoringRadiusM" <> 2000
             OR "monitoringArea" IS NOT NULL
        ) THEN
          RAISE EXCEPTION
            'cannot roll back site monitoring contract after monitoring configuration has been used';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_enforce_site_monitoring_location_revision" ON "sites"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS "enforce_site_monitoring_location_revision"()
    `);
    await queryRunner.query(`
      ALTER TABLE "sites"
        DROP CONSTRAINT IF EXISTS "CHK_sites_sea_cage_location",
        DROP CONSTRAINT IF EXISTS "CHK_sites_monitoring_area_geometry_kind",
        DROP CONSTRAINT IF EXISTS "CHK_sites_monitoring_location_revision",
        DROP CONSTRAINT IF EXISTS "CHK_sites_monitoring_radius",
        DROP COLUMN IF EXISTS "monitoringArea",
        DROP COLUMN IF EXISTS "monitoringRadiusM",
        DROP COLUMN IF EXISTS "monitoringLocationRevision"
    `);
  }
}
