import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DBR-HIGH-002 / DBR-HIGH-003
 *
 * The tenant row is the identity SSoT. Users, refresh tokens, and invitations
 * must have database-backed tenant referential integrity, and tenant lifecycle
 * values must be constrained to the canonical event-contract enums.
 */
export class TenantIntegrityConstraints1801200000000
  implements MigrationInterface
{
  name = 'TenantIntegrityConstraints1801200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await this.addTenantCheckConstraints(queryRunner);
    await this.assertNoTenantOrphans(queryRunner, 'users', 'tenantId');
    await this.assertNoTenantOrphans(queryRunner, 'refresh_tokens', 'tenantId');
    await this.assertNoTenantOrphans(queryRunner, 'invitations', 'tenantId');

    await this.addForeignKey(
      queryRunner,
      'users',
      'fk_auth_users_tenant',
      'tenantId',
      'SET NULL',
    );
    await this.addForeignKey(
      queryRunner,
      'refresh_tokens',
      'fk_auth_refresh_tokens_tenant',
      'tenantId',
      'SET NULL',
    );
    await this.addForeignKey(
      queryRunner,
      'invitations',
      'fk_auth_invitations_tenant',
      'tenantId',
      'RESTRICT',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await this.dropForeignKey(queryRunner, 'invitations', 'fk_auth_invitations_tenant');
    await this.dropForeignKey(queryRunner, 'refresh_tokens', 'fk_auth_refresh_tokens_tenant');
    await this.dropForeignKey(queryRunner, 'users', 'fk_auth_users_tenant');

    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" DROP CONSTRAINT IF EXISTS "chk_auth_tenants_plan"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth"."tenants" DROP CONSTRAINT IF EXISTS "chk_auth_tenants_status"`,
    );
  }

  private async addTenantCheckConstraints(queryRunner: QueryRunner): Promise<void> {
    await this.addTenantCheck(
      queryRunner,
      'chk_auth_tenants_status',
      `"status" IN ('PENDING', 'PROVISIONING', 'PROVISIONING_FAILED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'CANCELLED', 'ARCHIVED', 'PURGED')`,
    );
    await this.addTenantCheck(
      queryRunner,
      'chk_auth_tenants_plan',
      `"plan" IN ('free', 'trial', 'starter', 'professional', 'enterprise')`,
    );
  }

  private async addTenantCheck(
    queryRunner: QueryRunner,
    constraintName: string,
    expression: string,
  ): Promise<void> {
    this.assertSafeIdentifier(constraintName);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('auth.tenants') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM pg_constraint
              WHERE conrelid = 'auth.tenants'::regclass
                AND conname = '${constraintName}'
           )
        THEN
          ALTER TABLE "auth"."tenants"
            ADD CONSTRAINT "${constraintName}" CHECK (${expression}) NOT VALID;
          ALTER TABLE "auth"."tenants"
            VALIDATE CONSTRAINT "${constraintName}";
        END IF;
      END
      $$;
    `);
  }

  private async assertNoTenantOrphans(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<void> {
    this.assertSafeIdentifier(table);
    this.assertSafeIdentifier(column);

    await queryRunner.query(`
      DO $$
      DECLARE orphan_count int;
      BEGIN
        IF to_regclass('auth.${table}') IS NULL THEN
          RETURN;
        END IF;

        EXECUTE '
          SELECT count(*)::int
            FROM "auth"."${table}" child
            LEFT JOIN "auth"."tenants" tenant
              ON tenant."id" = child."${column}"
           WHERE child."${column}" IS NOT NULL
             AND tenant."id" IS NULL'
          INTO orphan_count;

        IF orphan_count > 0 THEN
          RAISE EXCEPTION 'Cannot add auth.%.% tenant FK: % orphan row(s) exist',
            '${table}', '${column}', orphan_count;
        END IF;
      END
      $$;
    `);
  }

  private async addForeignKey(
    queryRunner: QueryRunner,
    table: string,
    constraintName: string,
    column: string,
    onDelete: 'RESTRICT' | 'SET NULL',
  ): Promise<void> {
    this.assertSafeIdentifier(table);
    this.assertSafeIdentifier(constraintName);
    this.assertSafeIdentifier(column);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('auth.${table}') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM pg_constraint
              WHERE conrelid = 'auth.${table}'::regclass
                AND conname = '${constraintName}'
           )
        THEN
          ALTER TABLE "auth"."${table}"
            ADD CONSTRAINT "${constraintName}"
            FOREIGN KEY ("${column}")
            REFERENCES "auth"."tenants"("id")
            ON DELETE ${onDelete}
            ON UPDATE NO ACTION
            NOT VALID;
          ALTER TABLE "auth"."${table}"
            VALIDATE CONSTRAINT "${constraintName}";
        END IF;
      END
      $$;
    `);
  }

  private async dropForeignKey(
    queryRunner: QueryRunner,
    table: string,
    constraintName: string,
  ): Promise<void> {
    this.assertSafeIdentifier(table);
    this.assertSafeIdentifier(constraintName);
    await queryRunner.query(
      `ALTER TABLE "auth"."${table}" DROP CONSTRAINT IF EXISTS "${constraintName}"`,
    );
  }

  private assertSafeIdentifier(value: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      throw new Error(`Unsafe auth migration identifier: ${value}`);
    }
  }
}
