import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import {
  buildOutboxDeadLetterIndexDownSql,
  buildOutboxDeadLetterIndexUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'event_store_outbox is source-schema infrastructure; its dead-letter index must not be cloned into tenant schemas',
})
export class EnsureEventStoreOutboxDeadLetterIndex1825000000000 implements MigrationInterface {
  name = 'EnsureEventStoreOutboxDeadLetterIndex1825000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildOutboxDeadLetterIndexUpSql({
      schema: 'event_store',
      table: 'event_store_outbox',
      indexName: 'idx_event_store_outbox_dead_letter',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildOutboxDeadLetterIndexDownSql({
      schema: 'event_store',
      table: 'event_store_outbox',
      indexName: 'idx_event_store_outbox_dead_letter',
    })) {
      await queryRunner.query(sql);
    }
  }
}
