import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import {
  buildOutboxDeadLetterIndexDownSql,
  buildOutboxDeadLetterIndexUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'admin_outbox is source-schema infrastructure; its dead-letter index must not be cloned into tenant schemas',
})
export class EnsureAdminOutboxDeadLetterIndex1825000000000 implements MigrationInterface {
  name = 'EnsureAdminOutboxDeadLetterIndex1825000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildOutboxDeadLetterIndexUpSql({
      schema: 'admin',
      table: 'admin_outbox',
      indexName: 'idx_admin_outbox_dead_letter',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildOutboxDeadLetterIndexDownSql({
      schema: 'admin',
      table: 'admin_outbox',
      indexName: 'idx_admin_outbox_dead_letter',
    })) {
      await queryRunner.query(sql);
    }
  }
}
