import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireUnexecutedReportSchedule — reset the report-definition scheduling
 * fields nothing ever executed (APA-141).
 *
 * `admin.report_definitions.schedule` and `.recipients` were written by
 * `createDefinition`/`updateDefinition` and read by NOBODY. The only `@Cron` in
 * the analytics module drives the daily snapshot; a repo-wide search for reads
 * of `definition.schedule` / `.recipients` returns the write sites and type
 * declarations only. A definition saved with `schedule='daily'` never ran, and
 * its `recipients` never received anything — a stored promise the platform
 * never kept.
 *
 * The fields are gone from the entity, both controller DTOs and the service
 * API, so with the platform-wide `forbidNonWhitelisted: true` pipe a re-drift
 * now 400s instead of silently writing. This migration brings the DATA into
 * line with that: any row still carrying a schedule other than 'manual', or a
 * non-empty recipient list, is archived and reset to the inert values.
 *
 * # WHY RESET RATHER THAN DROP
 *
 * Dropping the columns is a breaking schema diff and belongs in a CONTRACT-phase
 * migration, which `@ExpandContract` requires to name an already-deployed EXPAND
 * predecessor (`dependsOn` is mandatory for `phase: 'contract'`). A pure
 * retirement has no such predecessor, so the physical drop needs its own
 * expand/contract sequencing and is tracked as PLAT-LOW-903. Resetting is
 * non-breaking, reversible in effect, and removes the misleading DATA now.
 *
 * # SAFETY SHAPE (data-only, idempotent, blue-green safe)
 *   * Archives only rows that actually carry a non-default value, into
 *     `admin.retired_report_schedules`, before resetting them — so the
 *     intent a SUPER_ADMIN once expressed is not silently discarded.
 *   * The UPDATE is guarded on the same predicate, so a re-run is a no-op.
 *   * No column is added, altered or dropped; the previous release keeps
 *     working against unchanged DDL.
 *   * Returns early when the table is absent (fresh DB built past this point).
 *
 * down() restores the archived values, because unlike a fabricated metric these
 * were operator input — wrong to act on, but genuinely expressed.
 */
export class RetireUnexecutedReportSchedule1802300000000 implements MigrationInterface {
  name = 'RetireUnexecutedReportSchedule1802300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tableExists: Array<{ exists: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'admin' AND table_name = 'report_definitions'
      ) AS exists
    `);
    if (!tableExists[0]?.exists) {
      return;
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.retired_report_schedules (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        definition_id   uuid        NOT NULL,
        schedule        varchar(20),
        recipients      jsonb,
        retired_at      timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_retired_report_schedules_definition"
        ON admin.retired_report_schedules (definition_id)
    `);

    await queryRunner.query(`
      INSERT INTO admin.retired_report_schedules (definition_id, schedule, recipients)
      SELECT id, schedule, recipients
      FROM admin.report_definitions
      WHERE schedule IS DISTINCT FROM 'manual'
         OR (recipients IS NOT NULL AND recipients <> '[]'::jsonb)
    `);

    await queryRunner.query(`
      UPDATE admin.report_definitions
      SET schedule = 'manual',
          recipients = NULL
      WHERE schedule IS DISTINCT FROM 'manual'
         OR (recipients IS NOT NULL AND recipients <> '[]'::jsonb)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const archiveExists: Array<{ exists: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'admin' AND table_name = 'retired_report_schedules'
      ) AS exists
    `);
    if (!archiveExists[0]?.exists) {
      return;
    }

    // Operator input, not a fabricated metric — restorable.
    await queryRunner.query(`
      UPDATE admin.report_definitions d
      SET schedule = r.schedule,
          recipients = r.recipients
      FROM admin.retired_report_schedules r
      WHERE r.definition_id = d.id
    `);
  }
}
