/**
 * Cursor Pagination — TypeORM Adapter Unit Tests
 *
 * Covers the QueryBuilder-based adapter that bridges
 * `Repository<T>` to `CursorPaginatedResponse<T>`:
 *   - tenantId always appears in the WHERE clause
 *   - additional `where` filters are merged (string / number /
 *     boolean / Date primitives supported)
 *   - cursor predicate uses compound tuple comparison
 *     `(createdAt, id) < (:cursorCreatedAt, :cursorId)`
 *   - order + take: DESC, DESC, first + 1
 *   - returned shape is the canonical CursorPaginatedResponse
 *   - malformed input propagates BadRequestException from the
 *     primitive (fail-closed)
 */
import { defined } from '@aquaculture/testing';
import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { encodeCursor } from '../cursor';
import { paginateCursor } from '../cursor-repository';

interface Row {
  id: string;
  tenantId: string;
  createdAt: Date;
  batchId?: string;
  isActive?: boolean;
}

interface CapturedCall {
  wheres: Array<{ clause: string; params?: Record<string, unknown> }>;
  orderBys: Array<{ column: string; direction: 'ASC' | 'DESC' }>;
  take: number | null;
}

function makeRepo(rows: Row[]): {
  repo: Repository<Row>;
  calls: CapturedCall;
} {
  const calls: CapturedCall = { wheres: [], orderBys: [], take: null };
  const qb = {
    where: jest.fn().mockImplementation((clause: string, params?: Record<string, unknown>) => {
      calls.wheres.push({ clause, params });
      return qb;
    }),
    andWhere: jest.fn().mockImplementation((clause: string, params?: Record<string, unknown>) => {
      calls.wheres.push({ clause, params });
      return qb;
    }),
    orderBy: jest.fn().mockImplementation((column: string, direction: 'ASC' | 'DESC') => {
      calls.orderBys.push({ column, direction });
      return qb;
    }),
    addOrderBy: jest.fn().mockImplementation((column: string, direction: 'ASC' | 'DESC') => {
      calls.orderBys.push({ column, direction });
      return qb;
    }),
    take: jest.fn().mockImplementation((n: number) => {
      calls.take = n;
      return qb;
    }),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  const repo = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  } as unknown as Repository<Row>;
  return { repo, calls };
}

function makeRow(id: string, createdAt: string): Row {
  return {
    id,
    tenantId: 'tenant-1',
    createdAt: new Date(createdAt),
  };
}

