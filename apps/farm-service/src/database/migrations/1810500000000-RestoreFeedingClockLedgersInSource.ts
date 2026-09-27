import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restores the two cross-tenant feeding-clock ledgers in the farm SOURCE
 * schema: `farm.tenant_localization` and `farm.feeding_job_runs`.
 *
 * WHY: CreateFeedingClockInfrastructure1809100000000 is recorded as applied in
 * `farm.migrations` — and its postCondition passed when it ran — yet neither
 * table exists in any schema today. farm-service therefore refused to boot on
 * `schema.drift.detected … [farm.tenant_localization] / [farm.feeding_job_runs]
 * entity declares owned table but DB has no such table in any non-tenant
 * schema` (2026-09-20 outage, FARM-CRITICAL-332).
 *
 * How they vanished is NOT established (DATA-HIGH-018): the ledger row
 * exists with a passing postCondition, no db-migrate run since 2026-09-17
 * logged a drop, the applying run's container is gone, and main's
 * SourceSchemaBootstrapService throws on orphans rather than dropping them.
 * Candidates are a source pass that executed under a tenant-first
 * search_path — which is why this restoration names `farm` explicitly — or a
 * manual drop. What IS established is that the ledger and the schema
 * disagree, so a NEW migration aligns the schema to the ledger
 * (docs/runbooks/schema-drift-response.md, path a); the original is immutable.
 *
 * WHAT: the same DDL as 1809100000000, IF NOT EXISTS, and — unlike the
 * original — schema-QUALIFIED: both tables are registered infrastructure
 * (MODULE_SCHEMAS farm.infrastructureTables), never cloned into tenant
 * schemas, so naming `farm` explicitly is legitimate and makes the restoration
 * independent of whatever search_path the session carries. Source-only, so the
 * tenant ledgers record it as skipped.
 */
@SourceOnlyMigration({
  reason:
    'tenant_localization + feeding_job_runs are cross-tenant farm infrastructure ledgers ' +
    '(tenantId-discriminated) and must not be cloned into tenant schemas',
})
export class RestoreFeedingClockLedgersInSource1810500000000 implements MigrationInterface {
  name = 'RestoreFeedingClockLedgersInSource1810500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "farm"."tenant_localization" (
         "tenantId"        uuid PRIMARY KEY,
         "timezone"        varchar(64) NOT NULL DEFAULT 'UTC',
         "locale"          varchar(16),
         "sourceUpdatedAt" TIMESTAMP WITH TIME ZONE,
         "updatedAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
       )`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "farm"."feeding_job_runs" (
         "id"          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
         "tenantId"    uuid NOT NULL,
         "jobName"     varchar(64) NOT NULL,
         "localDate"   date NOT NULL,
         "timezone"    varchar(64) NOT NULL,
         "status"      varchar(16) NOT NULL DEFAULT 'running',
         "attempts"    integer NOT NULL DEFAULT 1,
         "startedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "completedAt" TIMESTAMP WITH TIME ZONE,
         "error"       text,
         CONSTRAINT "CHK_fjr_status" CHECK ("status" IN ('running', 'succeeded', 'failed'))
       )`,
    );
    // Exactly-once-per-local-day claim: the unique index is what the claim hits.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fjr_tenant_job_local_date"
         ON "farm"."feeding_job_runs" ("tenantId", "jobName", "localDate")`,
    );
    // Retention sweep (monthly purge) walks the start timestamp.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fjr_started_at" ON "farm"."feeding_job_runs" ("startedAt")`,
    );
  }

  /** Both ledgers exist in the source schema and the claim's unique index is in place. */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT (
         to_regclass('farm.tenant_localization') IS NOT NULL
         AND to_regclass('farm.feeding_job_runs') IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM pg_indexes
            WHERE schemaname = 'farm' AND indexname = 'UQ_fjr_tenant_job_local_date'
         )
       ) AS ok`,
    );
    return rows[0]?.ok === true;
  }

  /**
   * Nothing to undo: the tables belong to 1809100000000, whose own `down`
   * owns their removal. Reverting a restoration must not drop ledger rows.
   */
  public async down(): Promise<void> {
    return Promise.resolve();
  }
}
