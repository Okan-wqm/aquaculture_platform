import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AdminIpColumnsToInet — an IP address becomes an IP address (ADMIN-HIGH-012).
 *
 * WHY: four security columns hold client IPs in `character varying(45)`. 45 is
 * the length of the longest IPv6 text form, which is the giveaway — the column
 * was sized for an address and then typed as text, so it accepts anything that
 * fits. `inet` validates on write, normalises `::ffff:192.0.2.1` and
 * `192.0.2.1` to comparable values, sorts correctly, and supports the subnet
 * operators (`<<=`, `>>`) that any real "is this address in the attacker's
 * range" query needs. Against a varchar, all of that is string matching.
 *
 * Template: `.archive/…-ConvertAuditIpColumnsToInet.ts`.
 *
 * # The placeholder this exposed
 *
 * The W5 security projection wrote `event.ip ?? 'unknown'` into all four
 * columns, and `'unknown'` is not an address. That is the defect this type
 * catches, and it is a fair illustration of the finding: a `varchar(45)` will
 * hold the word "unknown" forever and every `WHERE "ipAddress" = $1` will
 * quietly not match it.
 *
 * The columns therefore become NULLABLE inet, and the projection passes the
 * absent value through as absent. A missing IP is missing; the alternative is
 * a fabricated one, which is the thing this audit exists to remove. The
 * placeholder rows are converted to NULL by name below rather than being
 * counted as offenders, because they are a known filler with a known meaning.
 *
 * # Why the guard
 *
 * Anything OTHER than the known placeholders is a value nobody predicted, and
 * casting it blindly fails mid-deploy with `invalid input syntax for type
 * inet`. The count-and-RAISE reports table, column and count so the deploy
 * stops on a sentence an operator can act on.
 *
 * Closes: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-012
 */

const IP_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'activity_logs', column: 'ipAddress' },
  { table: 'api_usage_logs', column: 'ipAddress' },
  { table: 'login_attempts', column: 'ipAddress' },
  { table: 'security_events', column: 'ipAddress' },
];

/** Fillers that meant "no address"; they become NULL, which also means it. */
const PLACEHOLDERS = ['unknown', '', '-', 'n/a'];

export class AdminIpColumnsToInet1810000000000 implements MigrationInterface {
  name = 'AdminIpColumnsToInet1810000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '10s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    const placeholderList = PLACEHOLDERS.map((value) => `'${value}'`).join(', ');

    for (const { table, column } of IP_COLUMNS) {
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
              AND data_type <> 'inet'
          ) THEN
            RETURN;
          END IF;

          -- The column must accept the absence it already contains.
          EXECUTE format('ALTER TABLE admin.%I ALTER COLUMN %I DROP NOT NULL', '${table}', '${column}');

          EXECUTE format(
            'UPDATE admin.%I SET %I = NULL WHERE %I IN (${placeholderList})',
            '${table}', '${column}', '${column}'
          );

          EXECUTE format(
            'SELECT count(*) FROM admin.%I WHERE %I IS NOT NULL AND %I !~ ''^[0-9a-fA-F:.\\/]+$''',
            '${table}', '${column}', '${column}'
          ) INTO bad_rows;

          IF bad_rows > 0 THEN
            RAISE EXCEPTION
              'admin.%.% holds % row(s) that are neither an address nor a known placeholder. Inspect them before converting — do NOT cast blindly.',
              '${table}', '${column}', bad_rows;
          END IF;

          EXECUTE format(
            'ALTER TABLE admin.%I ALTER COLUMN %I TYPE inet USING %I::inet',
            '${table}', '${column}', '${column}'
          );
        END $$;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '10s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    // inet -> varchar is total. NOT NULL is NOT restored: the rows that were
    // 'unknown' are NULL now, and re-imposing the constraint would require
    // inventing a placeholder again — which is what the forward step removed.
    for (const { table, column } of IP_COLUMNS) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'admin'
              AND table_name = '${table}'
              AND column_name = '${column}'
              AND data_type = 'inet'
          ) THEN
            EXECUTE format(
              'ALTER TABLE admin.%I ALTER COLUMN %I TYPE character varying(45) USING host(%I)',
              '${table}', '${column}', '${column}'
            );
          END IF;
        END $$;
      `);
    }
  }
}
