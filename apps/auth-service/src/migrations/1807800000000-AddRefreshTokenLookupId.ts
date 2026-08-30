import {
  pinSearchPath,
  SourceOnlyMigration,
  withDdlSafety,
} from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

import { dropConcurrentIndex, ensureConcurrentBtreeIndex } from './support/concurrent-index';

const REFRESH_TOKEN_LOOKUP_INDEX = {
  schema: 'auth',
  table: 'refresh_tokens',
  name: 'IDX_refresh_tokens_token_id',
  columns: ['tokenId'],
  unique: true,
  predicate: '"tokenId" IS NOT NULL',
} as const;

/** Indexed non-secret lookup handle for deterministic refresh-token rotation. */
@SourceOnlyMigration({
  reason: 'auth refresh-token lookup identity is source-owned',
})
export class AddRefreshTokenLookupId1807800000000 implements MigrationInterface {
  name = 'AddRefreshTokenLookupId1807800000000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'auth');
    await withDdlSafety(
      queryRunner,
      { schema: 'auth', nonTransactionalDdl: true, advisoryLockKeySuffix: 'auth' },
      async () => {
        await queryRunner.query(
          `ALTER TABLE "auth"."refresh_tokens" ADD COLUMN IF NOT EXISTS "tokenId" uuid NULL`,
        );
        await queryRunner.query(
          `ALTER TABLE "auth"."refresh_tokens" ADD COLUMN IF NOT EXISTS "reuseContainedAt" timestamptz NULL`,
        );
        // ADD COLUMN IF NOT EXISTS is not a schema assertion: a drifted pre-existing
        // column would otherwise be silently accepted. Validate both contracts
        // before the index can become an authorization lookup authority.
        await queryRunner.query(`
          DO $$
          DECLARE
            token_id_type text;
            token_id_not_null boolean;
            reuse_type text;
            reuse_not_null boolean;
          BEGIN
            SELECT format_type(a.atttypid, a.atttypmod), a.attnotnull
              INTO token_id_type, token_id_not_null
              FROM pg_attribute a
              JOIN pg_class t ON t.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'auth'
               AND t.relname = 'refresh_tokens'
               AND a.attname = 'tokenId'
               AND a.attnum > 0
               AND NOT a.attisdropped;

            SELECT format_type(a.atttypid, a.atttypmod), a.attnotnull
              INTO reuse_type, reuse_not_null
              FROM pg_attribute a
              JOIN pg_class t ON t.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'auth'
               AND t.relname = 'refresh_tokens'
               AND a.attname = 'reuseContainedAt'
               AND a.attnum > 0
               AND NOT a.attisdropped;

            IF token_id_type IS DISTINCT FROM 'uuid'
               OR token_id_not_null IS DISTINCT FROM false THEN
              RAISE EXCEPTION USING
                ERRCODE = '55000',
                MESSAGE = 'auth.refresh_tokens.tokenId schema drift';
            END IF;
            IF reuse_type IS DISTINCT FROM 'timestamp with time zone'
               OR reuse_not_null IS DISTINCT FROM false THEN
              RAISE EXCEPTION USING
                ERRCODE = '55000',
                MESSAGE = 'auth.refresh_tokens.reuseContainedAt schema drift';
            END IF;
          END
          $$;
        `);
        await ensureConcurrentBtreeIndex(queryRunner, REFRESH_TOKEN_LOOKUP_INDEX);
      },
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'auth');
    await withDdlSafety(
      queryRunner,
      { schema: 'auth', nonTransactionalDdl: true, advisoryLockKeySuffix: 'auth' },
      async () => {
        await dropConcurrentIndex(queryRunner, 'auth', REFRESH_TOKEN_LOOKUP_INDEX.name);
        await queryRunner.query(
          `ALTER TABLE "auth"."refresh_tokens" DROP COLUMN IF EXISTS "reuseContainedAt"`,
        );
        await queryRunner.query(
          `ALTER TABLE "auth"."refresh_tokens" DROP COLUMN IF EXISTS "tokenId"`,
        );
      },
    );
  }
}
