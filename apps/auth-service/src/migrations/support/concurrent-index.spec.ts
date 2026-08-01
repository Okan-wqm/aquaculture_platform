import type { QueryRunner } from 'typeorm';

import {
  type ConcurrentBtreeIndexContract,
  dropConcurrentIndex,
  ensureConcurrentBtreeIndex,
} from './concurrent-index';

interface IndexState {
  columns: Array<string | null>;
  predicate: string | null;
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  hasExpressions: boolean;
  method: string;
}

const CONTRACT: ConcurrentBtreeIndexContract = {
  schema: 'auth',
  table: 'auth_outbox',
  name: 'idx_auth_outbox_system_idempotency',
  columns: ['idempotencyKey'],
  unique: true,
  predicate: '"tenantId" IS NULL AND "idempotencyKey" IS NOT NULL',
};

function exactState(overrides: Partial<IndexState> = {}): IndexState {
  return {
    columns: ['idempotencyKey'],
    predicate: '("tenantId" IS NULL AND "idempotencyKey" IS NOT NULL)',
    isUnique: true,
    isValid: true,
    isReady: true,
    hasExpressions: false,
    method: 'btree',
    ...overrides,
  };
}

function makeRunner(initial: IndexState | null): {
  runner: QueryRunner;
  queries: string[];
  state: { current: IndexState | null };
} {
  const queries: string[] = [];
  const state = { current: initial };
  const runner = {
    isTransactionActive: false,
    query: jest.fn((sql: string): Promise<unknown> => {
      queries.push(sql);
      if (sql.includes('FROM pg_class index_class')) {
        return Promise.resolve(state.current ? [state.current] : []);
      }
      if (sql.startsWith('DROP INDEX CONCURRENTLY')) {
        state.current = null;
      }
      if (sql.startsWith('CREATE UNIQUE INDEX CONCURRENTLY')) {
        state.current = exactState();
      }
      return Promise.resolve(undefined);
    }),
  } as never;
  return { runner, queries, state };
}

describe('concurrent index migration authority', () => {
  it('creates and verifies an absent index using replay-safe non-blocking DDL', async () => {
    const { runner, queries } = makeRunner(null);

    await ensureConcurrentBtreeIndex(runner, CONTRACT);

    expect(queries.join('\n')).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_auth_outbox_system_idempotency"',
    );
    expect(queries.filter((sql) => sql.includes('FROM pg_class index_class'))).toHaveLength(2);
  });

  it('keeps an exact valid index without rebuilding it', async () => {
    const { runner, queries } = makeRunner(exactState());

    await ensureConcurrentBtreeIndex(runner, CONTRACT);

    expect(queries.some((sql) => sql.startsWith('CREATE'))).toBe(false);
    expect(queries.some((sql) => sql.startsWith('DROP'))).toBe(false);
  });

  it('rebuilds an exact interrupted index before verifying the final catalog', async () => {
    const { runner, queries, state } = makeRunner(exactState({ isValid: false, isReady: false }));

    await ensureConcurrentBtreeIndex(runner, CONTRACT);

    expect(queries.some((sql) => sql.startsWith('DROP INDEX CONCURRENTLY'))).toBe(true);
    expect(queries.some((sql) => sql.startsWith('CREATE UNIQUE INDEX CONCURRENTLY'))).toBe(true);
    expect(state.current).toEqual(exactState());
  });

  it('fails closed on a same-name index with a different contract', async () => {
    const { runner, queries } = makeRunner(exactState({ columns: ['tenantId'] }));

    await expect(ensureConcurrentBtreeIndex(runner, CONTRACT)).rejects.toThrow(
      'schema drift; refusing to replace it',
    );
    expect(queries.some((sql) => sql.startsWith('CREATE'))).toBe(false);
    expect(queries.some((sql) => sql.startsWith('DROP'))).toBe(false);
  });

  it('rejects transactional execution and unsafe contract input', async () => {
    const { runner } = makeRunner(null);
    Object.defineProperty(runner, 'isTransactionActive', { value: true });
    await expect(ensureConcurrentBtreeIndex(runner, CONTRACT)).rejects.toThrow(
      'requires transaction=false',
    );

    const { runner: safeRunner } = makeRunner(null);
    await expect(
      ensureConcurrentBtreeIndex(safeRunner, { ...CONTRACT, table: 'auth_outbox; DROP' }),
    ).rejects.toThrow('Unsafe table');
  });

  it('drops an owned index concurrently and idempotently', async () => {
    const { runner, queries } = makeRunner(exactState());

    await dropConcurrentIndex(runner, 'auth', CONTRACT.name);

    expect(queries).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "auth"."idx_auth_outbox_system_idempotency"',
    );
  });
});
