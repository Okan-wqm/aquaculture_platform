import { convertAuditColumnsToTimestamptz } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AdminSchemaTimestamptz — every instant in the `admin` schema is an instant
 * (ADMIN-HIGH-012).
 *
 * WHY: 81 live columns across 35 admin tables are
 * `timestamp without time zone`. That type does not identify a moment — it is
 * a wall-clock reading with no origin — so two rows written either side of a
 * DST boundary compare wrongly, and `lastSeenAt`, `expiresAt`, `recordedAt`,
 * `acknowledgedAt`, `terminatedAt`, `firstSeenAt` and the rest are all read as
 * if they were ordered.
 *
 * # This has been fixed before, and the fix was undone
 *
 * `1781900000000-ConvertAuditColumnsToTimestamptz` ran across eight services in
 * 2026 and converted the audit columns. It now sits in `.archive/`, squashed
 * into `1800000000000-Baseline`, and the baseline declares
 * `"createdAt" TIMESTAMP NOT NULL DEFAULT now()` — the pre-fix type.
 *
 * The reason is worth stating plainly, because it is the actual defect: the
 * migration corrected the DATABASE and nobody corrected the ENTITIES. The
 * decorators still said bare `@CreateDateColumn()`, whose Postgres default is
 * `timestamp`, so when the baseline was regenerated from entity metadata it
 * regenerated the bug. auth-service (14 columns) and billing-service (7) show
 * the same reversal today — registered as its own finding, since their DDL is
 * theirs to change.
 *
 * So the durable half of this fix is the DECORATORS, which land in the same
 * commit. This migration only catches up databases that already exist; without
 * the decorators it would be undone by the next squash exactly as its
 * predecessor was.
 *
 * # Why discovery by type, not a column list
 *
 * The helper's original `auditColumns` list is a list, and a list is maintained
 * by whoever remembers it — which is why `expiresAt` and thirty others were
 * never converted in the first place. `columnScope: 'every-timestamp'` drops
 * the name predicate so the type alone decides, and a column added next year is
 * covered without anyone editing a list.
 *
 * # Safety
 *
 * `USING "col" AT TIME ZONE 'UTC'` is a semantic no-op for existing rows: the
 * fleet runs `TZ=UTC`, Node `new Date()` produces UTC instants, and the session
 * `TimeZone` GUC is `UTC` (the helper logs it as a deploy-time audit artefact —
 * an unexpected value is the signal to stop). Discovery filters on the current
 * type, so re-running converts nothing. Each table is rewritten once, not once
 * per column.
 *
 * Closes: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-012
 */
export class AdminSchemaTimestamptz1809800000000 implements MigrationInterface {
  name = 'AdminSchemaTimestamptz1809800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '10s'`);
    // A table rewrite on the larger ledgers takes longer than the 60s the
    // retire migrations use; audit_logs carries seven years of rows.
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    await convertAuditColumnsToTimestamptz(queryRunner, {
      schemaOverride: 'admin',
      columnScope: 'every-timestamp',
    });
  }

  public async down(): Promise<void> {
    // Deliberately not reversed.
    //
    // `revertAuditColumnsToTimestamp` would discover EVERY timestamptz column
    // in the schema, including the ones that were already correct before this
    // migration ran, and demote them — turning a rollback into a wider change
    // than the thing it rolls back. There is also nothing to roll back TO:
    // timestamptz holds strictly more information than timestamp, so the
    // forward direction loses nothing and the reverse discards the offset.
    //
    // A genuine rollback of this migration is a restore, not a demotion.
  }
}
