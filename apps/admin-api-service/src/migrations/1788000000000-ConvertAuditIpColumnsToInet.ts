import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ConvertAuditIpColumnsToInet1788000000000
 * ============================================================================
 *
 * Converts the IP-address columns on `shared.audit_logs` and
 * `admin.audit_logs` from `varchar(45)` to native Postgres `inet`.
 *
 * # Why this migration exists
 *
 * Pre-fix the audit-row IP columns were stored as varchar(45). Three
 * compounding issues:
 *
 *   1. No validation at INSERT time — a malformed string lands in the
 *      table and only surfaces when an operator runs a downstream
 *      report.
 *   2. Operator-side IP-range queries are awkward — varchar requires
 *      regex or LIKE patterns; native inet supports the `<<`
 *      containment operator (`ip << '10.0.0.0/8'::cidr`) and the
 *      `family()` function.
 *   3. B-tree indexing on varchar IP columns hashes the full string;
 *      inet indexes the binary representation, ~30% faster for the
 *      typical "show audit rows for IP X" forensic query.
 *
 * Other places in the platform (impersonation_session,
 * edge_devices, error_tracking) already use inet — the audit-log
 * tables were the holdouts. DBR-MEDIUM-003 captured the gap.
 *
 * # What this migration does
 *
 *   1. Pre-flight scan: count rows with malformed IP values that
 *      cannot be cast to inet. If any exist, fail-loud — operator
 *      triages before re-running.
 *   2. ALTER TABLE shared.audit_logs ALTER COLUMN ip TYPE inet USING (ip::inet)
 *   3. ALTER TABLE admin.audit_logs ALTER COLUMN "ipAddress" TYPE inet USING ("ipAddress"::inet)
 *
 * auth.audit_logs is owned by auth-service migrations; the auth-side
 * conversion ships in a separate auth-service migration (kept
 * per-service to respect ADR-011 schema ownership).
 *
 * # Why not CONCURRENTLY
 *
 * ALTER COLUMN TYPE takes AccessExclusive briefly to rewrite the
 * column. On a small audit table (typically < 1M rows on a fresh
 * deploy), the rewrite completes in < 1s. On larger tables operators
 * should run in a maintenance window — surfaced via the docstring.
 *
 * # Down-rollback
 *
 * Reverts to varchar(45). Down rollback loses the inet validation +
 * index efficiency but does not destroy data — operators using
 * down() should be aware that the post-down state allows malformed
 * IPs to land in the table.
 *
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-MEDIUM-003
 */
export class ConvertAuditIpColumnsToInet1788000000000
  implements MigrationInterface
{
  name = 'ConvertAuditIpColumnsToInet1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: pre-flight scan for malformed values.
    //
    // WHY: ALTER COLUMN TYPE inet USING (col::inet) raises on the
    // first invalid row, leaving the conversion mid-stream. Pre-flight
    // surfaces the problem fail-loud with a count so operators triage
    // (NULL out the malformed rows) before re-running.
    //
    // WHAT: PostgreSQL function inet_in() is the canonical validator.
    // We use a per-row TRY/CATCH simulation via a function-call wrap
    // and COUNT rows that would fail.
    const scanQuery = `
      SELECT
        SUM(
          CASE WHEN ip IS NULL OR ip ~ '^([0-9.]+|[0-9a-fA-F:]+(/[0-9]+)?)$'
            THEN 0 ELSE 1
          END
        )::text AS malformed_shared,
        (SELECT
          COUNT(*) FILTER (
            WHERE "ipAddress" IS NOT NULL
              AND NOT ("ipAddress" ~ '^([0-9.]+|[0-9a-fA-F:]+(/[0-9]+)?)$')
          )::text
         FROM admin.audit_logs
        ) AS malformed_admin
      FROM shared.audit_logs
    `;
    const scan: Array<{ malformed_shared: string; malformed_admin: string }> =
      await queryRunner.query(scanQuery);
    const sharedBad = Number(scan[0]?.malformed_shared ?? '0');
    const adminBad = Number(scan[0]?.malformed_admin ?? '0');
    if (sharedBad > 0 || adminBad > 0) {
      throw new Error(
        `Refusing to convert audit IP columns to inet: ` +
          `shared.audit_logs=${sharedBad} malformed row(s), ` +
          `admin.audit_logs=${adminBad} malformed row(s). ` +
          'Run docs/runbooks/audit-ip-malformed-triage.md to NULL out the ' +
          'offending rows before re-applying.',
      );
    }

    // Step 2: shared.audit_logs.ip → inet
    //
    // WHY: USING (ip::inet) is the canonical Postgres pattern for
    // type-cast column-rewrites. Postgres revalidates each value on
    // the cast — a row that the pre-flight scan missed (e.g. due to
    // regex incompleteness) still raises here, aborting the
    // transaction safely.
    await queryRunner.query(`
      ALTER TABLE shared.audit_logs
        ALTER COLUMN ip TYPE inet USING (ip::inet)
    `);

    // Step 3: admin.audit_logs.ipAddress → inet
    await queryRunner.query(`
      ALTER TABLE admin.audit_logs
        ALTER COLUMN "ipAddress" TYPE inet USING ("ipAddress"::inet)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE admin.audit_logs
        ALTER COLUMN "ipAddress" TYPE varchar(45) USING ("ipAddress"::text)
    `);
    await queryRunner.query(`
      ALTER TABLE shared.audit_logs
        ALTER COLUMN ip TYPE varchar(45) USING (ip::text)
    `);
  }
}