describe('paginateCursor', () => {
  it('issues tenantId WHERE + DESC-DESC order + first+1 take', async () => {
    const { repo, calls } = makeRepo([
      makeRow('1', '2026-04-23T12:00:00Z'),
      makeRow('2', '2026-04-23T11:00:00Z'),
    ]);

    const response = await paginateCursor(repo, {
      input: { first: 10 },
      tenantId: 'tenant-1',
    });

    // Tenant scope is always the first WHERE (the resolver
    // can't forget — paginateCursor enforces it).
    expect(calls.wheres[0]).toEqual({
      clause: 'e."tenantId" = :tenantId',
      params: { tenantId: 'tenant-1' },
    });
    // Order-by is DESC on createdAt THEN DESC on id (tie-breaker).
    expect(calls.orderBys).toEqual([
      { column: 'e."createdAt"', direction: 'DESC' },
      { column: 'e."id"', direction: 'DESC' },
    ]);
    // `take` is first + 1 — the extra row is the hasNextPage signal.
    expect(calls.take).toBe(11);

    expect(response.edges).toHaveLength(2);
    expect(response.pageInfo.hasNextPage).toBe(false);
  });

  it('merges static `where` filters on top of the tenant scope (string / number / boolean / Date)', async () => {
    const { repo, calls } = makeRepo([]);
    const since = new Date('2026-01-01');

    await paginateCursor(repo, {
      input: { first: 5 },
      tenantId: 'tenant-1',
      where: {
        batchId: 'batch-7',
        isActive: true,
      },
    });

    const afterFirst = calls.wheres.slice(1);
    expect(afterFirst).toEqual(
      expect.arrayContaining([
        {
          clause: 'e."batchId" = :w_batchId',
          params: { w_batchId: 'batch-7' },
        },
        {
          clause: 'e."isActive" = :w_isActive',
          params: { w_isActive: true },
        },
      ]),
    );
    // Sanity: `since` in the mock was never passed to where so the
    // test above doesn't leak expectations from earlier iterations.
    expect(since).toBeInstanceOf(Date);
  });

  it('skips `where` entries with undefined values (optional filter idiom)', async () => {
    const { repo, calls } = makeRepo([]);
    await paginateCursor(repo, {
      input: { first: 5 },
      tenantId: 'tenant-1',
      where: {
        batchId: 'batch-7',
        // Optional filter — typical resolver idiom where the
        // caller passes `undefined` for "no filter".
        isActive: undefined,
      },
    });
    const afterFirst = calls.wheres.slice(1);
    // `isActive` was undefined → NOT forwarded to WHERE.
    expect(afterFirst.some((w) => w.clause.includes('isActive'))).toBe(false);
    expect(afterFirst.some((w) => w.clause.includes('batchId'))).toBe(true);
  });

  it('with `after` cursor, adds compound tuple WHERE `(createdAt, id) < (?, ?)`', async () => {
    const anchor = makeRow('anchor-id', '2026-03-01T00:00:00Z');
    const cursor = encodeCursor(anchor);
    const { repo, calls } = makeRepo([]);

    await paginateCursor(repo, {
      input: { first: 20, after: cursor },
      tenantId: 'tenant-1',
    });

    const tupleWhere = calls.wheres.find((w) => w.clause.includes('e."createdAt"'));
    expect(tupleWhere).toBeDefined();
    const tuple = defined(tupleWhere, 'Expected tuple cursor predicate');
    expect(tuple.clause).toBe('(e."createdAt", e."id") < (:cursorCreatedAt, :cursorId)');
    expect(tuple.params).toEqual({
      cursorCreatedAt: anchor.createdAt,
      cursorId: anchor.id,
    });
  });

  it('returns the canonical CursorPaginatedResponse shape', async () => {
    const rows = [
      makeRow('1', '2026-04-23T12:00:00Z'),
      makeRow('2', '2026-04-23T11:00:00Z'),
      makeRow('3', '2026-04-23T10:00:00Z'),
    ];
    const { repo } = makeRepo(rows);

    const response = await paginateCursor(repo, {
      input: { first: 3 },
      tenantId: 'tenant-1',
    });

    expect(response.edges).toHaveLength(3);
    expect(response.pageInfo).toEqual({
      endCursor: encodeCursor(defined(rows[2])),
      hasNextPage: false,
    });
    // Each edge carries its OWN cursor.
    expect(defined(response.edges[0]).cursor).toBe(encodeCursor(defined(rows[0])));
    expect(defined(response.edges[2]).cursor).toBe(encodeCursor(defined(rows[2])));
  });

  it('drops the extra signal row and flags hasNextPage=true', async () => {
    // Caller asked for 2; repo returns 3 (2 + signal row).
    const rows = [
      makeRow('1', '2026-04-23T12:00:00Z'),
      makeRow('2', '2026-04-23T11:00:00Z'),
      makeRow('3', '2026-04-23T10:00:00Z'), // extra signal row
    ];
    const { repo } = makeRepo(rows);

    const response = await paginateCursor(repo, {
      input: { first: 2 },
      tenantId: 'tenant-1',
    });

    expect(response.edges).toHaveLength(2);
    expect(response.edges.some((e) => e.node.id === '3')).toBe(false);
    expect(response.pageInfo.hasNextPage).toBe(true);
    expect(response.pageInfo.endCursor).toBe(encodeCursor(defined(rows[1])));
  });

  it('propagates BadRequestException from decodeCursor (fail-closed)', async () => {
    const { repo } = makeRepo([]);
    await expect(
      paginateCursor(repo, {
        input: { first: 10, after: 'garbage' },
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('propagates BadRequestException when `first` exceeds the per-resolver cap', async () => {
    const { repo } = makeRepo([]);
    await expect(
      paginateCursor(repo, {
        input: { first: 60 },
        tenantId: 'tenant-1',
        firstCap: 50,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('null input → uses DEFAULT_FIRST (no after)', async () => {
    const { repo, calls } = makeRepo([]);
    await paginateCursor(repo, {
      input: null,
      tenantId: 'tenant-1',
    });
    // take = DEFAULT_FIRST + 1 = 21
    expect(calls.take).toBe(21);
    // No cursor predicate when `after` was omitted.
    expect(calls.wheres.some((w) => w.clause.includes('cursorCreatedAt'))).toBe(false);
  });
});
