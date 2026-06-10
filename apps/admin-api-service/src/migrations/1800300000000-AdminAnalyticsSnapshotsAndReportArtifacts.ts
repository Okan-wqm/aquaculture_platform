import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdminAnalyticsSnapshotsAndReportArtifacts1800300000000
  implements MigrationInterface
{
  name = 'AdminAnalyticsSnapshotsAndReportArtifacts1800300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "admin"."report_executions"
        ADD COLUMN IF NOT EXISTS "artifactObjectKey" VARCHAR(1024) NULL,
        ADD COLUMN IF NOT EXISTS "artifactSha256" VARCHAR(64) NULL,
        ADD COLUMN IF NOT EXISTS "artifactContentType" VARCHAR(100) NULL
    `);

    await queryRunner.query(`
      DELETE FROM "admin"."analytics_snapshots" s
      USING (
        SELECT
          ctid,
          row_number() OVER (
            PARTITION BY "snapshotType", "category", "snapshotDate"
            ORDER BY "createdAt" DESC, "id" DESC
          ) AS rn
        FROM "admin"."analytics_snapshots"
      ) ranked
      WHERE s.ctid = ranked.ctid
      AND ranked.rn > 1
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uk_analytics_snapshots_type_category_date"
        ON "admin"."analytics_snapshots" ("snapshotType", "category", "snapshotDate")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_report_executions_artifact_object_key"
        ON "admin"."report_executions" ("artifactObjectKey")
        WHERE "artifactObjectKey" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "admin"."idx_report_executions_artifact_object_key"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "admin"."uk_analytics_snapshots_type_category_date"
    `);
    await queryRunner.query(`
      ALTER TABLE "admin"."report_executions"
        DROP COLUMN IF EXISTS "artifactContentType",
        DROP COLUMN IF EXISTS "artifactSha256",
        DROP COLUMN IF EXISTS "artifactObjectKey"
    `);
  }
}
