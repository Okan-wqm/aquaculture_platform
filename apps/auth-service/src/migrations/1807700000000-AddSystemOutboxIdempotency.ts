import {
  pinSearchPath,
  SourceOnlyMigration,
  withDdlSafety,
} from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

import { dropConcurrentIndex, ensureConcurrentBtreeIndex } from './support/concurrent-index';

const SYSTEM_OUTBOX_INDEX = {
  schema: 'auth',
  table: 'auth_outbox',
  name: 'idx_auth_outbox_system_idempotency',
  columns: ['idempotencyKey'],
  unique: true,
  predicate: '"tenantId" IS NULL AND "idempotencyKey" IS NOT NULL',
} as const;

/**
 * Preserve idempotent delivery for explicitly system-routed auth outbox rows.
 * PostgreSQL's ordinary composite UNIQUE index treats NULL tenant identifiers
 * as distinct, so it cannot deduplicate platform events. The narrow partial
 * index covers only NULL-tenant rows and leaves tenant-scoped ownership intact.
 */
@SourceOnlyMigration({
  reason: 'auth system outbox idempotency is source-owned infrastructure',
})
export class AddSystemOutboxIdempotency1807700000000 implements MigrationInterface {
  name = 'AddSystemOutboxIdempotency1807700000000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'auth');
    await withDdlSafety(
      queryRunner,
      { schema: 'auth', nonTransactionalDdl: true, advisoryLockKeySuffix: 'auth' },
      async () => {
        await queryRunner.query(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1
              FROM auth.auth_outbox
              WHERE "tenantId" IS NULL AND "idempotencyKey" IS NOT NULL
              GROUP BY "idempotencyKey"
              HAVING COUNT(*) > 1
            ) THEN
              RAISE EXCEPTION USING
                MESSAGE = 'Refusing to enforce system outbox idempotency: duplicate keys exist',
                HINT = 'Investigate auth.auth_outbox NULL-tenant rows before retrying the migration';
            END IF;
          END
          $$
        `);
        await ensureConcurrentBtreeIndex(queryRunner, SYSTEM_OUTBOX_INDEX);
      },
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'auth');
    await withDdlSafety(
      queryRunner,
      { schema: 'auth', nonTransactionalDdl: true, advisoryLockKeySuffix: 'auth' },
      () => dropConcurrentIndex(queryRunner, 'auth', SYSTEM_OUTBOX_INDEX.name),
    );
  }
}
