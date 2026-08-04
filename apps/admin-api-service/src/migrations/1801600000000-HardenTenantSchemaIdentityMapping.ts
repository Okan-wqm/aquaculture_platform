import { MigrationInterface } from 'typeorm';

interface MigrationSqlRunner {
  query(statement: string): Promise<unknown>;
}

/**
 * The platform tenant worker mapping function is owned by the NOLOGIN
 * db_migrate role rather than the bootstrap superuser. admin.tenant_schemas is
 * created after platform bootstrap on a fresh database, so both the migration
 * authority's read grant and the admin runtime's column-level write envelope
 * must be asserted here, once the authoritative commit ledger exists.
 */
export class HardenTenantSchemaIdentityMapping1801600000000 implements MigrationInterface {
  name = 'HardenTenantSchemaIdentityMapping1801600000000';

  public async up(queryRunner: MigrationSqlRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_admin_tenant_schemas_schema_name"
        ON "admin"."tenant_schemas" ("schemaName")
    `);
    await queryRunner.query(`
      DO $tenant_schema_identity_constraint$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_constraint
          WHERE conname = 'CHK_admin_tenant_schema_identity'
            AND conrelid = 'admin.tenant_schemas'::regclass
        ) THEN
          ALTER TABLE "admin"."tenant_schemas"
            ADD CONSTRAINT "CHK_admin_tenant_schema_identity"
            CHECK (
              "schemaName" =
              'tenant_' || LEFT(REPLACE("tenantId"::text, '-', ''), 16)
            );
        END IF;
      END
      $tenant_schema_identity_constraint$
    `);
    await queryRunner.query('GRANT USAGE ON SCHEMA "admin" TO "db_migrate"');
    await queryRunner.query('GRANT SELECT ON TABLE "admin"."tenant_schemas" TO "db_migrate"');
    await queryRunner.query(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE "admin"."tenant_schemas" FROM "admin_service"',
    );
    await queryRunner.query('GRANT SELECT ON TABLE "admin"."tenant_schemas" TO "admin_service"');
    await queryRunner.query(
      'GRANT UPDATE ("status", "metadata", "updatedAt") ON TABLE "admin"."tenant_schemas" TO "admin_service"',
    );
  }

  public async down(queryRunner: MigrationSqlRunner): Promise<void> {
    await queryRunner.query(
      'REVOKE UPDATE ("status", "metadata", "updatedAt") ON TABLE "admin"."tenant_schemas" FROM "admin_service"',
    );
    await queryRunner.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "admin"."tenant_schemas" TO "admin_service"',
    );
    await queryRunner.query('REVOKE SELECT ON TABLE "admin"."tenant_schemas" FROM "db_migrate"');
    await queryRunner.query('REVOKE USAGE ON SCHEMA "admin" FROM "db_migrate"');
    await queryRunner.query(`
      ALTER TABLE "admin"."tenant_schemas"
        DROP CONSTRAINT IF EXISTS "CHK_admin_tenant_schema_identity"
    `);
    await queryRunner.query('DROP INDEX IF EXISTS "admin"."UQ_admin_tenant_schemas_schema_name"');
  }
}
