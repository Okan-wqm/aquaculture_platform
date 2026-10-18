import { MigrationInterface, QueryRunner } from 'typeorm';

import { applyTenantRlsToSchema } from '@aquaculture/backend-common';

// SAFE FORM (rls_predicate_not_canonical must not fire): the helper emits the
// canonical predicate, so a migration that calls it is canonical by construction.
export class CanonicalTenantRls1900000000003 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await applyTenantRlsToSchema(queryRunner, { schema: 'farm', tenantIdColumns: ['tenant_id'] });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation_policy ON ponds`);
  }
}
