import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import {
  buildOutboxDeadLetterIndexDownSql,
  buildOutboxDeadLetterIndexUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'messaging_outbox is source-schema infrastructure; its dead-letter index must not be cloned into tenant schemas',
})
export class EnsureMessagingOutboxDeadLetterIndex1825000000000 implements MigrationInterface {
  name = 'EnsureMessagingOutboxDeadLetterIndex1825000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildOutboxDeadLetterIndexUpSql({
      schema: 'messaging',
      table: 'messaging_outbox',
      indexName: 'idx_messaging_outbox_dead_letter',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildOutboxDeadLetterIndexDownSql({
      schema: 'messaging',
      table: 'messaging_outbox',
      indexName: 'idx_messaging_outbox_dead_letter',
    })) {
      await queryRunner.query(sql);
    }
  }
}
