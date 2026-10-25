import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import {
  buildOutboxDeadLetterIndexDownSql,
  buildOutboxDeadLetterIndexUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'billing_outbox is source-schema infrastructure; its dead-letter index must not be cloned into tenant schemas',
})
export class EnsureBillingOutboxDeadLetterIndex1825000000000 implements MigrationInterface {
  name = 'EnsureBillingOutboxDeadLetterIndex1825000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildOutboxDeadLetterIndexUpSql({
      schema: 'billing',
      table: 'billing_outbox',
      indexName: 'idx_billing_outbox_dead_letter',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildOutboxDeadLetterIndexDownSql({
      schema: 'billing',
      table: 'billing_outbox',
      indexName: 'idx_billing_outbox_dead_letter',
    })) {
      await queryRunner.query(sql);
    }
  }
}
