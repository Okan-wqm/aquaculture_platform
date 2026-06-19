import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DBR-CRITICAL-002 / DBR-HIGH-001
 *
 * Admin security evidence columns must be timezone-unambiguous and compliance
 * workflow states must be database-constrained, not TypeScript-only.
 */
export class AdminSecurityTimestamptzAndChecks1800700000000
  implements MigrationInterface
{
  name = 'AdminSecurityTimestamptzAndChecks1800700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await this.convertColumnToTimestamptz(queryRunner, 'impersonation_sessions', 'expiresAt');
    await this.convertColumnToTimestamptz(queryRunner, 'impersonation_sessions', 'endedAt');
    await this.convertColumnToTimestamptz(queryRunner, 'impersonation_sessions', 'createdAt');
    await this.convertColumnToTimestamptz(queryRunner, 'impersonation_sessions', 'updatedAt');

    await this.convertColumnToTimestamptz(queryRunner, 'impersonation_permissions', 'grantedAt');
    await this.convertColumnToTimestamptz(queryRunner, 'impersonation_permissions', 'expiresAt');
    await this.convertColumnToTimestamptz(queryRunner, 'impersonation_permissions', 'createdAt');
    await this.convertColumnToTimestamptz(queryRunner, 'impersonation_permissions', 'updatedAt');

    await this.convertColumnToTimestamptz(queryRunner, 'data_requests', 'createdAt');
    await this.convertColumnToTimestamptz(queryRunner, 'data_requests', 'updatedAt');

    await this.addCheck(
      queryRunner,
      'chk_admin_data_requests_request_type',
      `"requestType" IN ('access', 'deletion', 'portability', 'rectification', 'restriction')`,
    );
    await this.addCheck(
      queryRunner,
      'chk_admin_data_requests_status',
      `"status" IN ('pending', 'in_progress', 'completed', 'rejected', 'expired')`,
    );
    await this.addCheck(
      queryRunner,
      'chk_admin_data_requests_compliance_framework',
      `"complianceFramework" IN ('gdpr', 'ccpa', 'hipaa', 'pci_dss', 'sox', 'iso27001')`,
    );
    await this.addCheck(
      queryRunner,
      'chk_admin_data_requests_delivery_format',
      `"deliveryFormat" IS NULL OR "deliveryFormat" IN ('json', 'csv', 'pdf', 'xml')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await this.dropCheck(queryRunner, 'chk_admin_data_requests_delivery_format');
    await this.dropCheck(queryRunner, 'chk_admin_data_requests_compliance_framework');
    await this.dropCheck(queryRunner, 'chk_admin_data_requests_status');
    await this.dropCheck(queryRunner, 'chk_admin_data_requests_request_type');

    await this.convertColumnToTimestamp(queryRunner, 'data_requests', 'updatedAt');
    await this.convertColumnToTimestamp(queryRunner, 'data_requests', 'createdAt');

    await this.convertColumnToTimestamp(queryRunner, 'impersonation_permissions', 'updatedAt');
    await this.convertColumnToTimestamp(queryRunner, 'impersonation_permissions', 'createdAt');
    await this.convertColumnToTimestamp(queryRunner, 'impersonation_permissions', 'expiresAt');
    await this.convertColumnToTimestamp(queryRunner, 'impersonation_permissions', 'grantedAt');

    await this.convertColumnToTimestamp(queryRunner, 'impersonation_sessions', 'updatedAt');
    await this.convertColumnToTimestamp(queryRunner, 'impersonation_sessions', 'createdAt');
    await this.convertColumnToTimestamp(queryRunner, 'impersonation_sessions', 'endedAt');
    await this.convertColumnToTimestamp(queryRunner, 'impersonation_sessions', 'expiresAt');
  }

  private async convertColumnToTimestamptz(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<void> {
    this.assertSafeIdentifier(table);
    this.assertSafeIdentifier(column);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'admin'
             AND table_name = '${table}'
             AND column_name = '${column}'
             AND data_type = 'timestamp without time zone'
        ) THEN
          EXECUTE 'ALTER TABLE "admin"."${table}" ALTER COLUMN "${column}" TYPE timestamptz USING "${column}" AT TIME ZONE ''UTC''';
        END IF;
      END
      $$;
    `);
  }

  private async convertColumnToTimestamp(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<void> {
    this.assertSafeIdentifier(table);
    this.assertSafeIdentifier(column);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'admin'
             AND table_name = '${table}'
             AND column_name = '${column}'
             AND data_type = 'timestamp with time zone'
        ) THEN
          EXECUTE 'ALTER TABLE "admin"."${table}" ALTER COLUMN "${column}" TYPE timestamp USING "${column}" AT TIME ZONE ''UTC''';
        END IF;
      END
      $$;
    `);
  }

  private async addCheck(
    queryRunner: QueryRunner,
    constraintName: string,
    expression: string,
  ): Promise<void> {
    this.assertSafeIdentifier(constraintName);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('admin.data_requests') IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM pg_constraint
              WHERE conrelid = 'admin.data_requests'::regclass
                AND conname = '${constraintName}'
           )
        THEN
          ALTER TABLE "admin"."data_requests"
            ADD CONSTRAINT "${constraintName}" CHECK (${expression}) NOT VALID;
          ALTER TABLE "admin"."data_requests"
            VALIDATE CONSTRAINT "${constraintName}";
        END IF;
      END
      $$;
    `);
  }

  private async dropCheck(
    queryRunner: QueryRunner,
    constraintName: string,
  ): Promise<void> {
    this.assertSafeIdentifier(constraintName);
    await queryRunner.query(
      `ALTER TABLE "admin"."data_requests" DROP CONSTRAINT IF EXISTS "${constraintName}"`,
    );
  }

  private assertSafeIdentifier(value: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      throw new Error(`Unsafe admin migration identifier: ${value}`);
    }
  }
}
