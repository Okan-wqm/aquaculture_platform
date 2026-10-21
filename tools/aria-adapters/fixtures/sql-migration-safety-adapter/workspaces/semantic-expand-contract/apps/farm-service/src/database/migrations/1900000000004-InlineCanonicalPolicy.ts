import { MigrationInterface, QueryRunner } from 'typeorm';

// SAFE FORM (rls_predicate_not_canonical must not fire): an inline policy that
// spells the canonical predicate exactly — bypass clause, NULLIF, ::uuid and
// the `, true` missing-GUC argument.
export class InlineCanonicalPolicy1900000000004 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE POLICY tenant_isolation_policy ON feed_logs
        USING (
          current_setting('app.bypass_rls', true) = 'on'
          OR "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation_policy ON feed_logs`);
  }
}
