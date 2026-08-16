import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { buildEventDlqDownSql, buildEventDlqUpSql } from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'event_dlq is cross-tenant inbound-delivery infrastructure and must remain visible as one operator-owned shelf',
})
export class CreateNotificationEventDlq1801200000000 implements MigrationInterface {
  readonly name = 'CreateNotificationEventDlq1801200000000';

  private static readonly OPTIONS = {
    schema: 'notification',
    failedAtIndexName: 'idx_notification_event_dlq_failed_at',
    tenantIndexName: 'idx_notification_event_dlq_tenant',
  } as const;

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildEventDlqUpSql(CreateNotificationEventDlq1801200000000.OPTIONS)) {
      await queryRunner.query(sql);
    }
  }

  async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `SELECT to_regclass('notification.event_dlq') IS NOT NULL AS ok`,
    );
    return rows[0]?.ok === true;
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildEventDlqDownSql(CreateNotificationEventDlq1801200000000.OPTIONS)) {
      await queryRunner.query(sql);
    }
  }
}
