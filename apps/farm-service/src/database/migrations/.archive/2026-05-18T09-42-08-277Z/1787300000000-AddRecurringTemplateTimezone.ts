import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

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
  private readonly logger = new MigrationLogger(
    'AddRecurringTemplateTimezone1787300000000',
  );

  /**
   * Wave 4-A.2 Dalga 3 bootstrap-restoration guard.
   *
   * `farm.recurring_templates` is created by the source-schema baseline.
   * The hardcoded `farm.` prefix bypasses the runner's search_path
   * pinning so we check `information_schema.tables` with an explicit
   * schema filter rather than the `current_schema()` helper.
   */
  private async hasFarmRecurringTemplates(
    queryRunner: QueryRunner,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'farm'
          AND table_name = 'recurring_templates'
      ) AS exists
    `);
    return rows[0]?.exists === true;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasFarmRecurringTemplates(queryRunner))) {
      this.logger.log(
        'Skipping AddRecurringTemplateTimezone — farm.recurring_templates not present on this DB (installed by sibling baseline migration)',
      );
      return;
    }

    await queryRunner.query(`
      ALTER TABLE farm.recurring_templates
      ADD COLUMN IF NOT EXISTS "timezone" VARCHAR(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasFarmRecurringTemplates(queryRunner))) {
      return;
    }
    await queryRunner.query(`
      ALTER TABLE farm.recurring_templates
      DROP COLUMN IF EXISTS "timezone"
    `);
  }
}
