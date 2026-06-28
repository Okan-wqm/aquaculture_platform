/**
 * LotMixService Unit Tests
 *
 * Covers:
 *   - no-op when the incoming movement carries no lot number
 *   - no-op when the location is empty or already holds the same lot
 *   - mix creation when a different lot with non-zero quantity is
 *     resident, with correctly computed contributionPct values and a
 *     sorted `MIX-<lot1>-<lot2>-...` composite identifier
 *   - resident lots with quantity 0 are ignored (they represent
 *     drained-but-not-yet-removed rows)
 *   - `findMixesForLot` issues a JSONB-containment query
 *
 * Uses hand-rolled doubles for EntityManager + the two Repositories
 * the service consumes. No `as any` anywhere — doubles expose exactly
 * the methods under test.
 */
import { EntityManager } from 'typeorm';

import { createMockDataSource } from '@aquaculture/testing';

import { LotMixService } from '../services/lot-mix.service';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { LotContribution, StorageLotMix } from '../entities/storage-lot-mix.entity';

interface InventoryRepoDouble {
  find: jest.Mock;
}

interface MixRepoDouble {
  create: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
}

interface ManagerDouble {
  getRepository: jest.Mock;
}

function makeInventoryRows(
  rows: Array<Partial<StorageInventory>>,
): Array<Partial<StorageInventory>> {
  return rows;
}

function makeDoubles(opts: { residentLots?: Array<Partial<StorageInventory>> }): {
  service: LotMixService;
  inventoryRepo: InventoryRepoDouble;
  mixRepo: MixRepoDouble;
  manager: ManagerDouble;
} {
  const inventoryRepo: InventoryRepoDouble = {
    find: jest.fn().mockResolvedValue(opts.residentLots ?? []),
  };

  const mixRepo: MixRepoDouble = {
    create: jest.fn((row: Partial<StorageLotMix>) => ({
      ...row,
      id: 'mix-1',
    })),
    save: jest.fn(async (row: StorageLotMix) => row),
    createQueryBuilder: jest.fn(),
  };

  const manager: ManagerDouble = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === StorageInventory) return inventoryRepo;
      if (entity === StorageLotMix) return mixRepo;
      throw new Error(`unexpected repository request: ${String(entity)}`);
    }),
  };

  return {
    service: new LotMixService(),
    inventoryRepo,
    mixRepo,
    manager,
  };
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const LOCATION = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

