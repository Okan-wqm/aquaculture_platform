import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import {
  buildOutboxDeadLetterIndexDownSql,
  buildOutboxDeadLetterIndexUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'outbox_events is source-schema infrastructure; its dead-letter index must not be cloned into tenant schemas',
})
export class EnsureFarmOutboxDeadLetterIndex1825000000000 implements MigrationInterface {
  name = 'EnsureFarmOutboxDeadLetterIndex1825000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildOutboxDeadLetterIndexUpSql({
      schema: 'farm',
      table: 'outbox_events',
      indexName: 'idx_outbox_events_dead_letter',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildOutboxDeadLetterIndexDownSql({
      schema: 'farm',
      table: 'outbox_events',
      indexName: 'idx_outbox_events_dead_letter',
    })) {
      await queryRunner.query(sql);
    }
  }
}
