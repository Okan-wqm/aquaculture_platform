import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ConvertAuthAuditIpToInet1787400000000
 * ============================================================================
 *
 * Converts `auth.audit_logs.ipAddress` from `varchar(45)` to native
 * Postgres `inet`. Sibling to the admin-api migration
 * 1788000000000-ConvertAuditIpColumnsToInet which handles the
 * shared.audit_logs + admin.audit_logs leg.
 *
 * # Why split per-service
 *
 * ADR-011 schema-ownership: each service migrates its own schema.
 * `auth.audit_logs` is owned by auth-service so the conversion ships
 * here; `shared.audit_logs` + `admin.audit_logs` are owned by
 * admin-api-service so its leg ships there.
 *
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-MEDIUM-003
 */
export class ConvertAuthAuditIpToInet1787400000000
  implements MigrationInterface
{
  name = 'ConvertAuthAuditIpToInet1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Idempotency guard — on fresh DBs the Wave 1 baseline migration
    // (1700000000000-CreateInitialSchema) creates auth.audit_logs.ipAddress
    // as `inet` directly, so this migration is a no-op there. The pre-flight
    // regex scan below uses the `~` operator which does not exist for inet
    // (`operator does not exist: inet ~ unknown`), so we MUST short-circuit
    // before attempting to scan when the column is already inet. Legacy DBs
    // (where the column was originally varchar(45)) still hit the scan +
    // ALTER path below.
    const colType: Array<{ data_type: string }> = await queryRunner.query(`
      SELECT data_type
        FROM information_schema.columns
       WHERE table_schema = 'auth'
         AND table_name = 'audit_logs'
         AND column_name = 'ipAddress'
    `);
    const currentType = colType[0]?.data_type;
    if (currentType === 'inet') {
      // Already in target type — Wave 1 baseline path. Skip both the
      // varchar-only regex scan and the ALTER.
      return;
    }

    // Pre-flight scan — fail-loud on malformed values before the
    // type-cast rewrite. See sibling migration docstring for the
    // architectural rationale.
    const scan: Array<{ malformed: string }> = await queryRunner.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE "ipAddress" IS NOT NULL
            AND NOT ("ipAddress" ~ '^([0-9.]+|[0-9a-fA-F:]+(/[0-9]+)?)$')
        )::text AS malformed
      FROM auth.audit_logs
    `);
    const bad = Number(scan[0]?.malformed ?? '0');
    if (bad > 0) {
      throw new Error(
        `Refusing to convert auth.audit_logs.ipAddress to inet: ` +
          `${bad} malformed row(s). ` +
          'Run docs/runbooks/audit-ip-malformed-triage.md to NULL out the ' +
          'offending rows before re-applying.',
      );
    }

    await queryRunner.query(`
      ALTER TABLE auth.audit_logs
        ALTER COLUMN "ipAddress" TYPE inet USING ("ipAddress"::inet)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE auth.audit_logs
        ALTER COLUMN "ipAddress" TYPE varchar(45) USING ("ipAddress"::text)
    `);
  }
}
