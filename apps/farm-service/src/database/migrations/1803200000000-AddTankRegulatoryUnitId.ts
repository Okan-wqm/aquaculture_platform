import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddTankRegulatoryUnitId1803200000000
 *
 * Optional official regulatory unit id (kar-/merd-nummer) on tanks, reported as
 * `karId` in the settefisk report (RPT-016b). The settefisk assembler prefers
 * this over the internal `code` when set. Partial-unique per tenant: only
 * non-null values must be distinct, so tanks without a regulatory id are
 * unconstrained.
 *
 * Plain additive column on a per-tenant table — blue-green safe (nullable, no
 * backfill). current_schema-relative, idempotent, forward-only.
 */
export class AddTankRegulatoryUnitId1803200000000 implements MigrationInterface {
  name = 'AddTankRegulatoryUnitId1803200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE "tanks"
        ADD COLUMN IF NOT EXISTS "regulatoryUnitId" character varying(50)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tanks_tenant_regulatory_unit"
        ON "tanks" ("tenantId", "regulatoryUnitId")
        WHERE "regulatoryUnitId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_tanks_tenant_regulatory_unit"`);
    await queryRunner.query(`ALTER TABLE "tanks" DROP COLUMN IF EXISTS "regulatoryUnitId"`);
  }
}
