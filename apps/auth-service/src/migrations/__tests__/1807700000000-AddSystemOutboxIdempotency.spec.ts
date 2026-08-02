import type { QueryRunner } from 'typeorm';

import { AddSystemOutboxIdempotency1807700000000 } from '../1807700000000-AddSystemOutboxIdempotency';

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
                  columns: ['idempotencyKey'],
                  predicate: '("tenantId" IS NULL AND "idempotencyKey" IS NOT NULL)',
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

describe('AddSystemOutboxIdempotency1807700000000', () => {
  it('deduplicates only null-tenant rows with an explicit idempotency key', async () => {
    const { runner, queries } = makeRunner();
    await new AddSystemOutboxIdempotency1807700000000().up(runner);

    const sql = queries.join('\n');
    expect(sql).toContain('HAVING COUNT(*) > 1');
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_auth_outbox_system_idempotency"',
    );
    expect(sql).toContain('ON "auth"."auth_outbox" USING btree ("idempotencyKey")');
    expect(sql).toContain('WHERE "tenantId" IS NULL AND "idempotencyKey" IS NOT NULL');
    expect(new AddSystemOutboxIdempotency1807700000000().transaction).toBe(false);
  });

  it('drops only the system idempotency index on rollback', async () => {
    const { runner, queries } = makeRunner();
    await new AddSystemOutboxIdempotency1807700000000().down(runner);

    expect(queries.join('\n')).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "auth"."idx_auth_outbox_system_idempotency"',
    );
  });
});
