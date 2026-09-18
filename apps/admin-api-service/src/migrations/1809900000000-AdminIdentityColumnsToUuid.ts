import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AdminIdentityColumnsToUuid — a tenant id and a user id become uuids
 * (ADMIN-HIGH-012).
 *
 * WHY: 14 columns that hold nothing but `auth.tenants.id` and `auth.users.id`
 * are `character varying(100)`. A varchar accepts `''`, a trimmed id, a
 * truncated one, and an id from a different platform entirely; a `uuid` column
 * accepts a uuid. The type is the cheapest constraint available and admin was
 * not using it, on exactly the columns every tenant-scoped query joins on.
 *
 * Precedent: `1800100000000-AlignAdminTenantColumnsToUuid`.
 *
 * # What is deliberately NOT converted
 *
 * Twelve more columns look like identities and are not: `performedBy`,
 * `createdBy`, `updatedBy` — the actor columns. `users.service.ts:678` writes
 * `performedBy: 'admin-api-service'` and `security-monitoring.service.ts:758`
 * writes `createdBy: 'system'`, both correctly: an audit actor may be a
 * service, and a detector-raised incident has no human author.
 *
 * That is not a uuid problem, it is a missing sum type. An actor is
 * `{ kind: 'user' | 'service', id }`, and forcing it into a uuid column would
 * mean minting a fake uuid for `'system'` — replacing an honest string with a
 * dishonest identifier. Converting one member of the family while leaving its
 * twin would be worse still. The family stays text and is registered as its
 * own finding, with the typed-actor design named.
 *
 * # Why the guard, rather than letting the cast fail
 *
 * `ALTER ... TYPE uuid USING col::uuid` on a column holding one bad row fails
 * mid-deploy with `invalid input syntax for type uuid: "..."` and no indication
 * of which table, how many rows, or whether the value is garbage or a real
 * identifier from somewhere else. The DO block below counts the offenders per
 * column first and RAISES with the table, the column and the count, so the
 * deploy stops on a sentence an operator can act on instead of a cast error.
 *
 * Empty strings are folded to NULL rather than counted as offenders: `''` in a
 * nullable identity column is an absent id spelled badly, and `NULLIF` is the
 * conversion, not a data loss.
 *
 * Closes: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-012
 */

/** Columns that hold a platform uuid and nothing else. */
const IDENTITY_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'activity_logs', column: 'tenantId' },
  { table: 'activity_logs', column: 'userId' },
  { table: 'api_usage_logs', column: 'tenantId' },
  { table: 'api_usage_logs', column: 'userId' },
  { table: 'data_requests', column: 'tenantId' },
  { table: 'data_requests', column: 'assignedTo' },
  { table: 'email_templates', column: 'tenantId' },
  { table: 'login_attempts', column: 'tenantId' },
  { table: 'login_attempts', column: 'userId' },
  { table: 'security_events', column: 'tenantId' },
  { table: 'security_events', column: 'userId' },
  { table: 'security_events', column: 'assignedTo' },
  { table: 'security_events', column: 'resolvedBy' },
  { table: 'slow_query_logs', column: 'userId' },
];

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export class AdminIdentityColumnsToUuid1809900000000 implements MigrationInterface {
  name = 'AdminIdentityColumnsToUuid1809900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '10s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    for (const { table, column } of IDENTITY_COLUMNS) {
      await queryRunner.query(`
        DO $$
        DECLARE
          bad_rows bigint;
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'admin'
              AND table_name = '${table}'
              AND column_name = '${column}'
              AND data_type <> 'uuid'
          ) THEN
            RETURN;
          END IF;

          EXECUTE format(
            'SELECT count(*) FROM admin.%I WHERE %I IS NOT NULL AND %I <> '''' AND %I !~ %L',
            '${table}', '${column}', '${column}', '${column}', '${UUID_PATTERN}'
          ) INTO bad_rows;

          IF bad_rows > 0 THEN
            RAISE EXCEPTION
              'admin.%.% holds % row(s) that are not uuids; this column was assumed to carry only auth ids. Inspect them before converting — do NOT cast blindly.',
              '${table}', '${column}', bad_rows;
          END IF;

          EXECUTE format(
            'ALTER TABLE admin.%I ALTER COLUMN %I TYPE uuid USING NULLIF(%I, '''')::uuid',
            '${table}', '${column}', '${column}'
          );
        END $$;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '10s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    // uuid -> varchar is total: every uuid has a text form. The original widths
    // are restored so a rolled-back schema matches what the baseline declared.
    for (const { table, column } of IDENTITY_COLUMNS) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'admin'
              AND table_name = '${table}'
              AND column_name = '${column}'
              AND data_type = 'uuid'
          ) THEN
            EXECUTE format(
              'ALTER TABLE admin.%I ALTER COLUMN %I TYPE character varying(100) USING %I::text',
              '${table}', '${column}', '${column}'
            );
          END IF;
        END $$;
      `);
    }
  }
}
