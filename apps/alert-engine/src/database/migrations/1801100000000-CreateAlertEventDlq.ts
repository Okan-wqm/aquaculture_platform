import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { buildEventDlqDownSql, buildEventDlqUpSql } from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'event_dlq is cross-tenant inbound-delivery infrastructure and must remain visible as one operator-owned shelf',
})
export class CreateAlertEventDlq1801100000000 implements MigrationInterface {
  readonly name = 'CreateAlertEventDlq1801100000000';

  private static readonly OPTIONS = {
    schema: 'alert',
    failedAtIndexName: 'idx_alert_event_dlq_failed_at',
    tenantIndexName: 'idx_alert_event_dlq_tenant',
  } as const;

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildEventDlqUpSql(CreateAlertEventDlq1801100000000.OPTIONS)) {
      await queryRunner.query(sql);
    }
  }

  async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT to_regclass('alert.event_dlq') IS NOT NULL AS ok`,
    );
    return rows[0]?.ok === true;
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildEventDlqDownSql(CreateAlertEventDlq1801100000000.OPTIONS)) {
      await queryRunner.query(sql);
    }
  }
}
