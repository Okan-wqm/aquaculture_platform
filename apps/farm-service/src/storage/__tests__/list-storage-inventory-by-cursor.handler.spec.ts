/**
 * ListStorageInventoryByCursorHandler — Unit Tests
 *
 * Phase 5.1 first-resolver-adoption of the cursor pagination stack.
 * The handler itself is thin (delegates to `paginateCursor`) so the
 * tests focus on the wiring contract:
 *
 *   - tenantId always scopes the query
 *   - optional locationId / itemType filters are forwarded
 *   - undefined filters are skipped (they don't appear in WHERE)
 *   - cursor input is threaded through untouched
 *   - handler returns `{ edges, pageInfo }` — the canonical shape
 *
 * The adapter's own behaviour (tuple WHERE, DESC-DESC, first+1,
 * fail-closed on malformed cursor) is covered by
 * `libs/backend-common/src/pagination/__tests__/cursor-repository.spec.ts`.
 * This suite verifies the handler's ADAPTATION to the primitive, not
 * the primitive itself.
 */
import type { Repository } from 'typeorm';

import { encodeCursor } from '@aquaculture/backend-common';

import { ListStorageInventoryByCursorHandler } from '../handlers/list-storage-inventory-by-cursor.handler';
import { ListStorageInventoryByCursorQuery } from '../queries/list-storage-inventory-by-cursor.query';
import {
  StorageInventory,
  StorageItemType,
} from '../entities/storage-inventory.entity';

interface CapturedCall {
  wheres: Array<{ clause: string; params?: Record<string, unknown> }>;
  orderBys: Array<{ column: string; direction: 'ASC' | 'DESC' }>;
  take: number | null;
}

function makeRepo(rows: StorageInventory[]): {
  repo: Repository<StorageInventory>;
  calls: CapturedCall;
} {
  const calls: CapturedCall = { wheres: [], orderBys: [], take: null };
  const qb = {
    where: jest
      .fn()
      .mockImplementation((clause: string, params?: Record<string, unknown>) => {
        calls.wheres.push({ clause, params });
        return qb;
      }),
    andWhere: jest
      .fn()
      .mockImplementation((clause: string, params?: Record<string, unknown>) => {
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
  } as unknown as Repository<StorageInventory>;
  return { repo, calls };
}

function makeRow(id: string, createdAt: string): StorageInventory {
  const row: Partial<StorageInventory> = {
    id,
    tenantId: 'tenant-1',
    storageLocationId: 'loc-1',
    itemType: StorageItemType.FEED,
    itemId: 'item-1',
    quantity: 100,
    unit: 'kg',
    createdAt: new Date(createdAt),
  };
  return row as StorageInventory;
}

describe('ListStorageInventoryByCursorHandler', () => {
  function makeHandler(repo: Repository<StorageInventory>) {
    return new ListStorageInventoryByCursorHandler(repo);
  }

  it('tenantId always scopes the query (no location / no itemType)', async () => {
    const { repo, calls } = makeRepo([]);
    const handler = makeHandler(repo);

    await handler.execute(
      new ListStorageInventoryByCursorQuery('tenant-1', undefined, undefined, null),
    );

    expect(calls.wheres[0]).toEqual({
      clause: 'e."tenantId" = :tenantId',
      params: { tenantId: 'tenant-1' },
    });
    // No static-filter WHERE clauses beyond the tenant scope.
    const afterFirst = calls.wheres.slice(1);
    expect(afterFirst).toHaveLength(0);
  });

  it('forwards locationId + itemType filters onto the WHERE clause', async () => {
    const { repo, calls } = makeRepo([]);
    const handler = makeHandler(repo);

    await handler.execute(
      new ListStorageInventoryByCursorQuery(
        'tenant-1',
        'loc-42',
        StorageItemType.FEED,
        null,
      ),
    );

    const afterFirst = calls.wheres.slice(1);
    expect(afterFirst).toEqual(
      expect.arrayContaining([
        {
          clause: 'e."storageLocationId" = :w_storageLocationId',
          params: { w_storageLocationId: 'loc-42' },
        },
        {
          clause: 'e."itemType" = :w_itemType',
          params: { w_itemType: StorageItemType.FEED },
        },
      ]),
    );
  });

  it('threads a decoded cursor through as a tuple WHERE predicate', async () => {
    const anchor = makeRow('anchor', '2026-02-01T00:00:00Z');
    const cursor = encodeCursor(anchor);
    const { repo, calls } = makeRepo([]);
    const handler = makeHandler(repo);

    await handler.execute(
      new ListStorageInventoryByCursorQuery('tenant-1', undefined, undefined, {
        first: 20,
        after: cursor,
      }),
    );

    const tupleWhere = calls.wheres.find((w) => w.clause.includes('cursorCreatedAt'));
    expect(tupleWhere).toBeDefined();
    expect(tupleWhere!.clause).toBe(
      '(e."createdAt", e."id") < (:cursorCreatedAt, :cursorId)',
    );
    expect(tupleWhere!.params).toEqual({
      cursorCreatedAt: anchor.createdAt,
      cursorId: anchor.id,
    });
  });

  it('returns the canonical `{ edges, pageInfo }` shape with per-row cursors', async () => {
    const rows = [
      makeRow('1', '2026-04-23T12:00:00Z'),
      makeRow('2', '2026-04-23T11:00:00Z'),
    ];
    const { repo } = makeRepo(rows);
    const handler = makeHandler(repo);

    const response = await handler.execute(
      new ListStorageInventoryByCursorQuery('tenant-1', undefined, undefined, {
        first: 10,
      }),
    );

    expect(response.edges).toHaveLength(2);
    expect(response.edges[0]!.cursor).toBe(encodeCursor(rows[0]!));
    expect(response.edges[0]!.node.id).toBe('1');
    expect(response.pageInfo.hasNextPage).toBe(false);
    expect(response.pageInfo.endCursor).toBe(encodeCursor(rows[1]!));
  });

  it('flags hasNextPage when the repo returns one past `first`', async () => {
    const rows = [
      makeRow('1', '2026-04-23T12:00:00Z'),
      makeRow('2', '2026-04-23T11:00:00Z'),
      makeRow('3', '2026-04-23T10:00:00Z'), // signal row
    ];
    const { repo } = makeRepo(rows);
    const handler = makeHandler(repo);

    const response = await handler.execute(
      new ListStorageInventoryByCursorQuery('tenant-1', undefined, undefined, {
        first: 2,
      }),
    );

    expect(response.edges).toHaveLength(2);
    expect(response.pageInfo.hasNextPage).toBe(true);
    expect(response.edges.some((e) => e.node.id === '3')).toBe(false);
  });
});
