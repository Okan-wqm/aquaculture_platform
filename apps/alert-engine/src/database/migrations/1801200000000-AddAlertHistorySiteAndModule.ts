import { addColumnWithIndex, dropColumnWithIndex } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ALERT-MEDIUM-010: `alert_history` gains the site and the module an alarm
 * belongs to, so the tenant console can count and list alarms per module
 * workspace and per site instead of tenant-wide only.
 *
 * # Expand (blue-green safe)
 *
 * Both columns are nullable and have no default: the running release never
 * reads them and keeps inserting without them; the new release stamps them on
 * every alarm it creates. Each column and its index go through the shared
 * addColumnWithIndex (DEBT-2026-05-07-001). Table, index and enum type names
 * are UNQUALIFIED: this migration is replayed into every tenant schema with
 * the search_path pinned to it (the class 1801100000000 documents), so each
 * schema gets its own `alert_history_module_enum`, as a later per-tenant enum
 * column does (hr 1801600000000-AddEmployeeLaborCategory).
 *
 * # Lock discipline (ALERT-MEDIUM-011)
 *
 * DDL only, so the transaction the runner wraps around it is short. ADD
 * COLUMN without a default changes the catalog alone, but it holds ACCESS
 * EXCLUSIVE on the live alarm table until commit, and both index builds run
 * under that lock. `lock_timeout` keeps the migration from queueing behind a
 * long alarm transaction (a waiting ACCESS EXCLUSIVE request blocks every
 * later reader of the table); `statement_timeout` bounds each index build.
 * Either one rolls the whole migration back and stops the deploy with the
 * table as it was. Historic rows are attributed by 1801300000000, which
 * commits batch by batch.
 */
export class AddAlertHistorySiteAndModule1801200000000 implements MigrationInterface {
  name = 'AddAlertHistorySiteAndModule1801200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);
    await queryRunner.query(
      `DO $$ BEGIN
         CREATE TYPE "alert_history_module_enum" AS ENUM('farm', 'sensor', 'hydroponics');
       EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
    await addColumnWithIndex(queryRunner, {
      table: 'alert_history',
      column: 'site_id',
      columnType: 'uuid',
      indexName: 'IDX_alert_history_site_id_triggered_at',
      indexColumns: ['site_id', 'triggered_at'],
    });
    await addColumnWithIndex(queryRunner, {
      table: 'alert_history',
      column: 'module',
      columnType: { enumType: 'alert_history_module_enum' },
      indexName: 'IDX_alert_history_module_triggered_at',
      indexColumns: ['module', 'triggered_at'],
    });
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);
    await dropColumnWithIndex(queryRunner, {
      table: 'alert_history',
      column: 'module',
      indexName: 'IDX_alert_history_module_triggered_at',
    });
    await dropColumnWithIndex(queryRunner, {
      table: 'alert_history',
      column: 'site_id',
      indexName: 'IDX_alert_history_site_id_triggered_at',
    });
    // A tenant provisioned from the source schema after this migration copied
    // its column with the source schema's type; the source's type goes only
    // once no column anywhere still uses it.
    await queryRunner.query(
      `DO $$ BEGIN
         DROP TYPE IF EXISTS "alert_history_module_enum";
       EXCEPTION WHEN dependent_objects_still_exist THEN NULL; END $$;`,
    );
  }
}