describe('LotMixService.detect', () => {
  it('is a no-op when the incoming movement has no lotNumber', async () => {
    const { service, manager, mixRepo } = makeDoubles({});
    const outcome = await service.detect({
      tenantId: TENANT,
      storageLocationId: LOCATION,
      itemType: StorageItemType.FEED,
      itemId: ITEM,
      incomingLotNumber: null,
      incomingQuantityKg: 100,
      userId: USER,
      manager: manager as unknown as EntityManager,
    });
    expect(outcome.mixCreated).toBe(false);
    expect(outcome.mix).toBeNull();
    expect(outcome.effectiveLotNumber).toBeNull();
    expect(mixRepo.create).not.toHaveBeenCalled();
  });

  it('is a no-op when the location is empty', async () => {
    const { service, manager, mixRepo } = makeDoubles({ residentLots: [] });
    const outcome = await service.detect({
      tenantId: TENANT,
      storageLocationId: LOCATION,
      itemType: StorageItemType.FEED,
      itemId: ITEM,
      incomingLotNumber: 'LOT-A',
      incomingQuantityKg: 100,
      userId: USER,
      manager: manager as unknown as EntityManager,
    });
    expect(outcome.mixCreated).toBe(false);
    expect(mixRepo.create).not.toHaveBeenCalled();
  });

  it('is a no-op when only the same lot is already resident', async () => {
    const { service, manager, mixRepo } = makeDoubles({
      residentLots: makeInventoryRows([{ id: 'i1', lotNumber: 'LOT-A', quantity: 50 }]),
    });
    const outcome = await service.detect({
      tenantId: TENANT,
      storageLocationId: LOCATION,
      itemType: StorageItemType.FEED,
      itemId: ITEM,
      incomingLotNumber: 'LOT-A',
      incomingQuantityKg: 100,
      userId: USER,
      manager: manager as unknown as EntityManager,
    });
    expect(outcome.mixCreated).toBe(false);
    expect(mixRepo.create).not.toHaveBeenCalled();
  });

  it('ignores resident lots whose quantity has already drained to zero', async () => {
    const { service, manager, mixRepo } = makeDoubles({
      residentLots: makeInventoryRows([{ id: 'i1', lotNumber: 'LOT-OLD', quantity: 0 }]),
    });
    const outcome = await service.detect({
      tenantId: TENANT,
      storageLocationId: LOCATION,
      itemType: StorageItemType.FEED,
      itemId: ITEM,
      incomingLotNumber: 'LOT-A',
      incomingQuantityKg: 100,
      userId: USER,
      manager: manager as unknown as EntityManager,
    });
    expect(outcome.mixCreated).toBe(false);
    expect(mixRepo.create).not.toHaveBeenCalled();
  });

  it('creates a mix row when a different non-zero resident lot is found', async () => {
    const { service, manager, mixRepo } = makeDoubles({
      residentLots: makeInventoryRows([{ id: 'i1', lotNumber: 'LOT-OLD', quantity: 25 }]),
    });
    const outcome = await service.detect({
      tenantId: TENANT,
      storageLocationId: LOCATION,
      itemType: StorageItemType.FEED,
      itemId: ITEM,
      incomingLotNumber: 'LOT-NEW',
      incomingQuantityKg: 75,
      manufacturer: 'Skretting',
      userId: USER,
      manager: manager as unknown as EntityManager,
    });
    expect(outcome.mixCreated).toBe(true);
    expect(outcome.effectiveLotNumber).toBe('MIX-LOT-NEW-LOT-OLD');
    expect(mixRepo.create).toHaveBeenCalledTimes(2);
    const created = mixRepo.create.mock.calls[0][0] as {
      contributingLots: LotContribution[];
      totalQuantityKg: string;
      effectiveLotNumber: string;
    };
    expect(created.totalQuantityKg).toBe('100.00');
    expect(created.contributingLots).toHaveLength(2);
    // Percentages: 25 kg of 100 = 25%; 75 kg of 100 = 75%.
    const oldContrib = created.contributingLots.find((c) => c.lotNumber === 'LOT-OLD');
    const newContrib = created.contributingLots.find((c) => c.lotNumber === 'LOT-NEW');
    expect(oldContrib?.contributionPct).toBeCloseTo(25);
    expect(newContrib?.contributionPct).toBeCloseTo(75);
    // Manufacturer captured as a snapshot on each contribution.
    expect(oldContrib?.manufacturer).toBe('Skretting');
    expect(newContrib?.manufacturer).toBe('Skretting');
  });

  it('produces a sorted effective lot number regardless of resident order', async () => {
    const { service, manager } = makeDoubles({
      residentLots: makeInventoryRows([
        { id: 'i1', lotNumber: 'LOT-Z', quantity: 10 },
        { id: 'i2', lotNumber: 'LOT-A', quantity: 20 },
      ]),
    });
    const outcome = await service.detect({
      tenantId: TENANT,
      storageLocationId: LOCATION,
      itemType: StorageItemType.FEED,
      itemId: ITEM,
      incomingLotNumber: 'LOT-M',
      incomingQuantityKg: 30,
      userId: USER,
      manager: manager as unknown as EntityManager,
    });
    // Sorted composite: A, M, Z.
    expect(outcome.effectiveLotNumber).toBe('MIX-LOT-A-LOT-M-LOT-Z');
  });

  it('converts expiry Date objects to ISO strings on each contribution', async () => {
    const residentExpiry = new Date('2026-12-31T00:00:00.000Z');
    const incomingExpiry = new Date('2027-06-30T00:00:00.000Z');
    const { service, manager, mixRepo } = makeDoubles({
      residentLots: makeInventoryRows([
        {
          id: 'i1',
          lotNumber: 'LOT-OLD',
          quantity: 40,
          expiryDate: residentExpiry,
        },
      ]),
    });
    await service.detect({
      tenantId: TENANT,
      storageLocationId: LOCATION,
      itemType: StorageItemType.FEED,
      itemId: ITEM,
      incomingLotNumber: 'LOT-NEW',
      incomingQuantityKg: 60,
      incomingExpiryDate: incomingExpiry,
      userId: USER,
      manager: manager as unknown as EntityManager,
    });
    const created = mixRepo.create.mock.calls[0][0] as {
      contributingLots: LotContribution[];
    };
    const oldContrib = created.contributingLots.find((c) => c.lotNumber === 'LOT-OLD');
    const newContrib = created.contributingLots.find((c) => c.lotNumber === 'LOT-NEW');
    expect(oldContrib?.expiryDate).toBe(residentExpiry.toISOString());
    expect(newContrib?.expiryDate).toBe(incomingExpiry.toISOString());
  });
});

describe('LotMixService.findMixesForLot', () => {
  it('queries with JSONB containment against the contributing lots', async () => {
    const getMany = jest.fn().mockResolvedValue([{ id: 'mix-1' }]);
    const orderBy = jest.fn().mockReturnValue({ getMany });
    const andWhere = jest.fn().mockReturnValue({ orderBy });
    const where = jest.fn().mockReturnValue({ andWhere });
    const { mockManager } = createMockDataSource();
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue({ where }) as typeof mockManager.createQueryBuilder;

    const service = new LotMixService();
    const result = await service.findMixesForLot(mockManager, TENANT, 'LOT-A');

    expect(mockManager.createQueryBuilder).toHaveBeenCalledWith(StorageLotMix, 'mix');
    expect(where).toHaveBeenCalledWith('mix.tenantId = :tenantId', { tenantId: TENANT });
    expect(andWhere).toHaveBeenCalledWith('mix."contributingLots" @> :lotFilter', {
      lotFilter: JSON.stringify([{ lotNumber: 'LOT-A' }]),
    });
    expect(orderBy).toHaveBeenCalledWith('mix.mixedAt', 'DESC');
    expect(result).toEqual([{ id: 'mix-1' }]);
  });
});
