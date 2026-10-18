import { MigrationInterface, QueryRunner } from 'typeorm';

// TRUE POSITIVE (rls_predicate_not_canonical): a hand-rolled tenant policy
// that casts the raw GUC through COALESCE and has no bypass clause.
export class InlineTenantPolicy1900000000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ponds ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation_policy ON ponds
        USING ("tenant_id" = COALESCE(current_setting('app.current_tenant', true), '')::uuid);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation_policy ON ponds`);
  }
}
