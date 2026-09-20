import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restores the `feeding_record_attribution_quarantine` template in the farm
 * SOURCE schema.
 *
 * WHY: BackfillFeedingRecordBatchLocationAttribution1808700000000 is recorded
 * as applied in `farm.migrations`, the tenant clone exists in
 * `tenant_7f6b08ab90e246d3`, but the source-schema template — the copy every
 * future tenant is provisioned from and the one the SchemaDriftValidator checks
 * — does not. db-migrate reported it every run ("Source-schema write guards
 * reconciled … absentTables: [feeding_record_attribution_quarantine]") and
 * carried on; farm-service then refused to boot on
 * `schema.drift.detected … entity declares owned table but DB has no such table
 * in any non-tenant schema` (2026-09-20 outage, FARM-CRITICAL-332).
 *
 * How the template vanished: SourceSchemaBootstrapService, in strict mode,
 * `DROP TABLE … CASCADE`s every source-schema table its OWN image's
 * MODULE_SCHEMAS does not list. On 2026-09-17 locally built farm images from
 * an older branch — whose registry predates the three newest farm tables —
 * were started against this database and reaped them as orphans; the tenant
 * clones survived because the bootstrap reconciles only the source schema.
 * The migration ledger and the schema therefore disagree, and a NEW migration
 * aligns the schema to the ledger (docs/runbooks/schema-drift-response.md,
 * path a); the original migration is immutable.
 *
 * WHAT: the table and its index, UNQUALIFIED and IF NOT EXISTS. This is a
 * per-tenant table (MODULE_SCHEMAS farm.tables), so the migration fans out:
 * the source pass (search_path = farm) creates the template, the tenant pass
 * is a no-op where the clone already exists. DDL copied from 1808700000000 (1)
 * so the template matches the entity and the existing clone exactly.
 */
export class RestoreFeedingAttributionQuarantineTemplate1810400000000
  implements MigrationInterface
{
  name = 'RestoreFeedingAttributionQuarantineTemplate1810400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "feeding_record_attribution_quarantine" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "tenantId" uuid NOT NULL,
         "feedingRecordId" uuid NOT NULL,
         "batchId" uuid NOT NULL,
         "tankId" uuid,
         "feedingDate" date NOT NULL,
         "actualAmount" numeric(10,3) NOT NULL,
         "feedCost" numeric(12,2),
         "currency" varchar(3),
         "feedId" uuid,
         "sourceExecutionId" uuid,
         "reason" varchar(64) NOT NULL,
         "quarantinedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_feeding_record_attribution_quarantine" PRIMARY KEY ("id")
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fraq_tenant_record"
         ON "feeding_record_attribution_quarantine" ("tenantId", "feedingRecordId")`,
    );
  }

  /** The table is resolvable on the schema this pass is pinned to. */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT to_regclass('feeding_record_attribution_quarantine') IS NOT NULL AS ok`,
    );
    return rows[0]?.ok === true;
  }

  /**
   * Nothing to undo: the table belongs to 1808700000000, whose own `down`
   * owns its removal. Reverting a restoration must not drop tenant data.
   */
  public async down(): Promise<void> {
    return Promise.resolve();
  }
}
