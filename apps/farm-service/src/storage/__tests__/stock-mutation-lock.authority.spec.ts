import {
  mutationInstantDateV1,
  readTenantMutationInstantV1,
  readTenantMutationSession,
  type MutationInstantV1,
  type TenantMutationSession,
} from '@aquaculture/backend-common/database';
import type { EntityManager } from 'typeorm';

import { StorageItemType } from '../entities/storage-inventory.entity';
import {
  canonicalStockMutationKeyV1,
  StockMutationLockAuthority,
  StockMutationLockOrderError,
} from '../services/stock-mutation-lock.authority';

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  mutationInstantDateV1: jest.fn(),
  readTenantMutationInstantV1: jest.fn(),
  readTenantMutationSession: jest.fn(),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const ITEM_A = '22222222-2222-4222-8222-222222222222';
const ITEM_B = '33333333-3333-4333-8333-333333333333';
const MUTATION_DATE = new Date('2026-08-08T12:30:00.000Z');
const SESSION = Object.freeze({}) as TenantMutationSession;
const INSTANT = Object.freeze({}) as MutationInstantV1;

function mock<T>(implementation: Partial<T>): T {
  return implementation as T;
}

function managerDouble(): EntityManager {
  return mock<EntityManager>({ query: jest.fn().mockResolvedValue(undefined) });
}

describe('StockMutationLockAuthority', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(readTenantMutationInstantV1).mockResolvedValue(INSTANT);
    jest.mocked(mutationInstantDateV1).mockReturnValue(MUTATION_DATE);
  });

  it('locks one item once even when reverse transfer directions re-enter the scope', async () => {
    const manager = managerDouble();
    jest.mocked(readTenantMutationSession).mockReturnValue({
      manager,
      sourceSchema: 'farm',
      tenantId: TENANT,
    });
    const authority = new StockMutationLockAuthority();
    const target = { itemType: StorageItemType.FEED, itemId: ITEM_A };

    await authority.acquire(SESSION, TENANT, target);
    await authority.acquire(SESSION, TENANT, target);

    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
      [canonicalStockMutationKeyV1(TENANT, target)],
    );
  });

  it('permits ascending multi-item acquisition and rejects descending acquisition before waiting', async () => {
    const ascendingManager = managerDouble();
    const ascendingSession = Object.freeze({}) as TenantMutationSession;
    jest.mocked(readTenantMutationSession).mockImplementation((session) => ({
      manager: session === ascendingSession ? ascendingManager : managerDouble(),
      sourceSchema: 'farm',
      tenantId: TENANT,
    }));
    const authority = new StockMutationLockAuthority();

    await authority.acquire(ascendingSession, TENANT, {
      itemType: StorageItemType.FEED,
      itemId: ITEM_A,
    });
    await authority.acquire(ascendingSession, TENANT, {
      itemType: StorageItemType.FEED,
      itemId: ITEM_B,
    });
    expect(ascendingManager.query).toHaveBeenCalledTimes(2);

    const descendingManager = managerDouble();
    const descendingSession = Object.freeze({}) as TenantMutationSession;
    jest.mocked(readTenantMutationSession).mockReturnValue({
      manager: descendingManager,
      sourceSchema: 'farm',
      tenantId: TENANT,
    });
    const descendingAuthority = new StockMutationLockAuthority();
    await descendingAuthority.acquire(descendingSession, TENANT, {
      itemType: StorageItemType.FEED,
      itemId: ITEM_B,
    });

    await expect(
      descendingAuthority.acquire(descendingSession, TENANT, {
        itemType: StorageItemType.FEED,
        itemId: ITEM_A,
      }),
    ).rejects.toBeInstanceOf(StockMutationLockOrderError);
    expect(descendingManager.query).toHaveBeenCalledTimes(1);
  });

  it('reuses the session clock capability and returns defensive Date projections', async () => {
    const manager = managerDouble();
    jest.mocked(readTenantMutationSession).mockReturnValue({
      manager,
      sourceSchema: 'farm',
      tenantId: TENANT,
    });
    jest
      .mocked(mutationInstantDateV1)
      .mockReturnValueOnce(new Date(MUTATION_DATE))
      .mockReturnValueOnce(new Date(MUTATION_DATE));
    const authority = new StockMutationLockAuthority();
    const scope = await authority.acquire(SESSION, TENANT, {
      itemType: StorageItemType.FEED,
      itemId: ITEM_A,
    });

    const first = await scope.readMutationInstant();
    const second = await scope.readMutationInstant();

    expect(readTenantMutationInstantV1).toHaveBeenCalledTimes(1);
    expect(first).not.toBe(second);
    expect(first).toEqual(MUTATION_DATE);
    expect(second).toEqual(MUTATION_DATE);
  });

  it('rejects tenant mismatch before acquiring any database lock', async () => {
    const manager = managerDouble();
    jest.mocked(readTenantMutationSession).mockReturnValue({
      manager,
      sourceSchema: 'farm',
      tenantId: TENANT,
    });

    await expect(
      new StockMutationLockAuthority().acquire(SESSION, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        itemType: StorageItemType.FEED,
        itemId: ITEM_A,
      }),
    ).rejects.toThrow('does not match');
    expect(manager.query).not.toHaveBeenCalled();
  });
});
