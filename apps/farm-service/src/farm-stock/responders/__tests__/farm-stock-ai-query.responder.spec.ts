import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { FarmStockAiQueryResponder } from '../farm-stock-ai-query.responder';
import { GetFarmStockInventoryQuery } from '../../queries/get-farm-stock-inventory.query';
import {
  FarmStockContainerSnapshot,
} from '../../entities/farm-stock-container-snapshot.entity';
import { FarmStockBatchSnapshot } from '../../entities/farm-stock-batch-snapshot.entity';

const TENANT = '33333333-3333-4333-8333-333333333333';
const SITE = '22222222-2222-4222-8222-222222222222';

function container(containerId: string): FarmStockContainerSnapshot {
  return {
    id: `snap-${containerId}`,
    tenantId: TENANT,
    containerId,
    containerSource: 'tank' as FarmStockContainerSnapshot['containerSource'],
    name: 'Havuz 1',
    code: 'TNK-001',
    departmentId: null,
    siteId: SITE,
    status: 'active',
    volume: 120,
    maxBiomassKg: 12000,
    currentQuantity: 9500,
    currentBiomassKg: 3400,
    capacityUsedPercent: 28.3,
    isOverCapacity: false,
    hasActiveBatch: true,
    isActive: true,
    lastStockEventAt: new Date('2026-09-17T06:00:00.000Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as FarmStockContainerSnapshot;
}

const BATCH_SNAPSHOT: FarmStockBatchSnapshot = {
  id: 'bs1',
  tenantId: TENANT,
  containerId: 't1',
  batchId: 'b1',
  batchNumber: 'B-2026-001',
  batchStatus: 'active',
  speciesId: 'sp1',
  speciesName: 'Seabass',
  quantity: 9500,
  biomassKg: 3400,
  avgWeightG: 358,
  densityKgM3: 28.3,
  totalMortality: 480,
  totalCull: 20,
  harvestedQuantity: 0,
  isPrimary: true,
} as unknown as FarmStockBatchSnapshot;

describe('FarmStockAiQueryResponder (PR-5 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let responder: FarmStockAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    responder = new FarmStockAiQueryResponder({ execute } as unknown as QueryBus);
  });

  it('FARM_STOCK_INVENTORY: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [
      null,
      { tenantId: 'nope' },
      { tenantId: TENANT, siteId: 'site' },
      { tenantId: TENANT, hasActiveBatch: 'yes' },
      { tenantId: TENANT, limit: 51 },
    ]) {
      expect(await responder.inventory(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('FARM_STOCK_INVENTORY: happy path passes ONLY contract filters, bounds and projects', async () => {
    execute.mockResolvedValue({
      items: Array.from({ length: 60 }, (_, i) => ({
        container: container(`t${i}`),
        batches: [BATCH_SNAPSHOT],
      })),
      total: 60,
      page: 1,
      limit: 50,
      totalPages: 2,
      hasNextPage: true,
      hasPreviousPage: false,
    });

    const reply = await responder.inventory({
      tenantId: TENANT,
      siteId: SITE,
      hasActiveBatch: true,
      limit: 50,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetFarmStockInventoryQuery));
    const query = execute.mock.calls[0][0] as GetFarmStockInventoryQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.filter?.siteId).toBe(SITE);
    expect(query.filter?.hasActiveBatch).toBe(true);
    expect(query.filter?.search).toBeUndefined(); // free text stays unreachable

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items).toHaveLength(50);
      expect(reply.data.truncated).toBe(true);
      expect(reply.data.items[0]?.batches[0]?.batchNumber).toBe('B-2026-001');
      expect(reply.data.items[0]?.lastStockEventAt).toBe('2026-09-17T06:00:00.000Z');
      expect(JSON.stringify(reply.data)).not.toContain('createdAt');
      expect(JSON.stringify(reply.data)).not.toContain('tenantId');
    }
  });

  it('FARM_STOCK_INVENTORY: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.inventory({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });
});
