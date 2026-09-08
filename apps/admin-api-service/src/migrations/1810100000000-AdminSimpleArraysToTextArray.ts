import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AdminSimpleArraysToTextArray — a list becomes a list (ADMIN-HIGH-012).
 *
 * WHY: thirteen admin columns are declared `simple-array`, which is not a
 * Postgres type. TypeORM stores the array as `text` by joining the elements
 * with a comma and reads it back by splitting on a comma. So an element that
 * CONTAINS a comma silently becomes two elements on the next read, and there
 * is no encoding, escape or quoting layer to prevent it — the round trip is
 * lossy by construction.
 *
 * The columns this bites are the ones a human types into: an incident's
 * `affectedSystems`, a threat indicator's `threatTypes`, a compliance
 * request's `dataCategories`, and `tags` on three tables. "Pumps, aerators"
 * is one system with a comma in its name on the way in and two systems on the
 * way out, and nothing anywhere reports that it happened.
 *
 * # This type was already assumed by the code that reads it
 *
 * Two live query paths filter these columns with the Postgres array-overlap
 * operator:
 *
 *     activity-logging.service.ts:594  activity.tags && ARRAY[:...tags]
 *     audit-trail.service.ts:271       log.tags && ARRAY[:...tags]::varchar[]
 *
 * `&&` has no `text` operand form. Against the column as it is declared today
 * Postgres answers `operator does not exist: text && text[]`, so BOTH the
 * activity-log list and the audit-trail list return a 500 the moment a caller
 * passes `?tags=`. The filter was written against the type the column should
 * have had; this migration gives it that type, which is why the fix is the
 * conversion and not a rewrite of the predicate.
 *
 * # Conversion
 *
 * `string_to_array(col, ',')` reproduces exactly what TypeORM's reader already
 * does, so no row changes meaning: a value that was being split into two is
 * still two, and it is now two honestly and permanently. The corruption that
 * already happened is not recoverable — the separator and the datum are the
 * same byte — and this migration does not pretend otherwise. What it stops is
 * the next one.
 *
 * `''` becomes `{}` rather than `{''}`: TypeORM's reader maps the empty string
 * to the empty array, so an empty-array cell must stay an empty array.
 *
 * Pattern already in the repo: `tenant-erasure-operation.entity.ts:39`,
 * `audit.entity.ts:205`.
 *
 * Closes: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-012
 */

/** Columns TypeORM was comma-joining into a `text` cell. */
const ARRAY_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'activity_logs', column: 'tags' },
  { table: 'security_events', column: 'relatedActivityIds' },
  { table: 'security_events', column: 'mitigationActions' },
  { table: 'security_events', column: 'tags' },
  { table: 'security_incidents', column: 'affectedSystems' },
  { table: 'security_incidents', column: 'affectedTenants' },
  { table: 'security_incidents', column: 'teamMembers' },
  { table: 'security_incidents', column: 'relatedSecurityEvents' },
  { table: 'threat_intelligence', column: 'threatTypes' },
  { table: 'threat_intelligence', column: 'tags' },
  { table: 'threat_intelligence', column: 'relatedIndicators' },
  { table: 'data_requests', column: 'dataCategories' },
  { table: 'compliance_reports', column: 'includedTenants' },
];

export class AdminSimpleArraysToTextArray1810100000000 implements MigrationInterface {
  name = 'AdminSimpleArraysToTextArray1810100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '10s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    for (const { table, column } of ARRAY_COLUMNS) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'admin'
              AND table_name = '${table}'
              AND column_name = '${column}'
              AND data_type <> 'ARRAY'
          ) THEN
            RETURN;
          END IF;

          EXECUTE format(
            'ALTER TABLE admin.%I ALTER COLUMN %I TYPE text[] USING CASE'
            ' WHEN %I IS NULL THEN NULL'
            ' WHEN %I = '''' THEN ARRAY[]::text[]'
            ' ELSE string_to_array(%I, '','')'
            ' END',
            '${table}', '${column}', '${column}', '${column}', '${column}'
          );
        END $$;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '10s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    // `array_to_string` is the inverse of the forward step's `string_to_array`
    // for every value the forward step produced. It is NOT an inverse for a
    // value written while the column was `text[]` and containing a comma —
    // rolling back re-enters the ambiguity this migration left. That is a
    // property of the old type, not of this rollback.
    for (const { table, column } of ARRAY_COLUMNS) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'admin'
              AND table_name = '${table}'
              AND column_name = '${column}'
              AND data_type = 'ARRAY'
          ) THEN
            EXECUTE format(
              'ALTER TABLE admin.%I ALTER COLUMN %I TYPE text USING array_to_string(%I, '','')',
              '${table}', '${column}', '${column}'
            );
          END IF;
        END $$;
      `);
    }
  }
}
