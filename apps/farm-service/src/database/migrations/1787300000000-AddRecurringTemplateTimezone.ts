import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddRecurringTemplateTimezone
 * ============================================================================
 *
 * Phase 5.5 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 15-B13.
 *
 * Adds `timezone VARCHAR(64)` to `farm.recurring_templates` so
 * RecurringTaskService can compute `nextGeneration` + `dueDate` in
 * the template's local timezone rather than the host server's
 * wall-clock. Before this column, a template authored in
 * Europe/Istanbul on a container running UTC produced next-generation
 * timestamps offset by 3 hours during winter and 3 hours during
 * summer — operators experienced "task arrives 3 hours after I
 * expected" which accumulated missed deadlines.
 *
 * The column is nullable. Rows that predate this migration keep
 * the legacy server-local behaviour until the operator re-saves the
 * template (which stamps the site's timezone onto the row). The
 * service's `resolveTimezone()` helper falls back to UTC for null
 * values with a debug-level log rather than the previous silent
 * host-local default.
 */
export class AddRecurringTemplateTimezone1787300000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.recurring_templates
      ADD COLUMN IF NOT EXISTS "timezone" VARCHAR(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm.recurring_templates
      DROP COLUMN IF EXISTS "timezone"
    `);
  }
}
