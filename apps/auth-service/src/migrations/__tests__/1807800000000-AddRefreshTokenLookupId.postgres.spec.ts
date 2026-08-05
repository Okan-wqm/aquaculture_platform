import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import type { DataSource, QueryRunner } from 'typeorm';

import { AddRefreshTokenLookupId1807800000000 } from '../1807800000000-AddRefreshTokenLookupId';

interface ColumnContractRow {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
}

interface IndexContractRow {
  index_name: string;
  is_unique: boolean;
  is_valid: boolean;
  is_ready: boolean;
  method: string;
  predicate: string | null;
  columns: string[];
}

jest.setTimeout(120_000);

describe('AddRefreshTokenLookupId1807800000000 on real Postgres', () => {
  let harness: HarnessContext | undefined;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await requireAdmin().query('CREATE SCHEMA auth');
    await requireAdmin().query(`
      CREATE TABLE auth.refresh_tokens (
        id uuid PRIMARY KEY,
        token varchar(255) NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await shutdownHarness(harness);
  });

  it('runs up idempotently and establishes the exact column and partial-index catalogs', async () => {
    const migration = new AddRefreshTokenLookupId1807800000000();
    expect(migration.transaction).toBe(false);
    await withQueryRunner(async (queryRunner) => {
      await migration.up(queryRunner);
      await migration.up(queryRunner);
    });

    const columns = await requireAdmin().query<ColumnContractRow[]>(
      `
        SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
         WHERE table_schema = 'auth'
           AND table_name = 'refresh_tokens'
           AND column_name IN ('tokenId', 'reuseContainedAt')
         ORDER BY column_name
      `,
    );
    expect(columns).toEqual([
      {
        column_name: 'reuseContainedAt',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
      },
      { column_name: 'tokenId', data_type: 'uuid', is_nullable: 'YES' },
    ]);

    const indexes = await requireAdmin().query<IndexContractRow[]>(
      `
        SELECT
          idx.relname AS index_name,
          i.indisunique AS is_unique,
          i.indisvalid AS is_valid,
          i.indisready AS is_ready,
          am.amname AS method,
          pg_get_expr(i.indpred, i.indrelid) AS predicate,
          ARRAY(
            SELECT attribute.attname::text
              FROM unnest(i.indkey) WITH ORDINALITY AS keys(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = table_class.oid
               AND attribute.attnum = keys.attnum
             WHERE keys.ordinality <= i.indnkeyatts
             ORDER BY keys.ordinality
          ) AS columns
        FROM pg_class idx
        JOIN pg_namespace index_namespace ON index_namespace.oid = idx.relnamespace
        JOIN pg_index i ON i.indexrelid = idx.oid
        JOIN pg_class table_class ON table_class.oid = i.indrelid
        JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
        JOIN pg_am am ON am.oid = idx.relam
        WHERE index_namespace.nspname = 'auth'
          AND idx.relname = 'IDX_refresh_tokens_token_id'
          AND table_namespace.nspname = 'auth'
          AND table_class.relname = 'refresh_tokens'
      `,
    );
    expect(indexes).toHaveLength(1);
    const index = indexes[0];
    if (!index) {
      throw new Error('IDX_refresh_tokens_token_id was not created');
    }
    expect(index).toMatchObject({
      index_name: 'IDX_refresh_tokens_token_id',
      is_unique: true,
      is_valid: true,
      is_ready: true,
      method: 'btree',
      columns: ['tokenId'],
    });
    expect(index.predicate?.replace(/[\s()"]+/gu, '')).toBe('tokenIdISNOTNULL');
  });

  function requireAdmin(): DataSource {
    if (!harness) {
      throw new Error('Postgres harness is unavailable');
    }
    return harness.dataSource;
  }

  async function withQueryRunner(
    operation: (queryRunner: QueryRunner) => Promise<void>,
  ): Promise<void> {
    const queryRunner = requireAdmin().createQueryRunner();
    await queryRunner.connect();
    try {
      await operation(queryRunner);
    } finally {
      await queryRunner.release();
    }
  }
});
