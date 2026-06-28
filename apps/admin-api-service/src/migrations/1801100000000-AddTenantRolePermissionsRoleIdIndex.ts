import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ORPHAN-105: add the missing index on auth.tenant_role_permissions(role_id).
 *
 * Token minting JOINs `auth.tenant_role_permissions trp ON ura.role_id = trp.role_id`
 * on every request (token.service.ts). The table was created with only a PK + FK
 * and no index on role_id, so the JOIN seq-scans on each mint. This adds the
 * index. `IF NOT EXISTS` keeps it idempotent / blue-green safe; the table is the
 * admin-api entity surface (auth schema, DDL owned here alongside the table).
 */
export class AddTenantRolePermissionsRoleIdIndex1801100000000
  implements MigrationInterface
{
  name = 'AddTenantRolePermissionsRoleIdIndex1801100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_role_permissions_role_id"
        ON "auth"."tenant_role_permissions" ("role_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "auth"."idx_tenant_role_permissions_role_id"
    `);
  }
}
