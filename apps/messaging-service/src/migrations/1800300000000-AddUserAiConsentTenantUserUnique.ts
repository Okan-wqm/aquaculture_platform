import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserAiConsentTenantUserUnique1800300000000
  implements MigrationInterface
{
  name = 'AddUserAiConsentTenantUserUnique1800300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Tenant-relative DDL: migration runners pin search_path to messaging or a tenant schema.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_ai_consent_tenant_user"
        ON user_ai_consents ("tenantId", "userId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_user_ai_consent_tenant_user"
    `);
  }
}
