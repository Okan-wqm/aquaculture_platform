import { getMetadataArgsStorage, type QueryRunner } from 'typeorm';

import { RefreshToken } from '../../modules/authentication/entities/refresh-token.entity';
import { AddRefreshTokenLookupId1807800000000 } from '../1807800000000-AddRefreshTokenLookupId';

function makeRunner(): { runner: QueryRunner; queries: string[] } {
  const queries: string[] = [];
  let indexExists = false;
  const runner = {
    isTransactionActive: false,
    query: jest.fn((sql: string): Promise<unknown> => {
      queries.push(sql);
      if (sql.includes('SELECT current_schema()')) {
        return Promise.resolve([{ current_schema: 'auth' }]);
      }
      if (sql.includes('FROM pg_class index_class')) {
        return Promise.resolve(
          indexExists
            ? [
                {
                  columns: ['tokenId'],
                  predicate: '("tokenId" IS NOT NULL)',
                  isUnique: true,
                  isValid: true,
                  isReady: true,
                  hasExpressions: false,
                  method: 'btree',
                },
              ]
            : [],
        );
      }
      if (sql.startsWith('CREATE UNIQUE INDEX CONCURRENTLY')) {
        indexExists = true;
      }
      return Promise.resolve([]);
    }),
  } as never;
  return { runner, queries };
}

describe('AddRefreshTokenLookupId1807800000000', () => {
  it('pins auth, creates the lookup contract, and fails closed on catalog drift', async () => {
    const { runner, queries } = makeRunner();
    await new AddRefreshTokenLookupId1807800000000().up(runner);

    const sql = queries.join('\n');
    expect(sql).toContain('SET search_path TO "auth", public');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "tokenId" uuid NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "reuseContainedAt" timestamptz NULL');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "IDX_refresh_tokens_token_id"',
    );
    expect(sql).toContain('WHERE "tokenId" IS NOT NULL');
    expect(sql).toContain('format_type(a.atttypid, a.atttypmod)');
    expect(sql).toContain("token_id_type IS DISTINCT FROM 'uuid'");
    expect(sql).toContain("reuse_type IS DISTINCT FROM 'timestamp with time zone'");
    expect(sql).toContain('index_state.indisunique AS "isUnique"');
    expect(sql).toContain('index_state.indisvalid AS "isValid"');
    expect(sql).toContain('index_state.indisready AS "isReady"');
    expect(sql).toContain('index_state.indexprs IS NOT NULL AS "hasExpressions"');
    expect(sql).toContain('FROM unnest(index_state.indkey) WITH ORDINALITY');
    expect(new AddRefreshTokenLookupId1807800000000().transaction).toBe(false);

    const createIndexPosition = sql.indexOf(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "IDX_refresh_tokens_token_id"',
    );
    const validateIndexPosition = sql.lastIndexOf('FROM pg_class index_class');
    expect(createIndexPosition).toBeGreaterThan(-1);
    expect(validateIndexPosition).toBeGreaterThan(createIndexPosition);

    expect(queries.filter((query) => query.includes('FROM pg_class index_class'))).toHaveLength(2);
  });

  it('rolls back in dependency order', async () => {
    const { runner, queries } = makeRunner();
    await new AddRefreshTokenLookupId1807800000000().down(runner);

    const sql = queries.join('\n');
    expect(sql.indexOf('DROP INDEX CONCURRENTLY IF EXISTS')).toBeLessThan(
      sql.indexOf('DROP COLUMN IF EXISTS "tokenId"'),
    );
    expect(sql).toContain('DROP COLUMN IF EXISTS "reuseContainedAt"');
  });

  it('keeps entity metadata aligned with the migration', () => {
    const metadata = getMetadataArgsStorage();
    const columns = metadata.columns
      .filter((column) => column.target === RefreshToken)
      .map((column) => column.propertyName);
    const tokenIdIndex = metadata.indices.find(
      (index) => index.target === RefreshToken && index.name === 'IDX_refresh_tokens_token_id',
    );

    expect(columns).toEqual(expect.arrayContaining(['tokenId', 'reuseContainedAt']));
    expect(tokenIdIndex).toEqual(
      expect.objectContaining({ unique: true, where: '"tokenId" IS NOT NULL' }),
    );
  });
});
